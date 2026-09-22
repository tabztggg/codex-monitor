import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HistoryJobReader, parseHistorySessionFile } from '../history-jobs';

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, openSync: vi.fn(actual.openSync), readSync: vi.fn(actual.readSync), writeFileSync: vi.fn(actual.writeFileSync) };
});

const at = Date.parse('2026-09-22T10:00:00Z');
const iso = (time: number) => new Date(time).toISOString();
const usage = (tokens: number) => ({ input_tokens: tokens, cached_input_tokens: 0, output_tokens: 0, total_tokens: tokens });
const meta = (id: string, parent?: string) => ({ timestamp: iso(at), type: 'session_meta', payload: {
  id, timestamp: iso(at), cwd: 'C:/sample', source: parent ? { subagent: { thread_spawn: { parent_thread_id: parent } } } : 'cli'
} });
const model = { timestamp: iso(at), type: 'turn_context', payload: { model: 'gpt-6-astra' } };
const token = (time: number, increment: number, cumulative: number) => ({ timestamp: iso(time), type: 'event_msg', payload: {
  type: 'token_count', info: { last_token_usage: usage(increment), total_token_usage: usage(cumulative) }
} });
const event = (time: number, type: string, fields: Record<string, unknown> = {}) => ({ timestamp: iso(time), type: 'event_msg', payload: { type, ...fields } });
const lines = (records: unknown[]) => records.map(record => JSON.stringify(record)).join('\n') + '\n';
const windowAt = (start: number) => ({ startedAtMs: start, resetsAt: iso(start + 604800000), usedPercent: 10, limitName: 'Overall Codex', windowLabel: 'Weekly' });

