import type { QuotaCalibrationEvent } from './quota-equivalent';

type QuotaWindow = { startedAtMs: number; resetsAt: string; usedPercent: number; observedAtMs?: number };
const WEEK_MS = 604800000;
const MAX_GAP_MS = 30 * 60000;
export type QuotaAllocationSlice = { taskId: string; at: number; percent: number; estimated: boolean };
const positive = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;
const validTokens = (n: number | undefined): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;

/** Token fallback only distributes observed quota; it never supplies API prices.
 * Missing account identity retains its weight in the unassigned bucket. */
export function reconcileQuotaUsage(events: QuotaCalibrationEvent[], window: QuotaWindow | null | undefined, now: number) {
  const end = Date.parse(window?.resetsAt ?? '');
  if (!window || end - window.startedAtMs !== WEEK_MS || !Number.isFinite(window.usedPercent) ||
      window.usedPercent < 0 || window.usedPercent > 100) return null;
  const cutoff = Math.min(now, window.observedAtMs ?? now, end - 1);
  const unique = new Map<string | QuotaCalibrationEvent, QuotaCalibrationEvent>();
  for (const event of events) {
    if (!Number.isFinite(event.at) || event.at < window.startedAtMs || event.at > cutoff) continue;
    const key = event.id ?? event;
    if (!unique.get(key)?.duplicateUsage) unique.set(key, event);
  }
  const sorted = [...unique.values()].sort((a, b) => a.at - b.at);
  const attributed = new Map<string, number>();
  const partialTasks = new Set<string>();
  const matchedTasks = new Set<string>();
  const slices: QuotaAllocationSlice[] = [];
  const coveredEventIds = new Set<string>();
  const pending: QuotaCalibrationEvent[] = [];
  const streams = new Map<string, number>();
  let previousAt: number | null = null;
  let highWater: number | null = null;
  let calibrationCost = 0;
  let calibrationPercent = 0;
  let acceptedPercent = 0;
  let tokenFallbackPercent = 0;
  let trainingWeight = 0;
  let pricedTrainingWeight = 0;
  let calibratedAt: number | null = null;
  let observedSince: number | null = null;
  let matchingCost = 0;
  let firstUsed: number | null = null;
  let invalidInterval = false;
  const discard = () => {
    for (const event of pending) if (event.taskId) partialTasks.add(event.taskId);
    pending.length = 0;
  };
  for (let index = 0; index < sorted.length;) {
    const at = sorted[index].at;
    const group: QuotaCalibrationEvent[] = [];
    while (index < sorted.length && sorted[index].at === at) group.push(sorted[index++]);
    const matching = group.filter(e => e.limit && Math.abs(e.limit.resetsAt - end) <= 60000);
    const switched = group.some(e => e.limit && Math.abs(e.limit.resetsAt - end) > 60000 && e.streamId && streams.has(e.streamId));
    if (switched) { discard(); previousAt = null; }
    // Parallel known accounts must not borrow weights or erase this account's.
    const unknown = group.filter(e => !e.limit && !e.duplicateUsage && !(e.cost === null && e.tokens === 0) && (e.cost === null || positive(e.cost)));
    for (const e of unknown) if (e.taskId) partialTasks.add(e.taskId);
    if (!matching.length) {
      if (previousAt !== null && at - previousAt <= MAX_GAP_MS) pending.push(...unknown);
      else if (unknown.length) discard();
      continue;
    }
    const used = Math.max(...matching.map(e => e.limit!.used));
    if (!Number.isFinite(used) || used < 0 || used > 100) { discard(); previousAt = null; continue; }
    observedSince ??= at;
    firstUsed ??= Math.min(used, window.usedPercent);
    const continuous = previousAt !== null && at - previousAt <= MAX_GAP_MS;
    if (!continuous) discard();
    let regressed = false;
    const groupedStreams = new Map<string, { min: number; max: number }>();
    for (const e of matching) if (e.streamId) {
      const range = groupedStreams.get(e.streamId);
      groupedStreams.set(e.streamId, { min: Math.min(range?.min ?? 100, e.limit!.used), max: Math.max(range?.max ?? 0, e.limit!.used) });
    }
    for (const [id, range] of groupedStreams) {
      const prior = streams.get(id);
      if (prior !== undefined && range.min < prior) regressed = true;
      streams.set(id, Math.max(prior ?? 0, range.max));
    }
    for (const e of matching) {
      if (e.taskId) matchedTasks.add(e.taskId);
      if (e.duplicateUsage || e.cost === null && e.tokens === 0 || e.cost === 0 && (!validTokens(e.tokens) || e.tokens === 0)) continue;
      if (positive(e.cost) && highWater !== null) matchingCost += e.cost;
      if (continuous) pending.push(e);
      else if (e.taskId) partialTasks.add(e.taskId);
    }
    if (continuous) pending.push(...unknown);
    const delta = highWater === null ? 0 : Math.max(0, Math.min(used, window.usedPercent) - highWater);
    if (regressed) { discard(); invalidInterval = true; }
    if (delta > 0) {
      const needsTokens = pending.some(e => e.cost === null);
      const missingWeight = pending.some(e => e.cost !== null && (!Number.isFinite(e.cost) || e.cost < 0) ||
        e.cost === null && (!validTokens(e.tokens) || e.tokens === 0));
      const known = pending.filter(e => positive(e.cost));
      const pricedCost = known.reduce((sum, e) => sum + e.cost!, 0);
      const pricedTokens = known.reduce((sum, e) => sum + (validTokens(e.tokens) ? e.tokens : 0), 0);
      // Same-interval blended rate is a proxy weight, never a catalog price.
      const unit = pricedTokens > 0 ? pricedCost / pricedTokens : 1;
      const canMix = !needsTokens || pricedCost === 0 || known.every(e => validTokens(e.tokens) && e.tokens > 0);
      const weights = pending.map(e => ({ event: e, weight: positive(e.cost) ? e.cost : e.cost === null && validTokens(e.tokens) ? e.tokens * unit : 0 }));
      const total = weights.reduce((sum, e) => sum + e.weight, 0);
      if (continuous && !invalidInterval && !missingWeight && canMix && positive(total)) {
        let knownQuota = 0, knownCost = 0, accountWeight = 0, pricedWeight = 0;
        const uncertainAccount = pending.some(e => !e.limit || !e.taskId);
        for (const { event: e, weight } of weights) {
          if (!e.taskId || !e.limit || Math.abs(e.limit.resetsAt - end) > 60000 || !positive(weight)) continue;
          const percent = delta * weight / total;
          attributed.set(e.taskId, (attributed.get(e.taskId) ?? 0) + percent);
          slices.push({ taskId: e.taskId, at: e.at, percent, estimated: needsTokens || uncertainAccount });
          if (e.id) coveredEventIds.add(e.id);
          accountWeight += weight;
          if (needsTokens || uncertainAccount) partialTasks.add(e.taskId);
          if (positive(e.cost)) { knownQuota += percent; knownCost += e.cost; pricedWeight += weight; }
        }
        acceptedPercent += delta * accountWeight / total;
        if (needsTokens) tokenFallbackPercent += delta * accountWeight / total;
        // Only real priced cost and its own quota share train the reference.
        if (!uncertainAccount) {
          calibrationCost += knownCost;
          calibrationPercent += knownQuota;
          trainingWeight += accountWeight;
          pricedTrainingWeight += pricedWeight;
          calibratedAt = at;
        }
        pending.length = 0;
      } else discard();
      invalidInterval = false;
    }
    highWater = Math.max(highWater ?? 0, Math.min(used, window.usedPercent));
    previousAt = at;
  }
  discard();
  const attributedPercent = [...attributed.values()].reduce((sum, value) => sum + value, 0);
  const quotaCoverage = highWater !== null && firstUsed !== null && highWater > firstUsed ? acceptedPercent / (highWater - firstUsed) : 0;
  const costCoverage = matchingCost > 0 ? calibrationCost / matchingCost : 0;
  const pricedCoverage = trainingWeight > 0 ? pricedTrainingWeight / trainingWeight : 0;
  return { attributed, matchedTasks, partialTasks, slices, coveredEventIds, attributedPercent, tokenFallbackPercent,
    unattributedPercent: Math.max(0, window.usedPercent - attributedPercent),
    observedSince: observedSince === null ? null : new Date(observedSince).toISOString(),
    costPerPercent: calibrationPercent >= 5 && calibrationCost > 0 && quotaCoverage >= 0.9 && costCoverage >= 0.9 && pricedCoverage >= 0.9
      ? calibrationCost / calibrationPercent : null,
    referenceIsComplete: tokenFallbackPercent === 0,
    quotaCoverage, costCoverage, pricedCoverage,
    calibrationPercent, calibratedAt: calibratedAt === null ? null : new Date(calibratedAt).toISOString() };
}

