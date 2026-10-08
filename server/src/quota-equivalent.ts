import type { HistoryJob } from '../../shared/monitor';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { reconcileQuotaUsage, reconcileAcrossAccounts } from './quota-reconciliation';

type SavedCalibration = { version: 1; costPerPercent: number; quotaPercent: number; windowStart: number; updatedAt: number; accountId?: string; resetsAt?: string; referenceIsComplete?: boolean };
type CalibrationScope = { accountId: string; startedAtMs: number; resetsAt: string; usedPercent: number; observedAtMs?: number; allowUpdate?: boolean };
const SAMPLE_RETENTION_MS = 30 * 86400000;
const SAVE_INTERVAL_MS = 30000;
// v5 adds complete token weights. v4 identities/prices remain reusable and are
// enriched from selected compact records, without scanning extra archives.
const SAMPLE_VERSION = 5;
const CALIBRATION_POLICY = 4;

/** Keep the last usable reference across resets, reduced archive scopes and restarts. */
export class QuotaCalibration {
  private saved: SavedCalibration | null = null;
  private currentPolicy = false;
  private manual: {costPerPercent: number; updatedAt: number; accountId: string; resetsAt: string} | null = null;
  private readonly samples = new Map<string, QuotaCalibrationEvent>();
  private referenceSamplesKnown = false;
  private dirty = false;
  private referenceDirty = false;
  private saveFailed = false;
  private nextSaveAt = 0;
  private sampleGeneration = 0;
  private latestSampleAt = 0;
  private acrossCache: { key: string; result: ReturnType<typeof reconcileAcrossAccounts> } | null = null;
  constructor(private readonly file?: string) {
    if (file) {
      try {
        const value = JSON.parse(readFileSync(file + '.manual.json', 'utf8'));
        const end = Date.parse(value.resetsAt);
        if (value.version === 1 && Number.isFinite(value.costPerPercent) && value.costPerPercent > 0 && validTimestamp(value.updatedAt) &&
            typeof value.accountId === 'string' && value.accountId.length > 0 && Number.isFinite(end) &&
            value.updatedAt >= end - 604800000 && value.updatedAt < end) this.manual = value;
      } catch { /* Missing manual reference leaves automatic calibration active. */ }
    }
    if (file && existsSync(file)) {
      try {
        const value = JSON.parse(readFileSync(file, 'utf8'));
        // Quota attribution can already be useful before a five-point common
        // calibration exists. Retain its metadata across restarts as well.
        if (value?.version === 1 && value.costPerPercent === null && value.quotaPercent === 0 &&
            [4, SAMPLE_VERSION].includes(value.sampleVersion) && Array.isArray(value.samples) && value.samples.every(validSample)) {
          for (const event of value.samples) this.samples.set(sampleKey(event), event);
          this.dirty = value.sampleVersion !== SAMPLE_VERSION;
          return;
        }
        if (value?.version !== 1 || !Number.isFinite(value.costPerPercent) || value.costPerPercent <= 0 ||
            !Number.isFinite(value.quotaPercent) || value.quotaPercent < 5 ||
            !validTimestamp(value.windowStart) || !validTimestamp(value.updatedAt) || value.updatedAt < value.windowStart) throw new Error('Invalid calibration');
        this.currentPolicy = value.calibrationPolicy === CALIBRATION_POLICY;
        this.saved = { version: 1, costPerPercent: value.costPerPercent, quotaPercent: value.quotaPercent,
          windowStart: value.windowStart, updatedAt: value.updatedAt, accountId: value.accountId, resetsAt: value.resetsAt,
          referenceIsComplete: value.referenceIsComplete !== false };
        // Version 1 files without samples remain valid references. Do not replace
        // them from a potentially narrower selection until fresh samples qualify.
        if ([4, SAMPLE_VERSION].includes(value.sampleVersion) && Array.isArray(value.samples) && value.samples.every(validSample)) {
          for (const event of value.samples) this.samples.set(sampleKey(event), event);
          this.referenceSamplesKnown = this.currentPolicy && value.referenceSamplesKnown === true;
          this.dirty = value.sampleVersion !== SAMPLE_VERSION;
        } else this.dirty = true;
      } catch (error) { console.warn('Saved quota calibration unavailable:', String(error)); }
    }
  }

