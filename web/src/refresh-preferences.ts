import { DEFAULT_HISTORY_INTERVAL_MS } from '../../shared/polling';

export const refreshIntervals = [30_000, 60_000, 120_000, 300_000, 600_000, 1_800_000, 3_600_000];
export const refreshPreferenceKey = 'codex-monitor-refresh-interval-ms-v2';

export function readRefreshInterval(storage: Pick<Storage, 'getItem'>): number {
  try {
    const saved = Number(storage.getItem(refreshPreferenceKey));
    if (refreshIntervals.includes(saved)) return saved;
    // Migrate old high-frequency defaults once. Later explicit choices, including
    // faster refresh, remain under the user's control.
    const legacy = Number(storage.getItem('codex-monitor-refresh-interval-ms'));
    if (refreshIntervals.includes(legacy) && legacy >= DEFAULT_HISTORY_INTERVAL_MS) return legacy;
  } catch { /* Storage is optional. */ }
  return DEFAULT_HISTORY_INTERVAL_MS;
}
