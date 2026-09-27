import { EventEmitter } from 'node:events';
import { MonitorService } from '../service';
import { codexUsageFromRateLimitsRead } from '../usage';
import type { CodexUsageSnapshot } from '../../../shared/monitor';

const usage = (email: string, percent: number): CodexUsageSnapshot => ({
  ...codexUsageFromRateLimitsRead({ rateLimits: { limitId: 'codex', primary: { usedPercent: percent, windowDurationMins: 10080 } } }),
  account: { type: 'chatgpt', email, planType: 'pro' },
});
function setup() {
  const client = Object.assign(new EventEmitter(), { ensureStarted: vi.fn(async () => {}), request: vi.fn(async () => ({data:[]})) });
  const source = { hasChanged: vi.fn(async () => false), read: vi.fn(async () => usage('a@example.com', 92)) };
  const service = new MonitorService(client as never, {listJobs:()=>({})} as never, source);
  const internals = service as any;
  internals.activeSessionTracker.listActiveSessions = vi.fn(() => []);
  internals.activeSessionTracker.isActivitySourceAvailable = vi.fn(() => true);
  // Isolate these fake accounts from the user's on-disk history.
  internals.accountUsageHistory = { record:vi.fn(), list:vi.fn(()=>[]) };
  return { client, source, service, internals };
}
afterEach(() => { vi.useRealTimers(); });

it('checks login changes once a minute using the existing activity scan and updates account and quota together', async () => {
  vi.useFakeTimers();
  const { service, source, internals }=setup();
  await service.refreshCurrentAccount();
  expect(service.getSnapshot().codexUsage.account?.email).toBe('a@example.com');
  await internals.checkAccountIdentity();
  expect(source.hasChanged).toHaveBeenCalledTimes(1);
  source.hasChanged.mockResolvedValueOnce(true);
  source.read.mockResolvedValueOnce(usage('b@example.com',2));
  await vi.advanceTimersByTimeAsync(60000);
  await internals.refreshActiveSessions();
  await internals.accountIdentityCheck;
  expect(service.getSnapshot().codexUsage).toMatchObject({account:{email:'b@example.com'},primaryLimit:{primary:{usedPercent:2}}});
  await internals.checkAccountIdentity();
  expect(source.hasChanged).toHaveBeenCalledTimes(2);
});

it('ignores old quota notifications and auth/close events from the separate metadata client', async () => {
  const { service, source, client }=setup();
  source.read.mockResolvedValueOnce(usage('b@example.com',2));
  await service.refreshCurrentAccount();
  client.emit('notification',{method:'account/rateLimits/updated',params:{rateLimits:{limitId:'codex',primary:{usedPercent:99,windowDurationMins:10080}}}});
  client.emit('notification',{method:'account/updated',params:{}});
  client.emit('close',1);
  expect(service.getSnapshot().codexUsage).toMatchObject({account:{email:'b@example.com'},primaryLimit:{primary:{usedPercent:2}}});
  expect(service.getSnapshot().codexUsage.stale).not.toBe(true);
  expect(source.read).toHaveBeenCalledTimes(1);
});

it('deduplicates manual readers, respects the cooldown, but refreshes immediately for a changed account', async () => {
  vi.useFakeTimers();
  const { service, source }=setup();
  await Promise.all(Array.from({length:20},()=>service.refreshCurrentAccount()));
  expect(source.read).toHaveBeenCalledTimes(1);
  await service.refreshCurrentAccount(); expect(source.read).toHaveBeenCalledTimes(1);
  source.hasChanged.mockResolvedValueOnce(true); source.read.mockResolvedValueOnce(usage('b@example.com',2));
  await service.refreshCurrentAccount(); expect(source.read).toHaveBeenCalledTimes(2);
  expect(service.getSnapshot().codexUsage.account?.email).toBe('b@example.com');
  await vi.advanceTimersByTimeAsync(30000);
  await service.refreshCurrentAccount(); expect(source.read).toHaveBeenCalledTimes(3);
});

it('discards an in-flight old-account response and performs one follow-up read for the new login', async () => {
  const { service, source, internals }=setup();
  await service.refreshCurrentAccount();
  let finish!: (value:CodexUsageSnapshot)=>void;
  source.read.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve}));
  const oldRefresh=internals.refreshCodexUsage();
  source.hasChanged.mockResolvedValueOnce(true); source.read.mockResolvedValueOnce(usage('b@example.com',2));
  await internals.checkAccountIdentity(true);
  expect(service.getSnapshot().codexUsage.stale).toBe(true);
  finish(usage('a@example.com',100)); await oldRefresh;
  await internals.codexUsageRefreshPromise;
  expect(service.getSnapshot().codexUsage).toMatchObject({account:{email:'b@example.com'},primaryLimit:{primary:{usedPercent:2}}});
  expect(internals.accountUsageHistory.record.mock.calls.map((c:any[])=>c[0].primaryLimit.primary.usedPercent)).toEqual([92,2]);
  expect(source.read).toHaveBeenCalledTimes(3);
});
