import type { QuotaCalibrationEvent } from './quota-equivalent';

type QuotaWindow = { startedAtMs: number; resetsAt: string; usedPercent: number; observedAtMs?: number };
const WEEK_MS = 604800000;
const MAX_GAP_MS = 30 * 60000;

/** Replay recorded account quota increases, keeping unsupported amounts unassigned.
 * Token prices supply weights, never an independent estimate of the account total.
 * Reset matching is an identity estimate; unknown windows are not relabeled.
 */
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
  const pending = new Map<string, number>();
  const streams = new Map<string, number>();
  let previousAt: number | null = null;
  let highWater: number | null = null;
  let complete = true;
  let calibrationCost = 0;
  let calibrationPercent = 0;
  let observedSince: number | null = null;
  let calibratedAt: number | null = null;
  let matchingCost = 0;
  let firstUsed: number | null = null;
  const discard = () => {
    for (const id of pending.keys()) partialTasks.add(id);
    pending.clear();
    complete = true;
  };
  for (let index = 0; index < sorted.length;) {
    const at = sorted[index].at;
    const group: QuotaCalibrationEvent[] = [];
    while (index < sorted.length && sorted[index].at === at) group.push(sorted[index++]);
    for (const e of group) if (!e.limit && e.taskId && !e.duplicateUsage && (e.cost === null || e.cost > 0)) partialTasks.add(e.taskId);
    const matching = group.filter(e => e.limit && Math.abs(e.limit.resetsAt - end) <= 60000);
    // An unknown account or account switch interrupts the pairing of weights
    // with quota snapshots. Do not borrow another account's costs.
    const ambiguous = group.some(e => e.limit ? Math.abs(e.limit.resetsAt - end) > 60000 :
      !e.duplicateUsage && (e.cost === null || e.cost > 0));
    if (!matching.length) {
      if (ambiguous) { discard(); previousAt = null; }
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
    for (const event of matching) if (event.streamId) {
      const range = groupedStreams.get(event.streamId);
      groupedStreams.set(event.streamId, { min: Math.min(range?.min ?? 100, event.limit!.used), max: Math.max(range?.max ?? 0, event.limit!.used) });
    }
    for (const [id, range] of groupedStreams) {
      const prior = streams.get(id);
      if (prior !== undefined && range.min < prior) regressed = true;
      streams.set(id, Math.max(prior ?? 0, range.max));
    }
    for (const event of matching) {
      if (event.taskId) matchedTasks.add(event.taskId);
      if (event.duplicateUsage) continue;
      if (event.cost === null || !Number.isFinite(event.cost) || event.cost < 0 || !event.taskId && event.cost > 0) {
        complete = false;
        if (event.taskId) partialTasks.add(event.taskId);
      } else if (event.taskId && event.cost > 0) {
        if (previousAt !== null || highWater !== null) matchingCost += event.cost;
        // The first quota reading already includes pre-observation usage.
        // Only response costs following a baseline can explain an increase.
        if (continuous) pending.set(event.taskId, (pending.get(event.taskId) ?? 0) + event.cost);
        else partialTasks.add(event.taskId);
      }
    }
    if (regressed || ambiguous) complete = false;
    const delta = highWater === null ? 0 : Math.max(0, Math.min(used, window.usedPercent) - highWater);
    if (delta > 0) {
      const cost = [...pending.values()].reduce((sum, value) => sum + value, 0);
      if (continuous && complete && cost > 0) {
        for (const [id, weight] of pending) attributed.set(id, (attributed.get(id) ?? 0) + delta * weight / cost);
        calibrationCost += cost;
        calibrationPercent += delta;
        calibratedAt = at;
        pending.clear();
        complete = true;
      } else discard();
    }
    highWater = Math.max(highWater ?? 0, Math.min(used, window.usedPercent));
    previousAt = ambiguous ? null : at;
    if (ambiguous) discard();
  }
  // Costs after the last rounded snapshot are pending, not zero usage.
  discard();
  const attributedPercent = [...attributed.values()].reduce((sum, value) => sum + value, 0);
  // A narrow set of readable intervals can underrepresent the costs that
  // produced the account's quota. Preserve the prior common unit until both
  // quota and matching priced-cost coverage are sufficient to retrain it.
  const quotaCoverage = highWater !== null && firstUsed !== null && highWater > firstUsed ? calibrationPercent / (highWater - firstUsed) : 0;
  const costCoverage = matchingCost > 0 ? calibrationCost / matchingCost : 0;
  return { attributed, matchedTasks, partialTasks, attributedPercent,
    unattributedPercent: Math.max(0, window.usedPercent - attributedPercent),
    observedSince: observedSince === null ? null : new Date(observedSince).toISOString(),
    costPerPercent: calibrationPercent >= 5 && calibrationCost > 0 && quotaCoverage >= 0.9 && costCoverage >= 0.9 ? calibrationCost / calibrationPercent : null,
    quotaCoverage, costCoverage,
    calibrationPercent, calibratedAt: calibratedAt === null ? null : new Date(calibratedAt).toISOString() };
}