/** Reset anchors estimate account identity; calendar buckets can collide. */
export function reconcileAcrossAccounts(events: QuotaCalibrationEvent[], now: number, current?: QuotaWindow | null) {
  const windows: { end: number; used: number; events: QuotaCalibrationEvent[] }[] = [];
  const owners = new Map<QuotaCalibrationEvent, number>();
  for (const event of [...events].sort((a, b) => (a.limit?.resetsAt ?? 0) - (b.limit?.resetsAt ?? 0))) if (event.limit && event.at <= now) {
    const end = event.limit.resetsAt;
    let window = windows.find(w => Math.abs(w.end - end) <= 60000);
    if (!window) windows.push(window = { end, used: 0, events: [] });
    window.used = Math.max(window.used, event.limit.used);
    window.events.push(event);
    owners.set(event, window.end);
  }
  // A jittered timestamp can be within 60 seconds of two distinct anchors.
  // Normalize each record to its one deterministic owner before replaying.
  const normalized = events.map(e => e.limit && owners.has(e)
    ? { ...e, limit: { ...e.limit, resetsAt: owners.get(e)! } } : e);
  const slices: QuotaAllocationSlice[] = [];
  const coveredEventIds = new Set<string>();
  const currentOwner = current ? windows.find(w => Math.abs(Date.parse(current.resetsAt) - w.end) <= 60000) : undefined;
  for (const w of windows) {
    const selected = current && w === currentOwner
      ? { ...current, startedAtMs: w.end - WEEK_MS, resetsAt: new Date(w.end).toISOString() } : null;
    const result = reconcileQuotaUsage(normalized.filter(e => e.at >= w.end - WEEK_MS && e.at < w.end),
      selected ?? { startedAtMs: w.end - WEEK_MS, resetsAt: new Date(w.end).toISOString(), usedPercent: w.used }, now);
    if (!result) continue;
    slices.push(...result.slices);
    for (const id of result.coveredEventIds) coveredEventIds.add(id);
  }
  return { slices, coveredEventIds };
}
