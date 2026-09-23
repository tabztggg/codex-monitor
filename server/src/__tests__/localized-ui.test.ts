import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HistoryAnalysis, HistoryJob, HistoryUsageAllocation, MonitorSnapshot, ThreadNode, TurnSummary, MonitorItem } from '../../../shared/monitor';
import { createI18n, type Language } from '../../../web/src/localization';
import { DashboardPage, RunDetailPage } from '../../../web/src/App';
import { ThreadTree } from '../../../web/src/components/ThreadTree';
import { TranscriptPanel } from '../../../web/src/components/TranscriptPanel';
import { TurnInspector } from '../../../web/src/components/TurnInspector';
import { HistoryPeriodScope } from '../../../web/src/components/HistoryPanel';
import { TaskInsights } from '../../../web/src/components/TaskInsights';

const testState = vi.hoisted(() => ({ language: 'zh' as Language, loading: false, archiveMode: 'recent' as 'recent' | 'all', error: null as string | null }));
vi.mock('../../../web/src/LanguageContext', () => ({
  useI18n: () => ({ ...createI18n(testState.language), setLanguage: () => {} }),
  LanguageSwitch: () => null
}));
vi.mock('../../../web/src/useTaskHistory', () => ({ useTaskHistory: () => ({ jobs: [job], allocation: null, updatedAt: Date.parse('2026-09-22T00:00:00Z'), error: testState.error, archives: { mode: testState.archiveMode, total: 100, included: testState.archiveMode === 'all' ? 100 : 30 }, loading: testState.loading, requestedMode: testState.loading || testState.error ? 'all' : testState.archiveMode, loadArchives: () => {} }) }));

const job = { id: 'task', name: '用户任务 Original', archived: true, archivedAt: '2026-09-21T00:00:00Z',
  project: { id: 'project', name: '用户项目 Original' }, updatedAt: '2026-09-21T00:00:00Z',
  estimatedUsagePercentSinceReset: 2, totalEstimatedCostUsd: 42, totalEstimatedCostIsComplete: true,
  totalUsage: { totalTokens: 10000, inputTokens: 9000, cachedInputTokens: 0, outputTokens: 1000, reasoningOutputTokens: 0 } } as HistoryJob;
const snapshot = { runs: [], activeSessions: [], threads: {}, turns: {}, items: {}, pendingRequests: {},
  server: { connected: true, initialized: true, lastError: null, stderrTail: [] },
  activeShutdown: { scheduled: false, dryRun: true, executeAt: null },
  globalAutomation: { policy: { enabled: true, settleDelayMs: 30000, shutdownDelaySeconds: 60 }, state: { status: 'armed', shutdownAt: null, settlesAt: null } },
  codexUsage: { status: 'unavailable', limits: [], primaryLimit: null, error: 'Codex did not return rate limit data.' }
} as unknown as MonitorSnapshot;
const thread = { id: 't', name: '原始任务名', runtimeStatus: { bucket: 'waiting_on_human' }, sourceKind: 'appServer', childIds: [], turnIds: ['turn'] } as unknown as ThreadNode;
const turn = { id: 'turn', status: 'completed', startedAt: '2026-09-22T02:00:00Z', itemIds: ['item'], plan: [] } as unknown as TurnSummary;
const item = { id: 'item', type: 'agentMessage', title: 'Agent message', text: 'User input 原始对话文字', toolName: 'custom_tool' } as MonitorItem;

