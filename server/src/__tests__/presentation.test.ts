import { describe, expect, it } from 'vitest';
import { groupTasksByProject, limitArchivedTasks, overallUsageWindow, quotaPace, relativeActivity, taskTitle, visibleTasks } from '../../../web/src/presentation';
import type { CodexUsageLimit, CodexUsageSnapshot, CodexUsageWindow, HistoryJob } from '../../../shared/monitor';

const week: CodexUsageWindow = { label: 'Weekly', usedPercent: 23, remainingPercent: 77, windowDurationMins: 10080, resetsAt: '2026-09-12T00:00:00Z' };
const bucket = (id: string, primary: CodexUsageWindow | null, secondary: CodexUsageWindow | null = null): CodexUsageLimit => ({ id, primary, secondary, name: null, planType: null, credits: null, rateLimitReachedType: null });
const snapshot = (limits: CodexUsageLimit[], primaryLimit: CodexUsageLimit | null): CodexUsageSnapshot => ({ limits, primaryLimit, status: 'available', updatedAt: null, error: null });

describe('dashboard quota selection and pace', () => {
  it('selects only the general weekly limit even when Spark is primary and listed first', () => {
    const spark = bucket('codex_bengalfox', { ...week, windowDurationMins: 300 }, week);
    expect(overallUsageWindow(snapshot([spark, bucket('codex', null, week)], spark))).toBe(week);
    expect(overallUsageWindow(snapshot([spark], spark))).toBeNull();
  });
  it('uses the explicit codex map ahead of a stale legacy bucket', () => {
    expect(overallUsageWindow(snapshot([bucket('codex', week)], bucket('codex', { ...week, usedPercent: 90 })))).toBe(week);
  });
  it('does not show expired, invalid or future periods as current pace', () => {
    const reset = Date.parse(week.resetsAt!);
    expect(quotaPace(week, reset).expired).toBe(true);
    expect(quotaPace(week, reset).difference).toBeNull();
    expect(quotaPace({ ...week, resetsAt: 'invalid' }, reset).elapsed).toBeNull();
    expect(quotaPace(week, reset - 8 * 86400000).elapsed).toBeNull();
  });
  it('compares 23% usage to 14% elapsed without a projection', () => {
    const now = Date.parse(week.resetsAt!) - 0.86 * 10080 * 60000;
    expect(quotaPace(week, now).difference).toBeCloseTo(9);
    expect(quotaPace({ ...week, usedPercent: null }, now).difference).toBeNull();
  });
});

