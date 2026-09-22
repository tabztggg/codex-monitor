import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HistoryJob, MonitorSnapshot, ThreadNode, TurnSummary, MonitorItem } from '../../../shared/monitor';
import { createI18n, type Language } from '../../../web/src/localization';
import { DashboardPage, RunDetailPage } from '../../../web/src/App';
import { ThreadTree } from '../../../web/src/components/ThreadTree';
import { TranscriptPanel } from '../../../web/src/components/TranscriptPanel';
import { TurnInspector } from '../../../web/src/components/TurnInspector';

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
    expect(zh).toContain('跨账号 · 所选范围');
    expect(zh).toContain('aria-sort="descending"');
    expect(zh).toContain('按任务排序：升序');
    expect(zh).toContain('value="usage:desc" selected');
    testState.language = 'en';
    const en = render();
    expect(en).toContain('Overall Codex usage');
    expect(en).toContain('Approx. quota %');
    expect(en).toContain('20x equivalent usage');
    expect(en).toContain('All accounts · Selected period');
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