describe('full interface language rendering', () => {
  beforeEach(() => { testState.language = 'zh'; testState.loading = false; testState.archiveMode = 'recent'; testState.error = null; });

  it('puts totals before filters and the task table before secondary analysis', () => {
    const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(DashboardPage, { snapshot, nowMs: Date.now(), connectionLabel: 'live' })));
    expect(html.indexOf('class="statistics-controls"')).toBeLessThan(html.indexOf('class="scope-summary"'));
    expect(html.indexOf('class="scope-summary"')).toBeLessThan(html.indexOf('class="task-toolbar"'));
    expect(html.indexOf('class="task-toolbar"')).toBeLessThan(html.indexOf('class="task-table"'));
    expect(html.indexOf('class="task-table"')).toBeLessThan(html.indexOf('class="insights-panel"'));
    expect(html).toContain('等待校准');
    expect(html).toContain('更多操作');
  });

  it('keeps stale quota visible with the original account and timestamp in both languages', () => {
    const quota = { id: 'codex', primary: null, secondary: { label: 'Weekly', usedPercent: 20, remainingPercent: 80, windowDurationMins: 10080, resetsAt: '2026-09-29T00:00:00Z' } };
    const data = { ...snapshot, codexUsage: { status: 'available', stale: true, updatedAt: '2026-09-22T00:00:00Z',
      account: { type: 'chatgpt', email: 'old@example.com', planType: 'pro' }, limits: [quota], primaryLimit: quota } } as MonitorSnapshot;
    for (const language of ['en', 'zh'] as const) {
      testState.language = language;
      const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(DashboardPage, { snapshot: data, nowMs: Date.parse('2026-09-22T01:00:00Z'), connectionLabel: 'live' })));
      expect(html).toContain('80%');
      expect(html).toContain('old@example.com');
      expect(html).toContain(language === 'en' ? 'Last confirmed account' : '上次确认的账号');
      expect(html).toContain(language === 'en' ? 'Retrying automatically.' : '正在自动重试');
    }
  });

  it('uses a neutral pace for small differences and warns beyond five points', () => {
    const duration = 604800000;
    const start = Date.parse('2026-09-21T00:00:00Z');
    const render = (usedPercent: number) => {
      const quota = { id: 'codex', primary: null, secondary: { label: 'Weekly', usedPercent, remainingPercent: 100 - usedPercent, windowDurationMins: 10080, resetsAt: new Date(start + duration).toISOString() } };
      const data = { ...snapshot, codexUsage: { status: 'available', limits: [quota], primaryLimit: quota } } as MonitorSnapshot;
      return renderToStaticMarkup(createElement(MemoryRouter, null, createElement(DashboardPage, { snapshot: data, nowMs: start + duration / 100, connectionLabel: 'live' })));
    };
    expect(render(2)).not.toContain('pace-note fast');
    expect(render(2)).toContain('额度消耗与时间进度基本一致');
    expect(render(8)).toContain('pace-note fast');
  });

  it('shows full-archive loading, retry and scope controls without relabeling the previous results', () => {
    const render = () => renderToStaticMarkup(createElement(MemoryRouter, null, createElement(DashboardPage, { snapshot, nowMs: Date.now(), connectionLabel: 'live' })));
    testState.loading = true;
    const loading = render();
    expect(loading).toContain('aria-busy="true"');
    expect(loading).toContain('正在统计全部归档…完成前保留原有结果');
    expect(loading).toContain('返回最近 30 个归档');
    expect(loading).toContain('用户任务 Original');
    expect(loading).not.toContain('含全部归档任务');
    testState.loading = false;
    testState.error = 'offline';
    expect(render()).toContain('重试统计所有归档');
    expect(render()).toContain('当前仅统计最近 30 个归档任务');
    testState.error = null;
    testState.archiveMode = 'all';
    expect(render()).toContain('当前统计全部 100 个归档任务');
    expect(render()).toContain('仅统计最近 30 个归档');
  });
  it('renders dashboard tables, errors and shutdown safety descriptions in both languages', () => {
    const render = () => renderToStaticMarkup(createElement(MemoryRouter, null, createElement(DashboardPage, { snapshot, nowMs: Date.parse('2026-09-22T02:00:00Z'), connectionLabel: 'live' })));
    const zh = render();
    expect(zh).toContain('Codex 总体用量');
    expect(zh).toContain('用量所属账号');
    expect(zh).toContain('账号未知');
    expect(zh).toContain('Monitor 使用的 Codex CLI 登录账号');
    expect(zh).toContain('估算额度占比');
    expect(zh).toContain('已归档');
    expect(zh).toContain('1万');
    expect(zh).toContain('倒计时不会让这台电脑真正关机');
    expect(zh).toContain('Codex 未返回额度限制数据');
    expect(zh).toContain('aria-pressed="false">按项目分组');
    expect(zh).not.toContain('class="project-group-row"');
    expect(zh).toContain('用户项目 Original'); // The separate project ranking is available even with table grouping off.
    expect(zh).toContain('统计所有归档');
    expect(zh).toContain('当前仅统计最近 30 个归档任务。');
    expect(zh.match(/class="table-sort-button"/g)).toHaveLength(7);
    expect(zh).toContain('20x 等效消耗');
    expect(zh).toContain('跨账号 · 本周期');
    expect(zh).toContain('统计时间范围');
    expect(zh).toContain('等效消耗对比套餐');
    expect(zh).toContain('影响等效消耗、估算费用、Token 列');
    expect(zh).toContain('value="pro5x"');
    expect(zh).toContain('value="plus"');
    expect(zh).toContain('aria-sort="descending"');
    expect(zh).toContain('按任务排序：升序');
    expect(zh).toContain('value="usage:desc" selected');
    testState.language = 'en';
    const en = render();
    expect(en).toContain('Overall Codex usage');
    expect(en).toContain('Approx. quota %');
    expect(en).toContain('20x equivalent usage');
    expect(en).toContain('All accounts · Current quota period');
    expect(en).toContain('Equivalent usage comparison');
    expect(en).toContain('Statistics time range');
    expect(en).toContain('Archived');
    expect(en).toContain('10K');
    expect(en).toContain('Countdown will not shut down this computer');
    expect(en).toContain('用户任务 Original');
    expect(en).not.toContain('估算额度占比');
    expect(en).toContain('Calculate all archives');
    expect(en).toContain('aria-pressed="false">Group by project');
    expect(en).not.toContain('class="project-group-row"');
    expect(en).toContain('Statistics include only the 30 most recently archived tasks.');
    expect(en).toContain('Sort Task: Ascending');
    expect(en).toContain('Sort Approx. quota %: Ascending');
  });

  it('localizes the task tree, transcript labels and inspector while preserving original messages', () => {
    const render = () => renderToStaticMarkup(createElement('div', null,
      createElement(ThreadTree, { rootThreadId: 't', threads: { t: thread }, selectedThreadId: 't', onSelect: () => {} }),
      createElement(TranscriptPanel, { thread, turns: { turn }, items: { item } }),
      createElement(TurnInspector, { thread, turn, items: { item }, pendingRequests: [], activeShutdown: snapshot.activeShutdown })));
    const zh = render();
    expect(zh).toContain('任务树'); expect(zh).toContain('等待处理'); expect(zh).toContain('智能体消息');
    expect(zh).toContain('User input 原始对话文字'); expect(zh).toContain('本轮暂无命令输出');
    testState.language = 'en';
    const en = render();
    expect(en).toContain('Thread tree'); expect(en).toContain('Waiting for you'); expect(en).toContain('Agent message');
    expect(en).toContain('User input 原始对话文字'); expect(en).toContain('No command output in this turn yet.');
  });

  it('localizes unavailable run navigation without creating or executing a task', () => {
    const render = () => renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: ['/runs/missing'] },
      createElement(Routes, null, createElement(Route, { path: '/runs/:runId', element: createElement(RunDetailPage, { snapshot }) }))));
    expect(render()).toContain('返回仪表盘');
    testState.language = 'en';
    expect(render()).toContain('Back to dashboard');
  });
});