describe('task presentation', () => {
  it('sums all project quota values before display filters and retains unknown values', () => {
    const a = { id: 'a', name: 'Project A' };
    const b = { id: 'b', name: 'Project B' };
    const jobs = [
      { id: 'a1', project: a, archived: false, updatedAt: '2026-09-01T00:00:00Z', currentAccountEquivalentPercent: 1.2345 },
      { id: 'a2', project: a, archived: true, updatedAt: '2026-09-02T00:00:00Z', currentAccountEquivalentPercent: 2.3456 },
      { id: 'a3', project: a, archived: true, updatedAt: '2026-09-03T00:00:00Z', currentAccountEquivalentPercent: null },
      { id: 'b1', project: b, archived: false, updatedAt: '2026-09-04T00:00:00Z', currentAccountEquivalentPercent: 0 },
      { id: 'loose', project: null, archived: true, updatedAt: '2026-09-05T00:00:00Z', currentAccountEquivalentPercent: null }
    ] as HistoryJob[];
    const before = structuredClone(jobs);
    const groups = groupTasksByProject(jobs, [jobs[0], jobs[3]], 'usage');
    expect(groups.map(group => group.name)).toEqual(['Project A', 'Project B', '未分配项目']);
    expect(groups[0].quotaPercent).toBeCloseTo(3.5801, 10);
    expect(groups[0]).toMatchObject({ totalTasks: 3, quotaIsComplete: false, jobs: [jobs[0]] });
    expect(groups[1]).toMatchObject({ quotaPercent: 0, quotaIsComplete: true });
    expect(groups[2]).toMatchObject({ quotaPercent: null, quotaIsComplete: false, totalTasks: 1, jobs: [] });
    expect(groupTasksByProject(jobs, [], 'usage').map(group => group.quotaPercent)).toEqual(groups.map(group => group.quotaPercent));
    expect(groupTasksByProject(jobs, jobs, 'activity')[0].name).toBe('未分配项目');
    expect(jobs).toEqual(before);
  });

  it('uses project IDs instead of merging projects with identical names, and supports project-name search', () => {
    const jobs = [
      { id: 'one', project: { id: 'p1', name: 'Same project name' }, name: 'First task', updatedAt: '2026-09-01T00:00:00Z', currentAccountEquivalentPercent: 2 },
      { id: 'two', project: { id: 'p2', name: 'Same project name' }, name: 'Second task', updatedAt: '2026-09-02T00:00:00Z', currentAccountEquivalentPercent: 3 }
    ] as HistoryJob[];
    expect(groupTasksByProject(jobs, jobs, 'usage').map(group => group.quotaPercent)).toEqual([3, 2]);
    expect(visibleTasks(jobs, new Set(), 'all', 'same project', 'usage', Date.now())).toHaveLength(2);
  });
  it('limits archives to the 30 latest archive actions while keeping all unarchived tasks and source data', () => {
    const archives = Array.from({ length: 35 }, (_, index) => ({
      id: `archive-${index}`, archived: true,
      archivedAt: new Date(Date.UTC(2026, 8, 1, index)).toISOString(),
      // Reverse activity order: the limit must use archive actions, not activity or usage.
      updatedAt: new Date(Date.UTC(2026, 8, 1, 35 - index)).toISOString(),
      currentAccountEquivalentPercent: 35 - index
    })) as HistoryJob[];
    const unarchived = Array.from({ length: 40 }, (_, index) => ({ id: `active-${index}`, archived: false })) as HistoryJob[];
    const jobs = [...archives, ...unarchived];
    const before = structuredClone(jobs);
    const displayed = limitArchivedTasks(jobs);
    expect(displayed.filter(job => job.archived).map(job => job.id)).toEqual(archives.slice(5).map(job => job.id));
    expect(displayed.filter(job => !job.archived)).toEqual(unarchived);
    expect(limitArchivedTasks(jobs, 60)).toEqual(jobs);
    expect(jobs).toEqual(before);
  });

  it('uses last activity only when an archive timestamp is unavailable', () => {
    const jobs = [
      { id: 'known', archived: true, archivedAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-20T00:00:00Z' },
      { id: 'fallback', archived: true, archivedAt: null, updatedAt: '2026-09-02T00:00:00Z' }
    ] as HistoryJob[];
    expect(limitArchivedTasks(jobs, 1).map(job => job.id)).toEqual(['fallback']);
  });
  it('shows archives by default and hides only their rows without changing recorded usage', () => {
    const jobs = [
      { id: 'active', archived: false, updatedAt: '2026-09-07T10:00:00Z', currentAccountEquivalentPercent: 3 },
      { id: 'archived', archived: true, updatedAt: '2026-09-05T10:00:00Z', currentAccountEquivalentPercent: 7 }
    ] as HistoryJob[];
    const before = structuredClone(jobs);
    const now = Date.parse('2026-09-07T12:00:00Z');
    expect(visibleTasks(jobs, new Set(), 'all', '', 'usage', now).map(job => job.id)).toEqual(['archived', 'active']);
    expect(visibleTasks(jobs, new Set(), 'all', '', 'usage', now, true)).toEqual([jobs[0]]);
    expect(jobs).toEqual(before);
    expect(visibleTasks(jobs, new Set(), 'all', '', 'usage', now, false).map(job => job.currentAccountEquivalentPercent)).toEqual([7, 3]);
  });
  it('preserves authored titles and hides internal-context previews', () => {
    expect(taskTitle({ id: '123456789', name: 'Revisar el capítulo', preview: '<instructions>text</instructions>' })).toBe('Revisar el capítulo');
    expect(taskTitle({ id: 'x', name: '[P1] System design review', preview: null })).toBe('[P1] System design review');
    for (const preview of ['<recommended_plugins>secret context</recommended_plugins>', '[transcription] words', 'You are Codex, an agent', 'The following is the Codex agent history added since your last approval assessment.']) {
      expect(taskTitle({ id: '123456789', name: null, preview })).toBe('Untitled task · 12345678');
    }
    expect(taskTitle({ id: 'x', name: null, preview: '# Improve monitor\nDetails' })).toBe('Improve monitor');
  });
  it('filters before sorting and keeps unknown usage below measured zero', () => {
    const jobs = [
      { id: 'a', name: 'Active', updatedAt: '2026-09-05T10:00:00Z', currentAccountEquivalentPercent: null },
      { id: 'b', name: 'Today', updatedAt: '2026-09-07T10:00:00Z', currentAccountEquivalentPercent: 0 },
      { id: 'c', name: 'Old', updatedAt: '2026-09-05T10:00:00Z', currentAccountEquivalentPercent: 9 }
    ] as HistoryJob[];
    const now = new Date(2026, 8, 7, 12).getTime();
    expect(visibleTasks(jobs, new Set(['a']), 'today', '', 'usage', now).map(j => j.id)).toEqual(['b', 'a']);
    expect(visibleTasks(jobs, new Set(['a']), 'active', '', 'usage', now).map(j => j.id)).toEqual(['a']);
    expect(visibleTasks(jobs, new Set(), 'all', 'Old', 'usage', now).map(j => j.id)).toEqual(['c']);
  });
  it('formats activity in English with an unknown-data fallback', () => {
    expect(relativeActivity('2026-09-07T10:00:00Z', Date.parse('2026-09-07T10:03:00Z'))).toBe('3 min ago');
    expect(relativeActivity('bad', Date.now())).toBe('Unknown');
  });
});
