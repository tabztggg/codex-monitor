import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HistoryAnalysis, HistoryJob, HistoryModelUsage, HistoryUsageDay } from '../../../shared/monitor';
import { ModelAnalytics } from '../../../web/src/components/ModelAnalytics';
import { TaskInsights } from '../../../web/src/components/TaskInsights';
import { createI18n, type Language } from '../../../web/src/localization';

const state = vi.hoisted(() => ({ language: 'en' as Language }));
vi.mock('../../../web/src/LanguageContext', () => ({ useI18n: () => createI18n(state.language) }));
const model = (name: string | null, input: number, cached: number, cost: number | null): HistoryModelUsage => ({
  model: name, usage: { inputTokens: input, cachedInputTokens: cached, outputTokens: 10, reasoningOutputTokens: 5, totalTokens: input + 10 },
  costUsd: cost, unpricedTokens: cost === null ? input + 10 : 0, taskCount: 1, tokensComplete: true, costComplete: cost !== null
});
const small = model('model-a', 100, 100, 1);
const large = model(null, 900, 0, null);
const day = (date: string, models: HistoryModelUsage[]): HistoryUsageDay => ({ date, models,
  usage: { inputTokens: models.reduce((n, row) => n + row.usage.inputTokens, 0), cachedInputTokens: models.reduce((n, row) => n + row.usage.cachedInputTokens, 0), outputTokens: 10 * models.length, reasoningOutputTokens: 5 * models.length, totalTokens: models.reduce((n, row) => n + row.usage.totalTokens, 0) },
  costUsd: models.some(row => row.costUsd !== null) ? models.reduce((n, row) => n + (row.costUsd ?? 0), 0) : null,
  unpricedTokens: models.reduce((n, row) => n + row.unpricedTokens, 0)
});
const analysis: HistoryAnalysis = { period: '7d', startedAt: '2026-09-22T00:00:00Z', endedAt: '2026-09-28T15:00:00Z', timeZone: 'Asia/Hong_Kong',
  models: [small, large], days: [day('2026-09-27', [large]), day('2026-09-28', [small])], unpricedTokens: 910, untimedTokens: 0,
  pricing: { currency: 'USD', unit: 'perMillionTokens', verifiedAt: '2026-09-28', sourceUrl: 'https://openai.com/api/pricing/',
    models: [{ model: 'model-a', input: 2, cachedInput: 0.2, cacheWriteInput: 2, output: 8 }, { model: 'model-b', input: 1, cachedInput: 0.1, cacheWriteInput: 1.25, output: 4, verifiedAt: '2026-09-26' }], highContext: { inputTokensThreshold: 272000, inputMultiplier: 2, outputMultiplier: 1.5 }, note: '' }
};
const job: HistoryJob = { id: 'task a', name: 'Daily task', archived: false, sourceKind: 'exec', preview: null, project: null, createdAt: null, updatedAt: analysis.endedAt, cwd: null, modelProvider: null,
  runCount: 1, lastRunStartedAt: null, lastRunCompletedAt: null, lastRunDurationMs: null, totalDurationMs: 0, lastRunUsage: null, totalUsage: large.usage, totalEstimatedCostUsd: 999,
  totalEstimatedCostIsComplete: true, last24HoursUsage: null, last24HoursEstimatedCostUsd: null, sinceResetUsage: null, sinceResetEstimatedCostUsd: null, estimatedUsagePercentSinceReset: null,
  periodMetrics: { usage: large.usage, costUsd: 99, tokensComplete: true, costComplete: true, unpricedTokens: 0, untimedTokens: 0, days: [analysis.days[1]] }
};
const render = (data: HistoryAnalysis | null = analysis) => renderToStaticMarkup(createElement(ModelAnalytics, { analysis: data, periodLabel: 'Last 7 days' }));
const renderTrend = (data: HistoryAnalysis = analysis, jobs: HistoryJob[] = [job]) => renderToStaticMarkup(createElement(TaskInsights, { jobs, analysis: data, allocation: null, periodLabel: 'Last 7 days', section: 'trend', expanded: true }));