  resolve(events: QuotaCalibrationEvent[], windowStart: number | null, now: number, scope?: CalibrationScope) {
    let samplesChanged = false;
    for (const event of events) {
      if (!validSample(event) || event.at < now - SAMPLE_RETENTION_MS || event.at > now) continue;
      const key = sampleKey(event);
      const previous = this.samples.get(key);
      // A full log can prove unchanged cumulative usage while an overlapping
      // fragment lacks that preceding context. Retain the proven zero cost.
      const sample = previous?.duplicateUsage && !event.duplicateUsage
        ? { ...event, cost: 0, tokens: 0, duplicateUsage: true } : event;
      if (!sameSample(previous, sample)) {
        this.samples.set(key, { ...sample, limit: sample.limit ? { ...sample.limit } : null });
        samplesChanged = this.dirty = true;
      }
    }
    for (const [key, event] of this.samples) {
      if (event.at < now - SAMPLE_RETENTION_MS) {
        this.samples.delete(key);
        samplesChanged = true;
        this.dirty = true;
      }
    }
    const known = [...this.samples.values()];
    this.latestSampleAt = known.reduce((latest, e) => Math.max(latest, e.at), 0);
    if (samplesChanged) this.sampleGeneration++;
    if (scope) {
      // Train from the selected account's replayable quota increments, never
      // from a mixture of different account windows or a stale manual total.
      const reconciled = reconcileQuotaUsage(known, scope, now);
      let source: 'current' | 'previous' | 'unavailable' | 'manual' = this.saved ? 'previous' : 'unavailable';
      if (scope.allowUpdate !== false && reconciled?.costPerPercent && reconciled.calibratedAt &&
          (!this.saved?.accountId || Date.parse(reconciled.calibratedAt) >= this.saved.updatedAt)) {
        this.remember(reconciled.costPerPercent, reconciled.calibrationPercent, scope.startedAtMs, Date.parse(reconciled.calibratedAt), scope, reconciled.referenceIsComplete);
        source = 'current';
      }
      this.persist(now);
      const manual = this.manual;
      const manualMatches = manual && manual.accountId === scope.accountId &&
        Math.abs(Date.parse(manual.resetsAt) - Date.parse(scope.resetsAt)) <= 60000 && now < Date.parse(manual.resetsAt);
      if (manualMatches) return { costPerPercent: manual.costPerPercent, quotaPercent: 100,
        referenceQuotaPercent: 100, source: 'manual' as const, calibratedAt: new Date(manual.updatedAt).toISOString(),
        referenceAccountId: manual.accountId, referenceResetsAt: manual.resetsAt, referenceIsComplete: true, reconciliation: reconciled };
      // A confirmed older reference can still serve the cross-account unit
      // while this window gathers evidence. It never sets task attribution.
      const historicalManual = source !== 'current' && manual && (!this.saved || this.saved.updatedAt <= manual.updatedAt || !this.saved.accountId);
      return { costPerPercent: historicalManual ? manual.costPerPercent : this.saved?.costPerPercent ?? null,
        quotaPercent: reconciled?.calibrationPercent ?? 0,
        referenceQuotaPercent: historicalManual ? 100 : this.saved?.quotaPercent ?? 0,
        source: historicalManual ? 'previous' as const : source,
        calibratedAt: historicalManual ? new Date(manual.updatedAt).toISOString() : this.saved ? new Date(this.saved.updatedAt).toISOString() : null,
        referenceAccountId: historicalManual ? manual.accountId : this.saved?.accountId,
        referenceResetsAt: historicalManual ? manual.resetsAt : this.saved?.resetsAt,
        referenceIsComplete: historicalManual ? true : this.saved?.referenceIsComplete !== false,
        coverage: reconciled ? { quota: Math.min(1, reconciled.quotaCoverage), cost: Math.min(1, reconciled.costCoverage), priced: Math.min(1, reconciled.pricedCoverage) } : undefined,
        reconciliation: reconciled };
    }
    if (this.saved?.accountId) {
      this.persist(now);
      return { costPerPercent: this.saved.costPerPercent, quotaPercent: 0,
        referenceQuotaPercent: this.saved.quotaPercent, source: 'previous' as const,
        calibratedAt: new Date(this.saved.updatedAt).toISOString(),
        referenceAccountId: this.saved.accountId, referenceResetsAt: this.saved.resetsAt };
    }
    const current = windowStart === null ? null : calibrationDetails(known, windowStart, now + 1);
    const candidateStart = Math.max(windowStart ?? now - SAMPLE_RETENTION_MS,
      this.saved && !this.referenceSamplesKnown ? this.saved.updatedAt : -Infinity);
    const candidate = current && candidateStart === windowStart ? current : calibrationDetails(known, candidateStart, now + 1);
    let source: 'current' | 'previous' | 'unavailable' = this.saved ? 'previous' : 'unavailable';
    if (candidate.costPerPercent !== null && candidate.updatedAt !== null &&
        (!this.saved || (!this.currentPolicy || samplesChanged) && candidate.updatedAt >= this.saved.updatedAt)) {
      this.remember(candidate.costPerPercent, candidate.quotaPercent, candidateStart, candidate.updatedAt);
      source = windowStart === null ? 'previous' : 'current';
    } else if (events.length && current && current.costPerPercent !== null && this.saved &&
        current.updatedAt === this.saved.updatedAt && current.costPerPercent === this.saved.costPerPercent &&
        current.quotaPercent === this.saved.quotaPercent && this.referenceSamplesKnown) {
      // Startup may recover this exact reference before the live account's
      // window arrives. Its observations, not that temporary start, identify it.
      source = 'current';
    } else if (!this.saved) {
      // Upgrade recovery uses metadata already read for the selected tasks; never scan extra archives.
      const end = windowStart ?? now + 1;
      const start = end - SAMPLE_RETENTION_MS;
      const historic = calibrationDetails(known, start, end);
      if (historic.costPerPercent !== null && historic.updatedAt !== null) {
        this.remember(historic.costPerPercent, historic.quotaPercent, start, historic.updatedAt);
        source = 'previous';
      }
    }
    this.persist(now);
    if (this.manual && (!this.saved?.accountId || this.saved.updatedAt <= this.manual.updatedAt)) {
      return { costPerPercent: this.manual.costPerPercent, quotaPercent: 0, referenceQuotaPercent: 100,
        source: 'previous' as const, calibratedAt: new Date(this.manual.updatedAt).toISOString(),
        referenceAccountId: this.manual.accountId, referenceResetsAt: this.manual.resetsAt };
    }
    return { costPerPercent: this.saved?.costPerPercent ?? null, quotaPercent: windowStart === null ? 0 : candidate.quotaPercent,
      referenceQuotaPercent: this.saved?.quotaPercent ?? 0, source,
      calibratedAt: this.saved ? new Date(this.saved.updatedAt).toISOString() : null };
  }

