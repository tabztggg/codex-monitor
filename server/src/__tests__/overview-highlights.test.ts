import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { ActiveSession, HistoryAnalysis, HistoryJob } from '../../../shared/monitor';
import { createI18n } from '../../../web/src/localization';
import { latestRecordedActivity, OverviewHighlights, overviewTopTasks } from '../../../web/src/components/OverviewHighlights';
import { OverviewDataQuality } from '../../../web/src/components/OverviewDataQuality';

vi.mock('../../../web/src/LanguageContext', () => ({ useI18n: () => createI18n('en') }));
const job = (id: string, percent: number | null, scoped = true) => ({
  id, name: id, updatedAt: '2026-09-26T12:00:00Z', estimated20xPercent: percent, estimated20xIsComplete: true,
  lifetime20xPercent: 9999,
  ...(scoped ? { periodMetrics: { usage: null, tokensComplete: false, costComplete: false, costUsd: null, unpricedTokens: 0, untimedTokens: 0 } } : {})
} as HistoryJob);

describe('overview highlights and coverage', () => {
  it('ranks positive scoped estimates, never lifetime or unscoped cached values, and preserves values above 100%', () => {
    const jobs = [job('small', 3), job('zero', 0), job('missing', null), job('old-cache', 1000, false), job('large', 150), job('medium', 9), job('fourth', 1)];
    expect(overviewTopTasks(jobs).map(task => task.id)).toEqual(['large', 'medium', 'small']);
    const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(OverviewHighlights, {
      jobs, sessions: [], ready: true, live: true, periodLabel: 'Today', comparisonPlan: 'pro5x', nowMs: Date.parse('2026-09-27T00:00:00Z')
    })));
    expect(html).toContain('600.0%');
    expect(html).toContain('/tasks?task=large');
    expect(html).not.toContain('old-cache');
    expect(html).toContain('Today');
    expect(html).toContain('Across accounts');
  });

  it('keeps current activity independent of the range and uses actual timestamps rather than lexical order', () => {
    const session = { id: 'active', updatedAt: '2026-09-27T01:00:00+08:00' } as ActiveSession;
    const olderDayButLaterInstant = { ...job('recent', 3), updatedAt: '2026-09-26T22:00:00Z' };
    expect(latestRecordedActivity([olderDayButLaterInstant], [session])).toBe(olderDayButLaterInstant.updatedAt);
    expect(latestRecordedActivity([{ ...olderDayButLaterInstant, updatedAt: 'invalid' }], [])).toBeNull();
    const render = (periodLabel: string, jobs: HistoryJob[]) => renderToStaticMarkup(createElement(MemoryRouter, null, createElement(OverviewHighlights, {
      jobs, sessions: [session, session], ready: true, live: true, periodLabel, comparisonPlan: 'pro20x', nowMs: Date.parse('2026-09-27T00:00:00Z')
    })));
    for (const html of [render('Today', []), render('Task lifetime', [job('old', 900)])]) {
      expect(html).toContain('Active tasks</dt><dd>1</dd>');
      expect(html).toContain('independent of the date filter');
    }
  });

  it('does not show an initial disconnected snapshot as zero running tasks', () => {
    const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(OverviewHighlights, {
      jobs: [], sessions: [], ready: false, live: false, periodLabel: 'Today', comparisonPlan: 'pro20x', nowMs: Date.now()
    })));
    expect(html).toContain('Active tasks</dt><dd>--</dd>');
    expect(html).toContain('Waiting for range data');
  });

  it('labels unscoped cached records as partial and keeps coverage details collapsed', () => {
    const analysis: HistoryAnalysis = { period: 'today', startedAt: '2026-09-27T00:00:00Z', endedAt: '2026-09-27T01:00:00Z', timeZone: 'UTC', days: [], unpricedTokens: 0, untimedTokens: 0 };
    const html = renderToStaticMarkup(createElement(OverviewDataQuality, {
      jobs: [{ ...job('legacy', 3, false), totalUsage: { totalTokens: 100 } as HistoryJob['totalUsage'], totalEstimatedCostUsd: 1, totalEstimatedCostIsComplete: true }],
      analysis, archives: { mode: 'recent', included: 30, total: 240 }, allocation: null, updatedAt: null, onShowBasis: () => {}
    }));
    expect(html).toContain('Partial data');
    expect(html).toContain('Archive scope limited');
    expect(html).toContain('Tasks with unknown consumption</dt><dd>1</dd>');
    expect(html).toContain('<details class="overview-data-quality">');
    expect(html).not.toContain('Included records complete');
  });
});
