import type { HistoryJob } from '../../shared/monitor';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

type SavedCalibration = { version: 1; costPerPercent: number; quotaPercent: number; windowStart: number; updatedAt: number };
const SAMPLE_RETENTION_MS = 30 * 86400000;
const SAVE_INTERVAL_MS = 30000;

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
        if (Array.isArray(value.samples) && value.samples.every(validSample)) {
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
      if (!sameSample(this.samples.get(key), event)) {
        this.samples.set(key, { ...event, limit: event.limit ? { ...event.limit } : null });
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
        current.updatedAt === this.saved.updatedAt && windowStart === this.saved.windowStart && this.referenceSamplesKnown) {
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
    (event.cost === null || Number.isFinite(event.cost) && event.cost >= 0) &&
    (event.limit === null || event.limit && Number.isFinite(event.limit.used) && event.limit.used >= 0 && event.limit.used <= 100 &&
      validTimestamp(event.limit.resetsAt) && event.at < event.limit.resetsAt && event.at >= event.limit.resetsAt - 604800000));
}

function sampleKey(event: QuotaCalibrationEvent): string {
  return event.id ?? JSON.stringify([event.at, event.limit?.resetsAt ?? null]);
}

function sameSample(left: QuotaCalibrationEvent | undefined, right: QuotaCalibrationEvent): boolean {
  return Boolean(left && left.at === right.at && left.cost === right.cost &&
    left.limit?.used === right.limit?.used && left.limit?.resetsAt === right.limit?.resetsAt);
}

// Only usage metadata and opaque sample identities are retained, never authentication data or transcript text.
export interface QuotaCalibrationEvent {
  id?: string;
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
  let previous: QuotaCalibrationEvent | null = null;
  let pendingCost = 0;
  let complete = true;
  let cost = 0;
  let quota = 0;
  let updatedAt: number | null = null;
  for (const event of events.filter(e => e.at >= start && e.at < end).sort((a, b) => a.at - b.at)) {
    const prior = previous as QuotaCalibrationEvent | null;
    const sameWindow = Boolean(prior?.limit && event.limit &&
      Math.abs(prior.limit.resetsAt - event.limit.resetsAt) <= 60000 &&
      event.at - prior.at <= 30 * 60000);
    if (!sameWindow) {
      pendingCost = 0;
      complete = true;
    } else {
      // Parallel clients can report a stale lower value. Never recount the
      // rebound to a high-water mark already observed in this window.
      if (event.limit!.used < prior!.limit!.used) complete = false;
      if (event.cost === null || !Number.isFinite(event.cost) || event.cost < 0) complete = false;
      else pendingCost += event.cost;
      const delta = event.limit!.used - prior!.limit!.used;
      if (delta > 0) {
        if (complete && pendingCost > 0) { cost += pendingCost; quota += delta; updatedAt = event.at; }
        pendingCost = 0;
        complete = true;
      }
    }
    previous = sameWindow ? { ...event, limit: {
      ...event.limit!, used: Math.max(prior!.limit!.used, event.limit!.used)
    } } : event;
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
