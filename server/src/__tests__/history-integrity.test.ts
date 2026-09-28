import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HistoryJobReader, parseHistorySessionFile } from '../history-jobs';
import { MAX_SESSION_LOG_LINE_BYTES } from '../session-log-reader';

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, readdirSync: vi.fn(actual.readdirSync), statSync: vi.fn(actual.statSync),
    openSync: vi.fn(actual.openSync), readSync: vi.fn(actual.readSync) };
});

const at = Date.parse('2026-09-23T10:00:00Z');
const iso = (time: number) => new Date(time).toISOString();
const usage = (tokens: number) => ({ input_tokens: tokens, output_tokens: 0, cached_input_tokens: 0, total_tokens: tokens });
const meta = (id: string, time: number, fields = {}) => ({ timestamp: iso(time), type: 'session_meta',
  payload: { id, timestamp: iso(time), source: 'cli', ...fields } });
const model = { timestamp: iso(at), type: 'turn_context', payload: { model: 'gpt-6-astra' } };
const token = (time: number, increment: unknown, cumulative: unknown = increment) => ({ timestamp: iso(time),
  type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: increment, total_token_usage: cumulative } } });
const lines = (records: unknown[]) => records.map(record => JSON.stringify(record)).join('\n') + '\n';

describe('history source and usage integrity', () => {
  let root: string;
  let sessions: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-integrity-'));
    sessions = path.join(root, 'sessions');
    fs.mkdirSync(sessions);
    fs.mkdirSync(path.join(root, 'archived_sessions'));
  });
  afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });
  const options = { nowMs: at + 10000, period: 'lifetime' as const };
  function write(id: string, records: unknown[]) {
    const file = path.join(sessions, `rollout-${id}.jsonl`);
    fs.writeFileSync(file, lines(records));
    return file;
  }

  it.each(['ancestor-header', 'forked_from_id', 'forkedFromId'])('excludes %s inherited usage and keeps subsequent appends exactly once', mode => {
    const inherited = [meta('parent', at), model, token(at + 1000, usage(100))];
    write('parent', inherited);
    const childMeta = meta('child', at + 2000, { source: 'subAgent', parent_thread_id: 'parent',
      ...(mode === 'ancestor-header' ? {} : { [mode]: 'parent' }) });
    const child = write('child', [childMeta, ...(mode === 'ancestor-header' ? inherited : inherited.slice(1)),
      // A quota-only refresh repeats inherited counters after the fork time.
      token(at + 2500, usage(100)), token(at + 3000, usage(50), usage(150))]);
    const reader = new HistoryJobReader(sessions);
    const first = reader.listJobs(options);
    expect(first.data).toHaveLength(1);
    expect(first.data[0]).toMatchObject({ id: 'parent', totalUsage: { totalTokens: 150 }, totalEstimatedCostUsd: 0.0015,
      totalEstimatedCostIsComplete: true });
    expect(first.analysis?.days.reduce((sum, day) => sum + day.usage.totalTokens, 0)).toBe(150);
    const parsedChild = parseHistorySessionFile({ sessionId: 'child', fileContent: fs.readFileSync(child, 'utf8'),
      updatedAt: iso(at + 4000), nowMs: at + 10000 });
    expect(parsedChild).toMatchObject({ createdAt: iso(at + 2000), totalUsage: { totalTokens: 50 } });
    expect(parsedChild?.quotaCalibrationEvents?.some(event => event.at < at + 2000)).toBe(false);
    fs.appendFileSync(child, lines([token(at + 4000, usage(25), usage(175))]));
    expect(reader.listJobs(options).data[0].totalUsage?.totalTokens).toBe(175);
    expect(reader.listJobs(options).data[0].totalUsage?.totalTokens).toBe(175);
  });

  it('does not call undated inherited counters new consumption', () => {
    const inherited = token(at + 1000, usage(100));
    const { timestamp: _timestamp, ...undated } = inherited;
    write('child', [meta('child', at + 2000, { forked_from_id: 'parent' }), model, undated,
      token(at + 3000, usage(50), usage(150))]);
    const job = new HistoryJobReader(sessions).listJobs(options).data[0];
    expect(job).toMatchObject({ totalUsage: { totalTokens: 50 }, totalEstimatedCostIsComplete: false,
      periodMetrics: { tokensComplete: false, costComplete: false } });
  });

  it('re-reads v2 archive logs instead of trusting compact records that omitted the fork marker', () => {
    const file = path.join(root, 'archived_sessions', 'rollout-fork.jsonl');
    fs.writeFileSync(file, lines([meta('fork', at + 2000, { forked_from_id: 'parent' }), model,
      token(at + 1000, usage(100)), token(at + 3000, usage(50), usage(150))]));
    const ledger = path.join(root, 'cache', 'quota.json');
    expect(new HistoryJobReader(sessions, ledger).listJobs(options).data[0].totalUsage?.totalTokens).toBe(50);
    const cacheFile = path.join(root, 'cache', 'archived-history.json');
    const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    cache.version = 2;
    cache.entries[0][1].job.quotaCalibrationVersion = 6;
    cache.entries[0][1].job.totalUsage.totalTokens = 150;
    cache.entries[0][1].compact.records = cache.entries[0][1].compact.records.map((line: string) => {
      const record = JSON.parse(line);
      if (record.type === 'session_meta') delete record.payload.forked_from_id;
      return JSON.stringify(record);
    });
    fs.writeFileSync(cacheFile, JSON.stringify(cache));
    vi.mocked(fs.openSync).mockClear();
    expect(new HistoryJobReader(sessions, ledger).listJobs(options).data[0].totalUsage?.totalTokens).toBe(50);
    expect(vi.mocked(fs.openSync).mock.calls.some(call => String(call[0]) === file)).toBe(true);
    expect(JSON.parse(fs.readFileSync(cacheFile, 'utf8')).version).toBe(4);
  });

  it.each(['directory', 'stat', 'read'])('fails a %s error without returning or persisting a false empty snapshot', failure => {
    const file = write('task', [meta('task', at), model, token(at + 1000, usage(100))]);
    const reader = new HistoryJobReader(sessions);
    expect(reader.listJobs(options).data[0].totalUsage?.totalTokens).toBe(100);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const deny = Object.assign(new Error('temporary denial'), { code: 'EACCES' });
    if (failure === 'directory') {
      const readDirectory = vi.mocked(fs.readdirSync).getMockImplementation()!;
      let denied = false;
      vi.mocked(fs.readdirSync).mockImplementation((...args) => {
        if (!denied && String(args[0]) === sessions) { denied = true; throw deny; }
        return readDirectory(...args);
      });
    }
    else if (failure === 'stat') vi.mocked(fs.statSync).mockImplementationOnce(() => { throw deny; });
    else {
      fs.appendFileSync(file, lines([token(at + 2000, usage(25), usage(125))]));
      vi.mocked(fs.openSync).mockImplementationOnce(() => { throw deny; });
    }
    expect(() => reader.listJobs(options)).toThrow(/Could not (scan|read) local task statistics/);
    expect(reader.listJobs(options).data[0].totalUsage?.totalTokens).toBe(failure === 'read' ? 125 : 100);
    expect(reader.listJobs(options).data[0].totalUsage?.totalTokens).toBe(failure === 'read' ? 125 : 100);
    error.mockRestore();
  });

  it('keeps a last valid archive cache when a force rebuild cannot scan the archive directory', () => {
    fs.writeFileSync(path.join(root, 'archived_sessions', 'rollout-task.jsonl'), lines([meta('task', at), model, token(at + 1000, usage(100))]));
    const reader = new HistoryJobReader(sessions, path.join(root, 'cache', 'quota.json'));
    expect(reader.listJobs(options).data[0].totalUsage?.totalTokens).toBe(100);
    const cacheFile = path.join(root, 'cache', 'archived-history.json');
    const before = fs.readFileSync(cacheFile, 'utf8');
    const readDirectory = vi.mocked(fs.readdirSync).getMockImplementation()!;
    vi.mocked(fs.readdirSync).mockImplementation((...args) => {
      if (String(args[0]) === path.join(root, 'archived_sessions')) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return readDirectory(...args);
    });
    expect(() => reader.listJobs({ ...options, forceRefresh: true })).toThrow('Could not scan local task statistics');
    expect(fs.readFileSync(cacheFile, 'utf8')).toBe(before);
    vi.mocked(fs.readdirSync).mockRestore();
    expect(reader.listJobs(options).data[0].totalUsage?.totalTokens).toBe(100);
  });

  it('retains a successfully parsed summary when a force rebuild fails while reading the unchanged file', () => {
    const file = write('task', [meta('task', at), model, token(at + 1000, usage(100))]);
    const reader = new HistoryJobReader(sessions);
    const first = reader.listJobs(options);
    const realOpen = vi.mocked(fs.openSync).getMockImplementation()!;
    let reads = 0;
    vi.mocked(fs.openSync).mockImplementation((...args) => {
      if (String(args[0]) === file && ++reads === 2) throw new Error('temporary full read failure');
      return realOpen(...args);
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => reader.listJobs({ ...options, forceRefresh: true })).toThrow('Could not read local task statistics');
    vi.mocked(fs.openSync).mockRestore();
    vi.mocked(fs.openSync).mockClear();
    expect(reader.listJobs(options).data).toEqual(first.data);
    expect(fs.openSync).not.toHaveBeenCalled();
  });

  it('accepts a never-created sessions directory but rejects its disappearance after a successful populated scan', () => {
    const missing = path.join(root, 'new-install', 'sessions');
    expect(new HistoryJobReader(missing).listJobs(options).total).toBe(0);
    write('task', [meta('task', at), model, token(at + 1000, usage(100))]);
    const reader = new HistoryJobReader(sessions);
    reader.listJobs(options);
    fs.renameSync(sessions, path.join(root, 'temporarily-unavailable'));
    expect(() => reader.listJobs(options)).toThrow('Could not scan local task statistics');
    fs.renameSync(path.join(root, 'temporarily-unavailable'), sessions);
    expect(reader.listJobs(options).data[0].totalUsage?.totalTokens).toBe(100);
  });

  it('fails bounded oversized records repeatedly without re-reading or publishing partial usage', () => {
    const file = write('task', [meta('task', at), model, token(at + 1000, usage(100))]);
    const reader = new HistoryJobReader(sessions);
    reader.listJobs(options);
    fs.appendFileSync(file, 'x'.repeat(MAX_SESSION_LOG_LINE_BYTES + 1));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => reader.listJobs(options)).toThrow('Could not read local task statistics');
    vi.mocked(fs.readSync).mockClear();
    expect(() => reader.listJobs(options)).toThrow('Could not read local task statistics');
    expect(fs.readSync).not.toHaveBeenCalled();
    fs.writeFileSync(file, lines([meta('task', at), model, token(at + 1000, usage(100)), token(at + 2000, usage(25), usage(125))]));
    expect(reader.listJobs(options).data[0].totalUsage?.totalTokens).toBe(125);
  });

  it.each([
    { total_tokens: 100 },
    { input_tokens: -1, output_tokens: 0, total_tokens: 100 },
    { input_tokens: '100', output_tokens: 0, total_tokens: 100 },
    { input_tokens: 100.5, output_tokens: 0, total_tokens: 100 },
    { input_tokens: null, output_tokens: 0, total_tokens: 100 },
    { input_tokens: false, output_tokens: 0, total_tokens: 100 },
    { input_tokens: 100, output_tokens: 0, cached_input_tokens: 101, total_tokens: 100 },
    { input_tokens: 100, output_tokens: 0, cached_input_tokens: null, total_tokens: 100 }
  ])('retains known totals but marks malformed counters incomplete: %j', counters => {
    write('task', [meta('task', at), model, token(at + 1000, counters)]);
    const reader = new HistoryJobReader(sessions);
    for (const period of ['lifetime', 'today', 'quota'] as const) {
      const job = reader.listJobs({ ...options, period, usageWindow: { startedAtMs: at - 1000,
        resetsAt: iso(at - 1000 + 604800000), usedPercent: 10, limitName: 'Codex', windowLabel: 'Weekly' } }).data[0];
      expect(job.totalUsage?.totalTokens).toBe(100);
      expect(job.totalEstimatedCostUsd).toBeNull();
      expect(job.totalEstimatedCostIsComplete).toBe(false);
      expect(job.periodMetrics).toMatchObject({ usage: { totalTokens: 100 }, costUsd: null, costComplete: false,
        tokensComplete: false, unpricedTokens: 100 });
    }
  });

  it('keeps known costs as a lower bound and ignores a malformed last report only when valid cumulative counters prove a duplicate', () => {
    const file = write('task', [meta('task', at), model, token(at + 1000, usage(50)),
      token(at + 2000, { input_tokens: 0, output_tokens: 0, total_tokens: 25187 }, usage(50))]);
    const reader = new HistoryJobReader(sessions);
    expect(reader.listJobs(options).data[0]).toMatchObject({ totalUsage: { totalTokens: 50 },
      totalEstimatedCostUsd: 0.0005, totalEstimatedCostIsComplete: true });
    fs.appendFileSync(file, lines([token(at + 3000, { total_tokens: 100 }, usage(150))]));
    expect(reader.listJobs(options).data[0]).toMatchObject({ totalUsage: { totalTokens: 150 },
      totalEstimatedCostUsd: 0.0005, totalEstimatedCostIsComplete: false,
      periodMetrics: { costUsd: 0.0005, costComplete: false, unpricedTokens: 100 } });
  });
});