describe('visible statistics account and period scope', () => {
  const startedAt = '2026-09-23T01:50:54.000Z';
  const endedAt = '2026-09-23T04:18:10.000Z';
  const resetsAt = '2026-09-30T01:50:54.000Z';
  const nowMs = Date.parse(endedAt);
  const analysis: HistoryAnalysis = {
    period: 'quota', startedAt, endedAt, timeZone: 'Asia/Hong_Kong',
    days: [], unpricedTokens: 0, untimedTokens: 0
  };
  // Period bounds exist before quota changes have been attributed to tasks.
  const allocation: HistoryUsageAllocation = {
    status: 'unavailable', windowStartedAt: startedAt, resetsAt,
    usedPercent: 18, limitName: 'Overall Codex', windowLabel: 'Weekly', basis: null
  };
  const renderScope = (periodAnalysis: HistoryAnalysis | null = analysis,
    periodAllocation: HistoryUsageAllocation | null = allocation, time = nowMs) =>
    renderToStaticMarkup(createElement(HistoryPeriodScope, {
      analysis: periodAnalysis, allocation: periodAllocation, nowMs: time
    }));

  beforeEach(() => { testState.language = 'en'; });

  it('labels the equivalent summary as cross-account local records in both languages', () => {
    for (const language of ['en', 'zh'] as const) {
      testState.language = language;
      const html = renderToStaticMarkup(createElement(TaskInsights, {
        jobs: [job], analysis, allocation, periodLabel: 'period', comparisonPlan: 'pro5x', section: 'summary'
      }));
      expect(html).toContain(language === 'en' ? 'Pro 5x equivalent usage · Across accounts' : 'Pro 5x 等效消耗 · 跨账号');
      expect(html).toContain(language === 'en' ? 'Local records' : '本地记录');
    }
  });

  it('shows actual quota start and reset separately from the data cutoff even without attribution', () => {
    for (const language of ['en', 'zh'] as const) {
      testState.language = language;
      const html = renderScope();
      expect(html).toContain(startedAt);
      expect(html).toContain(resetsAt);
      expect(html).toContain(endedAt);
      expect(html).toContain(language === 'en' ? 'Starts' : '开始');
      expect(html).toContain(language === 'en' ? 'Ends / resets' : '结束／重置');
      expect(html).toContain(language === 'en' ? 'Data through' : '数据截至');
      const endLabel = language === 'en' ? 'Ends / resets' : '结束／重置';
      const cutoffLabel = language === 'en' ? 'Data through' : '数据截至';
      expect(html).toContain(`<dt>${endLabel}</dt><dd><time dateTime="${resetsAt}"`);
      expect(html).toContain(`<dt>${cutoffLabel}</dt><dd><time dateTime="${endedAt}"`);
      expect(html).toContain(language === 'en' ? 'Time zone: Asia/Hong_Kong' : '时区：Asia/Hong_Kong');
      expect(html).toContain('09:50:54');
      expect(html).toContain('12:18:10');
      expect(html).toContain('UTC+8');
      expect(html).not.toContain(language === 'en' ? 'Period unavailable' : '周期暂不可用');
    }
  });

  it('does not attach quota reset bounds to calendar-day or lifetime statistics', () => {
    for (const language of ['en', 'zh'] as const) {
      testState.language = language;
      for (const period of ['today', '7d', 'lifetime'] as const) {
        const html = renderScope({ ...analysis, period, startedAt: period === 'lifetime' ? null : startedAt });
        expect(html).toContain(endedAt);
        expect(html).not.toContain(resetsAt);
        expect(html).not.toContain(language === 'en' ? 'Ends / resets' : '结束／重置');
        if (period === 'lifetime') expect(html).toContain(language === 'en' ? 'All available history' : '全部可用历史');
      }
    }
  });

  it('does not invent quota dates from data cutoff when bounds are missing, invalid or reversed', () => {
    for (const language of ['en', 'zh'] as const) {
      testState.language = language;
      const invalidWindows = [null,
        { ...allocation, windowStartedAt: null },
        { ...allocation, resetsAt: null },
        { ...allocation, windowStartedAt: 'invalid' },
        { ...allocation, resetsAt: 'invalid' },
        { ...allocation, windowStartedAt: resetsAt, resetsAt: startedAt },
        { ...allocation, resetsAt: startedAt }
      ];
      for (const window of invalidWindows) {
        const html = renderScope(analysis, window);
        expect(html).toContain(language === 'en' ? 'Period unavailable' : '周期暂不可用');
        expect(html).toContain(endedAt);
        expect(html).not.toContain('Invalid Date');
      }
      expect(renderScope(null, null)).toContain(language === 'en' ? 'Period unavailable' : '周期暂不可用');
    }
  });

  it('identifies an expired retained quota window without silently moving its dates', () => {
    for (const language of ['en', 'zh'] as const) {
      testState.language = language;
      const html = renderScope(analysis, allocation, Date.parse(resetsAt));
      expect(html).toContain(startedAt);
      expect(html).toContain(resetsAt);
      expect(html).toContain(createI18n(language).t('This quota period has ended. Waiting for the renewed quota window.'));
    }
  });

  it('falls back to UTC for an invalid server time zone instead of breaking the dashboard', () => {
    const html = renderScope({ ...analysis, timeZone: 'Unknown/Invalid' });
    expect(html).toContain('Time zone: UTC');
    expect(html).toContain('01:50:54');
    expect(html).toContain('04:18:10');
    expect(html).not.toContain('Unknown/Invalid');
  });

  it('preserves the real short window when the account has no weekly limit', () => {
    const shortEnd = '2026-09-23T06:50:54.000Z';
    const html = renderScope(analysis, { ...allocation, resetsAt: shortEnd, windowLabel: '5h' });
    expect(html).toContain(shortEnd);
    expect(html).not.toContain(resetsAt);
    expect(html).not.toContain('Weekly');
    expect(html).not.toContain('Period unavailable');
  });
});
