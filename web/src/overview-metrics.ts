import type { HistoryJob, TokenUsage } from '../../shared/monitor';

export interface OverviewMetric {
  value: number | null;
  complete: boolean;
}

const validAmount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

function combine(values: OverviewMetric[]): OverviewMetric {
  const known = values.flatMap(metric => metric.value === null ? [] : [metric.value]);
  return {
    value: known.length ? known.reduce((sum, value) => sum + value, 0) : null,
    complete: values.length > 0 && values.every(metric => metric.value !== null && metric.complete)
  };
}

/** Only explicitly scoped records belong in an overview of the selected period. */
export function summarizeOverviewUsage(jobs: HistoryJob[]) {
  const amount = (value: unknown, complete: boolean): OverviewMetric => ({ value: validAmount(value) ? value : null, complete });
  const tokenMetric = (job: HistoryJob, key: keyof TokenUsage): OverviewMetric => {
    const period = job.periodMetrics;
    const value = period?.usage?.[key];
    // Cached input is a subset of input, never an extra term in the token total.
    if (key === 'cachedInputTokens' && (!validAmount(period?.usage?.inputTokens) || !validAmount(value) || value > period.usage.inputTokens)) {
      return { value: null, complete: false };
    }
    return amount(value, period?.tokensComplete === true);
  };
  const tokens = combine(jobs.map(job => tokenMetric(job, 'totalTokens')));
  const cost = combine(jobs.map(job => amount(job.periodMetrics?.costUsd, job.periodMetrics?.costComplete === true)));
  const equivalent = combine(jobs.map(job => amount(job.periodMetrics ? job.estimated20xPercent : null, job.estimated20xIsComplete === true)));
  let consumedTaskCount = 0;
  let unknownTaskCount = 0;
  for (const job of jobs) {
    const period = job.periodMetrics;
    const positive = [period?.usage?.totalTokens, period?.usage?.inputTokens, period?.usage?.outputTokens, period?.costUsd,
      period ? job.estimated20xPercent : null].some(value => validAmount(value) && value > 0);
    if (positive) consumedTaskCount += 1;
    else if (!period?.tokensComplete || !validAmount(period.usage?.totalTokens)) unknownTaskCount += 1;
  }
  return {
    consumedTaskCount,
    // These tasks cannot yet be classified as zero-consumption or consuming.
    unknownTaskCount,
    totals: {
      tokens: tokens.value, tokensComplete: tokens.complete,
      cost: cost.value, costComplete: cost.complete,
      equivalent: equivalent.value, equivalentComplete: equivalent.complete
    },
    tokenBreakdown: {
      input: combine(jobs.map(job => tokenMetric(job, 'inputTokens'))),
      output: combine(jobs.map(job => tokenMetric(job, 'outputTokens'))),
      cachedInput: combine(jobs.map(job => tokenMetric(job, 'cachedInputTokens')))
    }
  };
}
