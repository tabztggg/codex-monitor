import type { MonitorSnapshot } from '../../../shared/monitor';
import { api } from '../../../web/src/api';
import { startMonitorConnection } from '../../../web/src/monitor-connection';

class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  close = vi.fn(() => { this.readyState = 3; });
  constructor(readonly url: string) { FakeWebSocket.instances.push(this); }
  open() { this.readyState = 1; this.onopen?.(); }
  disconnect() { this.readyState = 3; this.onclose?.(); }
}

const snapshot = { marker: 'retained data' } as unknown as MonitorSnapshot;
let stop: (() => void) | undefined;
const callbacks = () => ({ snapshot: vi.fn(), error: vi.fn(), connectionLabel: vi.fn() });
const currentSocket = () => FakeWebSocket.instances.at(-1)!;

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.instances = [];
  vi.stubGlobal('window', { location: { protocol: 'http:', host: '192.168.1.2:4201' } });
  vi.stubGlobal('WebSocket', FakeWebSocket);
});
afterEach(() => {
  stop?.();
  stop = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('monitor connection recovery', () => {
  it('backs off failed HTTP requests to one per minute without also opening WebSockets', async () => {
    const fetch = vi.spyOn(api, 'fetchSnapshot').mockRejectedValue(new Error('offline'));
    stop = startMonitorConnection(callbacks());
    await vi.advanceTimersByTimeAsync(0);
    let attempts = 1;
    for (const delay of [1_500, 3_000, 6_000, 12_000, 24_000, 48_000, 60_000, 60_000]) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(fetch).toHaveBeenCalledTimes(attempts);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetch).toHaveBeenCalledTimes(++attempts);
    }
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it('retains backoff across short opens and resets only after a stable connection', async () => {
    vi.spyOn(api, 'fetchSnapshot').mockResolvedValue(snapshot);
    stop = startMonitorConnection(callbacks());
    await vi.advanceTimersByTimeAsync(0);
    currentSocket().open();
    currentSocket().disconnect();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(FakeWebSocket.instances).toHaveLength(2);
    currentSocket().open();
    await vi.advanceTimersByTimeAsync(29_999);
    currentSocket().disconnect();
    await vi.advanceTimersByTimeAsync(2_999);
    expect(FakeWebSocket.instances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeWebSocket.instances).toHaveLength(3);
    currentSocket().open();
    await vi.advanceTimersByTimeAsync(30_000);
    currentSocket().disconnect();
    await vi.advanceTimersByTimeAsync(1_499);
    expect(FakeWebSocket.instances).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeWebSocket.instances).toHaveLength(4);
  });

  it('aborts a stalled snapshot request after 30 seconds and ignores its late result', async () => {
    let resolve!: (value: MonitorSnapshot) => void;
    const fetch = vi.spyOn(api, 'fetchSnapshot').mockImplementationOnce(() => new Promise(done => { resolve = done; }))
      .mockResolvedValue(snapshot);
    const events = callbacks();
    stop = startMonitorConnection(events);
    const signal = fetch.mock.calls[0][0]!;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(signal.aborted).toBe(true);
    expect(events.error).toHaveBeenLastCalledWith('Monitor snapshot request timed out.');
    resolve(snapshot);
    await vi.advanceTimersByTimeAsync(0);
    expect(events.snapshot).not.toHaveBeenCalled();
    expect(FakeWebSocket.instances).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('closes a stalled WebSocket handshake and retries once after the deadline', async () => {
    const fetch = vi.spyOn(api, 'fetchSnapshot').mockResolvedValue(snapshot);
    const events = callbacks();
    stop = startMonitorConnection(events);
    await vi.advanceTimersByTimeAsync(0);
    const first = currentSocket();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(first.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(events.error).toHaveBeenLastCalledWith('Monitor WebSocket connection timed out.');
    await vi.advanceTimersByTimeAsync(1_500);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('aborts on disposal without publishing a late snapshot or opening a socket', async () => {
    let resolve!: (value: MonitorSnapshot) => void;
    const fetch = vi.spyOn(api, 'fetchSnapshot').mockImplementation(() => new Promise(done => { resolve = done; }));
    const events = callbacks();
    stop = startMonitorConnection(events);
    const signal = fetch.mock.calls[0][0]!;
    stop();
    expect(signal.aborted).toBe(true);
    resolve(snapshot);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(events.snapshot).not.toHaveBeenCalled();
    expect(events.error).not.toHaveBeenCalled();
    expect(events.connectionLabel).not.toHaveBeenCalled();
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores old socket callbacks after replacement and after disposal', async () => {
    const fetch = vi.spyOn(api, 'fetchSnapshot').mockResolvedValue(snapshot);
    const events = callbacks();
    stop = startMonitorConnection(events);
    await vi.advanceTimersByTimeAsync(0);
    const first = currentSocket();
    const staleCallbacks = [first.onopen!, first.onclose!, first.onerror!,
      () => firstMessage({ data: JSON.stringify({ type: 'snapshot', payload: { marker: 'old' } }) })];
    const firstMessage = first.onmessage!;
    first.disconnect();
    await vi.advanceTimersByTimeAsync(1_500);
    currentSocket().open();
    const counts = [events.snapshot.mock.calls.length, events.error.mock.calls.length, events.connectionLabel.mock.calls.length];
    staleCallbacks.forEach(call => call());
    expect([events.snapshot.mock.calls.length, events.error.mock.calls.length, events.connectionLabel.mock.calls.length]).toEqual(counts);
    const afterDispose = currentSocket().onclose!;
    stop();
    afterDispose();
    staleCallbacks.forEach(call => call());
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    expect(events.snapshot).toHaveBeenLastCalledWith(snapshot);
  });

  it('keeps the last snapshot when the next request fails and cancels a pending retry on disposal', async () => {
    const fetch = vi.spyOn(api, 'fetchSnapshot').mockResolvedValueOnce(snapshot).mockRejectedValue(new Error('offline'));
    const events = callbacks();
    stop = startMonitorConnection(events);
    await vi.advanceTimersByTimeAsync(0);
    currentSocket().disconnect();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(events.snapshot).toHaveBeenCalledTimes(1);
    expect(events.snapshot).toHaveBeenLastCalledWith(snapshot);
    expect(events.error).toHaveBeenLastCalledWith('offline');
    stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('passes the cancellation signal to the snapshot HTTP request', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(snapshot)));
    vi.stubGlobal('fetch', fetch);
    const signal = new AbortController().signal;
    await api.fetchSnapshot(signal);
    expect(fetch).toHaveBeenCalledWith('/api/snapshot', expect.objectContaining({ signal }));
  });
});
