import { useEffect, useRef, useState } from 'react';
import type { HistoryAnalysis, HistoryPeriod, HistoryArchiveMode, HistoryArchiveScope, HistoryJob, HistoryUsageAllocation } from '../../shared/monitor';
import { api } from './api';
import { DEFAULT_HISTORY_INTERVAL_MS } from '../../shared/polling';
import { startVisiblePolling } from './visible-polling';

interface TaskHistoryState {
  accountKey: string;
  accountId?: string;
  analysis: HistoryAnalysis | null;
  nextRefreshAt: number | null;
  jobs: HistoryJob[];
  allocation: HistoryUsageAllocation | null;
  updatedAt: number | null;
  error: string | null;
  archives: HistoryArchiveScope;
  loading: boolean;
}

export function historyAccountKey(accountReadyKey: string, accountId?: string): string {
  return JSON.stringify([accountReadyKey, accountId ?? null]);
}

function emptyHistoryState(accountKey: string, mode: HistoryArchiveMode, accountId?: string): TaskHistoryState {
  return { accountKey, accountId, jobs: [], allocation: null, analysis: null, nextRefreshAt: null, updatedAt: null,
    error: null, archives: { mode, total: 0, included: 0 }, loading: true };
}

/** A new account must never display the previous account's data or failure state. */
export function historyStateForAccount(state: TaskHistoryState, accountKey: string, mode: HistoryArchiveMode, accountId?: string): TaskHistoryState {
  return state.accountKey === accountKey ? state : emptyHistoryState(accountKey, mode, accountId);
}

/** A rebuild applies once to the selected scope; remaining pages reuse it. */
export async function loadHistoryPages(args: {
  mode: HistoryArchiveMode; period: HistoryPeriod; accountId?: string; range?: {from: string; to: string}; signal: AbortSignal; forceRefresh?: boolean;
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
      archiveMode: args.mode, period: args.period, accountId: args.accountId, range: args.range, signal: args.signal, forceRefresh: args.forceRefresh === true && cursor === null });
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
export function useTaskHistory(refreshIntervalMs = DEFAULT_HISTORY_INTERVAL_MS, period: HistoryPeriod = 'quota', accountReadyKey = '', accountId?: string, range?: {from: string; to: string}) {
  const [request, setRequest] = useState<{ mode: HistoryArchiveMode; version: number }>({ mode: 'recent', version: 0 });
  const rebuildPending = useRef(false);
  const accountKey = historyAccountKey(accountReadyKey, accountId);
  const [state, setState] = useState<TaskHistoryState>(() => emptyHistoryState(accountKey, 'recent', accountId));
  useEffect(() => {
    return startVisiblePolling({
      intervalMs: refreshIntervalMs,
      onSchedule: nextRefreshAt => setState(previous => previous.nextRefreshAt === nextRefreshAt ? previous : ({ ...previous, nextRefreshAt })),
      task: async signal => {
        let succeeded = false;
        const forceRefresh = rebuildPending.current;
        rebuildPending.current = false;
        setState(previous => ({ ...historyStateForAccount(previous, accountKey, request.mode, accountId), loading: true, nextRefreshAt: null, error: null }));
        try {
          const loaded = await loadHistoryPages({ mode: request.mode, period, accountId, range, signal, forceRefresh });
          if (signal.aborted) return;
          succeeded = true;
          setState(previous => signal.aborted ? previous : { ...loaded, accountKey, accountId, loading: false, nextRefreshAt: null, updatedAt: Date.now(), error: null });
        } catch (error) {
          if (!signal.aborted) setState(previous => signal.aborted ? previous : ({ ...historyStateForAccount(previous, accountKey, request.mode, accountId), loading: false, error: error instanceof Error ? error.message : String(error) }));
        }
        return succeeded || request.mode === 'recent' ? refreshIntervalMs : null;
      }
    });
  }, [request, refreshIntervalMs, period, accountKey, accountId, range]);
  const visibleState = historyStateForAccount(state, accountKey, request.mode, accountId);
  return { ...visibleState, requestedMode: request.mode, refreshNow: () => {
    if (visibleState.loading) return;
    setState(previous => ({ ...previous, loading: true, nextRefreshAt: null }));
    setRequest(previous => ({ ...previous, version: previous.version + 1 }));
  }, rebuildStatistics: () => {
    if (visibleState.loading) return;
    rebuildPending.current = true;
    setState(previous => ({ ...previous, loading: true, nextRefreshAt: null }));
    setRequest(previous => ({ ...previous, version: previous.version + 1 }));
  }, loadArchives: (mode: HistoryArchiveMode) => {
    rebuildPending.current = false;
    setState(previous => ({ ...previous, loading: true, error: null }));
    setRequest(previous => ({ mode, version: previous.version + 1 }));
  } };
}
