import { EventEmitter } from 'node:events';
import { MonitorService } from '../service';
import { AutomationController } from '../automation';
import { MonitorStore } from '../store';
import type { ActiveSession } from '../../../shared/monitor';

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

it('reads live counters without account, activity-discovery or history requests', () => {
  const request = vi.fn();
  const history = { listJobs: vi.fn() };
  const service = new MonitorService(Object.assign(new EventEmitter(), { request }) as never, history as never);
  const internal = service as unknown as {
    activeSessionTracker: { getLiveTokens: () => unknown; listActiveSessions: () => unknown };
  };
  const counters = { scope: 'local', status: 'collecting', windows: {} };
  const read = vi.spyOn(internal.activeSessionTracker, 'getLiveTokens').mockReturnValue(counters);
  const discover = vi.spyOn(internal.activeSessionTracker, 'listActiveSessions');
  expect(service.getLiveTokens()).toBe(counters);
  expect(read).toHaveBeenCalledTimes(1);
  expect(request).not.toHaveBeenCalled();
  expect(history.listJobs).not.toHaveBeenCalled();
  expect(discover).not.toHaveBeenCalled();
});

it('keeps the last activity list and holds idle automation when discovery fails', async () => {
  vi.useFakeTimers();
  const request = vi.fn(async () => ({ data: [] }));
  const client = Object.assign(new EventEmitter(), { request, ensureStarted: vi.fn(async () => {}) });
  const service = new MonitorService(client as never, { listJobs: vi.fn() } as never);
  const internal = service as unknown as {
    activeSessionTracker: { listActiveSessions: () => ActiveSession[]; isActivitySourceAvailable: () => boolean };
    automation: AutomationController;
    refreshActiveSessions: () => Promise<void>;
  };
  const runCommand = vi.fn(async () => {});
  internal.automation = new AutomationController(new MonitorStore(), { dryRun: false, runCommand });
  const active: ActiveSession = { id: 'fixture', name: null, preview: null, cwd: null,
    createdAt: null, updatedAt: new Date().toISOString(), lastTurnStartedAt: new Date().toISOString() };
  const scan = vi.spyOn(internal.activeSessionTracker, 'listActiveSessions').mockReturnValue([active]);
  const available = vi.spyOn(internal.activeSessionTracker, 'isActivitySourceAvailable').mockReturnValue(true);
  await internal.refreshActiveSessions();
  expect(service.getSnapshot().activeSessions).toEqual([active]);
  scan.mockReturnValue([]);
  available.mockReturnValue(false);
  request.mockClear();
  await service.armGlobalNoActiveSessionsAutomation({ settleDelayMs: 1000 });
  await vi.advanceTimersByTimeAsync(2000);
  expect(service.getSnapshot().activeSessions).toEqual([active]);
  expect(service.getSnapshot().globalAutomation.state.status).toBe('armed');
  expect(runCommand).not.toHaveBeenCalled();
  expect(request).not.toHaveBeenCalled();
  available.mockReturnValue(true);
  await internal.refreshActiveSessions();
  expect(service.getSnapshot().activeSessions).toEqual([]);
  await vi.advanceTimersByTimeAsync(999);
  expect(runCommand).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(runCommand).toHaveBeenCalledExactlyOnceWith('shutdown.exe', ['/s', '/t', '60']);
});

it('immediately suspends idle settling when a light live tail discovers a read failure', async () => {
  vi.useFakeTimers();
  const service = new MonitorService(new EventEmitter() as never, { listJobs: vi.fn() } as never);
  const internal = service as unknown as {
    activeSessionTracker: { getLiveTokens: () => unknown; isActivitySourceAvailable: () => boolean };
    automation: AutomationController;
  };
  const runCommand = vi.fn(async () => {});
  internal.automation = new AutomationController(new MonitorStore(), { dryRun: false, runCommand });
  internal.automation.armGlobalNoActiveSessions({ settleDelayMs: 1000 });
  await vi.advanceTimersByTimeAsync(999);
  vi.spyOn(internal.activeSessionTracker, 'getLiveTokens').mockReturnValue({ status: 'unavailable' });
  vi.spyOn(internal.activeSessionTracker, 'isActivitySourceAvailable').mockReturnValue(false);
  service.getLiveTokens();
  await vi.advanceTimersByTimeAsync(2000);
  expect(runCommand).not.toHaveBeenCalled();
  expect(internal.automation.getGlobalAutomation()).toMatchObject({ policy: { enabled: true }, state: { status: 'armed' } });
});
