import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HistoryJobReader } from '../history-jobs';
import { localDay } from '../../../shared/usage-period';

const now = new Date(2026, 8, 27, 18).getTime();
const hour = (days: number, h = 10) => new Date(2026, 8, 27 - days, h).getTime();
const tokens = (n: number) => ({ input_tokens: n, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: n });
const event = (at: number | null, increment: number, cumulative = increment) => ({
  timestamp: at === null ? undefined : new Date(at).toISOString(), type: 'event_msg',
  payload: { type: 'token_count', info: { last_token_usage: tokens(increment), total_token_usage: tokens(cumulative) } }
});
const window = { startedAtMs: hour(0, 9), resetsAt: new Date(hour(0, 9) + 604800000).toISOString(),
  usedPercent: 10, limitName: 'Overall Codex', windowLabel: 'Weekly' };

describe('rollout overlap and unavailable parents', () => {
  let root: string;
  let sessions: string;
  let archives: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'monitor-merge-'));
    sessions = path.join(root, 'sessions'); archives = path.join(root, 'archived_sessions');
    mkdirSync(sessions); mkdirSync(archives);
    writeFileSync(path.join(root, 'quota-calibration.json'), JSON.stringify({ version: 1, costPerPercent: .01,
      quotaPercent: 5, windowStart: hour(1), updatedAt: now }));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const reader = () => new HistoryJobReader(sessions, path.join(root, 'attribution.json'));
  function write(file: string, id: string, events: unknown[], options: { parent?: string; subagent?: boolean; archive?: boolean; model?: string } = {}) {
    const dest = path.join(options.archive ? archives : sessions, `rollout-${file}.jsonl`);
    writeFileSync(dest, [
      { type: 'session_meta', payload: { id, source: options.subagent ? 'subAgentOther' : 'cli', parent_thread_id: options.parent } },
      { type: 'turn_context', payload: { model: options.model ?? 'gpt-6-astra' } }, ...events
    ].map(line => JSON.stringify(line)).join('\n'));
    return dest;
  }

  it('counts exact rollout copies once in totals, days, windows and equivalent estimates', () => {
    const events = [
      { timestamp: new Date(hour(1)).toISOString(), type: 'event_msg', payload: { type: 'task_started', turn_id: 'first' } },
      event(hour(1), 500),
      { timestamp: new Date(hour(1) + 1000).toISOString(), type: 'event_msg', payload: { type: 'task_complete', turn_id: 'first', duration_ms: 1000 } },
      { timestamp: new Date(hour(0)).toISOString(), type: 'event_msg', payload: { type: 'task_started', turn_id: 'second' } },
      event(hour(0), 1000, 1500),
      { timestamp: new Date(hour(0) + 2000).toISOString(), type: 'event_msg', payload: { type: 'task_complete', turn_id: 'second', duration_ms: 2000 } }
    ];
    write('a', 'task', events); write('b', 'task', events);
    const monitor = reader();
    const lifetime = monitor.listJobs({ nowMs: now, period: 'lifetime', usageWindow: window });
    expect(lifetime.data).toHaveLength(1);
    expect(lifetime.data[0]).toMatchObject({ runCount: 2, totalDurationMs: 3000, totalUsage: { totalTokens: 1500 }, totalEstimatedCostUsd: .015,
      sinceResetUsage: { totalTokens: 1000 }, sinceResetEstimatedCostUsd: .01,
      last24HoursUsage: { totalTokens: 1000 }, last24HoursEstimatedCostUsd: .01, lifetime20xPercent: 1.5 });
    expect(lifetime.analysis?.days.map(day => day.usage.totalTokens)).toEqual([500, 1000]);
    expect(lifetime.data[0]).not.toHaveProperty('usageEvents');
    const today = monitor.listJobs({ nowMs: now, period: 'today', usageWindow: window });
    expect(today.data[0]).toMatchObject({ estimated20xPercent: 1, periodMetrics: { usage: { totalTokens: 1000 }, costUsd: .01 } });
    expect(today.analysis?.days).toHaveLength(1);
  });

  it('keeps new responses from overlapping fragments even when response sizes match', () => {
    const first = event(hour(0, 10), 1000), overlap = event(hour(0, 11), 1000, 2000), last = event(hour(0, 12), 1000, 3000);
    write('a', 'task', [first, overlap]); write('b', 'task', [overlap, last]); write('c', 'task', [last]);
    const result = reader().listJobs({ nowMs: now, period: 'today', usageWindow: window });
    expect(result.data[0].totalUsage?.totalTokens).toBe(3000);
    expect(result.data[0].totalEstimatedCostUsd).toBeCloseTo(.03);
    expect(result.analysis?.days[0].usage.totalTokens).toBe(3000);
    expect(result.data[0].estimated20xPercent).toBeCloseTo(3);
  });

  it('uses the full rollout evidence when a fragment starts with a repeated quota notification', () => {
    const first = event(hour(1), 1000), refresh = event(hour(0), 1000);
    write('full', 'task', [first, refresh]); write('fragment', 'task', [refresh]);
    const result = reader().listJobs({ nowMs: now, period: 'today', usageWindow: window });
    expect(result.data[0].totalUsage?.totalTokens).toBe(1000);
    expect(result.data[0].sinceResetUsage).toBeNull();
    expect(result.data[0].periodMetrics?.usage?.totalTokens).toBe(0);
    expect(result.analysis?.days).toEqual([]);
  });

  it('deduplicates unpriced responses but retains undated records without inventing identities', () => {
    const sample = event(hour(0), 1000);
    write('a', 'task', [sample], { model: 'unknown-model' });
    write('b', 'task', [sample], { model: 'unknown-model' });
    write('c', 'task', [event(null, 100)], { model: 'unknown-model' });
    const result = reader().listJobs({ nowMs: now, period: 'lifetime' });
    expect(result.data[0]).toMatchObject({ totalUsage: { totalTokens: 1100 }, totalEstimatedCostUsd: null, totalEstimatedCostIsComplete: false });
    expect(result.analysis).toMatchObject({ untimedTokens: 100, unpricedTokens: 1100 });
    expect(result.analysis?.days[0]).toMatchObject({ usage: { totalTokens: 1000 }, costUsd: null, unpricedTokens: 1000 });
  });

  it('retains missing-parent, parentless and cyclic subagents instead of dropping their usage', () => {
    write('missing', 'missing', [event(hour(0), 100)], { subagent: true, parent: 'absent' });
    write('parentless', 'parentless', [event(hour(0), 200)], { subagent: true });
    write('cycle1', 'cycle1', [event(hour(0), 300)], { subagent: true, parent: 'cycle2' });
    write('cycle2', 'cycle2', [event(hour(0), 400)], { subagent: true, parent: 'cycle1' });
    const result = reader().listJobs({ nowMs: now, period: 'today' });
    expect(result.total).toBe(4);
    expect(result.data.every(job => job.orphanedSubagent)).toBe(true);
    expect(result.analysis?.days[0].usage.totalTokens).toBe(1000);
    expect(result.data.reduce((sum, job) => sum + (job.periodMetrics?.usage?.totalTokens ?? 0), 0)).toBe(1000);
  });

  it('retains an active child whose parent is outside the recent 30 archives, then consolidates on all archives', () => {
    const old = write('old', 'old-parent', [event(hour(0), 100)], { archive: true });
    utimesSync(old, new Date(hour(3)), new Date(hour(3)));
    for (let i = 0; i < 30; i++) write(`new-${i}`, `new-${i}`, [], { archive: true });
    write('child', 'child', [event(hour(0), 200)], { subagent: true, parent: 'old-parent' });
    const monitor = reader();
    const recent = monitor.listJobs({ nowMs: now, period: 'today', limit: 100 });
    expect(recent.archives).toMatchObject({ included: 30, total: 31, mode: 'recent' });
    expect(recent.data.find(job => job.id === 'child')).toMatchObject({ orphanedSubagent: true, totalUsage: { totalTokens: 200 } });
    expect(recent.analysis?.days[0].usage.totalTokens).toBe(200);
    const all = monitor.listJobs({ nowMs: now, period: 'today', archiveMode: 'all', limit: 100 });
    expect(all.data.some(job => job.id === 'child')).toBe(false);
    expect(all.data.find(job => job.id === 'old-parent')?.totalUsage?.totalTokens).toBe(300);
    expect(all.analysis?.days[0].usage.totalTokens).toBe(300);
  });

  it('rejects a future custom start, and clamps a future end without reversing the interval', () => {
    const monitor = reader();
    expect(() => monitor.listJobs({ nowMs: now, period: 'custom', dateFrom: localDay(hour(-1)), dateTo: localDay(hour(-2)) })).toThrow('Invalid date range');
    expect(monitor.listJobs({ nowMs: now, period: 'custom', dateFrom: localDay(now), dateTo: localDay(hour(-1)) }).analysis)
      .toMatchObject({ endedAt: new Date(now).toISOString() });
  });
});
