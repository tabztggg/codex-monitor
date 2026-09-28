import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveTokenSnapshot, LiveTokenWindow } from '../../../shared/live-tokens';
import { api } from '../../../web/src/api';
import { createI18n, type Language } from '../../../web/src/localization';
import {
  LIVE_TOKEN_POLL_MS, LIVE_TOKEN_STALE_MS, LIVE_TOKEN_TIMEOUT_MS,
  LiveTokensPanel, LiveTokensView, liveTokenCacheHitPercent, receiveLiveTokenSnapshot, selectLiveTokenSnapshot, startLiveTokenPolling
} from '../../../web/src/components/LiveTokensPanel';

const testState = vi.hoisted(() => ({ language: 'en' as Language }));
vi.mock('../../../web/src/LanguageContext', () => ({ useI18n: () => createI18n(testState.language) }));
const nowMs = Date.parse('2026-09-27T02:00:00Z');
const windowData = (seconds: LiveTokenWindow['seconds'], inputTokens = 1000): LiveTokenWindow => ({
  seconds, status: 'ready', inputTokens, cachedInputTokens: inputTokens / 2, outputTokens: 200,
  reasoningOutputTokens: 100, totalTokens: inputTokens + 200, sampleCount: 2, taskCount: 1
});
const snapshot = (overrides: Partial<LiveTokenSnapshot> = {}): LiveTokenSnapshot => ({
  startedAt: new Date(nowMs - 600_000).toISOString(), updatedAt: new Date(nowMs).toISOString(),
  lastEventAt: new Date(nowMs - 1_000).toISOString(), status: 'ready', scope: 'local',
  windows: { oneMinute: windowData(60), fiveMinutes: windowData(300, 6000), twentyMinutes: windowData(1200, 20_000), oneHour: windowData(3600, 60_000) }, ...overrides
});
const render = (data: LiveTokenSnapshot | null, options: { seconds?: 1 | LiveTokenWindow['seconds']; failed?: boolean; nowMs?: number } = {}) => renderToStaticMarkup(createElement(LiveTokensView, {
  snapshot: data, seconds: options.seconds ?? 60, failed: options.failed ?? false, nowMs: options.nowMs ?? nowMs, onSelect: () => {}
}));

