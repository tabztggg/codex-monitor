import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HistoryJobReader, parseHistorySessionFile } from '../history-jobs';
import { estimateApiEquivalentCost, HISTORY_PRICING } from '../history-pricing';
import { currentAccountEquivalent } from '../quota-equivalent';
import { localDay } from '../../../shared/usage-period';

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, openSync: vi.fn(actual.openSync), readSync: vi.fn(actual.readSync) };
});

const now = new Date(2026, 8, 28, 18).getTime();
const at = (day: number, hour = 10) => new Date(2026, 8, day, hour).getTime();
const iso = (time: number) => new Date(time).toISOString();
const usage = (n: number) => ({ input_tokens: n, output_tokens: 0, total_tokens: n });
const meta = (id: string, fields = {}, time = at(20)) => ({ type: 'session_meta', timestamp: iso(time),
  payload: { id, timestamp: iso(time), source: 'cli', ...fields } });
const context = (model: string | null, time = at(20)) => ({ type: 'turn_context', timestamp: iso(time), payload: { model } });
const token = (time: number | null, increment: number, cumulative = increment, counters = {}) => ({
  type: 'event_msg', timestamp: time === null ? undefined : iso(time),
  payload: { type: 'token_count', info: { last_token_usage: { ...usage(increment), ...counters }, total_token_usage: usage(cumulative) } }
});
const lines = (records: unknown[]) => records.map(record => JSON.stringify(record)).join('\n') + '\n';
const window = { startedAtMs: at(27, 12), resetsAt: iso(at(27, 12) + 604800000), usedPercent: 10, limitName: 'Overall Codex', windowLabel: 'Weekly' };

