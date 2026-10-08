import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActiveSessionTracker } from '../active-sessions';
import { createLiveTokenFileState, LiveTokenMonitor } from '../live-tokens';
import { MAX_SESSION_LOG_LINE_BYTES } from '../session-log-reader';

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, readdirSync: vi.fn(actual.readdirSync), statSync: vi.fn(actual.statSync),
    readSync: vi.fn(actual.readSync), writeFileSync: vi.fn(actual.writeFileSync) };
});

const at = Date.parse('2026-09-27T10:00:00Z');
const id = '019d773d-49eb-7ae0-9327-ff3b0b39c7a7';
const childId = '019d773d-49eb-7ae0-9327-ff3b0b39c7a8';
const iso = (time: number) => new Date(time).toISOString();
const usage = (input = 100, output = 20) => ({ input_tokens: input, cached_input_tokens: Math.floor(input / 2),
  output_tokens: output, reasoning_output_tokens: Math.floor(output / 2), total_tokens: input + output });
const token = (time: number, input = 100, output = 20, totalInput = input, totalOutput = output) => ({
  timestamp: iso(time), type: 'event_msg', payload: { type: 'token_count', info: {
    last_token_usage: usage(input, output), total_token_usage: usage(totalInput, totalOutput)
  } }
});
const meta = (time: number, child = false) => ({ timestamp: iso(time), type: 'session_meta',
  payload: { id: child ? childId : id, timestamp: iso(time), source: child ? { subagent: { thread_spawn: { parent_thread_id: id } } } : 'cli' } });
const event = (time: number, type: string) => ({ timestamp: iso(time), type: 'event_msg', payload: { type, turn_id: 'turn' } });
const lines = (...records: unknown[]) => records.map(record => JSON.stringify(record)).join('\n') + '\n';

