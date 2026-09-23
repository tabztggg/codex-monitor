import { useEffect, useRef, useState } from 'react';
import type { HistoryAnalysis, HistoryPeriod, HistoryArchiveMode, HistoryArchiveScope, HistoryJob, HistoryUsageAllocation } from '../../shared/monitor';
import { api } from './api';

/** A rebuild applies once to the selected scope; remaining pages reuse it. */
export async function loadHistoryPages(args: {
  mode: HistoryArchiveMode; period: HistoryPeriod; signal: AbortSignal; forceRefresh?: boolean;
}) {
  const jobs = new Map<string, HistoryJob>();
  let cursor: string | null = null;
  let allocation: HistoryUsageAllocation | null = null;
  let analysis: HistoryAnalysis | null = null;
  let archives: HistoryArchiveScope = { mode: args.mode, total: 0, included: 0 };
  const cursors = new Set<string>();
  do {
    args.signal.throwIfAborted();
    const response = await api.fetchHistoryJobs({ sourceKinds: [], cursor, limit: 100, sortKey: 'createdAt', sortDirection: 'asc',
      archiveMode: args.mode, period: args.period, signal: args.signal, forceRefresh: args.forceRefresh === true && cursor === null });
    args.signal.throwIfAborted();
    response.data.forEach(job => jobs.set(job.id, job));
    allocation = response.usageAllocation;
    analysis = response.analysis ?? null;
    archives = response.archives;
    cursor = response.nextCursor;
    if (cursor && cursors.has(cursor)) throw new Error('History pagination did not advance.');
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return { jobs: [...jobs.values()], allocation, analysis, archives };
}

/** Load only the requested archive scope; publish complete pages atomically. */
export function useTaskHistory(refreshIntervalMs = 30_000, period: HistoryPeriod = 'quota', accountReadyKey = '') {
  const [request, setRequest] = useState<{ mode: HistoryArchiveMode; version: number }>({ mode: 'recent', version: 0 });
  const rebuildPending = useRef(false);
  const [state, setState] = useState<{
    analysis: HistoryAnalysis | null;
    nextRefreshAt: number | null;
    jobs: HistoryJob[];
    allocation: HistoryUsageAllocation | null;
    updatedAt: number | null;
    error: string | null;
    archives: HistoryArchiveScope;
    loading: boolean;
  }>({ jobs: [], allocation: null, analysis: null, nextRefreshAt: null, updatedAt: null, error: null, archives: { mode: 'recent', total: 0, included: 0 }, loading: true });
  useEffect(() => {
    const controller = new AbortController();
    let timer: number | undefined;
    async function refresh() {
      let succeeded = false;
      const forceRefresh = rebuildPending.current;
      rebuildPending.current = false;
      setState(previous => ({ ...previous, loading: true, nextRefreshAt: null, error: null }));
      try {
        const loaded = await loadHistoryPages({ mode: request.mode, period, signal: controller.signal, forceRefresh });
        if (controller.signal.aborted) return;
        succeeded = true;
        setState({ ...loaded, loading: false, nextRefreshAt: null, updatedAt: Date.now(), error: null });
      } catch (error) {
        if (!controller.signal.aborted) setState(previous => ({ ...previous, loading: false, error: error instanceof Error ? error.message : String(error) }));
      } finally {
        if (!controller.signal.aborted && (succeeded || request.mode === 'recent')) {
          const nextRefreshAt = Date.now() + refreshIntervalMs;
          setState(previous => ({ ...previous, nextRefreshAt }));
          timer = window.setTimeout(refresh, refreshIntervalMs);
        }
      }
    }
    void refresh();
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [request, refreshIntervalMs, period, accountReadyKey]);
  return { ...state, requestedMode: request.mode, refreshNow: () => {
    if (state.loading) return;
    setState(previous => ({ ...previous, loading: true, nextRefreshAt: null }));
    setRequest(previous => ({ ...previous, version: previous.version + 1 }));
  }, rebuildStatistics: () => {
    if (state.loading) return;
    rebuildPending.current = true;
    setState(previous => ({ ...previous, loading: true, nextRefreshAt: null }));
    setRequest(previous => ({ ...previous, version: previous.version + 1 }));
  }, loadArchives: (mode: HistoryArchiveMode) => {
    rebuildPending.current = false;
    setState(previous => ({ ...previous, loading: true, error: null }));
    setRequest(previous => ({ mode, version: previous.version + 1 }));
  } };
}
