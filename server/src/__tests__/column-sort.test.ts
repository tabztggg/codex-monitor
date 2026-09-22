import { describe, expect, it } from 'vitest';
import type { HistoryJob } from '../../../shared/monitor';
import { groupTasksByProject, limitArchivedTasks, visibleTasks, type TaskSortColumn, type SortDirection } from '../../../web/src/presentation';

const now = Date.parse('2026-09-22T00:00:00Z');
const active = new Set(['a']);
const jobs = [
  { id: 'a', name: 'Task 10', archived: false, updatedAt: '2026-09-02T00:00:00Z', estimatedUsagePercentSinceReset: 1, totalEstimatedCostUsd: 30, totalUsage: { totalTokens: 100 } },
  { id: 'b', name: 'task 2', archived: false, updatedAt: '2026-09-03T00:00:00Z', estimatedUsagePercentSinceReset: 3, totalEstimatedCostUsd: 10, totalUsage: { totalTokens: 300 } },
  { id: 'c', name: 'Task 1', archived: true, updatedAt: '2026-09-01T00:00:00Z', estimatedUsagePercentSinceReset: 2, totalEstimatedCostUsd: 20, totalUsage: { totalTokens: 200 } }
] as HistoryJob[];
const order = (data: HistoryJob[], column: TaskSortColumn, direction: SortDirection) =>
  visibleTasks(data, active, 'all', '', column, now, false, 'en', direction).map(job => job.id);

describe('task column sorting', () => {
  it.each<[TaskSortColumn, string[]]>([
    ['task', ['c', 'b', 'a']], ['status', ['a', 'b', 'c']],
    ['usage', ['a', 'c', 'b']], ['cost', ['b', 'c', 'a']],
    ['tokens', ['a', 'c', 'b']], ['activity', ['c', 'a', 'b']]
  ])('sorts %s in both directions using underlying values', (column, ascending) => {
    const before = structuredClone(jobs);
    expect(order(jobs, column, 'asc')).toEqual(ascending);
    expect(order(jobs, column, 'desc')).toEqual([...ascending].reverse());
    expect(jobs).toEqual(before);
  });

  it.each<TaskSortColumn>(['usage', 'cost', 'tokens', 'activity'])('keeps missing and invalid %s after measured zero in both directions', column => {
    const data = [
      { id: 'unknown', name: 'Unknown', updatedAt: 'invalid', estimatedUsagePercentSinceReset: null, totalEstimatedCostUsd: null, totalUsage: null },
      { id: 'invalid', name: 'Invalid', updatedAt: 'invalid', estimatedUsagePercentSinceReset: NaN, totalEstimatedCostUsd: Infinity, totalUsage: { totalTokens: NaN } },
      { id: 'zero', name: 'Zero', updatedAt: '1970-01-01T00:00:00Z', estimatedUsagePercentSinceReset: 0, totalEstimatedCostUsd: 0, totalUsage: { totalTokens: 0 } },
      { id: 'high', name: 'High', updatedAt: '2026-01-01T00:00:00Z', estimatedUsagePercentSinceReset: 2, totalEstimatedCostUsd: 2, totalUsage: { totalTokens: 2 } }
    ] as HistoryJob[];
    expect(order(data, column, 'asc')).toEqual(['zero', 'high', 'invalid', 'unknown']);
    expect(order(data, column, 'desc')).toEqual(['high', 'zero', 'invalid', 'unknown']);
  });

  it('sorts raw quota fractions instead of rounded display percentages and breaks equal values consistently', () => {
    const data = jobs.map(job => ({ ...job, estimatedUsagePercentSinceReset: 1.001, totalEstimatedCostUsd: 5, updatedAt: jobs[0].updatedAt }));
    data[1].estimatedUsagePercentSinceReset = 1.002;
    expect(order(data, 'usage', 'asc')).toEqual(['a', 'c', 'b']);
    expect(order([...data].reverse(), 'usage', 'desc')).toEqual(['b', 'a', 'c']);
  });

  it('keeps the same 30 recent archive actions under every sort and applies filters without changing usage', () => {
    const data = Array.from({ length: 35 }, (_, index) => ({ ...jobs[index % 3], id: `archive-${index}`, archived: true,
      archivedAt: new Date(Date.UTC(2026, 8, 1, index)).toISOString() }));
    const expected = data.slice(5).map(job => job.id).sort();
    for (const column of ['task', 'status', 'usage', 'cost', 'tokens', 'activity'] as const) {
      for (const direction of ['asc', 'desc'] as const) {
        const sorted = visibleTasks(data, active, 'all', '', column, now, false, 'en', direction);
        expect(limitArchivedTasks(sorted).map(job => job.id).sort()).toEqual(expected);
        expect(visibleTasks(jobs, active, 'active', '', column, now, false, 'en', direction)).toEqual([jobs[0]]);
        expect(visibleTasks(jobs, active, 'all', 'task', column, now, true, 'en', direction)).toHaveLength(2);
      }
    }
  });
});

