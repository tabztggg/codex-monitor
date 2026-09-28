import type { HistoryJob, HistoryModelUsage, HistoryUsageDay, TokenUsage } from '../../shared/monitor';

export type ModelSortKey = 'model' | 'input' | 'output' | 'tokens' | 'cacheHit' | 'tasks' | 'cost';
export type ModelSortDirection = 'asc' | 'desc';

/** Cached input is already included in input; ratios are undefined for zero input. */
export function historicalCacheHit(usage: Pick<TokenUsage, 'inputTokens' | 'cachedInputTokens'> | null | undefined): number | null {
  if (!usage || !Number.isFinite(usage.inputTokens) || usage.inputTokens <= 0
    || !Number.isFinite(usage.cachedInputTokens) || usage.cachedInputTokens < 0 || usage.cachedInputTokens > usage.inputTokens) return null;
  return usage.cachedInputTokens / usage.inputTokens * 100;
}

export function summarizeModelCache(models: HistoryModelUsage[] | undefined) {
  if (!models?.length) return { input: null, cached: null, uncached: null, hit: null, complete: false };
  const input = models.reduce((sum, row) => sum + row.usage.inputTokens, 0);
  const cached = models.reduce((sum, row) => sum + row.usage.cachedInputTokens, 0);
  const valid = models.every(row => Number.isFinite(row.usage.inputTokens) && row.usage.inputTokens >= 0
    && Number.isFinite(row.usage.cachedInputTokens) && row.usage.cachedInputTokens >= 0 && row.usage.cachedInputTokens <= row.usage.inputTokens);
  return { input: valid ? input : null, cached: valid ? cached : null, uncached: valid ? input - cached : null,
    hit: valid ? historicalCacheHit({ inputTokens: input, cachedInputTokens: cached }) : null,
    complete: valid && models.every(row => row.tokensComplete) };
}

export function summarizeModelCoverage(models: HistoryModelUsage[] | undefined) {
  if (!models?.length) return { total: null, priced: null, unpriced: null, percent: null, complete: false, unpricedModels: [] as (string | null)[] };
  const total = models.reduce((sum, row) => sum + row.usage.totalTokens, 0);
  const unpriced = models.reduce((sum, row) => sum + row.unpricedTokens, 0);
  const valid = models.every(row => Number.isFinite(row.usage.totalTokens) && row.usage.totalTokens >= 0
    && Number.isFinite(row.unpricedTokens) && row.unpricedTokens >= 0 && row.unpricedTokens <= row.usage.totalTokens);
  return { total: valid ? total : null, priced: valid ? total - unpriced : null, unpriced: valid ? unpriced : null,
    percent: valid && total > 0 ? (total - unpriced) / total * 100 : null,
    complete: valid && models.every(row => row.tokensComplete),
    unpricedModels: models.filter(row => row.unpricedTokens > 0).map(row => row.model) };
}

export function sortModelUsage(models: HistoryModelUsage[], key: ModelSortKey, direction: ModelSortDirection): HistoryModelUsage[] {
  const value = (row: HistoryModelUsage): string | number | null => key === 'model' ? row.model
    : key === 'cacheHit' ? historicalCacheHit(row.usage) : key === 'cost' ? row.costUsd
      : key === 'tasks' ? row.taskCount : key === 'input' ? row.usage.inputTokens : key === 'output' ? row.usage.outputTokens : row.usage.totalTokens;
  return [...models].sort((a, b) => {
    const left = value(a), right = value(b);
    const missingLeft = left === null || typeof left === 'number' && !Number.isFinite(left);
    const missingRight = right === null || typeof right === 'number' && !Number.isFinite(right);
    if (missingLeft !== missingRight) return missingLeft ? 1 : -1;
    const order = missingLeft || missingRight ? 0 : typeof left === 'string' && typeof right === 'string'
      ? left.localeCompare(right) : Number(left) - Number(right);
    return order * (direction === 'asc' ? 1 : -1) || (a.model ?? '\uffff').localeCompare(b.model ?? '\uffff');
  });
}

/** Use only the selected day's incremental records, never the task's lifetime totals. */
export function tasksForUsageDay(jobs: HistoryJob[], date: string): { job: HistoryJob; day: HistoryUsageDay; tokensComplete: boolean; costComplete: boolean }[] {
  return jobs.flatMap(job => {
    const day = job.periodMetrics?.days?.find(day => day.date === date);
    if (!day || day.usage.totalTokens <= 0) return [];
    const tokensComplete = job.periodMetrics?.tokensComplete === true && job.periodMetrics.untimedTokens === 0;
    return [{ job, day, tokensComplete, costComplete: tokensComplete && day.unpricedTokens === 0 && day.costUsd !== null }];
  }).sort((a, b) => b.day.usage.totalTokens - a.day.usage.totalTokens || a.job.id.localeCompare(b.job.id));
}

/** A stable identity-to-color mapping keeps a model's color across ranges and sorting. */
export function modelColor(model: string | null): string {
  if (model === null) return 'var(--muted)';
  const family = model.match(/(?:^|-)(astra|sol|luna|terra)(?:-|$)/)?.[1];
  if (family) return { astra: 'var(--accent-blue)', sol: 'var(--good)', luna: 'var(--warn)', terra: '#9c7be3' }[family]!;
  let hash = 0;
  for (const char of model) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return ['var(--accent-blue)', 'var(--good)', 'var(--warn)', '#9c7be3', '#d46f99', 'var(--neutral)', '#48a8b5'][Math.abs(hash) % 7];
}

export function modelTrendSegments(day: HistoryUsageDay, metric: 'tokens' | 'cost') {
  return [...(day.models ?? [])].sort((a, b) => (a.model ?? '\uffff').localeCompare(b.model ?? '\uffff'))
    .map(row => ({ model: row.model, value: metric === 'tokens' ? row.usage.totalTokens : row.costUsd }))
    .filter((row): row is { model: string | null; value: number } => row.value !== null && Number.isFinite(row.value) && row.value > 0);
}
