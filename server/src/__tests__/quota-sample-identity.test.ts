import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HistoryJobReader, parseHistorySessionFile } from '../history-jobs';
import { QuotaCalibration } from '../quota-equivalent';

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, openSync: vi.fn(actual.openSync) };
});

const start = Date.parse('2026-09-21T00:00:00Z');
const iso = (at: number) => new Date(at).toISOString();
const usage = (tokens: number) => ({ input_tokens: tokens, output_tokens: 0, total_tokens: tokens });
const token = (at: number, cumulative = 1000, used = 10) => ({ timestamp: iso(at), type: 'event_msg', payload: {
  type: 'token_count', info: { last_token_usage: usage(1000), total_token_usage: usage(cumulative) },
  rate_limits: { plan_type: 'pro', limit_id: 'codex', primary: {
    window_minutes: 10080, used_percent: used, resets_at: (start + 604800000) / 1000
  } }
} });
const records = (events: unknown[], task = 'task') => [
  { type: 'session_meta', payload: { id: task, cwd: 'C:/private/workspace' } },
  { type: 'turn_context', payload: { model: 'gpt-6-astra' } }, ...events
];
const lines = (value: unknown[]) => value.map(record => JSON.stringify(record)).join('\n') + '\n';
const parse = (value: unknown[], nowMs = start + 120000) => parseHistorySessionFile({
  sessionId: null, fileContent: lines(value), updatedAt: iso(nowMs), nowMs
})!;

afterEach(() => vi.restoreAllMocks());