describe('live token presentation', () => {
  beforeEach(() => { testState.language = 'en'; });

  it('defaults to the one-minute window and shows loading as unknown', () => {
    const html = renderToStaticMarkup(createElement(LiveTokensPanel));
    expect(html).toContain('aria-pressed="true" aria-label="Last 1 minute">1 min');
    expect(html).toContain('Collecting reports');
    expect(html.match(/<dd>--<\/dd>/g)).toHaveLength(4);
  });

  it('switches between independent windows and names local account scope explicitly', () => {
    const one = render(snapshot());
    const five = render(snapshot(), { seconds: 300 });
    const twenty = render(snapshot(), { seconds: 1200 });
    const hour = render(snapshot(), { seconds: 3600 });
    expect(one).toContain('title="1,000">1K</dd>');
    expect(five).toContain('title="6,000">6K</dd>');
    expect(twenty).toContain('title="20,000">20K</dd>');
    expect(hour).toContain('title="60,000">60K</dd>');
    expect(five).toContain('aria-pressed="true" aria-label="Last 5 minutes">5 min');
    expect(twenty).toContain('aria-pressed="true" aria-label="Last 20 minutes">20 min');
    expect(hour).toContain('aria-pressed="true" aria-label="Last 1 hour">1 hour');
    expect(one).toContain('50%');
    expect(one).toContain('Reporting tasks</dt><dd>1</dd>');
    expect(one).toContain('Tasks with reports in this window');
    expect(one).not.toContain('Active tasks');
    expect(one).toContain('Local chats · Across accounts');
    expect(one).toContain('Reports cannot be attributed to the current login');
    expect(one).toContain('memory for a rolling hour');
    expect(one).toContain('Includes cached input');
    expect(one).toContain('Includes reasoning output');
    expect(one).not.toContain('tok/s');
  });

  it('derives the per-second view from the last minute without scaling ratios or task counts', () => {
    const data = snapshot();
    const html = render(data, { seconds: 1 });
    expect(html).toContain('aria-pressed="true" aria-label="Per-second average over the last minute">1 s');
    expect(html).toContain('Input (tok/s)</dt><dd title="16.67">16.67</dd>');
    expect(html).toContain('Output (tok/s)</dt><dd title="3.33">3.33</dd>');
    expect(html).toContain('Cache hit</dt><dd>50%</dd>');
    expect(html).toContain('Reporting tasks</dt><dd>1</dd>');
    expect(html).toContain('Tasks reporting in the last minute');
    expect(html).toContain('Per-second average · Last minute ÷ 60');
    expect(data.windows.oneMinute.inputTokens).toBe(1000);
    const low = snapshot({ windows: { ...data.windows, oneMinute: windowData(60, 1) } });
    expect(render(low, { seconds: 1 })).toContain('title="0.02">0.02</dd>');
  });

  it('keeps the full-minute warmup and failure semantics for per-second averages', () => {
    const data = snapshot({ startedAt: new Date(nowMs - 20_000).toISOString() });
    const html = render(data, { seconds: 1 });
    expect(html).toContain('Window still filling');
    expect(html).toContain('title="16.67">16.67</dd>');
    expect(render(null, { seconds: 1 }).match(/<dd>--<\/dd>/g)).toHaveLength(4);
    const unavailable = { ...data, windows: { ...data.windows, oneMinute: { ...data.windows.oneMinute, status: 'unavailable' as const } } };
    const loaded = receiveLiveTokenSnapshot({ snapshot: null, lastReady: {}, failed: false }, data);
    const selected = selectLiveTokenSnapshot(receiveLiveTokenSnapshot(loaded, unavailable), 1);
    expect(selected).toEqual({ snapshot: data, failed: true });
    expect(render(selected.snapshot, { seconds: 1, failed: selected.failed })).toContain('Stale snapshot');
    testState.language = 'zh';
    const chinese = render(data, { seconds: 1 });
    for (const text of ['>1 秒</button>', '输入（Token/秒）', '输出（Token/秒）', '每秒均值 · 最近 1 分钟 ÷ 60', '并非逐秒采集']) expect(chinese).toContain(text);
  });

  it('distinguishes no reports from initial collecting or unavailable data', () => {
    const empty = { ...windowData(60, 0), outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0, sampleCount: 0, taskCount: 0 };
    const ready = snapshot({ windows: { oneMinute: empty, fiveMinutes: { ...empty, seconds: 300 }, twentyMinutes: { ...empty, seconds: 1200 }, oneHour: { ...empty, seconds: 3600 } } });
    const html = render(ready);
    expect(html).toContain('No reports in this window');
    expect(html).toContain('title="0">0</dd>');
    expect(html).toContain('Cache hit</dt><dd>--</dd>');
    for (const status of ['collecting', 'unavailable'] as const) {
      const unknown = render({ ...ready, windows: { ...ready.windows, oneMinute: { ...empty, status } } });
      expect(unknown.match(/<dd>--<\/dd>/g)).toHaveLength(4);
      expect(unknown).not.toContain('No reports in this window');
    }
    expect(render(null, { failed: true })).toContain('-- does not mean zero usage');
  });

  it('uses the selected window status so short empty windows do not wait for one hour', () => {
    const startedAt = new Date(nowMs - 61_000).toISOString();
    const empty = { ...windowData(60, 0), outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0, sampleCount: 0, taskCount: 0 };
    const data = snapshot({ startedAt, status: 'collecting', windows: {
      oneMinute: empty,
      fiveMinutes: { ...empty, seconds: 300, status: 'collecting' },
      twentyMinutes: { ...empty, seconds: 1200, status: 'collecting' },
      oneHour: { ...empty, seconds: 3600, status: 'collecting' }
    } });
    const one = render(data);
    expect(one).toContain('No reports in this window');
    expect(one).toContain('title="0">0</dd>');
    expect(one).not.toContain('Window still filling');
    for (const seconds of [300, 1200, 3600] as const) {
      const html = render(data, { seconds });
      expect(html).toContain('Collecting reports');
      expect(html).toContain('Window still filling');
      expect(html.match(/<dd>--<\/dd>/g)).toHaveLength(4);
    }
    const unavailableHour = { ...data, windows: { ...data.windows, oneHour: { ...data.windows.oneHour, status: 'unavailable' as const } } };
    expect(render(unavailableHour, { seconds: 3600 })).toContain('-- does not mean zero usage');
    expect(render(unavailableHour)).toContain('No reports in this window');
  });

  it('folds the longer counting and discovery notes while keeping scope and update time visible', () => {
    const html = render(snapshot());
    const detailsAt = html.indexOf('<details class="live-tokens-details">');
    expect(detailsAt).toBeGreaterThan(0);
    expect(html.slice(0, detailsAt)).toContain('Local chats · Across accounts');
    expect(html.slice(0, detailsAt)).toContain('Updated at');
    expect(html.slice(detailsAt)).toContain('<span class="live-tokens-details-label">About these numbers</span></summary>');
    expect(html.slice(detailsAt)).toContain('not when tokens are generated');
    expect(html.slice(detailsAt)).toContain('New tasks may take up to one minute to appear');
    expect(html.slice(detailsAt)).toContain('No history is saved');
    expect(html).not.toContain('<details class="live-tokens-details" open');
  });

  it('shows partial warmup coverage and labels delayed snapshots without changing their values', () => {
    const current = snapshot({ startedAt: new Date(nowMs - 20_000).toISOString() });
    expect(render(current)).toContain('Window still filling');
    expect(render(current)).toContain('Collecting since');
    for (const options of [{ failed: true }, { nowMs: nowMs + LIVE_TOKEN_STALE_MS + 1 }]) {
      const html = render(current, options);
      expect(html).toContain('Stale snapshot');
      expect(html).toContain('Snapshot at');
      expect(html).toContain('Current window unavailable. Showing the last received snapshot.');
      expect(html).toContain('title="1,000">1K</dd>');
      expect(html).not.toContain('Window still filling');
    }
  });

  it('retains the last successful values if local usage reading becomes unavailable', () => {
    const confirmed = snapshot();
    const initial = { snapshot: null, lastReady: {}, failed: false };
    const unavailable = snapshot({ status: 'unavailable', updatedAt: new Date(nowMs + 5000).toISOString(), windows: {
      oneMinute: { ...windowData(60), status: 'unavailable' }, fiveMinutes: { ...windowData(300), status: 'unavailable' },
      twentyMinutes: { ...windowData(1200), status: 'unavailable' }, oneHour: { ...windowData(3600), status: 'unavailable' }
    } });
    const loaded = receiveLiveTokenSnapshot(initial, confirmed);
    const failed = receiveLiveTokenSnapshot(loaded, unavailable);
    expect(selectLiveTokenSnapshot(failed, 60)).toEqual({ snapshot: confirmed, failed: true });
    expect(selectLiveTokenSnapshot(receiveLiveTokenSnapshot(initial, unavailable), 60)).toEqual({ snapshot: unavailable, failed: true });
    const restarted = { ...unavailable, startedAt: new Date(nowMs + 5000).toISOString() };
    const afterRestart = receiveLiveTokenSnapshot(loaded, restarted);
    expect(afterRestart.lastReady).toEqual({});
    expect(selectLiveTokenSnapshot(afterRestart, 60).snapshot).toBe(restarted);
  });

  it('recovers a short window without relabeling the preserved hourly snapshot as current', () => {
    const confirmed = snapshot();
    const loaded = receiveLiveTokenSnapshot({ snapshot: null, lastReady: {}, failed: false }, confirmed);
    const partial = snapshot({ updatedAt: new Date(nowMs + 5000).toISOString(), windows: {
      ...confirmed.windows, oneMinute: windowData(60, 20), oneHour: { ...windowData(3600), status: 'unavailable' }
    } });
    const state = receiveLiveTokenSnapshot(loaded, partial);
    expect(selectLiveTokenSnapshot(state, 60)).toEqual({ snapshot: partial, failed: false });
    const hour = selectLiveTokenSnapshot(state, 3600);
    expect(hour).toEqual({ snapshot: confirmed, failed: true });
    const html = render(hour.snapshot, { seconds: 3600, failed: hour.failed });
    expect(html).toContain('Stale snapshot');
    expect(html).toContain(`dateTime="${confirmed.updatedAt}"`);
    expect(html).not.toContain(`dateTime="${partial.updatedAt}"`);
    expect(Object.keys(state.lastReady)).toHaveLength(4);
  });

  it('does not divide by zero or report an invalid cache subset', () => {
    expect(liveTokenCacheHitPercent(windowData(60))).toBe(50);
    for (const value of [0, -1, NaN, Infinity]) expect(liveTokenCacheHitPercent(windowData(60, value))).toBeNull();
    for (const cachedInputTokens of [-1, 1001, NaN, Infinity]) {
      expect(liveTokenCacheHitPercent({ ...windowData(60), cachedInputTokens })).toBeNull();
    }
  });

  it('renders bilingual scope, controls, metrics, warmup, and stale messaging', () => {
    testState.language = 'zh';
    const html = render(snapshot({ startedAt: new Date(nowMs - 20_000).toISOString() }));
    for (const text of ['实时 Token', '>1 分钟</button>', '>5 分钟</button>', '>20 分钟</button>', '>1 小时</button>', '<span class="live-tokens-details-label">说明</span></summary>', '本机对话 · 跨账号', '缓存命中率', '有记录任务', '仅内存保留 1 小时', '窗口尚未收集完整', '按 Monitor 收到 Token 上报的时间计入窗口', '无法归属到当前登录账号']) expect(html).toContain(text);
    const stale = render(snapshot(), { failed: true });
    expect(stale).toContain('快照已过期');
    expect(stale).toContain('当前窗口数据不可用，显示上次收到的快照。');
    expect(stale).not.toContain('Current window unavailable');
  });
});

