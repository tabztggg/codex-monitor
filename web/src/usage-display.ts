import type { HistoryJob } from '../../shared/monitor';

export const comparisonPlans = { 'pro20x': { label: 'Pro 20x', multiplier: 1 }, 'pro5x': { label: 'Pro 5x', multiplier: 4 }, 'plus': { label: 'Plus', multiplier: 20 } } as const;
export type ComparisonPlan = keyof typeof comparisonPlans;
export function isComparisonPlan(value: unknown): value is ComparisonPlan {
  return typeof value === 'string' && Object.hasOwn(comparisonPlans, value);
}
// Compare against a nominal weekly allowance; never alter the source calibration.
export function comparePlanUsage(value: number | null | undefined, plan: ComparisonPlan): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  const result = value * comparisonPlans[plan].multiplier;
  return Number.isFinite(result) ? result : null;
}

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