describe('quota calibration sample identity', () => {
  it('keeps independent fragments of the same task instead of colliding at event zero', () => {
    const first = parse(records([token(start)]));
    const second = parse(records([token(start + 60000, 2000, 15)]));
    expect(first.quotaCalibrationVersion).toBe(5);
    expect(first.quotaCalibrationEvents?.[0].id).toMatch(/^v3:[a-f0-9]{64}$/);
    expect(second.quotaCalibrationEvents?.[0].id).not.toBe(first.quotaCalibrationEvents?.[0].id);
    expect(first.quotaCalibrationEvents?.[0].streamId).toMatch(/^[a-f0-9]{64}$/);
    expect(second.quotaCalibrationEvents?.[0].streamId).toBe(first.quotaCalibrationEvents?.[0].streamId);
    expect(new Set([...first.quotaCalibrationEvents!, ...second.quotaCalibrationEvents!].map(event => event.id)).size).toBe(2);
  });

  it('distinguishes same-time statistical events and task identities while ignoring field order', () => {
    const original = token(start);
    const reordered = { payload: {
      rate_limits: { primary: { resets_at: (start + 604800000) / 1000, used_percent: 10, window_minutes: 10080 }, limit_id: 'codex', plan_type: 'pro' },
      info: { total_token_usage: { total_tokens: 1000, output_tokens: 0, input_tokens: 1000 }, last_token_usage: usage(1000) },
      type: 'token_count'
    }, type: 'event_msg', timestamp: original.timestamp };
    const id = parse(records([original])).quotaCalibrationEvents![0].id;
    expect(parse(records([reordered])).quotaCalibrationEvents![0].id).toBe(id);
    expect(parse(records([token(start, 2000)])).quotaCalibrationEvents![0].id).not.toBe(id);
    expect(parse(records([token(start, 1000, 11)])).quotaCalibrationEvents![0].id).not.toBe(id);
    expect(parse(records([original], 'other-task')).quotaCalibrationEvents![0].id).not.toBe(id);
    expect(parse(records([original], 'other-task')).quotaCalibrationEvents![0].streamId)
      .not.toBe(parse(records([original])).quotaCalibrationEvents![0].streamId);
  });

  it('keeps identity across refreshes and repricing context without retaining transcript or path text', () => {
    const secret = 'PRIVATE_TRANSCRIPT_AND_AUTH_DO_NOT_RETAIN';
    const event = token(start);
    const initial = parse(records([event])).quotaCalibrationEvents![0];
    const modified = records([
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ text: secret }] } },
      { type: 'turn_context', payload: { model: 'unknown-model', cwd: secret } },
      { ...event, payload: { ...event.payload, transcript: secret, info: { ...event.payload.info, message: secret },
        rate_limits: { ...event.payload.rate_limits, access_token: secret } } }
    ]);
    const later = parse(modified, start + 604920000).quotaCalibrationEvents![0];
    expect(later.id).toBe(initial.id);
    expect(later.streamId).toBe(initial.streamId);
    expect(later.cost).toBeNull();
    expect(Object.keys(later).sort()).toEqual(['at', 'cost', 'duplicateUsage', 'id', 'limit', 'streamId']);
    expect(JSON.stringify(later)).not.toContain(secret);
    expect(JSON.stringify(later)).not.toContain('C:/private/workspace');
    expect(JSON.stringify(later)).not.toContain('unknown-model');
    expect(later.streamId).not.toContain('task');
  });

  it('deduplicates exact repeated events without replacing original cost with zero', () => {
    const event = token(start);
    const result = parse(records([event, event, token(start + 60000, 1000, 15)]));
    expect(result.quotaCalibrationEvents?.map(sample => [sample.cost, sample.limit?.used])).toEqual([[0.01, 10], [0, 15]]);
    expect(result.quotaCalibrationEvents?.map(sample => sample.duplicateUsage)).toEqual([false, true]);
    expect(result.totalUsage?.totalTokens).toBe(1000);
  });

  it('keeps the same event identity but exposes proven duplicate usage from a complete log', () => {
    const first = token(start);
    const repeated = token(start + 60000, 1000, 15);
    const complete = parse(records([first, repeated])).quotaCalibrationEvents![1];
    const overlap = parse(records([repeated])).quotaCalibrationEvents![0];
    expect(complete.id).toBe(overlap.id);
    expect(complete.streamId).toBe(overlap.streamId);
    expect(complete).toMatchObject({ duplicateUsage: true, cost: 0 });
    expect(overlap).toMatchObject({ duplicateUsage: false, cost: 0.01 });
    // A normal price correction also leaves identity unchanged; it is not proof of duplicate usage.
    const unpriced = parse(records([{ type: 'turn_context', payload: { model: 'unknown-model' } }, repeated]))
      .quotaCalibrationEvents![0];
    expect(unpriced.id).toBe(overlap.id);
    expect(unpriced).toMatchObject({ duplicateUsage: false, cost: null });
  });

  it('retains the same identity after archive moves, restart and duplicate file copies', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-sample-move-'));
    try {
      const sessions = path.join(root, 'sessions');
      const archives = path.join(root, 'archived_sessions');
      fs.mkdirSync(sessions); fs.mkdirSync(archives);
      const file = path.join(sessions, 'rollout-first-fragment.jsonl');
      fs.writeFileSync(file, lines(records([token(start)])));
      const capture = vi.spyOn(QuotaCalibration.prototype, 'resolve');
      const reader = new HistoryJobReader(sessions);
      reader.listJobs({ nowMs: start + 120000 });
      const original = capture.mock.calls.at(-1)![0][0].id;
      const archived = path.join(archives, 'rollout-renamed-fragment.jsonl');
      fs.renameSync(file, archived);
      fs.copyFileSync(archived, path.join(archives, 'rollout-duplicate.jsonl'));
      reader.listJobs({ nowMs: start + 180000 });
      expect(capture.mock.calls.at(-1)![0].map(sample => sample.id)).toEqual([original, original]);
      new HistoryJobReader(sessions).listJobs({ nowMs: start + 240000 });
      expect(capture.mock.calls.at(-1)![0].map(sample => sample.id)).toEqual([original, original]);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it.each([2, 3, 4])('upgrades version %s cached samples from compact records without rereading archives', oldVersion => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-sample-upgrade-'));
    try {
      const sessions = path.join(root, 'sessions');
      const archives = path.join(root, 'archived_sessions');
      const ledger = path.join(root, 'cache', 'quota.json');
      const cacheFile = path.join(root, 'cache', 'archived-history.json');
      const nowMs = start + 172800000;
      fs.mkdirSync(sessions); fs.mkdirSync(archives);
      fs.writeFileSync(path.join(archives, 'rollout-task.jsonl'), lines(records([token(start)])));
      new HistoryJobReader(sessions, ledger).listJobs({ nowMs });
      const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      const expectedIds = cache.entries[0][1].job.quotaCalibrationEvents.map((sample: { id: string }) => sample.id);
      const compact = cache.entries[0][1].compact;
      cache.entries[0][1].job.quotaCalibrationVersion = oldVersion;
      if (oldVersion === 2) cache.entries[0][1].job.quotaCalibrationEvents[0].id = 'task:0';
      delete cache.entries[0][1].job.quotaCalibrationEvents[0].duplicateUsage;
      fs.writeFileSync(cacheFile, JSON.stringify(cache));
      const reader = new HistoryJobReader(sessions, ledger);
      vi.mocked(fs.openSync).mockClear();
      reader.listJobs({ nowMs });
      expect(fs.openSync).not.toHaveBeenCalled();
      const upgraded = JSON.parse(fs.readFileSync(cacheFile, 'utf8')).entries[0][1];
      expect(upgraded.job.quotaCalibrationVersion).toBe(5);
      expect(upgraded.job.quotaCalibrationEvents.map((sample: { id: string }) => sample.id)).toEqual(expectedIds);
      expect(upgraded.job.quotaCalibrationEvents[0].duplicateUsage).toBe(false);
      expect(upgraded.compact).toEqual(compact);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