class PageVisibility extends EventTarget {
  hidden = false;
  setHidden(hidden: boolean) { this.hidden = hidden; this.dispatchEvent(new Event('visibilitychange')); }
}

describe('live token reads', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(nowMs); });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it('only calls the local no-store endpoint with the supplied abort signal', async () => {
    const data = snapshot();
    const fetch = vi.fn(async () => new Response(JSON.stringify(data), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const controller = new AbortController();
    expect(await api.fetchLiveTokens(controller.signal)).toEqual(data);
    expect(fetch).toHaveBeenCalledWith('/api/live-tokens', expect.objectContaining({ signal: controller.signal, cache: 'no-store' }));
  });

  it('polls every five seconds while visible and stops on disposal', async () => {
    const page = new PageVisibility();
    vi.stubGlobal('document', page);
    const fetch = vi.spyOn(api, 'fetchLiveTokens').mockResolvedValue(snapshot());
    const onSnapshot = vi.fn();
    const onFailure = vi.fn();
    const stop = startLiveTokenPolling({ onSnapshot, onFailure });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(LIVE_TOKEN_POLL_MS);
    expect(fetch).toHaveBeenCalledTimes(2);
    page.setHidden(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetch).toHaveBeenCalledTimes(2);
    page.setHidden(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(3);
    stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(onSnapshot).toHaveBeenCalledTimes(3);
    expect(onFailure).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds stalled requests, reports failures, and silently aborts on unmount', async () => {
    vi.stubGlobal('document', new PageVisibility());
    const fetch = vi.spyOn(api, 'fetchLiveTokens').mockImplementation(signal => new Promise((_resolve, reject) => {
      signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));
    const onSnapshot = vi.fn();
    const onFailure = vi.fn();
    const stop = startLiveTokenPolling({ onSnapshot, onFailure });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(LIVE_TOKEN_TIMEOUT_MS);
    expect(fetch.mock.calls[0][0]!.aborted).toBe(true);
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onSnapshot).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(LIVE_TOKEN_POLL_MS);
    expect(fetch).toHaveBeenCalledTimes(2);
    stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch.mock.calls[1][0]!.aborted).toBe(true);
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