  recordedEvents(): QuotaCalibrationEvent[] { return [...this.samples.values()]; }

  replayAcrossAccounts(now: number, scope?: Parameters<typeof reconcileAcrossAccounts>[2]) {
    const key = JSON.stringify([this.sampleGeneration, Math.min(now, this.latestSampleAt), scope?.usedPercent, scope?.resetsAt, scope?.observedAtMs]);
    if (this.acrossCache?.key === key) return this.acrossCache.result;
    const result = reconcileAcrossAccounts(this.recordedEvents(), now, scope);
    this.acrossCache = { key, result };
    return result;
  }

  private remember(costPerPercent: number, quotaPercent: number, windowStart: number, updatedAt: number, scope?: CalibrationScope, referenceIsComplete = true) {
    const next: SavedCalibration = { version: 1, costPerPercent, quotaPercent, windowStart, updatedAt,
      referenceIsComplete,
      ...(scope ? { accountId: scope.accountId, resetsAt: scope.resetsAt } : {}) };
    if (JSON.stringify(next) !== JSON.stringify(this.saved)) this.referenceDirty = this.dirty = true;
    this.saved = next;
    this.referenceSamplesKnown = true;
    this.currentPolicy = true;
  }

  private persist(now: number) {
    if (!this.file || !this.dirty || now < this.nextSaveAt && (this.saveFailed || !this.referenceDirty)) return;
    this.nextSaveAt = now + SAVE_INTERVAL_MS;
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      writeFileSync(this.file + '.tmp', JSON.stringify({ ...(this.saved ?? { version: 1, costPerPercent: null, quotaPercent: 0, windowStart: now, updatedAt: now }),
        calibrationPolicy: this.currentPolicy ? CALIBRATION_POLICY : 0, sampleVersion: SAMPLE_VERSION,
        samples: [...this.samples.values()], referenceSamplesKnown: this.referenceSamplesKnown }));
      renameSync(this.file + '.tmp', this.file);
      this.dirty = false;
      this.referenceDirty = this.saveFailed = false;
    } catch (error) {
      this.saveFailed = true;
      console.warn('Could not persist quota calibration; retaining it in memory:', String(error));
    }
  }
}

function validTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Number.isFinite(new Date(value).getTime());
}

function validSample(event: QuotaCalibrationEvent): boolean {
  return Boolean(event && validTimestamp(event.at) && (event.id === undefined || typeof event.id === 'string') &&
    (event.streamId === undefined || typeof event.streamId === 'string' && event.streamId.length > 0) &&
    (event.taskId === undefined || typeof event.taskId === 'string' && event.taskId.length > 0) &&
    (event.duplicateUsage === undefined || typeof event.duplicateUsage === 'boolean') &&
    (!event.duplicateUsage || event.cost === 0) &&
    (event.tokens === undefined || Number.isSafeInteger(event.tokens) && event.tokens >= 0) &&
    (!event.duplicateUsage || event.tokens === undefined || event.tokens === 0) &&
    (event.cost === null || Number.isFinite(event.cost) && event.cost >= 0) &&
    (event.limit === null || event.limit && Number.isFinite(event.limit.used) && event.limit.used >= 0 && event.limit.used <= 100 &&
      validTimestamp(event.limit.resetsAt) && event.at < event.limit.resetsAt && event.at >= event.limit.resetsAt - 604800000));
}

function sampleKey(event: QuotaCalibrationEvent): string {
  return event.id ?? JSON.stringify([event.at, event.limit?.resetsAt ?? null]);
}

function sameSample(left: QuotaCalibrationEvent | undefined, right: QuotaCalibrationEvent): boolean {
  return Boolean(left && left.at === right.at && left.cost === right.cost && left.tokens === right.tokens && left.streamId === right.streamId && left.taskId === right.taskId &&
    Boolean(left.duplicateUsage) === Boolean(right.duplicateUsage) &&
    left.limit?.used === right.limit?.used && left.limit?.resetsAt === right.limit?.resetsAt);
}

// Only usage metadata and opaque sample identities are retained, never authentication data or transcript text.
export interface QuotaCalibrationEvent {
  id?: string;
  streamId?: string;
  /** Consolidated principal task; no transcript or credentials. */
  taskId?: string;
  duplicateUsage?: boolean;
  at: number;
  cost: number | null;
  /** Complete incremental total only; absence cannot be mistaken for zero. */
  tokens?: number;
  limit: { used: number; resetsAt: number } | null;
}