describe('memory-only live token windows', () => {
  it('uses report receipt time, inclusive exact edges, distinct tasks, and subset counters', () => {
    const monitor = new LiveTokenMonitor(at);
    const root = createLiveTokenFileState(id, false);
    const child = createLiveTokenFileState(childId, false);
    monitor.consume(root, token(at, 100, 20), at + 10_000);
    monitor.consume(child, token(at + 1, 50, 10), at + 20_000);
    expect(monitor.snapshot(at + 70_000).windows.oneMinute).toEqual({ seconds: 60, status: 'ready',
      inputTokens: 150, outputTokens: 30, cachedInputTokens: 75, reasoningOutputTokens: 15,
      totalTokens: 180, sampleCount: 2, taskCount: 2 });
    expect(monitor.snapshot(at + 70_001).windows.oneMinute).toMatchObject({ totalTokens: 60, sampleCount: 1, taskCount: 1 });
    expect(monitor.snapshot(at + 310_000).windows.fiveMinutes.totalTokens).toBe(180);
    expect(monitor.snapshot(at + 310_001).windows.fiveMinutes.totalTokens).toBe(60);
    expect(monitor.snapshot(at + 320_001)).toMatchObject({ status: 'ready', lastEventAt: iso(at + 1),
      windows: { fiveMinutes: { totalTokens: 0, sampleCount: 0, taskCount: 0 } } });
  });

  it('ignores cumulative refreshes with different timestamps and info:null without clearing baseline', () => {
    const monitor = new LiveTokenMonitor(at);
    const state = createLiveTokenFileState(id, true);
    monitor.consume(state, token(at, 100, 20), at);
    monitor.finishFile(state);
    monitor.consume(state, { timestamp: iso(at + 1), type: 'event_msg', payload: { type: 'token_count', info: null } }, at + 1);
    monitor.consume(state, token(at + 20_000, 100, 20), at + 20_000);
    expect(monitor.snapshot(at + 20_000)).toMatchObject({ status: 'collecting', lastEventAt: null,
      windows: { oneMinute: { totalTokens: 0, sampleCount: 0 } } });
    monitor.consume(state, token(at + 30_000, 30, 4, 130, 24), at + 30_000);
    expect(monitor.snapshot(at + 30_000).windows.oneMinute).toMatchObject({ inputTokens: 30, outputTokens: 4, sampleCount: 1 });
  });

  it('accepts a real counter reset as the last report, not a negative cumulative delta', () => {
    const monitor = new LiveTokenMonitor(at);
    const state = createLiveTokenFileState(id, false);
    monitor.consume(state, token(at, 100, 20, 1000, 200), at);
    monitor.consume(state, token(at + 1, 3, 2, 3, 2), at + 1);
    expect(monitor.snapshot(at + 1).windows.oneMinute.totalTokens).toBe(125);
  });

  it('marks cumulative gaps incomplete without assigning missing usage to the current window', () => {
    const monitor = new LiveTokenMonitor(at);
    const state = createLiveTokenFileState(id, true);
    monitor.consume(state, token(at, 100, 20, 1000, 200), at);
    monitor.finishFile(state);
    monitor.consume(state, token(at + 1000, 100, 20, 1300, 260), at + 1000);
    expect(monitor.snapshot(at + 1000).windows.oneMinute).toMatchObject({ status: 'unavailable',
      inputTokens: 100, outputTokens: 20, totalTokens: 120, sampleCount: 1 });
    monitor.consume(state, token(at + 2000, 3, 2, 1303, 262), at + 2000);
    expect(monitor.snapshot(at + 61_001).windows).toMatchObject({
      oneMinute: { status: 'ready', totalTokens: 5 }, fiveMinutes: { status: 'unavailable', totalTokens: 125 }
    });
  });

  it('ignores unchanged-cumulative context snapshots before and after real live usage', () => {
    const monitor = new LiveTokenMonitor(at);
    const state = createLiveTokenFileState(id, true);
    const cumulative = { input_tokens: 334587594, cached_input_tokens: 328534656,
      output_tokens: 1346511, reasoning_output_tokens: 846073, total_tokens: 335934105 };
    const contextSnapshot = (time: number) => ({ timestamp: iso(time), type: 'event_msg', payload: {
      type: 'token_count', info: {
        total_token_usage: { ...cumulative },
        last_token_usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0,
          reasoning_output_tokens: 0, total_tokens: 25187 }
      }
    } });
    // A baseline can itself end at a compact/context snapshot. Its valid
    // cumulative value must still prevent the next quota refresh being counted.
    monitor.consume(state, contextSnapshot(at), at);
    monitor.finishFile(state);
    monitor.consume(state, contextSnapshot(at + 1), at + 1);
    expect(monitor.snapshot(at + 1)).toMatchObject({ status: 'collecting',
      windows: { oneMinute: { totalTokens: 0, sampleCount: 0 } } });

    cumulative.input_tokens += 243887;
    cumulative.output_tokens += 1694;
    cumulative.total_tokens += 245581;
    monitor.consume(state, { timestamp: iso(at + 2), type: 'event_msg', payload: { type: 'token_count', info: {
      total_token_usage: { ...cumulative }, last_token_usage: usage(243887, 1694)
    } } }, at + 2);
    monitor.consume(state, contextSnapshot(at + 3), at + 3);
    expect(monitor.snapshot(at + 3)).toMatchObject({ status: 'ready',
      windows: { oneMinute: { totalTokens: 245581, sampleCount: 1 } } });

    // Changed cumulative counters do not make the context size a valid increment.
    cumulative.input_tokens++;
    cumulative.total_tokens++;
    monitor.consume(state, contextSnapshot(at + 4), at + 4);
    expect(monitor.snapshot(at + 4)).toMatchObject({ status: 'unavailable',
      windows: { oneMinute: { totalTokens: 245581, sampleCount: 1 } } });
  });

  it('reports collecting before sufficient observation and no-report zero after warmup', () => {
    const monitor = new LiveTokenMonitor(at);
    expect(monitor.snapshot(at + 59_999).status).toBe('collecting');
    expect(monitor.snapshot(at + 60_000)).toMatchObject({ status: 'ready', lastEventAt: null,
      windows: { oneMinute: { status: 'ready', totalTokens: 0, sampleCount: 0 },
        fiveMinutes: { status: 'collecting' }, twentyMinutes: { status: 'collecting' }, oneHour: { status: 'collecting' } } });
    expect(monitor.snapshot(at + 300_000).windows.fiveMinutes.status).toBe('ready');
    expect(monitor.snapshot(at + 1_200_000).windows.twentyMinutes.status).toBe('ready');
    expect(monitor.snapshot(at + 3_600_000).windows.oneHour.status).toBe('ready');
    expect(monitor.snapshot(at + 300_000, false).status).toBe('unavailable');
    expect(new LiveTokenMonitor(at + 300_000).snapshot(at + 300_000).status).toBe('collecting');
  });

  it.each([
    { input_tokens: -1 }, { output_tokens: 0.5 }, { input_tokens: '100' },
    { cached_input_tokens: 200 }, { reasoning_output_tokens: 30 }, { total_tokens: 999 },
    { input_tokens: undefined }
  ])('never presents an invalid counter as a complete live count: %j', invalid => {
    const monitor = new LiveTokenMonitor(at);
    const state = createLiveTokenFileState(id, false);
    const report = token(at);
    Object.assign(report.payload.info.last_token_usage, invalid);
    monitor.consume(state, report, at);
    expect(monitor.snapshot(at)).toMatchObject({ status: 'unavailable', windows: { oneMinute: { totalTokens: 0 } } });
    expect(monitor.snapshot(at + 300_001).status).toBe('ready');
  });

  it('bounds retained reports and marks capacity loss unavailable until its window expires', () => {
    const monitor = new LiveTokenMonitor(at, 2);
    const state = createLiveTokenFileState(id, false);
    for (let i = 0; i < 3; i++) monitor.consume(state, token(at + i, 1, 0, i + 1, 0), at + i);
    expect(monitor.snapshot(at + 2).status).toBe('unavailable');
    expect((monitor as unknown as { samples: unknown[] }).samples).toHaveLength(2);
    expect(monitor.snapshot(at + 300_003)).toMatchObject({ status: 'ready', windows: {
      fiveMinutes: { status: 'ready', sampleCount: 0 }, oneHour: { status: 'unavailable', sampleCount: 2 } } });
    expect((monitor as unknown as { samples: unknown[] }).samples).toHaveLength(2);
    expect(monitor.snapshot(at + 3_600_003).windows.oneHour).toMatchObject({ status: 'ready', sampleCount: 0 });
    expect((monitor as unknown as { samples: unknown[] }).samples).toHaveLength(0);
  });

  it('retains all four independent rolling windows until their exact one-hour cutoff', () => {
    const monitor = new LiveTokenMonitor(at);
    const state = createLiveTokenFileState(id, false);
    const points = [0, 2_400_000, 3_300_000, 3_540_000];
    points.forEach((offset, index) => monitor.consume(state, token(at + offset, 10, 2, (index + 1) * 10, (index + 1) * 2), at + offset));
    const exact = monitor.snapshot(at + 3_600_000).windows;
    expect(exact.oneMinute.totalTokens).toBe(12);
    expect(exact.fiveMinutes.totalTokens).toBe(24);
    expect(exact.twentyMinutes.totalTokens).toBe(36);
    expect(exact.oneHour.totalTokens).toBe(48);
    const after = monitor.snapshot(at + 3_600_001).windows;
    expect(after.oneMinute.totalTokens).toBe(0);
    expect(after.fiveMinutes.totalTokens).toBe(12);
    expect(after.twentyMinutes.totalTokens).toBe(24);
    expect(after.oneHour.totalTokens).toBe(36);
    expect((monitor as unknown as { samples: unknown[] }).samples).toHaveLength(3);
  });

  it('invalidates only windows that still contain a missing report', () => {
    const monitor = new LiveTokenMonitor(at);
    monitor.markUnavailable(at);
    expect(monitor.snapshot(at + 60_000).windows.oneMinute.status).toBe('unavailable');
    expect(monitor.snapshot(at + 60_001)).toMatchObject({ status: 'ready', windows: {
      oneMinute: { status: 'ready' }, fiveMinutes: { status: 'unavailable' },
      twentyMinutes: { status: 'unavailable' }, oneHour: { status: 'unavailable' } } });
    expect(monitor.snapshot(at + 300_001).windows.fiveMinutes.status).toBe('ready');
    expect(monitor.snapshot(at + 1_200_001).windows.twentyMinutes.status).toBe('ready');
    expect(monitor.snapshot(at + 3_600_001).windows.oneHour.status).toBe('ready');
  });
});

