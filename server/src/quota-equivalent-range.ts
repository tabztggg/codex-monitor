import type { QuotaCalibrationEvent } from './quota-equivalent';
import type { QuotaAllocationSlice } from './quota-reconciliation';

/** Use observed, independently replayed account increments before extrapolating
 * uncovered priced usage. A response is counted by exactly one route. */
export function quotaEquivalentRange(
  events: QuotaCalibrationEvent[], slices: QuotaAllocationSlice[], coveredIds: Set<string>,
  costPerPercent: number | null, start: number | null, end: number, complete: boolean
) {
  let percent = 0;
  let known = false;
  let isComplete = complete;
  for (const slice of slices) if ((start === null || slice.at >= start) && slice.at <= end) {
    percent += slice.percent;
    known = true;
    if (slice.estimated) isComplete = false;
  }
  const unique = new Map<string | QuotaCalibrationEvent, QuotaCalibrationEvent>();
  for (const e of events) {
    if ((start !== null && e.at < start) || e.at > end) continue;
    const key = e.id ?? e;
    if (!unique.get(key)?.duplicateUsage) unique.set(key, e);
  }
  for (const e of unique.values()) {
    if (e.duplicateUsage) { known = true; continue; }
    if (e.id && coveredIds.has(e.id)) continue;
    if (e.cost === 0 || e.cost === null && e.tokens === 0) { known = true; continue; }
    // The missing quota observation is visible even when its token cost can
    // supply a fallback estimate. This is never official per-task telemetry.
    isComplete = false;
    if (e.cost !== null && Number.isFinite(e.cost) && e.cost > 0 && costPerPercent !== null && costPerPercent > 0) {
      percent += e.cost / costPerPercent;
      known = true;
    }
  }
  return { percent: known ? percent : null, complete: isComplete && known };
}
