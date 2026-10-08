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
import { QuotaReconciliation } from '../../../web/src/components/QuotaReconciliation';

const testState = vi.hoisted(() => ({ language: 'zh' as Language, loading: false, archiveMode: 'recent' as 'recent' | 'all', error: null as string | null, period: 'quota' as 'quota' | 'today', allocation: null as HistoryUsageAllocation | null }));
vi.mock('../../../web/src/LanguageContext', () => ({
  useI18n: () => ({ ...createI18n(testState.language), setLanguage: () => {} }),
  LanguageSwitch: () => null
}));
vi.mock('../../../web/src/useTaskHistory', () => ({ useTaskHistory: () => ({ jobs: [job], allocation: testState.allocation, analysis: { period: testState.period }, updatedAt: Date.parse('2026-09-22T00:00:00Z'), error: testState.error, archives: { mode: testState.archiveMode, total: 100, included: testState.archiveMode === 'all' ? 100 : 30 }, loading: testState.loading, requestedMode: testState.loading || testState.error ? 'all' : testState.archiveMode, loadArchives: () => {} }) }));

const job = { id: 'task', name: '用户任务 Original', archived: true, archivedAt: '2026-09-21T00:00:00Z',
  project: { id: 'project', name: '用户项目 Original' }, updatedAt: '2026-09-21T00:00:00Z',
  estimatedUsagePercentSinceReset: 2, totalEstimatedCostUsd: 42, totalEstimatedCostIsComplete: true,
  currentAccountEquivalentPercent: 6.7, currentAccountEquivalentIsComplete: false,
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
  it('renders account reconciliation in both languages with the official total and unassigned amount', () => {
    const allocation = { attributionBasis: 'observedQuotaIncrements', usedPercent: 79,
      includedAttributedPercent: 60, outsideScopePercent: 6, unattributedPercent: 13 } as HistoryUsageAllocation;
    for (const language of ['zh', 'en'] as const) {
      testState.language = language;
      const html = renderToStaticMarkup(createElement(QuotaReconciliation, { allocation }));
      expect(html).toContain(language === 'zh' ? '账号额度对账' : 'Account quota reconciliation');
      expect(html).toContain(language === 'zh' ? '未归属额度' : 'Unattributed quota');
      for (const percent of ['79.0%', '60.0%', '6.0%', '13.0%']) expect(html).toContain(percent);
      expect(html).not.toContain('NaN');
    }
  });
  it('labels token-weight allocation as part of task totals and supports older snapshots', () => {
    const allocation = { attributionBasis: 'observedQuotaIncrements', usedPercent: 25,
      includedAttributedPercent: 24, outsideScopePercent: 0, unattributedPercent: 1,
      tokenFallbackPercent: 20 } as HistoryUsageAllocation;
    for (const language of ['zh', 'en'] as const) {
      testState.language = language;
      const render = (value: HistoryUsageAllocation) => renderToStaticMarkup(createElement(QuotaReconciliation, { allocation: value }));
      const html = render(allocation);
      expect(html).toContain(language === 'zh' ? 'Token 权重分配' : 'Token-weight allocation');
      expect(html).toContain(language === 'zh' ? '不额外相加' : 'not an additional amount');
      for (const percent of ['25.0%', '24.0%', '1.0%', '20.0%']) expect(html).toContain(percent);
      for (const tokenFallbackPercent of [undefined, 0]) {
        const old = render({ ...allocation, tokenFallbackPercent });
        expect(old).not.toContain(language === 'zh' ? 'Token 权重分配' : 'Token-weight allocation');
        expect(old).not.toContain('NaN');
      }
    }
  });
  it('shows mixed calibration quality and priced coverage in both languages without inventing prices', () => {
    try {
      for (const language of ['zh', 'en'] as const) {
        testState.language = language;
        testState.allocation = { equivalent20x: { source: 'current', costPerPercentUsd: 2,
          calibrationQuotaPercent: 12, referenceIsComplete: false, method: 'mixedTokenWeights',
          coverage: { quota: 1, cost: 0.99, priced: 0.75 } } } as HistoryUsageAllocation;
        const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(DashboardPage, { snapshot, nowMs: Date.now(), connectionLabel: 'live', page: 'trends' })));
        expect(html).toContain(language === 'zh' ? '费用与 Token 混合权重' : 'Mixed cost and token weights');
        expect(html).toContain(language === 'zh' ? '<dt>校准已定价权重</dt><dd>75.0%</dd>' : '<dt>Priced calibration weight</dt><dd>75.0%</dd>');
        expect(html).toContain(language === 'zh' ? '美元费用仅包含已定价记录' : 'USD totals include only priced records');
        expect(html).toContain(language === 'zh' ? 'US$2.00+' : '$2.00+');
      }
    } finally { testState.allocation = null; }
  });
  it('distinguishes a manual normalization target from observed calibration samples', () => {
    const render = () => renderToStaticMarkup(createElement(MemoryRouter, null, createElement(DashboardPage, { snapshot, nowMs: Date.now(), connectionLabel: 'live', page: 'trends' })));
    try {
      for (const language of ['zh', 'en'] as const) {
        testState.language = language;
        testState.allocation = { equivalent20x: { source: 'manual', costPerPercentUsd: 2, calibrationQuotaPercent: 100 } } as HistoryUsageAllocation;
        const manual = render();
        expect(manual).toContain(language === 'zh' ? '<dt>手动归一化目标</dt><dd>100%</dd>' : '<dt>Manual normalization target</dt><dd>100%</dd>');
        expect(manual).not.toContain(language === 'zh' ? '<dt>校准样本</dt>' : '<dt>Calibration observations</dt>');
        for (const source of ['current', 'previous', 'unavailable'] as const) {
          testState.allocation.equivalent20x = { source, costPerPercentUsd: 2, calibrationQuotaPercent: 12 };
          const automatic = render();
          expect(automatic).toContain(language === 'zh' ? '<dt>校准样本</dt><dd>12 个百分点</dd>' : '<dt>Calibration observations</dt><dd>12 percentage points</dd>');
          expect(automatic).not.toContain(language === 'zh' ? '<dt>手动归一化目标</dt>' : '<dt>Manual normalization target</dt>');
        }
      }
    } finally { testState.allocation = null; }
  });
  it('explains why an unmerged subtask is listed separately', () => {
    job.orphanedSubagent = true;
    try {
      const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(DashboardPage, { snapshot, nowMs: Date.now(), connectionLabel: 'live', page: 'tasks' })));
      expect(html).toContain('父任务不可用');
    } finally { delete job.orphanedSubagent; }
  });
  it('makes range and archive scope visible on every page without suggesting a single-account trend', () => {
    for (const page of ['overview', 'tasks', 'trends'] as const) {
      const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(DashboardPage, { snapshot, nowMs: Date.now(), connectionLabel: 'live', page })));
      expect(html).toContain('归档：最近 30 / 共 100 个');
      if (page === 'trends') expect(html).not.toContain('account-page-picker');
      if (page === 'tasks') {
        expect(html).toContain('时间范围影响费用和 Token');
        expect(html).toContain('今日有活动');
        const head = html.slice(html.indexOf('<thead>'), html.indexOf('</thead>'));
        expect(head).toContain('所选账号 · 本周期');
        expect(head).toContain('跨账号 · 任务累计');
      }
    }
  });

  it('keeps quota percentages above 100 and scales both rankings consistently', () => {
    testState.language = 'en';
    const jobs = [
      { ...job, id: 'a', name: 'First', project: { id: 'a', name: 'A' }, estimated20xPercent: 300, estimated20xIsComplete: true },
      { ...job, id: 'b', name: 'Second', project: { id: 'b', name: 'B' }, estimated20xPercent: 150, estimated20xIsComplete: true }
    ];
    const html = renderToStaticMarkup(createElement(TaskInsights, { jobs, analysis: null, allocation: null, periodLabel: 'Today', section: 'trend', expanded: true }));
    expect(html).toContain('300.0%');
    expect(html).toContain('150.0%');
    expect(html.match(/width:50%/g)).toHaveLength(2);
    expect(html).toContain('Full bar = 300.0% quota');
  });

  it('marks daily estimates as partial when records cannot be assigned to a date', () => {
    testState.language = 'en';
    const html = renderToStaticMarkup(createElement(TaskInsights, { jobs: [], analysis: {
      period: 'today', startedAt: null, endedAt: '2026-09-27T01:00:00Z', timeZone: 'UTC', unpricedTokens: 0, untimedTokens: 50,
      days: [{ date: '2026-09-27', costUsd: 10, usage: job.totalUsage!, unpricedTokens: 0 }]
    }, allocation: { equivalent20x: { costPerPercentUsd: 2 } } as HistoryUsageAllocation, periodLabel: 'Today', section: 'trend', expanded: true }));
    expect(html).toContain('5.0%+');
    expect(html).toContain('Some records have no date');
  });
  it('uses the daily quota estimate instead of repricing it and preserves unavailable values', () => {
    testState.language = 'en';
    const day = { date: '2026-10-07', costUsd: 80, usage: job.totalUsage!, unpricedTokens: 0,
      estimated20xPercent: 2, estimated20xIsComplete: false,
      models: [{ model: 'gpt-6-sol', usage: job.totalUsage!, costUsd: 80, unpricedTokens: 0, taskCount: 1, tokensComplete: true, costComplete: true }] };
    const analysis = { period: 'today' as const, startedAt: null, endedAt: '2026-10-07T08:00:00Z', timeZone: 'America/Los_Angeles', unpricedTokens: 0, untimedTokens: 0, days: [day] };
    const render = (value: HistoryAnalysis) => renderToStaticMarkup(createElement(TaskInsights, { jobs: [], analysis: value,
      allocation: { equivalent20x: { costPerPercentUsd: 2 } } as HistoryUsageAllocation, periodLabel: 'Today', section: 'trend', expanded: true }));
    const html = render(analysis);
    expect(html).toContain('aria-label="2026-10-07: 2.0%+"');
    expect(html).not.toContain('aria-label="2026-10-07: 40.0%');
    expect(html).not.toContain('class="model-trend-segment"');
    expect(html).not.toContain('class="model-legend"');
    const missing = render({ ...analysis, days: [{ ...day, estimated20xPercent: null }] });
    expect(missing).toContain('aria-label="2026-10-07: --"');
    expect(missing).not.toContain('aria-label="2026-10-07: 40.0%');
  });

  it('renders separate overview, tasks and trends pages', () => {
    const renderPage = (page: 'overview' | 'tasks' | 'trends') => renderToStaticMarkup(createElement(MemoryRouter, null, createElement(DashboardPage, { snapshot, nowMs: Date.now(), connectionLabel: 'live', page })));
    const overview = renderPage('overview');
    expect(overview).toContain('account-stack');
    expect(overview).toContain('scope-summary');
    expect(overview).not.toContain('class="task-table"');
    expect(overview).not.toContain('class="insights-panel"');
    const tasks = renderPage('tasks');
    expect(tasks).toContain('class="task-table"');
    expect(tasks).not.toContain('account-stack');
    expect(tasks).not.toContain('scope-summary');
    const trends = renderPage('trends');
    expect(trends).toContain('class="insights-panel" open');
    expect(trends).toContain('rankings-grid');
    expect(trends).toContain('estimation-basis');
    expect(trends).not.toContain('class="task-table"');
  });
  it('shows only current usage in the overview while keeping saved accounts in the task picker', () => {
    const makeUsage = (email: string, used: number) => {
      const limit = { id: 'codex', primary: null, secondary: { label: 'Weekly', usedPercent: used, remainingPercent: 100 - used, windowDurationMins: 10080, resetsAt: '2026-09-29T00:00:00Z' } };
      return { status: 'available', updatedAt: '2026-09-22T00:00:00Z', account: { type: 'chatgpt', email, planType: 'pro' }, limits: [limit], primaryLimit: limit };
    };
    const live = makeUsage('live@example.com', 20);
    const old = makeUsage('history@example.com', 75);
    const data = { ...snapshot, codexUsage: live, accountUsages: [{ id: 'live', current: true, usage: makeUsage('outdated@example.com', 40) }, { id: 'old', current: false, usage: old }] } as MonitorSnapshot;
    testState.language = 'en';
    const renderPage = (page: 'overview' | 'tasks') => renderToStaticMarkup(createElement(MemoryRouter, null, createElement(DashboardPage, { snapshot: data, nowMs: Date.parse('2026-09-22T01:00:00Z'), connectionLabel: 'live', page })));
    const html = renderPage('overview');
    expect(html).toContain('live@example.com');
    expect(html).not.toContain('outdated@example.com');
    expect(html).not.toContain('history@example.com');
    expect(html).toContain('20% <span>Quota used</span>');
    expect(html).toContain('aria-label="Remaining quota" aria-valuemin="0" aria-valuemax="100" aria-valuenow="80"');
    expect(html).toContain('aria-label="Time remaining in this period"');
    expect(html).toContain('Quota period');
    expect(html).toContain('dateTime="2026-09-22T00:00:00.000Z"');
    expect(html).toContain('dateTime="2026-09-29T00:00:00Z"');
    expect(html).toContain('class="account-updated-at"');
    expect(html).toContain('80%');
    expect(html.match(/class="surface global-quota account-usage-row/g)).toHaveLength(1);
    expect(html).not.toContain('This account is not being refreshed');
    expect(html).not.toContain('class="account-radio"');
    expect(html).not.toContain('account-page-picker');
    const tasks = renderPage('tasks');
    expect(tasks).toContain('account-page-picker');
    expect(tasks).toContain('<option value="" selected="">live@example.com</option>');
    expect(tasks).toContain('<option value="old">history@example.com</option>');
    expect(tasks).not.toContain('account-usage-row');
  });

  it('shows both equivalents in one cell without losing partial, zero, or missing values', () => {
    const original = { current: job.currentAccountEquivalentPercent, across: job.lifetime20xPercent, complete: job.lifetime20xIsComplete };
    try {
      job.currentAccountEquivalentPercent = 0;
      job.lifetime20xPercent = 125.6;
      job.lifetime20xIsComplete = false;
      const render = () => renderToStaticMarkup(createElement(MemoryRouter, null, createElement(DashboardPage, { snapshot, nowMs: Date.now(), connectionLabel: 'live' })));
      const html = render();
      const table = html.slice(html.indexOf('<table'), html.indexOf('</table>'));
      expect(table).toContain('class="equivalent-pair"');
      expect(table).toContain('0.0%+');
      expect(table).toContain('125.6%+');
      expect(table).toContain('class="equivalent-divider"> / </span>');
      expect(table).not.toContain('class="metric-equivalent20x');
      job.lifetime20xPercent = null;
      expect(render()).toContain('等待校准');
      expect(render()).toContain('0.0%+');
    } finally {
      job.currentAccountEquivalentPercent = original.current;
      job.lifetime20xPercent = original.across;
      job.lifetime20xIsComplete = original.complete;
    }
  });
  beforeEach(() => { testState.language = 'zh'; testState.loading = false; testState.archiveMode = 'recent'; testState.error = null; testState.period = 'quota'; });

  it('shows selected-account allocations independently of the cross-account reference and date selector', () => {
    for (const period of ['quota', 'today'] as const) {
      testState.period = period;
      const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(DashboardPage, { snapshot, nowMs: Date.now(), connectionLabel: 'live' })));
      const table = html.slice(html.indexOf('<table'), html.indexOf('</table>'));
      expect(table).toContain('所选账号占比');
      expect(table).toContain('6.7%+');
      expect(table).not.toContain('>2.0%');
      expect(table).toContain('所选账号 · 本周期');
      expect(html).toContain('按记录到的额度增量分配');
    }
  });

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
      expect(html).toContain(language === 'en' ? 'Last recorded' : '最近记录');
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
    expect(zh).toContain('所选账号占比');
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
    expect(zh).toContain('跨账号 · 任务累计');
    expect(zh).toContain('统计时间范围');
    expect(zh).toContain('等效消耗对比套餐');
    expect(zh).toContain('时间范围影响跨账号汇总等效消耗、费用、Token');
    expect(zh).toContain('value="pro5x"');
    expect(zh).toContain('value="plus"');
    expect(zh).toContain('aria-sort="descending"');
    expect(zh).toContain('按任务排序：升序');
    expect(zh).toContain('value="equivalent20x:desc" selected');
    testState.language = 'en';
    const en = render();
    expect(en).toContain('Overall Codex usage');
    expect(en).toContain('20x equivalent usage · Selected account');
    expect(en).toContain('20x equivalent usage');
    expect(en).toContain('Selected account · This period / Across accounts · Lifetime');
    expect(en).toContain('Equivalent usage comparison');
    expect(en).toContain('Statistics time range');
    expect(en).toContain('Archived');
    expect(en).toContain('10K');
    expect(en).toContain('Countdown will not shut down this computer');
    expect(en).toContain('用户任务 Original');
    expect(en).not.toContain('所选账号占比');
    expect(en).toContain('Calculate all archives');
    expect(en).toContain('aria-pressed="false">Group by project');
    expect(en).not.toContain('class="project-group-row"');
    expect(en).toContain('Statistics include only the 30 most recently archived tasks.');
    expect(en).toContain('Sort Task: Ascending');
    expect(en).toContain('Sort Pro 20x equivalent usage · Across accounts · Lifetime: Ascending');
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
  it('distinguishes calendar-day range totals from the account reset period in both languages', () => {
    for (const language of ['en', 'zh'] as const) {
      testState.language = language;
      const render = (period: HistoryAnalysis['period']) => renderToStaticMarkup(createElement(TaskInsights, {
        jobs: [job], analysis: { ...analysis, period, timeZone: 'America/Los_Angeles' }, allocation,
        periodLabel: createI18n(language).t('Today'), section: 'summary'
      }));
      const html = render('today');
      expect(html).toContain(language === 'en' ? 'Account quota is cumulative for its reset period' : '账号额度按重置周期累计');
      expect(html).toContain(language === 'en' ? 'Time zone: America/Los_Angeles' : '时区：America/Los_Angeles');
      expect(html).toContain(language === 'en' ? 'these totals cover Today' : '下方合计统计今天');
      expect(render('quota')).not.toContain('class="scope-period-note"');
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

  it('keeps confirmed custom dates and their analysis time zone in the compact range', () => {
    const confirmed = { ...analysis, period: 'custom' as const, timeZone: 'America/New_York',
      startedAt: '2026-09-19T02:30:00.000Z', endedAt: '2026-09-20T10:45:00.000Z' };
    for (const language of ['en', 'zh'] as const) {
      testState.language = language;
      const html = renderToStaticMarkup(createElement(HistoryPeriodScope, {
        analysis: confirmed, allocation, nowMs, compact: true
      }));
      expect(html).toContain(`dateTime="${confirmed.startedAt}"`);
      expect(html).toContain(`dateTime="${confirmed.endedAt}"`);
      expect(html).toContain('22:30');
      expect(html).toContain('06:45');
      expect(html.match(/UTC-4/g)).toHaveLength(2);
      expect(html).not.toContain(resetsAt);
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