describe('live token activity tail integration', () => {
  let root: string;
  let file: string;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(at);
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-live-'));
    file = path.join(root, `rollout-${id}.jsonl`);
    vi.mocked(fs.readdirSync).mockClear(); vi.mocked(fs.statSync).mockClear();
    vi.mocked(fs.readSync).mockClear(); vi.mocked(fs.writeFileSync).mockClear();
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

  it('baselines every existing report, tails only new bytes, shares throttling, and never enumerates or writes in the light path', () => {
    fs.writeFileSync(file, lines(meta(at - 1000), event(at, 'task_started'), token(at),
      { timestamp: iso(at), type: 'response_item', payload: { content: 'x'.repeat(1024 * 1024) } }));
    const tracker = new ActiveSessionTracker(root);
    expect(tracker.listActiveSessions(at)).toHaveLength(1);
    expect(tracker.getLiveTokens(at).windows.fiveMinutes.sampleCount).toBe(0);
    fs.appendFileSync(file, lines(token(at + 1, 3, 2, 103, 22)));
    vi.mocked(fs.readdirSync).mockClear(); vi.mocked(fs.statSync).mockClear();
    vi.mocked(fs.readSync).mockClear(); vi.mocked(fs.writeFileSync).mockClear();
    expect(tracker.getLiveTokens(at + 5000).windows.oneMinute).toMatchObject({ inputTokens: 3, outputTokens: 2, sampleCount: 1 });
    const bytes = vi.mocked(fs.readSync).mock.results.reduce((sum, result) => sum + (result.type === 'return' ? Number(result.value) : 0), 0);
    expect(bytes).toBeLessThan(1000);
    const statCalls = vi.mocked(fs.statSync).mock.calls.length;
    const readCalls = vi.mocked(fs.readSync).mock.calls.length;
    expect(tracker.getLiveTokens(at + 5001).windows.oneMinute.sampleCount).toBe(1);
    expect(fs.statSync).toHaveBeenCalledTimes(statCalls);
    expect(fs.readSync).toHaveBeenCalledTimes(readCalls);
    expect(fs.readdirSync).not.toHaveBeenCalled();
    expect(fs.writeFileSync).not.toHaveBeenCalled();
    // The regular activity scan sees the same cursor, so it does not add usage twice.
    tracker.listActiveSessions(at + 6000);
    expect(tracker.getLiveTokens(at + 6000).windows.oneMinute.sampleCount).toBe(1);
  });

  it('baselines token reports across an oversized compacted record without counting replacement history', () => {
    const copiedUsage = token(at, 100, 20);
    const compacted = { timestamp: iso(at + 1), ordinal: 1, type: 'compacted', payload: {
      message: 'x'.repeat(MAX_SESSION_LOG_LINE_BYTES + 1),
      replacement_history: [copiedUsage], latest_token_usage_record: copiedUsage
    } };
    expect(Buffer.byteLength(JSON.stringify(compacted))).toBeGreaterThan(MAX_SESSION_LOG_LINE_BYTES);
    fs.writeFileSync(file, lines(meta(at - 1000), event(at, 'task_started'), copiedUsage,
      compacted, token(at + 2, 3, 2, 103, 22)));
    const tracker = new ActiveSessionTracker(root);
    expect(tracker.listActiveSessions(at + 2000)).toHaveLength(1);
    expect(tracker.isActivitySourceAvailable()).toBe(true);
    expect(tracker.getLiveTokens(at + 2000)).toMatchObject({ status: 'collecting',
      windows: { oneMinute: { status: 'collecting', totalTokens: 0, sampleCount: 0 } } });
    fs.appendFileSync(file, lines(token(at + 3000, 4, 1, 107, 23)));
    expect(tracker.getLiveTokens(at + 7000)).toMatchObject({ status: 'ready',
      windows: { oneMinute: { status: 'ready', inputTokens: 4, outputTokens: 1, totalTokens: 5, sampleCount: 1 } } });
    tracker.listActiveSessions(at + 8000);
    expect(tracker.getLiveTokens(at + 8000).windows.oneMinute).toMatchObject({ status: 'ready', totalTokens: 5, sampleCount: 1 });
  });

  it('tails new token reports after an oversized compacted record without replaying copied reports', () => {
    const copiedUsage = token(at, 100, 20);
    fs.writeFileSync(file, lines(meta(at - 1000), event(at, 'task_started'), copiedUsage));
    const tracker = new ActiveSessionTracker(root);
    tracker.listActiveSessions(at);
    const compacted = { timestamp: iso(at + 1), ordinal: 1, type: 'compacted', payload: {
      message: 'x'.repeat(MAX_SESSION_LOG_LINE_BYTES + 1),
      replacement_history: [copiedUsage], latest_token_usage_record: copiedUsage
    } };
    expect(Buffer.byteLength(JSON.stringify(compacted))).toBeGreaterThan(MAX_SESSION_LOG_LINE_BYTES);
    fs.appendFileSync(file, lines(compacted, token(at + 2, 3, 2, 103, 22)));
    expect(tracker.getLiveTokens(at + 5000)).toMatchObject({ status: 'ready',
      windows: { oneMinute: { status: 'ready', inputTokens: 3, outputTokens: 2, totalTokens: 5, sampleCount: 1 } } });
    expect(tracker.isActivitySourceAvailable()).toBe(true);
    fs.appendFileSync(file, lines(token(at + 6000, 4, 1, 107, 23)));
    expect(tracker.getLiveTokens(at + 10_000)).toMatchObject({ status: 'ready',
      windows: { oneMinute: { status: 'ready', inputTokens: 7, outputTokens: 3, totalTokens: 10, sampleCount: 2 } } });
    tracker.listActiveSessions(at + 11_000);
    expect(tracker.getLiveTokens(at + 11_000).windows.oneMinute).toMatchObject({ status: 'ready', totalTokens: 10, sampleCount: 2 });
  });

  it('keeps completed chats long enough to receive final usage', () => {
    fs.writeFileSync(file, lines(meta(at), event(at, 'task_started')));
    const tracker = new ActiveSessionTracker(root);
    tracker.listActiveSessions(at);
    fs.appendFileSync(file, lines(event(at + 1000, 'task_complete')));
    expect(tracker.listActiveSessions(at + 1000)).toHaveLength(0);
    fs.appendFileSync(file, lines(token(at + 2000, 4, 2)));
    expect(tracker.getLiveTokens(at + 5000).windows.oneMinute).toMatchObject({ totalTokens: 6, taskCount: 1 });
  });

  it('discovers new subagents on ordinary scans and excludes inherited parent history even after monitoring began', () => {
    const tracker = new ActiveSessionTracker(root);
    tracker.listActiveSessions(at);
    const child = path.join(root, `rollout-${childId}.jsonl`);
    fs.writeFileSync(child, lines(meta(at + 10_000, true), meta(at + 1000),
      token(at + 2000, 100, 20), event(at + 11_000, 'task_started'), token(at + 12_000, 3, 2, 103, 22)));
    expect(tracker.getLiveTokens(at + 15_000).windows.oneMinute.sampleCount).toBe(0);
    expect(tracker.listActiveSessions(at + 60_000)).toHaveLength(0);
    expect(tracker.getLiveTokens(at + 60_000).windows.oneMinute).toMatchObject({ totalTokens: 5, taskCount: 1, sampleCount: 1 });
    fs.appendFileSync(child, lines(token(at + 61_000, 4, 1, 107, 23)));
    expect(tracker.getLiveTokens(at + 65_000).windows.oneMinute).toMatchObject({ totalTokens: 10, sampleCount: 2 });
  });

  it('does not lose partial records or replay a complete no-newline tail', () => {
    fs.writeFileSync(file, lines(meta(at), event(at, 'task_started')));
    const tracker = new ActiveSessionTracker(root);
    tracker.listActiveSessions(at);
    const tail = JSON.stringify(token(at + 1, 3, 2));
    fs.appendFileSync(file, tail.slice(0, -4));
    expect(tracker.getLiveTokens(at + 5000).windows.oneMinute.sampleCount).toBe(0);
    fs.appendFileSync(file, tail.slice(-4));
    expect(tracker.getLiveTokens(at + 10_000).windows.oneMinute.totalTokens).toBe(5);
    fs.appendFileSync(file, '\n' + lines(token(at + 11_000, 4, 1, 7, 3)));
    expect(tracker.getLiveTokens(at + 15_000).windows.oneMinute).toMatchObject({ totalTokens: 10, sampleCount: 2 });
  });

  it('retains replay checkpoints after rewrite or truncation and counts only new reports', () => {
    const header = lines(meta(at), event(at, 'task_started'));
    const first = token(at + 1000, 3, 2);
    fs.writeFileSync(file, header);
    const tracker = new ActiveSessionTracker(root);
    tracker.listActiveSessions(at);
    fs.appendFileSync(file, lines(first));
    expect(tracker.getLiveTokens(at + 5000).windows.oneMinute.totalTokens).toBe(5);
    fs.writeFileSync(file, header + lines(first));
    fs.utimesSync(file, new Date(), new Date(Date.now() + 1000));
    expect(tracker.getLiveTokens(at + 10_000).windows.oneMinute.totalTokens).toBe(5);
    fs.writeFileSync(file, header);
    tracker.getLiveTokens(at + 15_000);
    fs.appendFileSync(file, lines(token(at + 16_000, 1, 1)));
    expect(tracker.getLiveTokens(at + 20_000).windows.oneMinute).toMatchObject({ totalTokens: 7, sampleCount: 2 });
  });

  it('ignores unchanged cumulative refreshes after the initial baseline', () => {
    fs.writeFileSync(file, lines(meta(at), event(at, 'task_started'), token(at)));
    const tracker = new ActiveSessionTracker(root);
    tracker.listActiveSessions(at);
    fs.appendFileSync(file, lines(token(at + 20_000)));
    expect(tracker.getLiveTokens(at + 25_000).windows.oneMinute.sampleCount).toBe(0);
  });

  it('expires samples during ordinary background scans and skips stale file tails', () => {
    fs.writeFileSync(file, lines(meta(at), event(at, 'task_started')));
    const tracker = new ActiveSessionTracker(root, 1000);
    tracker.listActiveSessions(at);
    fs.appendFileSync(file, lines(token(at + 1, 1, 0)));
    tracker.listActiveSessions(at + 5000);
    tracker.listActiveSessions(at + 305_001);
    vi.mocked(fs.readSync).mockClear(); vi.mocked(fs.statSync).mockClear();
    expect(tracker.getLiveTokens(at + 305_001).windows.fiveMinutes.sampleCount).toBe(0);
    expect(fs.readSync).not.toHaveBeenCalled();
    expect(fs.statSync).not.toHaveBeenCalled();
  });

  it('retains an hour of reports without extending the fifteen-minute live-file tail eligibility', () => {
    fs.writeFileSync(file, lines(meta(at), event(at, 'task_started')));
    const tracker = new ActiveSessionTracker(root);
    tracker.listActiveSessions(at);
    fs.appendFileSync(file, lines(token(at + 1000, 1, 0)));
    tracker.getLiveTokens(at + 5000);
    vi.mocked(fs.readSync).mockClear(); vi.mocked(fs.statSync).mockClear();
    expect(tracker.getLiveTokens(at + 16 * 60_000).windows.oneHour).toMatchObject({ totalTokens: 1, sampleCount: 1 });
    expect(fs.readSync).not.toHaveBeenCalled();
    expect(fs.statSync).not.toHaveBeenCalled();
  });

  it('reports unavailable for a missing or unreadable source rather than ready zero', () => {
    const absent = new ActiveSessionTracker(path.join(root, 'missing'));
    absent.listActiveSessions(at);
    expect(absent.getLiveTokens(at + 300_000).status).toBe('unavailable');
    vi.mocked(fs.readdirSync).mockImplementationOnce(() => { throw new Error('EACCES'); });
    const denied = new ActiveSessionTracker(root);
    denied.listActiveSessions(at);
    expect(denied.getLiveTokens(at + 300_000).status).toBe('unavailable');
  });

  it.each(['root', 'nested', 'stat'])('preserves activity and checkpoints when %s discovery fails', async failure => {
    const day = path.join(root, '2026', '09', '27');
    fs.mkdirSync(day, { recursive: true });
    file = path.join(day, `rollout-${id}.jsonl`);
    fs.writeFileSync(file, lines(meta(at), event(at, 'task_started')));
    const tracker = new ActiveSessionTracker(root);
    const active = tracker.listActiveSessions(at);
    fs.appendFileSync(file, lines(token(at + 1000, 100, 0)));
    expect(tracker.getLiveTokens(at + 5000).windows.oneMinute.totalTokens).toBe(100);
    const actual = await vi.importActual<typeof fs>('node:fs');
    if (failure === 'stat') {
      vi.mocked(fs.statSync).mockImplementationOnce(() => { throw new Error('EACCES'); });
    } else {
      vi.mocked(fs.readdirSync).mockImplementation(((...args: Parameters<typeof fs.readdirSync>) => {
        if (String(args[0]) === (failure === 'root' ? root : day)) throw new Error('EACCES');
        return Reflect.apply(actual.readdirSync, null, args);
      }) as typeof fs.readdirSync);
    }
    expect(tracker.listActiveSessions(at + 6000)).toEqual(active);
    expect(tracker.isActivitySourceAvailable()).toBe(false);
    expect(tracker.getLiveTokens(at + 6000).status).toBe('unavailable');
    vi.mocked(fs.readdirSync).mockImplementation(actual.readdirSync);
    tracker.listActiveSessions(at + 7000);
    expect(tracker.isActivitySourceAvailable()).toBe(true);
    expect(tracker.getLiveTokens(at + 7000).windows.oneMinute.totalTokens).toBe(100);
    fs.appendFileSync(file, lines(token(at + 8000, 100, 0, 200, 0)));
    expect(tracker.getLiveTokens(at + 10_000).windows.oneMinute).toMatchObject({ totalTokens: 200, sampleCount: 2 });
  });

  it('retains confirmed activity and reports an oversized record instead of committing a partial scan', () => {
    const header = lines(meta(at), event(at, 'task_started'));
    fs.writeFileSync(file, header);
    const tracker = new ActiveSessionTracker(root);
    const active = tracker.listActiveSessions(at);
    fs.appendFileSync(file, lines(event(at + 1000, 'task_complete')) + 'x'.repeat(MAX_SESSION_LOG_LINE_BYTES + 1));
    expect(tracker.listActiveSessions(at + 5000)).toEqual(active);
    expect(tracker.isActivitySourceAvailable()).toBe(false);
    vi.mocked(fs.readSync).mockClear();
    expect(tracker.getLiveTokens(at + 10_000).status).toBe('unavailable');
    expect(fs.readSync).not.toHaveBeenCalled();
    fs.writeFileSync(file, header + lines(event(at + 1000, 'task_complete')));
    expect(tracker.listActiveSessions(at + 15_000)).toEqual([]);
    expect(tracker.isActivitySourceAvailable()).toBe(true);
  });

  it('accepts a report written after the scan began using its actual receipt time', async () => {
    fs.writeFileSync(file, lines(meta(at), event(at, 'task_started')));
    const tracker = new ActiveSessionTracker(root);
    tracker.listActiveSessions(at);
    fs.appendFileSync(file, lines(token(at + 5100, 2, 1)));
    const actual = await vi.importActual<typeof fs>('node:fs');
    vi.mocked(fs.readSync).mockImplementationOnce((...args: Parameters<typeof fs.readSync>) => {
      vi.setSystemTime(at + 5200);
      return Reflect.apply(actual.readSync, null, args);
    });
    expect(tracker.getLiveTokens(at + 5000)).toMatchObject({ status: 'ready', updatedAt: iso(at + 5200),
      windows: { oneMinute: { totalTokens: 3, sampleCount: 1 } } });
  });

  it('does not let an inaccessible historical file poison current live statistics', () => {
    fs.writeFileSync(file, lines(meta(at - 86_400_000), event(at - 86_400_000, 'task_complete')));
    fs.utimesSync(file, new Date(at - 86_400_000), new Date(at - 86_400_000));
    vi.mocked(fs.readSync).mockImplementationOnce(() => { throw new Error('old inaccessible file'); });
    const tracker = new ActiveSessionTracker(root);
    tracker.listActiveSessions(at);
    expect(tracker.getLiveTokens(at + 300_000).status).toBe('ready');
  });
});
