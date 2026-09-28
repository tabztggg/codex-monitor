import { describe, expect, it } from 'vitest';
import type { HistoryJob, HistoryModelUsage, HistoryUsageDay, TokenUsage } from '../../../shared/monitor';
import { historicalCacheHit, modelColor, modelTrendSegments, sortModelUsage, summarizeModelCache, summarizeModelCoverage, tasksForUsageDay } from '../../../web/src/model-analytics';

const usage = (inputTokens: number, cachedInputTokens = 0, outputTokens = 0): TokenUsage => ({ inputTokens, cachedInputTokens, outputTokens, totalTokens: inputTokens + outputTokens, reasoningOutputTokens: 0 });
const model = (name: string | null, input = 100, cached = 50, cost: number | null = 1): HistoryModelUsage => ({
  model: name, usage: usage(input, cached, 10), costUsd: cost, unpricedTokens: cost === null ? input + 10 : 0, taskCount: 1, tokensComplete: true, costComplete: cost !== null
});
const day = (date: string, input: number, cost: number | null = 1): HistoryUsageDay => ({ date, usage: usage(input, input / 2, 10), costUsd: cost, unpricedTokens: cost === null ? input + 10 : 0 });
const job = (id: string, days: HistoryUsageDay[], overrides: Partial<NonNullable<HistoryJob['periodMetrics']>> = {}): HistoryJob => ({
  id, totalUsage: usage(99999), totalEstimatedCostUsd: 999, periodMetrics: { days, usage: usage(88888), costUsd: 888, tokensComplete: true, costComplete: true, unpricedTokens: 0, untimedTokens: 0, ...overrides }
} as HistoryJob);

describe('historical model analytics', () => {
  it('weights cache hit by total input and never counts cached input twice', () => {
    const summary = summarizeModelCache([model('a', 100, 100), model('b', 900, 0)]);
    expect(summary).toEqual({ input: 1000, cached: 100, uncached: 900, hit: 10, complete: true });
    expect(summarizeModelCache([{ ...model('a'), tokensComplete: false }]).complete).toBe(false);
  });

  it('keeps absent, zero-input and malformed ratios unknown instead of displaying a fabricated zero', () => {
    for (const value of [undefined, null, usage(0), usage(-1), usage(100, 101), usage(100, -1), usage(Infinity), usage(100, NaN)]) expect(historicalCacheHit(value)).toBeNull();
    expect(historicalCacheHit(usage(100, 0))).toBe(0);
    expect(summarizeModelCache([]).hit).toBeNull();
    expect(summarizeModelCache([model('a', 100, 101)]).input).toBeNull();
  });

  it('sorts each metric without mutation and puts missing values last in either direction', () => {
    const rows = [model('z', 100, 80, null), { ...model('a', 900, 90, 3), taskCount: 3 }, model(null, 0, 0, 1)];
    expect(sortModelUsage(rows, 'cost', 'asc').map(row => row.costUsd)).toEqual([1, 3, null]);
    expect(sortModelUsage(rows, 'cost', 'desc').map(row => row.costUsd)).toEqual([3, 1, null]);
    expect(sortModelUsage(rows, 'cacheHit', 'desc').map(row => row.model)).toEqual(['z', 'a', null]);
    expect(sortModelUsage(rows, 'cacheHit', 'asc').map(row => row.model)).toEqual(['a', 'z', null]);
    expect(sortModelUsage(rows, 'model', 'desc').map(row => row.model)).toEqual(['z', 'a', null]);
    for (const key of ['input', 'tokens', 'tasks'] as const) expect(sortModelUsage(rows, key, 'desc')[0].model).toBe('a');
    expect(rows[0].model).toBe('z');
  });

  it('weights pricing coverage by recorded tokens and keeps incomplete or invalid coverage explicit', () => {
    const priced = model('priced', 100, 50, 1);
    const unpriced = model('unpriced', 900, 0, null);
    const coverage = summarizeModelCoverage([priced, { ...unpriced, tokensComplete: false }]);
    expect(coverage).toEqual({ total: 1020, priced: 110, unpriced: 910, percent: 110 / 1020 * 100, complete: false, unpricedModels: ['unpriced'] });
    expect(summarizeModelCoverage(undefined).percent).toBeNull();
    expect(summarizeModelCoverage([{ ...priced, unpricedTokens: 111 }]).percent).toBeNull();
  });

  it('drills down into only the selected day and sorts on that day rather than lifetime totals', () => {
    const first = job('first', [day('2026-09-27', 900), day('2026-09-28', 10)]);
    const second = job('second', [day('2026-09-28', 100, null)]);
    const undated = job('untimed', [], { untimedTokens: 50 });
    const result = tasksForUsageDay([first, second, undated], '2026-09-28');
    expect(result.map(row => row.job.id)).toEqual(['second', 'first']);
    expect(result.map(row => row.day.usage.totalTokens)).toEqual([110, 20]);
    expect(result.map(row => row.costComplete)).toEqual([false, true]);
    expect(tasksForUsageDay([first], '2026-09-27')[0].day.usage.totalTokens).toBe(910);
    expect(tasksForUsageDay([first], '2026-09-26')).toEqual([]);
    expect(tasksForUsageDay([job('partial', [day('2026-09-28', 5)], { untimedTokens: 1 })], '2026-09-28')[0].tokensComplete).toBe(false);
  });

  it('keeps unknown-model tokens in stacks but omits unavailable costs', () => {
    const data = { ...day('2026-09-28', 300), models: [model('b'), model(null, 100, 10, null), model('a')] };
    expect(modelTrendSegments(data, 'tokens').map(row => row.model)).toEqual(['a', 'b', null]);
    expect(modelTrendSegments(data, 'cost').map(row => row.model)).toEqual(['a', 'b']);
    expect(modelTrendSegments({ ...data, models: undefined }, 'cost')).toEqual([]);
    expect(modelColor(null)).toBe('var(--muted)');
    expect(modelColor('a')).toBe(modelColor('a'));
    expect(new Set(['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna'].map(modelColor)).size).toBe(3);
  });
});
