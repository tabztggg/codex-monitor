import type { HistoryJob } from '../../shared/monitor';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

type SavedCalibration = { version: 1; costPerPercent: number; quotaPercent: number; windowStart: number; updatedAt: number };
const SAMPLE_RETENTION_MS = 30 * 86400000;
const SAVE_INTERVAL_MS = 30000;
// v3 records use content identities and per-stream quota observations. Old
// sample keys cannot safely coexist with them; retain only the old reference.
const SAMPLE_VERSION = 3;

/** Keep the last usable reference across resets, reduced archive scopes and restarts. */
export class QuotaCalibration {
  private saved: SavedCalibration | null = null;
  private readonly samples = new Map<string, QuotaCalibrationEvent>();
  private referenceSamplesKnown = false;
  private dirty = false;
  private referenceDirty = false;
  private saveFailed = false;
  private nextSaveAt = 0;
  constructor(private readonly file?: string) {
    if (file && existsSync(file)) {
      try {
        const value = JSON.parse(readFileSync(file, 'utf8'));
        if (value?.version !== 1 || !Number.isFinite(value.costPerPercent) || value.costPerPercent <= 0 ||
            !Number.isFinite(value.quotaPercent) || value.quotaPercent < 5 ||
            !validTimestamp(value.windowStart) || !validTimestamp(value.updatedAt) || value.updatedAt < value.windowStart) throw new Error('Invalid calibration');
        this.saved = { version: 1, costPerPercent: value.costPerPercent, quotaPercent: value.quotaPercent,
          windowStart: value.windowStart, updatedAt: value.updatedAt };
        // Version 1 files without samples remain valid references. Do not replace
        // them from a potentially narrower selection until fresh samples qualify.
        if (value.sampleVersion === SAMPLE_VERSION && Array.isArray(value.samples) && value.samples.every(validSample)) {
          for (const event of value.samples) this.samples.set(sampleKey(event), event);
          this.referenceSamplesKnown = value.referenceSamplesKnown === true;
        }
      } catch (error) { console.warn('Saved quota calibration unavailable:', String(error)); }
    }
  }

  resolve(events: QuotaCalibrationEvent[], windowStart: number | null, now: number) {
    let samplesChanged = false;
    for (const event of events) {
      if (!validSample(event) || event.at < now - SAMPLE_RETENTION_MS || event.at > now) continue;
      const key = sampleKey(event);
      const previous = this.samples.get(key);
      // A full log can prove unchanged cumulative usage while an overlapping
      // fragment lacks that preceding context. Retain the proven zero cost.
      const sample = previous?.duplicateUsage && !event.duplicateUsage
        ? { ...event, cost: 0, duplicateUsage: true } : event;
      if (!sameSample(previous, sample)) {
        this.samples.set(key, { ...sample, limit: sample.limit ? { ...sample.limit } : null });
        samplesChanged = this.dirty = true;
      }
    }
    for (const [key, event] of this.samples) {
      if (event.at < now - SAMPLE_RETENTION_MS) {
        this.samples.delete(key);
        this.dirty = true;
      }
    }
    const known = [...this.samples.values()];
    const current = windowStart === null ? null : calibrationDetails(known, windowStart, now + 1);
    const candidateStart = Math.max(windowStart ?? now - SAMPLE_RETENTION_MS,
      this.saved && !this.referenceSamplesKnown ? this.saved.updatedAt : -Infinity);
    const candidate = current && candidateStart === windowStart ? current : calibrationDetails(known, candidateStart, now + 1);
    let source: 'current' | 'previous' | 'unavailable' = this.saved ? 'previous' : 'unavailable';
    if (candidate.costPerPercent !== null && candidate.updatedAt !== null &&
        (!this.saved || samplesChanged && candidate.updatedAt >= this.saved.updatedAt)) {
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
    return { costPerPercent: this.saved?.costPerPercent ?? null, quotaPercent: windowStart === null ? 0 : candidate.quotaPercent,
      referenceQuotaPercent: this.saved?.quotaPercent ?? 0, source,
      calibratedAt: this.saved ? new Date(this.saved.updatedAt).toISOString() : null };
  }

  private remember(costPerPercent: number, quotaPercent: number, windowStart: number, updatedAt: number) {
    const next: SavedCalibration = { version: 1, costPerPercent, quotaPercent, windowStart, updatedAt };
    if (JSON.stringify(next) !== JSON.stringify(this.saved)) this.referenceDirty = this.dirty = true;
    this.saved = next;
    this.referenceSamplesKnown = true;
  }

  private persist(now: number) {
    if (!this.file || !this.saved || !this.dirty || now < this.nextSaveAt && (this.saveFailed || !this.referenceDirty)) return;
    this.nextSaveAt = now + SAVE_INTERVAL_MS;
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      writeFileSync(this.file + '.tmp', JSON.stringify({ ...this.saved,
        sampleVersion: SAMPLE_VERSION, samples: [...this.samples.values()], referenceSamplesKnown: this.referenceSamplesKnown }));
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
    (event.duplicateUsage === undefined || typeof event.duplicateUsage === 'boolean') &&
    (!event.duplicateUsage || event.cost === 0) &&
    (event.cost === null || Number.isFinite(event.cost) && event.cost >= 0) &&
    (event.limit === null || event.limit && Number.isFinite(event.limit.used) && event.limit.used >= 0 && event.limit.used <= 100 &&
      validTimestamp(event.limit.resetsAt) && event.at < event.limit.resetsAt && event.at >= event.limit.resetsAt - 604800000));
}

function sampleKey(event: QuotaCalibrationEvent): string {
  return event.id ?? JSON.stringify([event.at, event.limit?.resetsAt ?? null]);
}

function sameSample(left: QuotaCalibrationEvent | undefined, right: QuotaCalibrationEvent): boolean {
  return Boolean(left && left.at === right.at && left.cost === right.cost && left.streamId === right.streamId &&
    Boolean(left.duplicateUsage) === Boolean(right.duplicateUsage) &&
    left.limit?.used === right.limit?.used && left.limit?.resetsAt === right.limit?.resetsAt);
}

// Only usage metadata and opaque sample identities are retained, never authentication data or transcript text.
export interface QuotaCalibrationEvent {
  id?: string;
  streamId?: string;
  duplicateUsage?: boolean;
  at: number;
  cost: number | null;
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
        if (complete && pendingCost > 0) { cost += pendingCost; quota += delta; updatedAt = at; }
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
