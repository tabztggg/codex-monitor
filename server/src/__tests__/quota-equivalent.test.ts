import { describe, expect, it } from 'vitest';
import type { HistoryJob } from '../../../shared/monitor';
import { calibrate20x, equivalent20x, pro20xWeeklyLimit, type QuotaCalibrationEvent } from '../quota-equivalent';
import { parseHistorySessionFile } from '../history-jobs';
import { groupTasksByProject, visibleTasks } from '../../../web/src/presentation';

const start = Date.parse('2026-09-21T00:00:00Z');
const end = start + 604800000;
const event = (minute: number, used: number, cost: number | null, reset = end): QuotaCalibrationEvent =>
  ({ at: start + minute * 60000, cost, limit: { used, resetsAt: reset } });

describe('20x weekly equivalents', () => {
  it('combines quota snapshots from parallel tasks before taking deltas and keeps pending costs through rounded readings', () => {
    const calibration = calibrate20x([
      event(4, 15, 1), event(0, 10, 999), event(1, 10, 2), event(2, 10, 0), event(3, 15, 8)
    ], start, end);
    expect(calibration).toEqual({ costPerPercent: 2, quotaPercent: 5 });
  });

  it('calibrates multiple account windows without counting their initial balances or switch jumps', () => {
    expect(calibrate20x([
      event(0, 80, 1000), event(1, 85, 10),
      event(2, 20, 500, end + 3600000), event(3, 25, 10, end + 3600000),
      event(4, 85, 800), event(5, 90, 10)
    ], start, end)).toEqual({ costPerPercent: 2, quotaPercent: 15 });
  });

  it('does not recount a stale parallel snapshot when it catches up to the high-water mark', () => {
    expect(calibrate20x([
      event(0, 10, 0), event(1, 15, 10), event(2, 10, 2), event(3, 15, 2),
      event(4, 16, 2), event(5, 21, 10)
    ], start, end)).toEqual({ costPerPercent: 2, quotaPercent: 10 });
  });

  it('rejects corrections, observation gaps, missing prices and missing weekly limits', () => {
    expect(calibrate20x([
      event(0, 10, 0), event(1, 15, null), event(2, 10, 1), event(45, 20, 100),
      { ...event(46, 25, 100), limit: null }, event(47, 30, 100), event(48, 35, 10)
    ], start, end)).toEqual({ costPerPercent: 2, quotaPercent: 5 });
    expect(calibrate20x([event(0, 0, 1), event(1, 1, 1)], start, end).costPerPercent).toBeNull();
    expect(calibrate20x([event(-1, 0, 1), event(1, 5, 1)], start, end).costPerPercent).toBeNull();
    expect(calibrate20x([event(0, 0, 1), event(10080, 5, 1)], start, end).costPerPercent).toBeNull();
  });

  it('uses only valid general Pro weekly limits, including secondary windows', () => {
    const rate = { plan_type: 'pro', limit_id: 'codex', primary: { window_minutes: 300 },
      secondary: { window_minutes: 10080, used_percent: 20, resets_at: end / 1000 } };
    expect(pro20xWeeklyLimit(rate, start)).toEqual({ used: 20, resetsAt: end });
    expect(pro20xWeeklyLimit({ ...rate, plan_type: 'plus' }, start)).toBeNull();
    expect(pro20xWeeklyLimit({ ...rate, limit_id: 'spark' }, start)).toBeNull();
    expect(pro20xWeeklyLimit(rate, end)).toBeNull();
    expect(pro20xWeeklyLimit({ ...rate, secondary: { ...rate.secondary, used_percent: Infinity } }, start)).toBeNull();
  });

  it('reads metadata on repeated token snapshots without counting repeated token cost', () => {
    const usage = { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 1000 };
    const lines = [
      { type: 'session_meta', payload: { id: 'task' } },
      { type: 'turn_context', payload: { model: 'gpt-6-astra' } },
      ...[10, 15].map((used, i) => ({ timestamp: new Date(start + i * 60000).toISOString(), type: 'event_msg', payload: {
        type: 'token_count', info: { last_token_usage: usage, total_token_usage: usage },
        rate_limits: { plan_type: 'pro', primary: { used_percent: used, window_minutes: 10080, resets_at: end / 1000 } }
      } }))
    ];
    const parsed = parseHistorySessionFile({ sessionId: 'task', fileContent: lines.map(line => JSON.stringify(line)).join('\n'),
      updatedAt: new Date(start).toISOString(), nowMs: start + 120000, usageWindowStartedAtMs: start });
    expect(parsed?.totalUsage?.totalTokens).toBe(1000);
    expect(parsed?.quotaCalibrationEvents?.map(e => [e.cost, e.limit?.used])).toEqual([[0.01, 10], [0, 15]]);
  });

  it('allows totals far above 100%, handles partial and unavailable data, and sorts tasks and projects', () => {
    const a = { id: 'a', name: 'A', project: { id: 'a', name: 'A' }, updatedAt: new Date(start).toISOString(),
      sinceResetUsage: { totalTokens: 100 }, sinceResetEstimatedCostUsd: 500, totalUsage: { totalTokens: 100 } } as HistoryJob;
    expect(equivalent20x(a, 2)).toBe(250);
    expect(equivalent20x(a, null)).toBeNull();
    expect(equivalent20x({ ...a, sinceResetUsage: null }, 2)).toBe(0);
    expect(equivalent20x({ ...a, sinceResetUsage: null, totalUsage: null }, 2)).toBeNull();
    const jobs = [
      { ...a, estimated20xPercent: 250, estimated20xIsComplete: true },
      { ...a, id: 'b', estimated20xPercent: 150, estimated20xIsComplete: false },
      { ...a, id: 'c', project: { id: 'c', name: 'C' }, estimated20xPercent: 50, estimated20xIsComplete: true },
      { ...a, id: 'unknown', project: { id: 'u', name: 'U' }, estimated20xPercent: null }
    ];
    expect(visibleTasks(jobs, new Set(), 'all', '', 'equivalent20x', start, false, 'en', 'asc').map(j => j.id)).toEqual(['c', 'b', 'a', 'unknown']);
    expect(visibleTasks(jobs, new Set(), 'all', '', 'equivalent20x', start, false, 'en', 'desc').map(j => j.id)).toEqual(['a', 'b', 'c', 'unknown']);
    const groups = groupTasksByProject(jobs, [jobs[0]], 'equivalent20x');
    expect(groups.map(g => g.id)).toEqual(['project:a', 'project:c', 'project:u']);
    expect(groups[0]).toMatchObject({ equivalent20xPercent: 400, equivalent20xIsComplete: false, jobs: [jobs[0]] });
  });
});
