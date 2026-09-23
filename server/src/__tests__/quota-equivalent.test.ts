import { describe, expect, it } from 'vitest';
import type { HistoryJob } from '../../../shared/monitor';
import { QuotaCalibration, calibrate20x, equivalent20x, pro20xWeeklyLimit, type QuotaCalibrationEvent } from '../quota-equivalent';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseHistorySessionFile } from '../history-jobs';
import { groupTasksByProject, visibleTasks } from '../../../web/src/presentation';

const start = Date.parse('2026-09-21T00:00:00Z');
const end = start + 604800000;
const event = (minute: number, used: number, cost: number | null, reset = end): QuotaCalibrationEvent =>
  ({ at: start + minute * 60000, cost, limit: { used, resetsAt: reset } });

describe('20x weekly equivalents', () => {
  it('keeps previously read parallel costs when archives are hidden, including after restarting, and accepts fresh samples', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'monitor-calibration-'));
    const file = path.join(dir, 'reference.json');
    try {
      const first = { ...event(0, 0, 0), id: 'active:0' };
      const archived = { ...event(1, 0, 10), id: 'archived:0' };
      const last = { ...event(2, 5, 10), id: 'active:1' };
      const full = new QuotaCalibration(file);
      expect(full.resolve([first, archived, last], start, start + 180000).costPerPercent).toBe(4);
      expect(full.resolve([first, last], start, start + 240000).costPerPercent).toBe(4);
      const restarted = new QuotaCalibration(file);
      expect(restarted.resolve([first, last], start, start + 300000).costPerPercent).toBe(4);
      expect(restarted.resolve([first, last, { ...event(6, 10, 10), id: 'active:2' }], start, start + 420000))
        .toMatchObject({ costPerPercent: 3, quotaPercent: 10, source: 'current' });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('updates from newer samples after switching to an account with an earlier weekly start', () => {
    const calibration = new QuotaCalibration();
    const day = 86400000;
    const newerWindow = [event(1440, 0, 0, end + day), event(1441, 5, 10, end + day)];
    expect(calibration.resolve(newerWindow, start + day, start + day + 120000).costPerPercent).toBe(2);
    // The previous account's samples are retained even when its tasks are no longer shown.
    expect(calibration.resolve([event(2880, 0, 0), event(2881, 5, 30)], start, start + 2 * day + 120000))
      .toMatchObject({ costPerPercent: 4, quotaPercent: 10, source: 'current', calibratedAt: new Date(start + 2 * day + 60000).toISOString() });
  });

  it('retries a failed save on a later ordinary refresh even if no further events arrive', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'monitor-calibration-'));
    const blocked = path.join(dir, 'blocked');
    const file = path.join(blocked, 'reference.json');
    try {
      writeFileSync(blocked, 'temporarily prevents directory creation');
      const calibration = new QuotaCalibration(file);
      expect(calibration.resolve([event(0, 0, 0), event(1, 5, 10)], start, start + 120000).costPerPercent).toBe(2);
      expect(existsSync(file)).toBe(false);
      rmSync(blocked);
      mkdirSync(blocked);
      calibration.resolve([], start, start + 125000);
      expect(existsSync(file)).toBe(false); // Failure retries are bounded to at most once per 30 seconds.
      calibration.resolve([], start, start + 151000);
      expect(JSON.parse(readFileSync(file, 'utf8')).costPerPercent).toBe(2);
      expect(new QuotaCalibration(file).resolve([], null, start + 180000).costPerPercent).toBe(2);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('keeps a legacy v1 reference until fresh samples qualify instead of trusting a narrower historical selection', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'monitor-calibration-'));
    const file = path.join(dir, 'reference.json');
    try {
      writeFileSync(file, JSON.stringify({ version: 1, costPerPercent: 4, quotaPercent: 5, windowStart: start, updatedAt: start + 120000 }));
      const calibration = new QuotaCalibration(file);
      const reduced = [event(0, 0, 0), event(2, 5, 10)];
      expect(calibration.resolve(reduced, start, start + 180000).costPerPercent).toBe(4);
      expect(calibration.resolve([...reduced, event(4, 6, 2)], start, start + 300000))
        .toMatchObject({ costPerPercent: 4, quotaPercent: 1, source: 'previous' });
      expect(new QuotaCalibration(file).resolve([...reduced, event(4, 6, 2), event(6, 10, 8)], start, start + 420000).costPerPercent).toBe(2);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('retains distinct parallel samples at the same timestamp and expires old samples without clearing the reference', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'monitor-calibration-'));
    const file = path.join(dir, 'reference.json');
    try {
      const calibration = new QuotaCalibration(file);
      const events = [{ ...event(0, 0, 0), id: 'a:0' }, { ...event(1, 0, 10), id: 'b:0' }, { ...event(1, 5, 10), id: 'a:1' }];
      expect(calibration.resolve(events, start, start + 120000).costPerPercent).toBe(4);
      expect(calibration.resolve(events, null, start + 31 * 86400000).costPerPercent).toBe(4);
      expect(JSON.parse(readFileSync(file, 'utf8')).samples).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('retains a valid reference through resets, sparse samples, restart and then replaces it with a qualified new reference', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'monitor-calibration-'));
    const file = path.join(dir, 'reference.json');
    try {
      const initial = new QuotaCalibration(file);
      expect(initial.resolve([event(0, 0, 0), event(1, 5, 10)], start, start + 120000)).toMatchObject({ costPerPercent: 2, source: 'current' });
      expect(initial.resolve([], start, start + 180000)).toMatchObject({ costPerPercent: 2, source: 'previous' });
      const restarted = new QuotaCalibration(file);
      const next = (minute: number, used: number, cost: number) => ({ at: end + minute * 60000, cost, limit: { used, resetsAt: end + 604800000 } });
      expect(restarted.resolve([next(0, 0, 0), next(1, 1, 3)], end, end + 120000)).toMatchObject({ costPerPercent: 2, quotaPercent: 1, source: 'previous' });
      expect(restarted.resolve([next(0, 0, 0), next(1, 5, 15)], end, end + 120000)).toMatchObject({ costPerPercent: 3, source: 'current' });
      expect(new QuotaCalibration(file).resolve([], null, end + 180000)).toMatchObject({ costPerPercent: 3, source: 'previous' });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('recovers a historical reference from loaded logs, but never invents one from insufficient or invalid data', () => {
    expect(new QuotaCalibration().resolve([event(0, 0, 0), event(1, 5, 10)], end, end + 120000))
      .toMatchObject({ costPerPercent: 2, source: 'previous', quotaPercent: 0 });
    expect(new QuotaCalibration().resolve([event(0, 0, 0), event(1, 1, 10)], end, end + 120000))
      .toMatchObject({ costPerPercent: null, source: 'unavailable' });
    const dir = mkdtempSync(path.join(os.tmpdir(), 'monitor-calibration-'));
    try {
      const file = path.join(dir, 'reference.json');
      writeFileSync(file, JSON.stringify({ version: 1, costPerPercent: -1, quotaPercent: 5, windowStart: start, updatedAt: start }));
      expect(new QuotaCalibration(file).resolve([], start, start + 120000).costPerPercent).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
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
    expect(parsed?.quotaCalibrationEvents?.map(e => e.id)).toEqual(['task:0', 'task:1']);
    const nextPeriod = parseHistorySessionFile({ sessionId: 'task', fileContent: lines.map(line => JSON.stringify(line)).join('\n'),
      updatedAt: new Date(start).toISOString(), nowMs: end + 120000, usageWindowStartedAtMs: end });
    expect(nextPeriod?.quotaCalibrationEvents).toEqual(parsed?.quotaCalibrationEvents);
    expect(nextPeriod?.sinceResetUsage).toBeNull();
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