describe('historical analytics presentation', () => {
  beforeEach(() => { state.language = 'en'; vi.stubGlobal('window', { localStorage: { getItem: () => 'tokens' } }); });
  afterEach(() => vi.unstubAllGlobals());

  it('shows cross-account selected-period model totals, weighted cache rate, accessible sorting and audited pricing', () => {
    const html = render();
    expect(html).toContain('Models in the selected period');
    expect(html).toContain('Across accounts');
    expect(html).toContain('Last 7 days');
    expect(html).toContain('aria-sort="descending"');
    expect(html).toContain('aria-label="Sort by API-equivalent cost"');
    expect(html).toContain('Unknown model');
    expect(html).toContain('Recorded cache hit</dt><dd>10.0%</dd>');
    expect(html).toContain('Total input</dt><dd>1K</dd>');
    expect(html).toContain('Uncached input</dt><dd>900</dd>');
    expect(html).toContain('USD per 1 million tokens');
    expect(html).toContain('dateTime="2026-09-28"');
    expect(html).toContain('https://openai.com/api/pricing/');
    expect(html).toContain('not subscription charges or official quota deductions');
    expect(html).toContain('Priced share of recorded tokens</dt><dd>10.8%</dd>');
    expect(html).toContain('Unpriced models');
    expect(html).toContain('Not recorded');
    expect(html).toContain('<time dateTime="2026-09-26">2026-09-26</time>');
    expect(html).toContain('Rates used for estimates');
    expect(html).not.toContain('Official lifetime usage');
  });

  it('keeps missing model data distinct from an empty period and shows partial cost as a lower bound', () => {
    expect(render(null)).toContain('Model usage is unavailable. -- does not mean zero usage.');
    expect(render(null)).toContain('Price basis is unavailable.');
    expect(render({ ...analysis, models: [] })).toContain('No model usage records in this period.');
    const html = render({ ...analysis, models: [{ ...small, tokensComplete: false, costComplete: false }] });
    expect(html).toContain('$1.00+');
    expect(html).toContain('100+');
    expect(html).toContain('Missing records may change this rate');
  });

  it('renders model stacks and an explicitly dated drilldown using day totals rather than lifetime totals', () => {
    const html = renderTrend();
    expect(html).toContain('model-trend-stack');
    expect(html.match(/class="model-trend-segment"/g)).toHaveLength(2);
    expect(html).toContain('aria-label="Model legend"');
    expect(html).toContain('aria-label="2026-09-28: 110"');
    expect(html).toContain('Usage on 2026-09-28');
    expect(html).toMatch(/<details class="day-usage-details" id="[^"]+"><summary>Usage on 2026-09-28<\/summary>/);
    expect(html).toContain('Models on 2026-09-28');
    expect(html).toContain('Tasks on 2026-09-28');
    expect(html).toContain('/tasks?task=task%20a&amp;from=2026-09-28&amp;to=2026-09-28');
    const tasks = html.slice(html.indexOf('class="day-task-list"'));
    expect(tasks).toContain('<td>100</td><td>10</td><td>110</td>');
    expect(tasks).toContain('$1.00');
    expect(tasks).not.toContain('$999.00');
    expect(html).toContain('Rankings use the full selected scope');
  });

  it('preserves unpriced and undated states and uses a percentage axis for cache efficiency', () => {
    vi.stubGlobal('window', { localStorage: { getItem: () => 'cost' } });
    const costs = renderTrend({ ...analysis, untimedTokens: 5 });
    expect(costs).toContain('class="trend-missing">--');
    expect(costs).toContain('$1.00+');
    expect(costs).toContain('Some records have no date');
    vi.stubGlobal('window', { localStorage: { getItem: () => 'cacheHit' } });
    const cache = renderTrend();
    expect(cache).toContain('Daily cache hit uses cached input / total input');
    expect(cache).toContain('height:100%');
    expect(cache).not.toContain('model-trend-stack');
    expect(cache).toContain('2026-09-28: 100.0%');
  });

  it('labels unavailable day-level task/model details and renders all new controls in Chinese', () => {
    expect(renderTrend({ ...analysis, days: [{ ...analysis.days[1], models: undefined }] }, [{ ...job, periodMetrics: undefined }])).toContain('Daily task details are unavailable for some records.');
    state.language = 'zh';
    const html = render() + renderTrend();
    for (const text of ['模型用量对比', '跨账号', '历史缓存效率', '模型价格依据', '按总 Token 数排序', '当日任务', '当日模型用量', '模型图例', '缓存命中率']) expect(html).toContain(text);
    expect(html).not.toContain('Model comparison');
    expect(html).not.toContain('Sort by');
  });
});
