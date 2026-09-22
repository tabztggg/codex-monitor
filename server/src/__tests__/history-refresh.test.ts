import { EventEmitter } from 'node:events';
import type { HistoryJob, HistoryJobListResponse } from '../../../shared/monitor';
import { api } from '../../../web/src/api';
import { loadHistoryPages } from '../../../web/src/useTaskHistory';
import { MonitorService } from '../service';
import type { HistoryJobReader } from '../history-jobs';

const emptyPage = (): HistoryJobListResponse => ({
  data: [], total: 0, nextCursor: null, archives: { mode: 'recent', total: 50, included: 30 },
  usageAllocation: { status: 'unavailable', usedPercent: null, windowStartedAt: null, resetsAt: null,
    limitName: null, windowLabel: null, basis: null }
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('scoped manual history rebuild', () => {
  it('rebuilds only the first page and keeps the recent archive scope for every page', async () => {
    const fetchPage = vi.spyOn(api, 'fetchHistoryJobs')
      .mockResolvedValueOnce({ ...emptyPage(), data: [{ id: 'first' } as HistoryJob], nextCursor: 'next' })
      .mockResolvedValueOnce({ ...emptyPage(), data: [{ id: 'second' } as HistoryJob] });
    const loaded = await loadHistoryPages({ mode: 'recent', period: 'quota', signal: new AbortController().signal, forceRefresh: true });
    expect(fetchPage.mock.calls.map(([request]) => request.forceRefresh)).toEqual([true, false]);
    expect(fetchPage.mock.calls.map(([request]) => request.archiveMode)).toEqual(['recent', 'recent']);
    expect(loaded.jobs.map(job => job.id)).toEqual(['first', 'second']);
    expect(loaded.archives.included).toBe(30);
  });

  it('ordinary refresh and different time ranges do not request a rebuild', async () => {
    const fetchPage = vi.spyOn(api, 'fetchHistoryJobs').mockResolvedValue(emptyPage());
    for (const period of ['quota', 'today', '7d', 'lifetime'] as const) {
      await loadHistoryPages({ mode: 'recent', period, signal: new AbortController().signal });
    }
    expect(fetchPage.mock.calls.every(([request]) => request.forceRefresh === false)).toBe(true);
    expect(fetchPage.mock.calls.every(([request]) => request.archiveMode === 'recent')).toBe(true);
  });

  it('stops canceled pagination before fetching or publishing another page', async () => {
    const controller = new AbortController();
    const fetchPage = vi.spyOn(api, 'fetchHistoryJobs').mockImplementation(async () => {
      controller.abort();
      return { ...emptyPage(), nextCursor: 'next' };
    });
    await expect(loadHistoryPages({ mode: 'recent', period: 'quota', signal: controller.signal, forceRefresh: true }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it('encodes explicit rebuilds in the API query and refuses to rebuild later pages', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(emptyPage()), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await api.fetchHistoryJobs({ sourceKinds: [], archiveMode: 'recent', forceRefresh: true });
    await api.fetchHistoryJobs({ sourceKinds: [], archiveMode: 'recent', forceRefresh: true, cursor: 'next' });
    await api.fetchHistoryJobs({ sourceKinds: [] });
    const urls = fetchMock.mock.calls.map(call => new URL(String(call[0]), 'http://localhost'));
    expect(urls.map(url => url.searchParams.get('forceRefresh'))).toEqual(['true', null, null]);
    expect(urls.every(url => url.searchParams.get('archives') === 'recent')).toBe(true);
  });
});

describe('history metadata reuse', () => {
  it('shares concurrent metadata pagination, caches it for 60 seconds, and forwards scoped rebuilds', async () => {
    let now = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const client = Object.assign(new EventEmitter(), {
      ensureStarted: vi.fn(async () => {}),
      request: vi.fn(async (_method: string, args: { cursor: string | null }) => args.cursor
        ? { data: [{ id: 'second', name: 'Second task' }], nextCursor: null }
        : { data: [{ id: 'first', name: 'First task' }], nextCursor: 'next' })
    });
    const reader = { listJobs: vi.fn((_args: Parameters<HistoryJobReader['listJobs']>[0]) => emptyPage()) };
    const service = new MonitorService(client as never, reader as never);
    await Promise.all([
      service.listHistoryJobs({ archiveMode: 'recent', forceRefresh: true }),
      service.listHistoryJobs({ archiveMode: 'recent', cursor: 'next', forceRefresh: true })
    ]);
    expect(client.ensureStarted).toHaveBeenCalledTimes(1);
    expect(client.request).toHaveBeenCalledTimes(2);
    const firstRead = reader.listJobs.mock.calls[0][0];
    expect(firstRead).toMatchObject({ archiveMode: 'recent', forceRefresh: true });
    expect([...(firstRead.metadataById?.keys() ?? [])]).toEqual(['first', 'second']);
    expect(reader.listJobs.mock.calls[1][0]).toMatchObject({ archiveMode: 'recent', cursor: 'next', forceRefresh: false });
    now += 59_999;
    await service.listHistoryJobs({});
    expect(client.request).toHaveBeenCalledTimes(2);
    now += 1;
    await Promise.all([service.listHistoryJobs({}), service.listHistoryJobs({})]);
    expect(client.request).toHaveBeenCalledTimes(4);
  });

  it('clears a failed shared metadata request so the next refresh can recover', async () => {
    const client = Object.assign(new EventEmitter(), {
      ensureStarted: vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined),
      request: vi.fn(async () => ({ data: [{ id: 'recovered' }], nextCursor: null }))
    });
    const reader = { listJobs: vi.fn((_args: Parameters<HistoryJobReader['listJobs']>[0]) => emptyPage()) };
    const service = new MonitorService(client as never, reader as never);
    await Promise.all([service.listHistoryJobs({}), service.listHistoryJobs({})]);
    expect(client.ensureStarted).toHaveBeenCalledTimes(1);
    expect(reader.listJobs.mock.calls.every(([args]) => args.metadataById === null)).toBe(true);
    await service.listHistoryJobs({});
    expect(client.ensureStarted).toHaveBeenCalledTimes(2);
    expect(reader.listJobs.mock.calls[2][0].metadataById?.has('recovered')).toBe(true);
  });
});
