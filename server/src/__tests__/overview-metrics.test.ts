import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { HistoryJob, HistoryPeriodMetrics, TokenUsage } from '../../../shared/monitor';
import { summarizeOverviewUsage } from '../../../web/src/overview-metrics';
import { TaskInsights } from '../../../web/src/components/TaskInsights';

const usage = (inputTokens: number, outputTokens: number, cachedInputTokens = 0): TokenUsage => ({
  inputTokens, outputTokens, cachedInputTokens, reasoningOutputTokens: 0, totalTokens: inputTokens + outputTokens
});
const job = (periodMetrics?: Partial<HistoryPeriodMetrics>, extra: Partial<HistoryJob> = {}): HistoryJob => ({
  id: 'task', totalUsage: usage(90000, 10000, 60000), totalEstimatedCostUsd: 100,
  totalEstimatedCostIsComplete: true, estimated20xPercent: 2, estimated20xIsComplete: true,
  ...(periodMetrics ? { periodMetrics: { usage: usage(80, 20, 60), costUsd: 1, costComplete: true, tokensComplete: true, unpricedTokens: 0, untimedTokens: 0, ...periodMetrics } } : {}),
  ...extra
} as HistoryJob);

describe('overview selected-period metrics', () => {
  it('counts only tasks with recorded consumption in the selected period, not lifetime or included tasks', () => {
    const summary = summarizeOverviewUsage([
      job({}), job({ usage: usage(0, 0), costUsd: 0 }, { id: 'zero', estimated20xPercent: 0 }),
      job(undefined, { id: 'lifetime-only' }),
      job({ usage: usage(20, 0), costUsd: null, costComplete: false }, { id: 'unpriced', estimated20xPercent: null })
    ]);
    expect(summary.consumedTaskCount).toBe(2);
    expect(summary.unknownTaskCount).toBe(1);
    expect(summary.totals.tokens).toBe(120);
    expect(summary.totals.cost).toBe(1);
    expect(summary.totals.equivalent).toBe(2);
    expect(summary.totals.tokensComplete).toBe(false);
  });

  it('keeps cached input inside input and never adds it to the total', () => {
    const summary = summarizeOverviewUsage([job({})]);
    expect(summary.tokenBreakdown).toEqual({
      input: { value: 80, complete: true }, output: { value: 20, complete: true }, cachedInput: { value: 60, complete: true }
    });
    expect(summary.totals.tokens).toBe(100);
    expect(summary.consumedTaskCount).toBe(1);
  });

  it('preserves missing values instead of pretending they are zero or falling back to lifetime', () => {
    for (const jobs of [[], [job()], [job({ usage: null, costUsd: null, costComplete: false, tokensComplete: false }, { estimated20xPercent: null })]]) {
      const summary = summarizeOverviewUsage(jobs);
      expect(summary.totals).toEqual({ tokens: null, tokensComplete: false, cost: null, costComplete: false, equivalent: null, equivalentComplete: false });
      expect(summary.tokenBreakdown.input).toEqual({ value: null, complete: false });
      expect(summary.tokenBreakdown.output).toEqual({ value: null, complete: false });
      expect(summary.tokenBreakdown.cachedInput).toEqual({ value: null, complete: false });
      expect(summary.consumedTaskCount).toBe(0);
    }
  });

  it('distinguishes recorded zero usage from missing or incomplete usage', () => {
    const summary = summarizeOverviewUsage([job({ usage: usage(0, 0), costUsd: 0 }, { estimated20xPercent: 0 })]);
    expect(summary.totals).toEqual({ tokens: 0, tokensComplete: true, cost: 0, costComplete: true, equivalent: 0, equivalentComplete: true });
    expect(summary.tokenBreakdown.cachedInput).toEqual({ value: 0, complete: true });
    expect(summary.consumedTaskCount).toBe(0);
    expect(summary.unknownTaskCount).toBe(0);
    expect(summarizeOverviewUsage([job({ usage: usage(0, 0), costUsd: 0, tokensComplete: false }, { estimated20xPercent: 0 })]).unknownTaskCount).toBe(1);
  });

  it('marks token components partial and does not invalidate complete token data just because prices are missing', () => {
    const partial = summarizeOverviewUsage([job({}), job({ usage: usage(8, 2, 6), tokensComplete: false, untimedTokens: 10 })]);
    expect(partial.totals.tokens).toBe(110);
    expect(partial.tokenBreakdown.input).toEqual({ value: 88, complete: false });
    expect(partial.tokenBreakdown.cachedInput).toEqual({ value: 66, complete: false });
    const unpriced = summarizeOverviewUsage([job({ costUsd: null, costComplete: false, unpricedTokens: 100 }, { estimated20xPercent: null })]);
    expect(unpriced.tokenBreakdown.input.complete).toBe(true);
    expect(unpriced.totals.cost).toBeNull();
  });

  it('rejects invalid token components without manufacturing a cache ratio or losing valid components', () => {
    const summary = summarizeOverviewUsage([job({ usage: { ...usage(80, 20, 90), outputTokens: Number.NaN } })]);
    expect(summary.tokenBreakdown.input).toEqual({ value: 80, complete: true });
    expect(summary.tokenBreakdown.output).toEqual({ value: null, complete: false });
    expect(summary.tokenBreakdown.cachedInput).toEqual({ value: null, complete: false });
  });

  it('renders unavailable and partial values distinctly and allows the parent to own calibration details', () => {
    const render = (jobs: HistoryJob[]) => renderToStaticMarkup(createElement(TaskInsights, {
      jobs, analysis: null, allocation: null, periodLabel: 'Today', section: 'summary', hideCalibration: true
    }));
    const missing = render([job()]);
    expect(missing).toContain('-- tasks with recorded usage');
    expect(missing).not.toContain('100K');
    const partial = render([job({ tokensComplete: false })]);
    expect(partial).toContain('1 tasks with recorded usage');
    expect(partial).toContain('<strong>100+</strong>');
    expect(partial).toContain('<dt>Input</dt><dd>80+</dd>');
    expect(partial).toContain('<dt>Output</dt><dd>20+</dd>');
    expect(partial).toContain('<dt>Cached within input</dt><dd>60+</dd>');
    expect(partial).not.toContain('calibration-strip');
  });
});