/** This installation's owner confirmed that the recorded Pro accounts are all 20x. */
export function pro20xWeeklyLimit(value: unknown, at: number): QuotaCalibrationEvent['limit'] {
  if (!value || typeof value !== 'object') return null;
  const rate = value as Record<string, any>;
  if (rate.plan_type !== 'pro' || (rate.limit_id && rate.limit_id !== 'codex')) return null;
  const week = [rate.primary, rate.secondary].find(window => window?.window_minutes === 10080);
  if (!week || typeof week.used_percent !== 'number' || !Number.isFinite(week.used_percent) ||
      week.used_percent < 0 || week.used_percent > 100 || typeof week.resets_at !== 'number') return null;
  const resetsAt = week.resets_at * 1000;
  if (!Number.isFinite(resetsAt) || at >= resetsAt || at < resetsAt - 604800000) return null;
  return { used: week.used_percent, resetsAt };
}

/** Calibrate a common unit from observed Pro quota changes, not the subscription price.
 * Parallel sessions share a quota: merge their timeline before taking differences.
 * A reset/switch, missing price, long observation gap or correction starts a new baseline.
 */
export function calibrate20x(events: QuotaCalibrationEvent[], start: number, end: number) {
  const { costPerPercent, quotaPercent } = calibrationDetails(events, start, end);
  return { costPerPercent, quotaPercent };
}

function calibrationDetails(events: QuotaCalibrationEvent[], start: number, end: number) {
  type WindowState = { resetsAt: number; highWater: number | null; streams: Map<string, number> };
  type Observation = { used: number; cost: number | null; anonymousMinimum: number | null;
    streams: Map<string, { minimum: number; maximum: number }>; regressed: boolean };
  const windows: WindowState[] = [];
  let previous: { at: number; window: WindowState } | null = null;
  let pendingCost = 0;
  let complete = true;
  let cost = 0;
  let quota = 0;
  const recent: { cost: number; quota: number }[] = [];
  let updatedAt: number | null = null;
  const sorted = events.filter(e => e.at >= start && e.at < end).sort((a, b) =>
    a.at - b.at || (a.limit?.resetsAt ?? Infinity) - (b.limit?.resetsAt ?? Infinity) ||
    (a.cost ?? Infinity) - (b.cost ?? Infinity));
  for (let index = 0; index < sorted.length;) {
    const at = sorted[index].at;
    const groups = new Map<WindowState, Observation>();
    let unknownWindow = false;
    // Simultaneous parallel reports have no meaningful file order. Include
    // all their response costs before applying their highest quota reading.
    while (index < sorted.length && sorted[index].at === at) {
      const event = sorted[index++];
      if (!event.limit) { unknownWindow = true; continue; }
      let window = windows.find(value => Math.abs(value.resetsAt - event.limit!.resetsAt) <= 60000);
      if (!window) {
        window = { resetsAt: event.limit.resetsAt, highWater: null, streams: new Map() };
        windows.push(window);
      }
      const group = groups.get(window) ?? { used: event.limit.used, cost: 0,
        anonymousMinimum: null, streams: new Map(), regressed: false };
      group.used = Math.max(group.used, event.limit.used);
      group.cost = group.cost === null || event.cost === null || !Number.isFinite(event.cost) || event.cost < 0
        ? null : group.cost + event.cost;
      if (event.streamId) {
        const source = group.streams.get(event.streamId);
        group.streams.set(event.streamId, { minimum: Math.min(source?.minimum ?? event.limit.used, event.limit.used),
          maximum: Math.max(source?.maximum ?? event.limit.used, event.limit.used) });
      } else group.anonymousMinimum = Math.min(group.anonymousMinimum ?? event.limit.used, event.limit.used);
      groups.set(window, group);
    }
    for (const [window, group] of groups) {
      group.regressed = group.anonymousMinimum !== null && window.highWater !== null && group.anonymousMinimum < window.highWater;
      for (const [id, source] of group.streams) {
        const highWater = window.streams.get(id);
        // A different client's monotonic reading may lag the global reading.
        // Only a fall within that same source proves an observed correction.
        if (highWater !== undefined && source.minimum < highWater) group.regressed = true;
        window.streams.set(id, Math.max(highWater ?? source.maximum, source.maximum));
      }
    }
    if (unknownWindow || groups.size !== 1) {
      // Without an unambiguous account window, do not pair costs across the
      // interruption. Keep every known high-water mark for later stale reads.
      for (const [window, group] of groups) window.highWater = Math.max(window.highWater ?? group.used, group.used);
      previous = null;
      pendingCost = 0;
      complete = true;
      continue;
    }
    const [window, group] = groups.entries().next().value!;
    const highWater = window.highWater;
    const prior = previous as { at: number; window: WindowState } | null;
    const continuous = prior?.window === window && at - prior.at <= 30 * 60000;
    if (!continuous) {
      pendingCost = 0;
      complete = !group.regressed;
    } else {
      if (group.regressed) complete = false;
      if (group.cost === null) complete = false;
      else pendingCost += group.cost;
      const delta = group.used - highWater!;
      if (delta > 0) {
        if (complete && pendingCost > 0) {
          recent.push({ cost: pendingCost, quota: delta });
          cost += pendingCost; quota += delta; updatedAt = at;
          // Retain whole observations covering the latest 20 percentage points.
          // Never split a rounded quota increment or invent unpriced cost.
          while (recent.length > 1 && quota - recent[0].quota >= 20) {
            const removed = recent.shift()!; cost -= removed.cost; quota -= removed.quota;
          }
        }
        pendingCost = 0;
        complete = true;
      }
    }
    window.highWater = Math.max(highWater ?? group.used, group.used);
    previous = { at, window };
  }
  // Integer quota snapshots are noisy. Avoid extrapolating from a single percentage point.
  return { costPerPercent: quota >= 5 && cost > 0 ? cost / quota : null, quotaPercent: quota, updatedAt };
}

