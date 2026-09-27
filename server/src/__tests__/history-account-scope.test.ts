import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HistoryAnalysis, HistoryJob, HistoryJobListResponse, HistoryUsageAllocation } from '../../../shared/monitor';
import { api } from '../../../web/src/api';
import { historyAccountKey, historyStateForAccount, loadHistoryPages } from '../../../web/src/useTaskHistory';

const previousState = (accountReadyKey = 'logged-in-a', accountId?: string) => ({
  accountKey: historyAccountKey(accountReadyKey, accountId), accountId,
  jobs: [{ id: 'previous-account-task' } as HistoryJob],
  allocation: { usedPercent: 83 } as HistoryUsageAllocation,
  analysis: { totalTokens: 1000 } as unknown as HistoryAnalysis,
  updatedAt: 123, nextRefreshAt: 456, error: 'previous account offline', loading: false,
  archives: { mode: 'recent' as const, total: 52, included: 30 }
});

afterEach(() => vi.restoreAllMocks());

describe('history account scope isolation', () => {
  it('clears every published result when the logged-in account changes with no explicit selection', () => {
    const previous = previousState();
    const nextKey = historyAccountKey('logged-in-b');
    expect(historyStateForAccount(previous, nextKey, 'recent')).toEqual({
      accountKey: nextKey, accountId: undefined, jobs: [], allocation: null, analysis: null,
      updatedAt: null, nextRefreshAt: null, error: null, loading: true,
      archives: { mode: 'recent', total: 0, included: 0 }
    });
    expect(previous.jobs[0].id).toBe('previous-account-task');
  });

  it('isolates explicit selections even when the logged-in account is unchanged', () => {
    const previous = previousState('logged-in-a', 'historical-b');
    expect(historyStateForAccount(previous, historyAccountKey('logged-in-a', 'historical-c'), 'all', 'historical-c'))
      .toMatchObject({ accountId: 'historical-c', jobs: [], updatedAt: null, error: null, loading: true,
        archives: { mode: 'all', total: 0, included: 0 } });
  });

  it('retains the last values and timestamp during refresh of the same account', () => {
    const refreshing = { ...previousState(), loading: true, error: null };
    expect(historyStateForAccount(refreshing, historyAccountKey('logged-in-a'), 'recent')).toBe(refreshing);
  });

  it('keeps a new-account failure visible instead of restoring the previous account data', () => {
    const key = historyAccountKey('logged-in-b');
    const empty = historyStateForAccount(previousState(), key, 'recent');
    const failed = { ...empty, loading: false, error: 'new account unavailable' };
    expect(historyStateForAccount(failed, key, 'recent')).toMatchObject({
      jobs: [], allocation: null, analysis: null, updatedAt: null,
      loading: false, error: 'new account unavailable'
    });
  });

  it('discards a late response that resolves after account loading was aborted', async () => {
    let resolvePage!: (response: HistoryJobListResponse) => void;
    const fetchPage = vi.spyOn(api, 'fetchHistoryJobs').mockImplementation(() => new Promise(resolve => { resolvePage = resolve; }));
    const controller = new AbortController();
    const loading = loadHistoryPages({ mode: 'recent', period: 'today', accountId: 'old', signal: controller.signal });
    controller.abort();
    resolvePage({ data: [{ id: 'old-task' } as HistoryJob], nextCursor: 'another-old-page', total: 2,
      archives: { mode: 'recent', total: 30, included: 30 }, usageAllocation: {} as HistoryUsageAllocation });
    await expect(loading).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });
});
