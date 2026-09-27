import { api, HISTORY_PAGE_TIMEOUT_MS } from '../../../web/src/api';
import { loadHistoryPages } from '../../../web/src/useTaskHistory';
import { startVisiblePolling } from '../../../web/src/visible-polling';

const page = { data: [], nextCursor: null, archives: { mode: 'recent', included: 0, total: 0 }, usageAllocation: null };
const response = () => new Response(JSON.stringify(page), { status: 200 });

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each(['headers', 'body'])('bounds a stalled history %s read and leaves the caller usable', async stall => {
  const parent = new AbortController();
  let requestSignal: AbortSignal | undefined;
  vi.stubGlobal('fetch', vi.fn((_input, init) => {
    requestSignal = init.signal;
    // Model a transport/body that never settles, even when cancellation is requested.
    return stall === 'headers' ? new Promise(() => {}) : Promise.resolve({ ok: true, json: () => new Promise(() => {}) });
  }));
  const pending = loadHistoryPages({ mode: 'recent', period: 'today', signal: parent.signal });
  const failed = expect(pending).rejects.toThrow('Task request timed out');
  await vi.advanceTimersByTimeAsync(HISTORY_PAGE_TIMEOUT_MS);
  await failed;
  expect(requestSignal?.aborted).toBe(true);
  expect(parent.signal.aborted).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
  vi.stubGlobal('fetch', vi.fn(async () => response()));
  expect(await loadHistoryPages({ mode: 'recent', period: 'today', signal: parent.signal })).toMatchObject({ jobs: [] });
  expect(vi.getTimerCount()).toBe(0);
});

it('cancels an in-flight request on navigation and removes its deadline', async () => {
  const parent = new AbortController();
  let signal: AbortSignal | undefined;
  const fetchMock = vi.fn((_input, init) => { signal = init.signal; return new Promise(() => {}); });
  vi.stubGlobal('fetch', fetchMock);
  const pending = api.fetchHistoryJobs({ sourceKinds: [], signal: parent.signal });
  const failed = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  parent.abort();
  await failed;
  expect(signal?.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
  await expect(api.fetchHistoryJobs({ sourceKinds: [], signal: parent.signal })).rejects.toMatchObject({ name: 'AbortError' });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('resumes the normal polling interval after a hung request, without overlap or rapid retries', async () => {
  vi.stubGlobal('document', Object.assign(new EventTarget(), { hidden: false }));
  const fetchMock = vi.fn().mockImplementationOnce(() => new Promise(() => {})).mockImplementation(async () => response());
  vi.stubGlobal('fetch', fetchMock);
  const failures: string[] = [];
  let loaded = 0;
  const stop = startVisiblePolling({ intervalMs: 600_000, task: async signal => {
    try { await loadHistoryPages({ mode: 'recent', period: 'today', signal }); loaded++; }
    catch (error) { failures.push((error as Error).message); }
  } });
  try {
    await vi.advanceTimersByTimeAsync(HISTORY_PAGE_TIMEOUT_MS);
    expect(failures).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(599_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(loaded).toBe(1);
  } finally { stop(); }
  expect(vi.getTimerCount()).toBe(0);
});