describe('project sorting', () => {
  const alpha = { id: 'alpha', name: 'Alpha' };
  const beta = { id: 'beta', name: 'Beta' };
  const gamma = { id: 'gamma', name: 'Gamma' };
  const data = [
    { ...jobs[0], project: alpha, estimatedUsagePercentSinceReset: 2, totalEstimatedCostUsd: 5, totalUsage: { totalTokens: 40 } },
    { ...jobs[2], id: 'archive', project: alpha, updatedAt: '2026-09-03T00:00:00Z', estimatedUsagePercentSinceReset: 5, totalEstimatedCostUsd: 15, totalUsage: { totalTokens: 60 } },
    { ...jobs[1], project: beta, updatedAt: '2026-09-04T00:00:00Z', estimatedUsagePercentSinceReset: 9, totalEstimatedCostUsd: 12, totalUsage: { totalTokens: 150 } },
    { ...jobs[2], project: gamma, updatedAt: 'invalid', estimatedUsagePercentSinceReset: null, totalEstimatedCostUsd: null, totalUsage: null }
  ] as HistoryJob[];

  it('reports partial lifetime totals without treating unknowns as zero or hiding incomplete price estimates', () => {
    const records = [
      { ...data[0], totalEstimatedCostUsd: 10, totalEstimatedCostIsComplete: true, totalUsage: { totalTokens: 100 } },
      { ...data[1], totalEstimatedCostUsd: 5, totalEstimatedCostIsComplete: false, totalUsage: { totalTokens: 50 } },
      { ...data[0], id: 'missing', totalEstimatedCostUsd: null, totalUsage: null },
      { ...data[2], totalEstimatedCostUsd: 0, totalEstimatedCostIsComplete: true, totalUsage: { totalTokens: 0 } },
      data[3]
    ] as HistoryJob[];
    const groups = groupTasksByProject(records, [records[0], records[3]], 'cost');
    expect(groups.find(group => group.id === 'project:alpha')).toMatchObject({
      totalEstimatedCostUsd: 15, totalEstimatedCostIsComplete: false,
      totalTokens: 150, tokensIsComplete: false, jobs: [records[0]]
    });
    expect(groups.find(group => group.id === 'project:beta')).toMatchObject({
      totalEstimatedCostUsd: 0, totalEstimatedCostIsComplete: true, totalTokens: 0, tokensIsComplete: true
    });
    expect(groups.find(group => group.id === 'project:gamma')).toMatchObject({
      totalEstimatedCostUsd: null, totalEstimatedCostIsComplete: false, totalTokens: null, tokensIsComplete: false
    });
    const pricedPartially = groupTasksByProject(records.slice(0, 2), [], 'cost')[0];
    expect(pricedPartially).toMatchObject({ totalEstimatedCostUsd: 15, totalEstimatedCostIsComplete: false, totalTokens: 150, tokensIsComplete: true });
  });

  it.each<[TaskSortColumn, string[], string[]]>([
    ['task', ['alpha', 'beta', 'gamma'], ['gamma', 'beta', 'alpha']],
    ['status', ['alpha', 'beta', 'gamma'], ['gamma', 'beta', 'alpha']],
    ['usage', ['alpha', 'beta', 'gamma'], ['beta', 'alpha', 'gamma']],
    ['cost', ['beta', 'alpha', 'gamma'], ['alpha', 'beta', 'gamma']],
    ['tokens', ['alpha', 'beta', 'gamma'], ['beta', 'alpha', 'gamma']],
    ['activity', ['alpha', 'beta', 'gamma'], ['beta', 'alpha', 'gamma']]
  ])('sorts projects by %s over full history regardless of hidden rows', (column, asc, desc) => {
    for (const [direction, expected] of [['asc', asc], ['desc', desc]] as const) {
      const groups = groupTasksByProject(data, [data[0], data[2]], column, direction, active, 'en');
      expect(groups.map(group => group.id)).toEqual(expected.map(id => `project:${id}`));
      expect(groups.find(group => group.id === 'project:alpha')).toMatchObject({ quotaPercent: 7, totalEstimatedCostUsd: 20, totalTokens: 100, jobs: [data[0]] });
      expect(groupTasksByProject(data, [], column, direction, active, 'en').map(group => group.id)).toEqual(groups.map(group => group.id));
    }
  });
});
