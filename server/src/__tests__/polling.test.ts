import { EventEmitter } from 'node:events';
import { startVisiblePolling } from '../../../web/src/visible-polling';
import { readRefreshInterval, refreshPreferenceKey } from '../../../web/src/refresh-preferences';
import { MonitorService } from '../service';

class PageVisibility extends EventTarget {
  hidden = false;
  setHidden(hidden: boolean) {
    this.hidden = hidden;
    this.dispatchEvent(new Event('visibilitychange'));
  }
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('visible-page polling', () => {
  it('does no hidden polling, catches up once when overdue, and preserves an unexpired deadline', async () => {
    const page = new PageVisibility();
    vi.stubGlobal('document', page);
    const task = vi.fn(async () => {});
    const scheduled = vi.fn();
    const stop = startVisiblePolling({ intervalMs: 600_000, task, onSchedule: scheduled });
    await vi.advanceTimersByTimeAsync(0);
    expect(task).toHaveBeenCalledTimes(1);
    page.setHidden(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(scheduled).toHaveBeenLastCalledWith(null);
    await vi.advanceTimersByTimeAsync(120_000);
    page.setHidden(false);
    await vi.advanceTimersByTimeAsync(479_999);
    expect(task).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(task).toHaveBeenCalledTimes(2);
    page.setHidden(true);
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(task).toHaveBeenCalledTimes(2);
    page.setHidden(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(task).toHaveBeenCalledTimes(3);
    stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('waits for a slow read without overlap and aborts it on disposal', async () => {
    const page = new PageVisibility();
    vi.stubGlobal('document', page);
    let finish!: () => void;
    const task = vi.fn((_signal: AbortSignal) => new Promise<void>(resolve => { finish = resolve; }));
    const stop = startVisiblePolling({ intervalMs: 600_000, task });
    await vi.advanceTimersByTimeAsync(0);
    page.setHidden(true);
    page.setHidden(false);
    await vi.advanceTimersByTimeAsync(1_200_000);
    expect(task).toHaveBeenCalledTimes(1);
    stop();
    expect(task.mock.calls[0][0].aborted).toBe(true);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    page.setHidden(true); page.setHidden(false);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('defers the initial read while hidden and retains explicit pause after failure', async () => {
    const page = new PageVisibility();
    page.hidden = true;
    vi.stubGlobal('document', page);
    const task = vi.fn(async () => null);
    const stop = startVisiblePolling({ intervalMs: 600_000, task });
    await vi.advanceTimersByTimeAsync(1_200_000);
    expect(task).not.toHaveBeenCalled();
    page.setHidden(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(task).toHaveBeenCalledTimes(1);
    page.setHidden(true); page.setHidden(false);
    await vi.advanceTimersByTimeAsync(1_200_000);
    expect(task).toHaveBeenCalledTimes(1);
    stop();
  });

  it('finishes a hidden in-flight read without scheduling more and uses completion time', async () => {
    const page = new PageVisibility();
    vi.stubGlobal('document', page);
    let finish!: () => void;
    const task = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const stop = startVisiblePolling({ intervalMs: 600_000, task });
    await vi.advanceTimersByTimeAsync(0);
    page.setHidden(true);
    await vi.advanceTimersByTimeAsync(30_000);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    page.setHidden(false);
    await vi.advanceTimersByTimeAsync(599_999);
    expect(task).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(task).toHaveBeenCalledTimes(2);
    stop(); finish();
  });
});

describe('low-overhead preferences', () => {
  const read = (entries: Record<string, string>) => readRefreshInterval({ getItem: key => entries[key] ?? null });
  it('defaults to ten minutes and migrates old fast preferences', () => {
    expect(read({})).toBe(600_000);
    for (const value of [30_000, 60_000, 120_000, 300_000]) {
      expect(read({ 'codex-monitor-refresh-interval-ms': String(value) })).toBe(600_000);
    }
  });
  it('preserves subsequent explicit choices, including fast and hourly polling', () => {
    for (const value of [30_000, 600_000, 1_800_000, 3_600_000]) {
      expect(read({ [refreshPreferenceKey]: String(value) })).toBe(value);
    }
    expect(read({ [refreshPreferenceKey]: '-1' })).toBe(600_000);
    expect(readRefreshInterval({ getItem: () => { throw new Error('disabled'); } })).toBe(600_000);
  });
});

describe('backend polling and shutdown safety', () => {
  const setup = () => {
    const client = Object.assign(new EventEmitter(), { ensureStarted: vi.fn(async () => {}) });
    const service = new MonitorService(client as never, { listJobs: vi.fn() } as never);
    const internal = service as any;
    internal.refreshActiveSessions = vi.fn(async () => { internal.automation.evaluateActiveSessions(1); });
    internal.refreshCodexUsage = vi.fn(async () => {});
    return { service, internal, client };
  };
  it('scans activity once a minute and quota once in five minutes after initial load', async () => {
    const { service, internal, client } = setup();
    await service.start();
    expect(internal.refreshActiveSessions).toHaveBeenCalledTimes(1);
    expect(internal.refreshCodexUsage).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(internal.refreshActiveSessions).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(240_001);
    expect(internal.refreshActiveSessions).toHaveBeenCalledTimes(6);
    expect(internal.refreshCodexUsage).toHaveBeenCalledTimes(2);
    client.emit('notification', { method: 'account/updated', params: {} });
    expect(internal.refreshCodexUsage).toHaveBeenCalledTimes(3);
  });
  it('reconciles activity before arming, switches to two seconds, and slows on disarm', async () => {
    const { service, internal } = setup();
    await service.start();
    const arm = vi.spyOn(internal.automation, 'armGlobalNoActiveSessions');
    await service.armGlobalNoActiveSessionsAutomation({});
    expect(internal.refreshActiveSessions).toHaveBeenCalledTimes(2);
    expect(internal.refreshActiveSessions.mock.invocationCallOrder[1]).toBeLessThan(arm.mock.invocationCallOrder[0]);
    expect(service.getSnapshot().globalAutomation.state.settlesAt).toBeNull();
    await vi.advanceTimersByTimeAsync(6_000);
    expect(internal.refreshActiveSessions).toHaveBeenCalledTimes(5);
    await service.cancelGlobalNoActiveSessionsAutomation();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(internal.refreshActiveSessions).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(1);
    expect(internal.refreshActiveSessions).toHaveBeenCalledTimes(6);
  });
});
