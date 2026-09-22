import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HistoryJobReader } from '../history-jobs';

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, openSync: vi.fn(actual.openSync) };
});

const nowMs = Date.parse('2026-05-15T12:00:00Z');
const usageWindow = { usedPercent: 0, startedAtMs: Date.parse('2026-05-10T00:00:00Z'),
  resetsAt: '2026-05-17T00:00:00Z', limitName: 'Overall Codex', windowLabel: 'Weekly' };

describe('archived task history', () => {
  let root: string;
  let sessions: string;
  let archives: string;
  let ledger: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-archives-'));
    sessions = path.join(root, 'sessions');
    archives = path.join(root, 'archived_sessions');
    ledger = path.join(root, 'cache', 'quota.json');
    fs.mkdirSync(sessions);
    fs.mkdirSync(archives);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('includes archives and archived children in quota attribution without counting a moved copy twice', () => {
    writeSession(archives, 'archived', 0);
    const reader = new HistoryJobReader(sessions, ledger);
    reader.listJobs({ nowMs, usageWindow, observeUsage: true });
    const active = writeSession(sessions, 'active', 100);
    fs.copyFileSync(active, path.join(archives, path.basename(active)));
    writeSession(archives, 'archived', 200);
    writeSession(archives, 'child', 100, 'active');
    const result = reader.listJobs({ nowMs, usageWindow: { ...usageWindow, usedPercent: 10 }, observeUsage: true });
    expect(result.total).toBe(2);
    expect(result.data.find(job => job.id === 'active')).toMatchObject({ archived: false, totalUsage: { totalTokens: 200 }, estimatedUsagePercentSinceReset: 5 });
    expect(result.data.find(job => job.id === 'archived')).toMatchObject({ archived: true, totalUsage: { totalTokens: 200 }, estimatedUsagePercentSinceReset: 5 });
    expect(result.usageAllocation.unattributedPercent).toBe(0);
  });

  it('preserves task totals and allocations when a task is archived and restored', () => {
    const reader = new HistoryJobReader(sessions, ledger);
    reader.listJobs({ nowMs, usageWindow, observeUsage: true });
    const active = writeSession(sessions, 'moving', 100);
    const args = { nowMs, usageWindow: { ...usageWindow, usedPercent: 3 }, observeUsage: true };
    const before = reader.listJobs(args);
    const archived = path.join(archives, path.basename(active));
    fs.renameSync(active, archived);
    const after = reader.listJobs(args);
    expect(after.data).toEqual(before.data.map(job => ({ ...job, archived: true })));
    expect(after.usageAllocation).toEqual(before.usageAllocation);
    fs.renameSync(archived, active);
    expect(reader.listJobs(args)).toEqual(before);
    expect(JSON.parse(fs.readFileSync(path.join(root, 'cache', 'archived-history.json'), 'utf8')).entries).toHaveLength(0);
  });

  it('reuses old archive summaries after restart and a quota reset, but reparses changed files', () => {
    writeSession(archives, 'old', 100);
    const nextWindow = { ...usageWindow, startedAtMs: Date.parse('2026-05-14T00:00:00Z'), resetsAt: '2026-05-21T00:00:00Z' };
    const first = new HistoryJobReader(sessions, ledger).listJobs({ nowMs, usageWindow: nextWindow });
    vi.mocked(fs.openSync).mockClear();
    const restarted = new HistoryJobReader(sessions, ledger);
    // Startup can list history before account quota is available.
    expect(restarted.listJobs({ nowMs }).data).toEqual(first.data.map(job => ({ ...job,
      estimated20xIsComplete: false,
      periodMetrics: { ...job.periodMetrics, usage: null, costUsd: null, costComplete: false, tokensComplete: false }
    })));
    const cached = restarted.listJobs({ nowMs: nowMs + 7 * 86400000, usageWindow: { ...nextWindow, startedAtMs: Date.parse('2026-05-21T00:00:00Z'), resetsAt: '2026-05-28T00:00:00Z' } });
    expect(cached.data).toEqual(first.data);
    expect(fs.openSync).not.toHaveBeenCalled();
    writeSession(archives, 'old', 12345);
    expect(restarted.listJobs({ nowMs, usageWindow: nextWindow }).data[0].totalUsage?.totalTokens).toBe(12345);
    expect(fs.openSync).toHaveBeenCalled();
  });

  it('clears period usage without rescanning an old archive while keeping the cached period reusable', () => {
    writeSession(archives, 'period', 100);
    const first = new HistoryJobReader(sessions, ledger).listJobs({ nowMs, usageWindow });
    expect(first.data[0].sinceResetUsage?.totalTokens).toBe(100);
    const reader = new HistoryJobReader(sessions, ledger);
    vi.mocked(fs.openSync).mockClear();
    expect(reader.listJobs({ nowMs }).data[0].sinceResetUsage).toBeNull();
    expect(reader.listJobs({ nowMs, usageWindow: { ...usageWindow, startedAtMs: nowMs - 86400000 } }).data[0].sinceResetUsage).toBeNull();
    expect(reader.listJobs({ nowMs, usageWindow }).data[0].sinceResetUsage?.totalTokens).toBe(100);
    expect(fs.openSync).not.toHaveBeenCalled();
  });

  it('expires cached recent usage and clears the previous period after a reset', () => {
    writeSession(archives, 'recent', 100);
    const first = new HistoryJobReader(sessions, ledger).listJobs({ nowMs: Date.parse('2026-05-12T12:00:00Z'), usageWindow });
    expect(first.data[0].last24HoursUsage?.totalTokens).toBe(100);
    expect(first.data[0].sinceResetUsage?.totalTokens).toBe(100);
    const later = new HistoryJobReader(sessions, ledger).listJobs({ nowMs, usageWindow: { ...usageWindow, startedAtMs: Date.parse('2026-05-14T00:00:00Z') } });
    expect(later.data[0].last24HoursUsage).toBeNull();
    expect(later.data[0].sinceResetUsage).toBeNull();
    expect(later.data[0].totalUsage?.totalTokens).toBe(100);
  });

  it('rebuilds an invalid cache from unchanged original logs', () => {
    const file = writeSession(archives, 'recoverable', 123);
    const original = fs.readFileSync(file, 'utf8');
    fs.mkdirSync(path.dirname(ledger));
    fs.writeFileSync(path.join(root, 'cache', 'archived-history.json'), '{broken');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(new HistoryJobReader(sessions, ledger).listJobs({ nowMs }).data[0].totalUsage?.totalTokens).toBe(123);
    expect(warning).toHaveBeenCalled();
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
  });

  it('loads archived titles from the local desktop index without needing an archived-thread API query', () => {
    writeSession(sessions, 'active', 100);
    writeSession(archives, 'archived', 200);
    fs.writeFileSync(path.join(root, 'session_index.jsonl'), [
      { id: 'active', thread_name: 'Active title' },
      { id: 'archived', thread_name: 'Archive title' }
    ].map(record => JSON.stringify(record)).join('\n'));
    const result = new HistoryJobReader(sessions).listJobs({ nowMs });
    expect(result.data.find(job => job.id === 'archived')).toMatchObject({ name: 'Archive title', archived: true });
    expect(result.data.find(job => job.id === 'active')?.name).toBe('Active title');
  });

  it('selects the newest 30 archive roots before opening logs, and scans older ones only on explicit request', () => {
    const db = new DatabaseSync(path.join(root, 'state_5.sqlite'));
    db.exec('CREATE TABLE threads (id TEXT, archived INTEGER, archived_at INTEGER, source TEXT)');
    const insert = db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?)');
    const ids = Array.from({ length: 35 }, (_, i) => `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`);
    ids.forEach((id, index) => {
      writeSession(archives, id, index + 1);
      insert.run(id, 1, 1790000000 + index, 'vscode');
      // Activity order is deliberately opposite to the archive-action order.
      fs.utimesSync(path.join(archives, `rollout-${id}.jsonl`), 1790001000 - index, 1790001000 - index);
    });
    const activeId = '10000000-0000-0000-0000-000000000000';
    const childId = '20000000-0000-0000-0000-000000000000';
    const oldChildId = '30000000-0000-0000-0000-000000000000';
    writeSession(sessions, activeId, 50);
    writeSession(archives, childId, 5, ids[34]);
    writeSession(archives, oldChildId, 100, ids[0]);
    insert.run(activeId, 0, null, 'vscode');
    insert.run(childId, 1, 1790000100, JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: ids[34] } } }));
    insert.run(oldChildId, 1, 1790000200, JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: ids[0] } } }));
    db.close();
    const reader = new HistoryJobReader(sessions, ledger);
    vi.mocked(fs.openSync).mockClear();
    const recent = reader.listJobs({ nowMs, limit: 100, usageWindow, observeUsage: true });
    expect(recent.archives).toEqual({ mode: 'recent', included: 30, total: 35 });
    expect(recent.total).toBe(31);
    expect(recent.data.filter(job => job.archived).map(job => job.id).sort()).toEqual(ids.slice(5));
    expect(recent.data.find(job => job.id === ids[34])?.totalUsage?.totalTokens).toBe(40);
    const opened = vi.mocked(fs.openSync).mock.calls.map(call => String(call[0]));
    expect(opened.filter(file => file.startsWith(archives))).toHaveLength(31); // 30 roots + one included child
    for (const id of [...ids.slice(0, 5), oldChildId]) expect(opened).not.toContain(path.join(archives, `rollout-${id}.jsonl`));

    const all = reader.listJobs({ nowMs, limit: 100, archiveMode: 'all' });
    expect(all.archives).toEqual({ mode: 'all', included: 35, total: 35 });
    expect(all.total).toBe(36);
    expect(all.data.find(job => job.id === ids[0])?.totalUsage?.totalTokens).toBe(101);
    // Cache availability, a changed old log, search, and pagination never expand recent mode.
    writeSession(archives, ids[0], 999);
    vi.mocked(fs.openSync).mockClear();
    expect(reader.listJobs({ nowMs, limit: 100 }).total).toBe(31);
    expect(reader.listJobs({ nowMs, searchTerm: ids[0] }).data).toEqual([]);
    const page = reader.listJobs({ nowMs, limit: 10, cursor: '20' });
    expect(page.archives).toEqual(recent.archives);
    expect(vi.mocked(fs.openSync).mock.calls.map(call => String(call[0]))).not.toContain(path.join(archives, `rollout-${ids[0]}.jsonl`));
    expect(new HistoryJobReader(sessions, ledger).listJobs({ nowMs, limit: 100 }).total).toBe(31);
  });

  it('uses bounded headers without a database and keeps descendants of active tasks', () => {
    const ids = Array.from({ length: 35 }, (_, i) => `fallback-${i}`);
    ids.forEach((id, index) => {
      const file = writeSession(archives, id, index + 1);
      fs.utimesSync(file, 1790000000 + index, 1790000000 + index);
    });
    writeSession(sessions, 'active-root', 50);
    writeSession(archives, 'active-child', 7, 'active-root');
    const result = new HistoryJobReader(sessions).listJobs({ nowMs, limit: 100 });
    expect(result.archives).toEqual({ mode: 'recent', total: 35, included: 30 });
    expect(result.data.find(job => job.id === 'active-root')?.totalUsage?.totalTokens).toBe(57);
    expect(result.data.some(job => job.id === 'fallback-0')).toBe(false);
    expect(result.data.some(job => job.id === 'fallback-34')).toBe(true);
  });
});

function writeSession(directory: string, id: string, tokens: number, parent?: string): string {
  const file = path.join(directory, `rollout-${id}.jsonl`);
  const timestamp = '2026-05-12T09:00:00Z';
  const usage = { input_tokens: tokens, output_tokens: 0, total_tokens: tokens };
  const records = [
    { timestamp, type: 'session_meta', payload: { id, timestamp, source: parent ? 'subAgent' : 'cli', parent_thread_id: parent } },
    { timestamp, type: 'turn_context', payload: { model: 'gpt-5.6-sol' } },
    { timestamp, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: usage, last_token_usage: usage } } }
  ];
  fs.writeFileSync(file, records.map(record => JSON.stringify(record)).join('\n'));
  return file;
}