describe('incremental task statistics', () => {
  let root: string;
  let sessions: string;
  let archives: string;
  let ledger: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-incremental-'));
    sessions = path.join(root, 'sessions');
    archives = path.join(root, 'archived_sessions');
    ledger = path.join(root, 'cache', 'quota.json');
    fs.mkdirSync(sessions); fs.mkdirSync(archives);
    vi.mocked(fs.openSync).mockClear(); vi.mocked(fs.readSync).mockClear();
  });
  afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

  it('does not reread a completed recent task as time passes, while its rolling usage expires', () => {
    const file = path.join(sessions, 'rollout-task.jsonl');
    fs.writeFileSync(file, lines([meta('task'), model, event(at, 'task_started', { turn_id: 'turn' }),
      token(at + 1000, 100, 100), event(at + 2000, 'task_complete', { turn_id: 'turn' })]));
    const reader = new HistoryJobReader(sessions);
    expect(reader.listJobs({ nowMs: at + 3000 }).data[0].last24HoursUsage?.totalTokens).toBe(100);
    vi.mocked(fs.openSync).mockClear(); vi.mocked(fs.readSync).mockClear();
    expect(reader.listJobs({ nowMs: at + 120000 }).data[0].totalDurationMs).toBe(2000);
    const later = reader.listJobs({ nowMs: at + 86400000 + 2000 }).data[0];
    expect(later.last24HoursUsage).toBeNull();
    expect(later.totalUsage?.totalTokens).toBe(100);
    expect(fs.openSync).not.toHaveBeenCalled();
    expect(fs.readSync).not.toHaveBeenCalled();
  });

  it('reads only appended bytes, keeps model and duplicate-counter state, and consumes the completion tail', () => {
    const file = path.join(sessions, 'rollout-task.jsonl');
    fs.writeFileSync(file, lines([meta('task'), model, event(at, 'task_started', { turn_id: 'turn' }),
      { timestamp: iso(at), type: 'response_item', payload: { type: 'function_call_output', output: 'x'.repeat(2 * 1024 * 1024) } },
      token(at + 1000, 100, 100)]));
    const reader = new HistoryJobReader(sessions);
    reader.listJobs({ nowMs: at + 2000 });
    vi.mocked(fs.readSync).mockClear();
    const appended = lines([token(at + 3000, 100, 100), token(at + 4000, 100, 200),
      event(at + 5000, 'task_complete', { turn_id: 'turn' })]);
    fs.appendFileSync(file, appended);
    const job = reader.listJobs({ nowMs: at + 6000 }).data[0];
    expect(job.totalUsage?.totalTokens).toBe(200);
    expect(job.totalEstimatedCostUsd).toBeCloseTo(0.002);
    expect(job.lastRunCompletedAt).toBe(iso(at + 5000));
    expect(job.lastRunDurationMs).toBe(5000);
    const bytes = vi.mocked(fs.readSync).mock.results.reduce((sum, result) => sum + (result.type === 'return' ? Number(result.value) : 0), 0);
    expect(bytes).toBeLessThanOrEqual(Buffer.byteLength(appended) + 512);
    const expected = parseHistorySessionFile({ sessionId: null, fileContent: fs.readFileSync(file, 'utf8'), updatedAt: iso(at), nowMs: at + 6000 });
    expect(job.totalUsage).toEqual(expected?.totalUsage);
    expect(job.totalDurationMs).toBe(expected?.totalDurationMs);
  });

  it('recomputes exact quota boundaries and open-turn duration without rereading the log', () => {
    const file = path.join(sessions, 'rollout-task.jsonl');
    fs.writeFileSync(file, lines([meta('task'), model, event(at, 'task_started', { turn_id: 'turn' }),
      token(at + 1000, 100, 100), token(at + 3000, 200, 300)]));
    const reader = new HistoryJobReader(sessions);
    expect(reader.listJobs({ nowMs: at + 4000, usageWindow: windowAt(at) }).data[0].sinceResetUsage?.totalTokens).toBe(300);
    vi.mocked(fs.openSync).mockClear(); vi.mocked(fs.readSync).mockClear();
    const changed = reader.listJobs({ nowMs: at + 5000, usageWindow: windowAt(at + 2000) }).data[0];
    expect(changed.sinceResetUsage?.totalTokens).toBe(200);
    expect(changed.lastRunDurationMs).toBe(5000);
    expect(reader.listJobs({ nowMs: at + 5000 }).data[0].sinceResetUsage).toBeNull();
    expect(reader.listJobs({ nowMs: at + 5000, usageWindow: windowAt(at) }).data[0].sinceResetUsage?.totalTokens).toBe(300);
    expect(fs.openSync).not.toHaveBeenCalled();
    expect(fs.readSync).not.toHaveBeenCalled();
  });

  it('persists compact archive records without instructions or tool contents and reuses them after restart', () => {
    const secret = 'PRIVATE_TOOL_CONTENT_DO_NOT_CACHE';
    const file = path.join(archives, 'rollout-task.jsonl');
    const records = [
      { ...meta('task'), payload: { ...meta('task').payload, instructions: secret.repeat(1000) } }, model,
      { timestamp: iso(at + 1000), type: 'response_item', payload: { type: 'function_call_output', output: secret.repeat(10000) } },
      { timestamp: iso(at + 2000), type: 'event_msg', payload: { type: 'user_message', message: 'Show usage totals' } },
      token(at + 3000, 100, 100)
    ];
    fs.writeFileSync(file, lines(records));
    new HistoryJobReader(sessions, ledger).listJobs({ nowMs: at + 4000, usageWindow: windowAt(at) });
    const cache = fs.readFileSync(path.join(root, 'cache', 'archived-history.json'), 'utf8');
    expect(cache).not.toContain(secret);
    expect(cache.length).toBeLessThan(10000);
    const reader = new HistoryJobReader(sessions, ledger);
    vi.mocked(fs.openSync).mockClear(); vi.mocked(fs.readSync).mockClear();
    vi.mocked(fs.writeFileSync).mockClear();
    const job = reader.listJobs({ nowMs: at + 86400000 + 4000, usageWindow: windowAt(at + 2000) }).data[0];
    expect(job.sinceResetUsage?.totalTokens).toBe(100);
    expect(job.last24HoursUsage).toBeNull();
    expect(job.preview).toBe('Show usage totals');
    expect(fs.openSync).not.toHaveBeenCalled();
    expect(fs.readSync).not.toHaveBeenCalled();
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  it('rebuilds after truncation and force refresh without clearing quota attribution', () => {
    const file = path.join(sessions, 'rollout-task.jsonl');
    fs.writeFileSync(file, lines([meta('task'), model, token(at + 1000, 100, 100)]));
    const reader = new HistoryJobReader(sessions, ledger);
    const args = { nowMs: at + 5000, usageWindow: windowAt(at), observeUsage: true };
    reader.listJobs(args);
    fs.appendFileSync(file, lines([token(at + 2000, 100, 200)]));
    const allocated = reader.listJobs({ ...args, usageWindow: { ...args.usageWindow, usedPercent: 11 } });
    expect(allocated.data[0].estimatedUsagePercentSinceReset).toBe(1);
    vi.mocked(fs.openSync).mockClear();
    const forced = reader.listJobs({ ...args, usageWindow: { ...args.usageWindow, usedPercent: 11 }, observeUsage: false, forceRefresh: true });
    expect(forced.data[0].estimatedUsagePercentSinceReset).toBe(1);
    expect(fs.openSync).toHaveBeenCalled();
    fs.writeFileSync(file, lines([meta('replacement'), model, token(at + 1000, 7, 7)]));
    const replaced = reader.listJobs({ nowMs: at + 5000 }).data;
    expect(replaced).toHaveLength(1);
    expect(replaced[0]).toMatchObject({ id: 'replacement', totalUsage: { totalTokens: 7 } });
  });

  it('keeps child identity and attributes incremental usage despite inherited parent metadata', () => {
    fs.writeFileSync(path.join(sessions, 'rollout-parent.jsonl'), lines([meta('parent'), model, token(at + 1000, 100, 100)]));
    const file = path.join(sessions, 'rollout-child.jsonl');
    fs.writeFileSync(file, lines([meta('child', 'parent'), meta('parent'), model, token(at + 1000, 20, 20)]));
    const reader = new HistoryJobReader(sessions);
    expect(reader.listJobs({ nowMs: at + 2000 }).data[0]).toMatchObject({ id: 'parent', totalUsage: { totalTokens: 120 } });
    fs.appendFileSync(file, lines([token(at + 3000, 30, 50)]));
    const result = reader.listJobs({ nowMs: at + 4000 });
    expect(result.total).toBe(1);
    expect(result.data[0]).toMatchObject({ id: 'parent', totalUsage: { totalTokens: 150 } });
  });

  it('does not lose incomplete tails or double count complete tails without a newline', () => {
    const file = path.join(sessions, 'rollout-task.jsonl');
    const tail = JSON.stringify(token(at + 1000, 100, 100));
    fs.writeFileSync(file, lines([meta('task'), model]) + tail.slice(0, -4));
    const reader = new HistoryJobReader(sessions);
    expect(reader.listJobs({ nowMs: at + 2000 }).data[0].totalUsage).toBeNull();
    fs.appendFileSync(file, tail.slice(-4));
    expect(reader.listJobs({ nowMs: at + 2000 }).data[0].totalUsage?.totalTokens).toBe(100);
    fs.appendFileSync(file, '\n' + lines([token(at + 3000, 50, 150)]));
    expect(reader.listJobs({ nowMs: at + 4000 }).data[0].totalUsage?.totalTokens).toBe(150);
  });
});