describe('model analytics from incremental token events', () => {
  let root: string;
  let sessions: string;
  let archives: string;
  let ledger: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-model-'));
    sessions = path.join(root, 'sessions'); archives = path.join(root, 'archived_sessions');
    ledger = path.join(root, 'cache', 'quota.json');
    fs.mkdirSync(sessions); fs.mkdirSync(archives);
    vi.mocked(fs.openSync).mockClear(); vi.mocked(fs.readSync).mockClear();
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  function write(name: string, records: unknown[], archived = false) {
    const file = path.join(archived ? archives : sessions, `rollout-${name}.jsonl`);
    fs.writeFileSync(file, lines(records));
    return file;
  }

  it('attributes model switches at local midnight and retains cache/output/reasoning counters', () => {
    write('switch', [meta('switch'), context('gpt-6-sol'), token(at(27, 23), 100),
      context('gpt-6-astra', at(28, 0)), token(at(28, 0), 300, 400,
        { input_tokens: 200, cached_input_tokens: 80, cache_write_input_tokens: 10, output_tokens: 100, reasoning_output_tokens: 40 })]);
    const result = new HistoryJobReader(sessions).listJobs({ nowMs: now, period: '7d' });
    expect(result.analysis?.models).toEqual(result.data[0].periodMetrics?.models);
    expect(result.analysis?.models?.map(row => [row.model, row.usage.totalTokens, row.taskCount])).toEqual([
      ['gpt-6-astra', 300, 1], ['gpt-6-sol', 100, 1]
    ]);
    const astra = result.analysis!.models![0];
    expect(astra).toMatchObject({ tokensComplete: true, costComplete: true, usage: {
      inputTokens: 200, cachedInputTokens: 80, cacheWriteInputTokens: 10, outputTokens: 100, reasoningOutputTokens: 40
    } });
    expect(astra.costUsd).toBeCloseTo((120 * 10 + 80 + 10 * 12.5 + 100 * 50) / 1e6);
    expect(result.analysis?.days.map(day => [day.date, day.models?.[0].model])).toEqual([
      [localDay(at(27)), 'gpt-6-sol'], [localDay(at(28)), 'gpt-6-astra']
    ]);
    expect(result.data[0].periodMetrics?.days).toEqual(result.analysis?.days);
    expect(result.analysis!.models!.reduce((sum, row) => sum + row.usage.totalTokens, 0)).toBe(result.data[0].totalUsage?.totalTokens);
  });

  it('uses exact quota and inclusive custom day boundaries, with aggregate scope independent of pagination', () => {
    write('a', [meta('a'), context('gpt-6-sol'), token(at(27, 11), 100), token(at(27, 12), 200, 300), token(at(28), 300, 600)]);
    write('b', [meta('b'), context('gpt-6-sol'), token(at(28), 400)]);
    const reader = new HistoryJobReader(sessions);
    const quota = reader.listJobs({ nowMs: now, period: 'quota', usageWindow: window, limit: 1 });
    expect(quota.data).toHaveLength(1);
    expect(quota.analysis?.models?.[0]).toMatchObject({ usage: { totalTokens: 900 }, taskCount: 2 });
    expect(quota.analysis?.days[0].models?.[0].usage.totalTokens).toBe(200);
    const custom = reader.listJobs({ nowMs: now, period: 'custom', dateFrom: localDay(at(27)), dateTo: localDay(at(27)) });
    expect(custom.analysis?.models?.[0]).toMatchObject({ usage: { totalTokens: 300 }, taskCount: 1 });
    const filtered = reader.listJobs({ nowMs: now, period: 'today', searchTerm: 'b' });
    expect(filtered.analysis?.models?.[0]).toMatchObject({ usage: { totalTokens: 400 }, taskCount: 1 });
    expect(reader.listJobs({ nowMs: now, period: 'quota' }).analysis?.models).toEqual([]);
  });

  it('keeps missing model separate from a named unpriced model and does not borrow the preceding turn model', () => {
    write('unknown', [meta('unknown'), token(at(28), 10), context('not-in-catalog'), token(at(28) + 1, 20, 30),
      context('gpt-6-sol'), token(at(28) + 2, 30, 60), context(null), token(at(28) + 3, 40, 100)]);
    const result = new HistoryJobReader(sessions).listJobs({ nowMs: now, period: 'today' });
    expect(result.analysis?.models?.find(row => row.model === null)).toMatchObject({
      usage: { totalTokens: 50 }, unpricedTokens: 50, tokensComplete: true, costComplete: false, costUsd: null, taskCount: 1
    });
    expect(result.analysis?.models?.find(row => row.model === 'not-in-catalog')).toMatchObject({
      usage: { totalTokens: 20 }, unpricedTokens: 20, costUsd: null, costComplete: false
    });
    expect(result.analysis?.unpricedTokens).toBe(70);
  });

  it('prices GPT-6.1 Sol and restores selected-account quota estimates from its token events', () => {
    const record = token(at(28), 110000, 110000, {
      input_tokens: 100000, cached_input_tokens: 80000, output_tokens: 10000, reasoning_output_tokens: 4000
    });
    const rated = { ...record, payload: { ...record.payload, rate_limits: {
      plan_type: 'pro', primary: { used_percent: 10, window_minutes: 10080, resets_at: Date.parse(window.resetsAt) / 1000 }
    } } };
    const parsed = parseHistorySessionFile({ sessionId: 'new-sol', updatedAt: iso(at(28)), nowMs: now,
      usageWindowStartedAtMs: window.startedAtMs, fileContent: lines([meta('new-sol'), context('gpt-6.1-sol'), rated]) })!;
    // Cached input is $0.10/M (old Sol is $0.20/M); reasoning is already in output.
    const expectedCost = (20000 * 2 + 80000 * 0.1 + 10000 * 10) / 1e6;
    expect(parsed.totalEstimatedCostUsd).toBeCloseTo(expectedCost);
    expect(parsed.totalEstimatedCostIsComplete).toBe(true);
    expect(currentAccountEquivalent(parsed.quotaCalibrationEvents ?? [], window, now, 2, true, 0))
      .toMatchObject({ percent: expectedCost / 2, complete: true });
    write('new-sol', [meta('new-sol'), context('gpt-6.1-sol'), rated]);
    const result = new HistoryJobReader(sessions).listJobs({ nowMs: now, period: 'today', usageWindow: window });
    expect(result.data[0].periodMetrics).toMatchObject({ costUsd: expectedCost, costComplete: true, unpricedTokens: 0 });
    expect(result.analysis?.models?.[0]).toMatchObject({ model: 'gpt-6.1-sol', costUsd: expectedCost, costComplete: true });
    expect(HISTORY_PRICING.models.find(row => row.model === 'gpt-6.1-sol')).toMatchObject({
      input: 2, cachedInput: 0.1, cacheWriteInput: 2.5, output: 10, verifiedAt: '2026-09-30'
    });
    expect(estimateApiEquivalentCost({ inputTokens: 300000, cachedInputTokens: 200000, cacheWriteInputTokens: 1000,
      outputTokens: 10000, reasoningOutputTokens: 4000, totalTokens: 310000 }, 'gpt-6.1-sol'))
      .toBeCloseTo(((100000 * 2 + 200000 * 0.1 + 1000 * 2.5) * 2 + 10000 * 10 * 1.5) / 1e6);
  });

  it('reprices an old archived summary without reopening the transcript or dropping token counts', () => {
    write('sol-archive', [meta('sol-archive'), context('gpt-6.1-sol'), token(at(28), 100000)], true);
    const stableNow = now + 3 * 86400000;
    new HistoryJobReader(sessions, ledger).listJobs({ nowMs: stableNow, period: 'lifetime' });
    const cacheFile = path.join(root, 'cache', 'archived-history.json');
    const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    cached.entries[0][1].job.quotaCalibrationVersion = 7;
    cached.entries[0][1].job.totalEstimatedCostUsd = null;
    cached.entries[0][1].job.totalEstimatedCostIsComplete = false;
    fs.writeFileSync(cacheFile, JSON.stringify(cached));
    const reader = new HistoryJobReader(sessions, ledger);
    vi.mocked(fs.openSync).mockClear(); vi.mocked(fs.readSync).mockClear();
    const result = reader.listJobs({ nowMs: stableNow, period: 'lifetime' });
    expect(result.data[0]).toMatchObject({ totalUsage: { totalTokens: 100000 },
      totalEstimatedCostUsd: 0.2, totalEstimatedCostIsComplete: true });
    expect(fs.openSync).not.toHaveBeenCalled(); expect(fs.readSync).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(cacheFile, 'utf8')).entries[0][1].job.quotaCalibrationVersion).toBe(9);
  });

  it('excludes future timestamps from quota/recent usage while preserving recorded lifetime totals', () => {
    const records = [meta('clock'), context('gpt-6-sol'), token(at(28), 100), token(now + 1, 200, 300)];
    write('clock', records); write('clock-copy', records);
    const reader = new HistoryJobReader(sessions);
    const quota = reader.listJobs({ nowMs: now, period: 'quota', usageWindow: window });
    expect(quota.data[0]).toMatchObject({ totalUsage: { totalTokens: 300 }, sinceResetUsage: { totalTokens: 100 },
      last24HoursUsage: { totalTokens: 100 }, periodMetrics: { usage: { totalTokens: 100 } } });
    expect(quota.analysis?.models?.[0].usage.totalTokens).toBe(100);
    expect(quota.analysis?.days[0].usage.totalTokens).toBe(100);
    expect(reader.listJobs({ nowMs: now, period: 'lifetime' }).analysis?.models?.[0].usage.totalTokens).toBe(300);
    const advanced = reader.listJobs({ nowMs: now + 2, period: 'quota', usageWindow: window });
    expect(advanced.analysis?.models?.[0].usage.totalTokens).toBe(300);
  });

  it('retains known counters and incomplete flags without creating a fabricated zero model row', () => {
    write('incomplete', [meta('incomplete'), context('gpt-6-sol'), token(at(28), 100, 100, { cached_input_tokens: 101 })]);
    write('unavailable', [meta('unavailable'), context('gpt-6-astra'), { type: 'event_msg', timestamp: iso(at(28)),
      payload: { type: 'token_count', info: { last_token_usage: { input_tokens: -1 }, total_token_usage: usage(200) } } }]);
    const result = new HistoryJobReader(sessions).listJobs({ nowMs: now, period: 'today' });
    expect(result.analysis?.models).toHaveLength(1);
    expect(result.analysis?.models?.[0]).toMatchObject({ model: 'gpt-6-sol', usage: { totalTokens: 100 },
      tokensComplete: false, costComplete: false, costUsd: null, unpricedTokens: 100 });
    expect(result.data.find(job => job.id === 'unavailable')?.periodMetrics).toMatchObject({ models: [], usage: null, tokensComplete: false });
  });

  it('deduplicates copied rollout events, upgrades partial model context, and counts children as one principal task', () => {
    const records = [meta('root'), context('gpt-6-sol'), token(at(28), 100), token(at(28) + 1, 100, 100)];
    write('root', records); write('root-copy', records);
    write('root-fragment', [meta('root'), token(at(28), 100)]);
    write('child', [meta('child', { source: 'subAgent', parent_thread_id: 'root' }), context('gpt-6-sol'), token(at(28), 100)]);
    write('nested', [meta('nested', { source: 'subAgent', parent_thread_id: 'child' }), context('gpt-6-astra'), token(at(28), 100)]);
    const result = new HistoryJobReader(sessions).listJobs({ nowMs: now, period: 'today' });
    expect(result.total).toBe(1);
    expect(result.analysis?.models?.map(row => [row.model, row.usage.totalTokens, row.taskCount])).toEqual([
      ['gpt-6-sol', 200, 1], ['gpt-6-astra', 100, 1]
    ]);
    expect(result.data[0].totalUsage?.totalTokens).toBe(300);
    expect(result.analysis?.days[0].models?.every(row => row.taskCount === 1)).toBe(true);
  });

  it('excludes inherited fork usage and untimed increments from dated slices while preserving lifetime attribution', () => {
    write('fork', [meta('fork', { forked_from_id: 'parent' }, at(28)), meta('parent'), context('gpt-6-astra'),
      token(at(27), 100), context('gpt-6-sol', at(28)), token(at(28) + 1, 50, 150)]);
    write('undated', [meta('undated'), context('gpt-6-luna'), token(null, 20), token(at(28), 30, 50)]);
    const reader = new HistoryJobReader(sessions);
    const today = reader.listJobs({ nowMs: now, period: 'today' });
    expect(today.analysis?.models?.map(row => [row.model, row.usage.totalTokens])).toEqual([['gpt-6-sol', 50], ['gpt-6-luna', 30]]);
    expect(today.analysis?.models?.find(row => row.model === 'gpt-6-luna')?.tokensComplete).toBe(false);
    expect(today.analysis?.untimedTokens).toBe(20);
    const lifetime = reader.listJobs({ nowMs: now, period: 'lifetime' });
    expect(lifetime.analysis?.models?.find(row => row.model === 'gpt-6-luna')).toMatchObject({ usage: { totalTokens: 50 }, tokensComplete: true });
    expect(lifetime.analysis?.days.flatMap(day => day.models ?? []).reduce((sum, row) => sum + row.usage.totalTokens, 0)).toBe(80);
  });

  it('lazily upgrades v3 archive attribution from compact statistics without reopening transcripts', () => {
    write('archive', [meta('archive'), context('gpt-6-sol'), token(at(27), 100), context('unpriced'), token(at(28), 200, 300)], true);
    new HistoryJobReader(sessions, ledger).listJobs({ nowMs: now, period: 'lifetime' });
    const cacheFile = path.join(root, 'cache', 'archived-history.json');
    const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    cached.version = 3;
    for (const [, value] of cached.entries) {
      delete value.job.modelUsageVersion;
      for (const event of value.job.usageEvents) { delete event.model; delete event.tokensComplete; }
    }
    fs.writeFileSync(cacheFile, JSON.stringify(cached));
    const reader = new HistoryJobReader(sessions, ledger);
    vi.mocked(fs.openSync).mockClear(); vi.mocked(fs.readSync).mockClear();
    const result = reader.listJobs({ nowMs: now, period: 'lifetime' });
    expect(result.analysis?.models?.map(row => [row.model, row.usage.totalTokens])).toEqual([['unpriced', 200], ['gpt-6-sol', 100]]);
    expect(fs.openSync).not.toHaveBeenCalled(); expect(fs.readSync).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(cacheFile, 'utf8')).version).toBe(4);
  });

  it('rebuilds cached local days from compact statistics after a time-zone change and restart', () => {
    const originalZone = process.env.TZ;
    const originalResolvedZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const eventAt = Date.parse('2026-09-27T20:00:00Z');
    const later = eventAt + 3 * 86400000;
    try {
      process.env.TZ = 'UTC';
      write('zone', [meta('zone'), context('gpt-6-sol'), token(eventAt, 100)], true);
      const reader = new HistoryJobReader(sessions, ledger);
      const utc = reader.listJobs({ nowMs: later, period: 'lifetime' });
      expect(utc.analysis?.days[0]).toMatchObject({ date: '2026-09-27', usage: { totalTokens: 100 } });
      process.env.TZ = 'Asia/Hong_Kong';
      vi.mocked(fs.openSync).mockClear(); vi.mocked(fs.readSync).mockClear();
      const hongKong = reader.listJobs({ nowMs: later, period: 'lifetime' });
      expect(hongKong.analysis).toMatchObject({ timeZone: 'Asia/Hong_Kong', days: [{ date: '2026-09-28',
        usage: { totalTokens: 100 }, models: [{ model: 'gpt-6-sol', usage: { totalTokens: 100 } }] }] });
      expect(hongKong.data[0].periodMetrics?.days).toEqual(hongKong.analysis?.days);
      expect(fs.openSync).not.toHaveBeenCalled(); expect(fs.readSync).not.toHaveBeenCalled();
      const cacheFile = path.join(root, 'cache', 'archived-history.json');
      expect(JSON.parse(fs.readFileSync(cacheFile, 'utf8')).entries[0][1].timeZone).toBe('Asia/Hong_Kong');

      process.env.TZ = 'UTC';
      const restarted = new HistoryJobReader(sessions, ledger);
      vi.mocked(fs.openSync).mockClear(); vi.mocked(fs.readSync).mockClear();
      const again = restarted.listJobs({ nowMs: later, period: 'lifetime' });
      expect(again.analysis?.days).toEqual(utc.analysis?.days);
      expect(again.analysis?.models).toEqual(utc.analysis?.models);
      expect(again.data[0].totalUsage).toEqual(utc.data[0].totalUsage);
      expect(fs.openSync).not.toHaveBeenCalled(); expect(fs.readSync).not.toHaveBeenCalled();
    } finally {
      // On Windows, deleting TZ does not reliably reset Node's cached zone.
      process.env.TZ = originalZone ?? originalResolvedZone;
    }
  });

  it('upgrades an existing v4 cache without a time-zone marker from its compact timeline', () => {
    write('zone-upgrade', [meta('zone-upgrade'), context('gpt-6-sol'), token(at(27), 100)], true);
    new HistoryJobReader(sessions, ledger).listJobs({ nowMs: now + 3 * 86400000, period: 'lifetime' });
    const cacheFile = path.join(root, 'cache', 'archived-history.json');
    const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    delete cache.entries[0][1].timeZone;
    cache.entries[0][1].job.dailyUsage[0].date = '1999-01-01';
    fs.writeFileSync(cacheFile, JSON.stringify(cache));
    const reader = new HistoryJobReader(sessions, ledger);
    vi.mocked(fs.openSync).mockClear(); vi.mocked(fs.readSync).mockClear();
    expect(reader.listJobs({ nowMs: now + 3 * 86400000, period: 'lifetime' }).analysis?.days[0].date).toBe(localDay(at(27)));
    expect(fs.openSync).not.toHaveBeenCalled(); expect(fs.readSync).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(cacheFile, 'utf8')).entries[0][1].timeZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });

  it('keeps model totals within the selected archive scope and consolidates an orphan when its parent becomes available', () => {
    const old = write('old', [meta('old'), context('gpt-6-sol'), token(at(28), 100)], true);
    fs.utimesSync(old, new Date(at(20)), new Date(at(20)));
    for (let index = 0; index < 30; index++) write(`new-${index}`, [meta(`new-${index}`)], true);
    write('child', [meta('child', { source: 'subAgent', parent_thread_id: 'old' }), context('gpt-6-sol'), token(at(28), 50)]);
    const reader = new HistoryJobReader(sessions);
    const recent = reader.listJobs({ nowMs: now, period: 'today' });
    expect(recent.archives.included).toBe(30);
    expect(recent.analysis?.models?.[0]).toMatchObject({ usage: { totalTokens: 50 }, taskCount: 1 });
    const all = reader.listJobs({ nowMs: now, period: 'today', archiveMode: 'all' });
    expect(all.analysis?.models?.[0]).toMatchObject({ usage: { totalTokens: 150 }, taskCount: 1 });
    expect(all.data.some(job => job.id === 'child')).toBe(false);
  });

  it('reads only an appended model-switch tail and preserves attribution when the log is replaced', () => {
    const file = write('task', [meta('task'), context('gpt-6-sol'),
      { type: 'response_item', payload: { type: 'function_call_output', output: 'x'.repeat(2 * 1024 * 1024) } }, token(at(28), 100)]);
    const reader = new HistoryJobReader(sessions);
    reader.listJobs({ nowMs: now, period: 'today' });
    vi.mocked(fs.readSync).mockClear();
    const appended = lines([context('gpt-6-luna', at(28) + 1), token(at(28) + 2, 200, 300)]);
    fs.appendFileSync(file, appended);
    expect(reader.listJobs({ nowMs: now, period: 'today' }).analysis?.models?.map(row => row.model)).toEqual(['gpt-6-luna', 'gpt-6-sol']);
    const bytes = vi.mocked(fs.readSync).mock.results.reduce((sum, result) => sum + (result.type === 'return' ? Number(result.value) : 0), 0);
    expect(bytes).toBeLessThanOrEqual(Buffer.byteLength(appended) + 512);
    fs.writeFileSync(file, lines([meta('replacement'), context('gpt-6-astra'), token(at(28), 7)]));
    expect(reader.listJobs({ nowMs: now, period: 'today' }).analysis?.models?.[0]).toMatchObject({ model: 'gpt-6-astra', usage: { totalTokens: 7 } });
  });

  it('publishes the exact retained rates and high-context calculation with scoped verification dates', () => {
    const catalog = new HistoryJobReader(sessions).listJobs({ nowMs: now }).analysis!.pricing!;
    expect(catalog).toEqual(HISTORY_PRICING);
    expect(catalog.models.find(row => row.model === 'gpt-6-sol')?.verifiedAt).toBe('2026-09-26');
    expect(catalog.models.find(row => row.model === 'gpt-5.6-sol')?.verifiedAt).toBeNull();
    const sample = { inputTokens: 272001, cachedInputTokens: 100000, cacheWriteInputTokens: 20,
      outputTokens: 100, reasoningOutputTokens: 40, totalTokens: 272101 };
    const prices = catalog.models.find(row => row.model === 'gpt-6-sol')!;
    expect(estimateApiEquivalentCost(sample, 'gpt-6-sol')).toBeCloseTo(
      ((172001 * prices.input + 100000 * prices.cachedInput + 20 * prices.cacheWriteInput) * 2 + 100 * prices.output * 1.5) / 1e6);
    expect(estimateApiEquivalentCost(sample, 'unpriced')).toBeNull();
    expect(estimateApiEquivalentCost(sample, 'constructor')).toBeNull();
  });
});
