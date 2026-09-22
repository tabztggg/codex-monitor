import type { HistoryJob } from '../../shared/monitor';

// Only numeric usage metadata is retained, never authentication data or transcript text.
export interface QuotaCalibrationEvent {
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
  let previous: QuotaCalibrationEvent | null = null;
  let pendingCost = 0;
  let complete = true;
  let cost = 0;
  let quota = 0;
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
        if (complete && pendingCost > 0) { cost += pendingCost; quota += delta; }
        pendingCost = 0;
        complete = true;
      }
    }
    previous = sameWindow ? { ...event, limit: {
      ...event.limit!, used: Math.max(prior!.limit!.used, event.limit!.used)
    } } : event;
  }
  // Integer quota snapshots are noisy. Avoid extrapolating from a single percentage point.
  return { costPerPercent: quota >= 5 && cost > 0 ? cost / quota : null, quotaPercent: quota };
}

export function equivalent20x(job: HistoryJob, costPerPercent: number | null): number | null {
  if (costPerPercent === null || !Number.isFinite(costPerPercent) || costPerPercent <= 0) return null;
  if (!job.sinceResetUsage) return job.totalUsage ? 0 : null;
  const cost = job.sinceResetEstimatedCostUsd;
  return cost !== null && Number.isFinite(cost) && cost >= 0 ? cost / costPerPercent : null;
}