export function equivalent20x(job: HistoryJob, costPerPercent: number | null): number | null {
  if (costPerPercent === null || !Number.isFinite(costPerPercent) || costPerPercent <= 0) return null;
  if (!job.sinceResetUsage) return job.totalUsage ? 0 : null;
  const cost = job.sinceResetEstimatedCostUsd;
  return cost !== null && Number.isFinite(cost) && cost >= 0 ? cost / costPerPercent : null;
}

/** Rollouts do not identify the account: a matching weekly reset is an estimate,
 * not proof of identity. Never assign missing-window records to the current account.
 */
export function currentAccountEquivalent(
  events: QuotaCalibrationEvent[],
  window: { startedAtMs: number; resetsAt: string } | null | undefined,
  now: number,
  costPerPercent: number | null,
  hasUsage: boolean,
  untimedTokens = 0
): { percent: number | null; complete: boolean } {
  const end = Date.parse(window?.resetsAt ?? '');
  if (!window || end <= now || end - window.startedAtMs !== 604800000 ||
      costPerPercent === null || !Number.isFinite(costPerPercent) || costPerPercent <= 0 || !hasUsage) {
    return { percent: null, complete: false };
  }
  // Consolidated parent/child logs and overlapping fragments can repeat samples.
  // Prefer the full log's proven duplicate over a fragment's apparent increment.
  const unique = new Map<string | QuotaCalibrationEvent, QuotaCalibrationEvent>();
  for (const event of events) {
    const key = event.id ?? event;
    if (!unique.get(key)?.duplicateUsage) unique.set(key, event);
  }
  let cost = 0;
  let complete = untimedTokens === 0;
  for (const event of unique.values()) {
    if (event.at < window.startedAtMs || event.at > now || event.at >= end || event.duplicateUsage) continue;
    if (!event.limit) {
      if (event.cost === null || event.cost > 0) complete = false;
      continue;
    }
    if (Math.abs(event.limit.resetsAt - end) > 60000) continue;
    if (event.cost === null || !Number.isFinite(event.cost) || event.cost < 0) complete = false;
    else cost += event.cost;
  }
  return { percent: cost > 0 || complete ? cost / costPerPercent : null, complete };
}
