import type { HistoryJob } from '../../shared/monitor';

export function formatUsagePercent(value: number | null, locale: string): string {
  if (value === null || !Number.isFinite(value)) return '--';
  const digits = value > 0 && value < 0.1 ? 2 : 1;
  return `${new Intl.NumberFormat(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value)}%`;
}
export function formatEstimatedCost(value: number | null, complete = true, locale = 'en-US'): string {
  if (value === null || !Number.isFinite(value)) return '--';
  const digits = value < 0.01 ? 3 : 2;
  return new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value) + (complete ? '' : '+');
}
export function formatTokenCount(value: number | null, locale: string, complete = true): string {
  if (value === null || !Number.isFinite(value)) return '--';
  return new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(value) + (complete ? '' : '+');
}
export function summarizeTasks(jobs: HistoryJob[]) {
  const sum = (values: (number | null | undefined)[]) => {
    const known = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    return known.length ? known.reduce((a, b) => a + b, 0) : null;
  };
  return {
    cost: sum(jobs.map(j => j.totalEstimatedCostUsd)), costComplete: jobs.every(j => j.totalEstimatedCostUsd != null && j.totalEstimatedCostIsComplete),
    tokens: sum(jobs.map(j => j.totalUsage?.totalTokens)), tokensComplete: jobs.every(j => j.totalUsage != null && j.periodMetrics?.tokensComplete !== false),
    equivalent: sum(jobs.map(j => j.estimated20xPercent)), equivalentComplete: jobs.every(j => j.estimated20xPercent != null && j.estimated20xIsComplete)
  };
}
