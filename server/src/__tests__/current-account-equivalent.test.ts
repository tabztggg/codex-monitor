import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { currentAccountEquivalent, type QuotaCalibrationEvent } from '../quota-equivalent';
import { HistoryJobReader } from '../history-jobs';
import { groupTasksByProject, visibleTasks } from '../../../web/src/presentation';

const start = Date.parse('2026-09-21T00:00:00Z');
const end = start + 604800000;
const now = start + 3600000;
const window = { startedAtMs: start, resetsAt: new Date(end).toISOString(), usedPercent: 20, limitName: 'Overall Codex', windowLabel: 'Weekly' };
const event = (cost: number | null, reset: number | null = end, at = start + 1000): QuotaCalibrationEvent =>
  ({ at, cost, limit: reset === null ? null : { used: 20, resetsAt: reset } });

describe('current account equivalents', () => {
  it('counts only the current account window, tolerates drift, and includes usage before monitoring began', () => {
    const events = [event(10), event(20, end + 30000), event(400, end + 86400000),
      event(80, end, start - 1), event(90, end, now + 1)];
    expect(currentAccountEquivalent(events, window, now, 2, true)).toEqual({ percent: 15, complete: true });
    expect(currentAccountEquivalent(events, { ...window, startedAtMs: start + 86400000, resetsAt: new Date(end + 86400000).toISOString() }, now + 86400000, 2, true))
      .toEqual({ percent: 0, complete: true });
    // Switching accounts with overlapping quota windows filters by reset, not by the task's identity.
    const otherWindow = { ...window, startedAtMs: start - 86400000, resetsAt: new Date(end - 86400000).toISOString() };
    expect(currentAccountEquivalent([event(10), event(40, end - 86400000)], otherWindow, now, 2, true))
      .toEqual({ percent: 20, complete: true });
  });

  it('excludes unknown identities and unpriced usage without reporting them as zero', () => {
    expect(currentAccountEquivalent([event(10), event(null), event(20, null)], window, now, 2, true))
      .toEqual({ percent: 5, complete: false });
    for (const events of [[event(null)], [event(20, null)], [event(0), event(null)]]) {
      expect(currentAccountEquivalent(events, window, now, 2, true)).toEqual({ percent: null, complete: false });
    }
    expect(currentAccountEquivalent([event(10), event(null, end + 86400000)], window, now, 2, true))
      .toEqual({ percent: 5, complete: true });
    expect(currentAccountEquivalent([event(10)], window, now, 2, true, 100)).toEqual({ percent: 5, complete: false });
  });

  it('distinguishes no current usage from missing calibration, empty logs, and expired quota', () => {
    expect(currentAccountEquivalent([event(40, end + 86400000)], window, now, 2, true)).toEqual({ percent: 0, complete: true });
    expect(currentAccountEquivalent([], window, now, 2, false)).toEqual({ percent: null, complete: false });
    expect(currentAccountEquivalent([event(10)], window, end, 2, true)).toEqual({ percent: null, complete: false });
    expect(currentAccountEquivalent([event(10)], null, now, 2, true)).toEqual({ percent: null, complete: false });
    expect(currentAccountEquivalent([event(10)], window, now, null, true)).toEqual({ percent: null, complete: false });
    expect(currentAccountEquivalent([event(300)], window, now, 2, true).percent).toBe(150);
  });

  it('does not double count overlapping fragments or repeated token reports', () => {
    const first = { ...event(10), id: 'first' };
    const repeat = { ...event(10), id: 'repeat' };
    const provenDuplicate = { ...repeat, cost: 0, duplicateUsage: true };
    for (const events of [[first, first, repeat, provenDuplicate], [first, provenDuplicate, repeat]]) {
      expect(currentAccountEquivalent(events, window, now, 2, true)).toEqual({ percent: 5, complete: true });
    }
  });

  it('merges task fragments and archived children, keeps ranges independent, and reuses calibration after restart', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'monitor-account-'));
    const sessions = path.join(root, 'sessions');
    const archives = path.join(root, 'archived_sessions');
    const cache = path.join(root, 'cache');
    mkdirSync(sessions); mkdirSync(archives); mkdirSync(cache);
    const iso = (time: number) => new Date(time).toISOString();
    const write = (directory: string, file: string, id: string, costTokens: number, reset: number | null, parent?: string, at = start + 1000, model = 'gpt-5.5') => {
      const usage = { input_tokens: costTokens, output_tokens: 0, total_tokens: costTokens };
      writeFileSync(path.join(directory, file), [
        { type: 'session_meta', timestamp: iso(at), payload: { id, cwd: 'C:/project', source: parent ? { subagent: { thread_spawn: { parent_thread_id: parent } } } : 'cli' } },
        { type: 'turn_context', timestamp: iso(at), payload: { model } },
        { type: 'event_msg', timestamp: iso(at), payload: { type: 'token_count',
          info: { last_token_usage: usage, total_token_usage: usage },
          rate_limits: reset === null ? null : { plan_type: 'pro', secondary: { window_minutes: 10080, used_percent: 20, resets_at: reset / 1000 } } } }
      ].map(record => JSON.stringify(record)).join('\n'));
    };
    try {
      writeFileSync(path.join(cache, 'quota-calibration.json'), JSON.stringify({ version: 1, costPerPercent: 1, quotaPercent: 5, windowStart: start - 10000, updatedAt: start }));
      write(sessions, 'a.jsonl', 'parent', 100000, end);
      write(sessions, 'b.jsonl', 'parent', 100000, end, undefined, start + 2000);
      write(archives, 'child.jsonl', 'child', 100000, end, 'parent');
      write(sessions, 'other.jsonl', 'other', 200000, end - 86400000);
      write(sessions, 'unknown.jsonl', 'unknown', 100000, null);
      write(sessions, 'unpriced.jsonl', 'unpriced', 100000, end, undefined, start + 1000, 'unknown-model');
      const reader = new HistoryJobReader(sessions, path.join(cache, 'quota.json'));
      const args = { nowMs: now, usageWindow: window, account: { type: 'chatgpt', email: 'current@example.com', planType: 'pro' } };
      const response = reader.listJobs(args);
      const parent = response.data.find(job => job.id === 'parent')!;
      expect(parent).toMatchObject({ currentAccountEquivalentPercent: 1.5, currentAccountEquivalentIsComplete: true, estimated20xPercent: 1.5, estimatedUsagePercentSinceReset: null });
      expect(response.data.find(job => job.id === 'other')).toMatchObject({ currentAccountEquivalentPercent: 0, estimated20xPercent: 1 });
      expect(response.data.find(job => job.id === 'unknown')).toMatchObject({ currentAccountEquivalentPercent: null, currentAccountEquivalentIsComplete: false, estimated20xPercent: 0.5 });
      expect(response.data.find(job => job.id === 'unpriced')).toMatchObject({ currentAccountEquivalentPercent: null, currentAccountEquivalentIsComplete: false });
      expect(response.usageAllocation.currentAccount?.email).toBe('current@example.com');
      expect(reader.listJobs({ ...args, period: 'lifetime' }).data.find(job => job.id === 'parent')?.currentAccountEquivalentPercent).toBe(1.5);
      expect(new HistoryJobReader(sessions, path.join(cache, 'quota.json')).listJobs(args).data).toEqual(response.data);
      const group = groupTasksByProject(response.data, [parent], 'usage')[0];
      expect(group).toMatchObject({ quotaPercent: 1.5, quotaIsComplete: false, jobs: [parent] });
      expect(visibleTasks(response.data, new Set(), 'all', '', 'usage', now)[0].id).toBe('parent');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
