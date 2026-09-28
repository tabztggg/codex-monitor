import { useEffect, useState } from 'react';
import type { LiveTokenSnapshot, LiveTokenWindow } from '../../../shared/live-tokens';
import { api } from '../api';
import { useI18n } from '../LanguageContext';
import { formatTokenCount } from '../usage-display';
import { startVisiblePolling } from '../visible-polling';
import './LiveTokensPanel.css';

export const LIVE_TOKEN_POLL_MS = 5_000;
export const LIVE_TOKEN_TIMEOUT_MS = 4_000;
export const LIVE_TOKEN_STALE_MS = 15_000;
type LiveTokenSeconds = 1 | LiveTokenWindow['seconds'];
const timeWindows = [
  { seconds: 1, key: 'oneMinute', label: '1 s', description: 'Per-second average over the last minute' },
  { seconds: 60, key: 'oneMinute', label: '1 min', description: 'Last 1 minute' },
  { seconds: 300, key: 'fiveMinutes', label: '5 min', description: 'Last 5 minutes' },
  { seconds: 1200, key: 'twentyMinutes', label: '20 min', description: 'Last 20 minutes' },
  { seconds: 3600, key: 'oneHour', label: '1 hour', description: 'Last 1 hour' }
] as const;
type LiveTokenWindowKey = typeof timeWindows[number]['key'];
export interface LiveTokenUiState {
  snapshot: LiveTokenSnapshot | null;
  lastReady: Partial<Record<LiveTokenWindowKey, LiveTokenSnapshot>>;
  failed: boolean;
}
const keyForWindow = (seconds: LiveTokenSeconds) => timeWindows.find(window => window.seconds === seconds)!.key;

/** Only local, ephemeral reads. Cleanup aborts the active request as well as polling. */
export function startLiveTokenPolling(options: {
  onSnapshot: (snapshot: LiveTokenSnapshot) => void;
  onFailure: () => void;
  onClock?: (nowMs: number) => void;
}): () => void {
  return startVisiblePolling({
    intervalMs: LIVE_TOKEN_POLL_MS,
    onSchedule: () => options.onClock?.(Date.now()),
    task: async signal => {
      const request = new AbortController();
      const abort = () => request.abort();
      signal.addEventListener('abort', abort, { once: true });
      const timeout = setTimeout(abort, LIVE_TOKEN_TIMEOUT_MS);
      try {
        const snapshot = await api.fetchLiveTokens(request.signal);
        if (!signal.aborted && !request.signal.aborted) options.onSnapshot(snapshot);
        else if (!signal.aborted) options.onFailure();
      } catch {
        if (!signal.aborted) options.onFailure();
      } finally {
        clearTimeout(timeout);
        signal.removeEventListener('abort', abort);
      }
    }
  });
}

export function liveTokenCacheHitPercent(window: LiveTokenWindow): number | null {
  const { inputTokens, cachedInputTokens } = window;
  return Number.isFinite(inputTokens) && inputTokens > 0 && Number.isFinite(cachedInputTokens)
    && cachedInputTokens >= 0 && cachedInputTokens <= inputTokens
    ? cachedInputTokens / inputTokens * 100 : null;
}

export function receiveLiveTokenSnapshot(previous: LiveTokenUiState, next: LiveTokenSnapshot): LiveTokenUiState {
  // At most four confirmed snapshots, each with its original observation time.
  // A new Monitor process starts a new observation period.
  const lastReady: LiveTokenUiState['lastReady'] = previous.snapshot?.startedAt === next.startedAt ? { ...previous.lastReady } : {};
  for (const { key } of timeWindows) if (next.windows[key].status === 'ready') lastReady[key] = next;
  return { snapshot: next, lastReady, failed: false };
}

export function selectLiveTokenSnapshot(state: LiveTokenUiState, seconds: LiveTokenSeconds) {
  const key = keyForWindow(seconds);
  const unavailable = state.snapshot?.windows[key].status === 'unavailable';
  return {
    snapshot: unavailable ? state.lastReady[key] ?? state.snapshot : state.snapshot,
    failed: state.failed || unavailable
  };
}

export function LiveTokensPanel() {
  const [state, setState] = useState<LiveTokenUiState>(() => ({ snapshot: null, lastReady: {}, failed: false }));
  const [seconds, setSeconds] = useState<LiveTokenSeconds>(60);
  const [nowMs, setNowMs] = useState(Date.now);
  useEffect(() => startLiveTokenPolling({
    onSnapshot: next => {
      setState(previous => receiveLiveTokenSnapshot(previous, next));
    },
    onFailure: () => setState(previous => ({ ...previous, failed: true })),
    onClock: setNowMs
  }), []);
  return <LiveTokensView {...selectLiveTokenSnapshot(state, seconds)} seconds={seconds} nowMs={nowMs} onSelect={setSeconds} />;
}

export function LiveTokensView({ snapshot, failed = false, seconds, nowMs, onSelect }: {
  snapshot: LiveTokenSnapshot | null;
  failed?: boolean;
  seconds: LiveTokenSeconds;
  nowMs: number;
  onSelect: (seconds: LiveTokenSeconds) => void;
}) {
  const { t, locale, dateTime, time } = useI18n();
  const windowKey = keyForWindow(seconds);
  const window = snapshot?.windows[windowKey];
  const ready = window?.status === 'ready';
  const updatedMs = snapshot ? Date.parse(snapshot.updatedAt) : NaN;
  const stale = ready && (failed || !Number.isFinite(updatedMs) || nowMs - updatedMs > LIVE_TOKEN_STALE_MS);
  const available = ready && !!window;
  const perSecond = seconds === 1;
  const empty = available && window.sampleCount === 0;
  const warming = !!snapshot && nowMs - Date.parse(snapshot.startedAt) < (perSecond ? 60 : seconds) * 1000;
  const cacheHit = available ? liveTokenCacheHitPercent(window) : null;
  const number = (value: number) => value.toLocaleString(locale, { maximumFractionDigits: 1 });
  const tokenTitle = (value: number | undefined) => available && value !== undefined
    ? (perSecond ? value / 60 : value).toLocaleString(locale, { maximumFractionDigits: perSecond ? 2 : 1 }) : undefined;
  const count = (value: number | undefined) => available && value !== undefined
    ? perSecond ? (value / 60).toLocaleString(locale, { notation: 'compact', maximumFractionDigits: 2 }) : formatTokenCount(value, locale) : '--';
  const unavailable = window?.status === 'unavailable' || (!ready && failed);
  const state = stale ? 'Stale snapshot' : unavailable ? 'Unavailable' : !ready ? 'Collecting reports' : empty ? 'No reports in this window' : 'Recent reports';
  return <section className={`live-tokens-panel${stale ? ' live-tokens-stale' : ''}`} aria-label={t('Live token reports')}>
    <div className="live-tokens-heading">
      <div className="live-tokens-title"><h3>{t('Live token reports')}</h3><span className="live-tokens-status"
        data-state={stale ? 'stale' : unavailable ? 'unavailable' : !ready ? 'collecting' : empty ? 'empty' : 'ready'} role="status">{t(state)}</span></div>
      <div className="live-tokens-range" role="group" aria-label={t('Live token time window')}>
        {timeWindows.map(({ seconds: value, label, description }) => <button key={value} type="button" aria-pressed={seconds === value}
          aria-label={t(description)} onClick={() => onSelect(value)}>{t(label)}</button>)}
      </div>
    </div>
    <p className="live-tokens-scope">{t('Local chats · Across accounts')}{perSecond ? ` · ${t('Per-second average · Last minute ÷ 60')}` : ''}</p>
    <dl className="live-tokens-metrics">
      <div><dt>{t(perSecond ? 'Input (tok/s)' : 'Input')}</dt><dd title={tokenTitle(window?.inputTokens)}>{count(window?.inputTokens)}</dd><small>{t('Includes cached input')}</small></div>
      <div><dt>{t(perSecond ? 'Output (tok/s)' : 'Output')}</dt><dd title={tokenTitle(window?.outputTokens)}>{count(window?.outputTokens)}</dd><small>{t('Includes reasoning output')}</small></div>
      <div><dt>{t('Cache hit')}</dt><dd>{cacheHit === null ? '--' : `${number(cacheHit)}%`}</dd><small>{t('Cached input / input')}</small></div>
      <div><dt>{t('Reporting tasks')}</dt><dd>{available ? number(window.taskCount) : '--'}</dd><small>{t(perSecond ? 'Tasks reporting in the last minute' : 'Tasks with reports in this window')}</small></div>
    </dl>
    {snapshot && !stale && !unavailable && (warming || !ready) && <p className="live-tokens-observation">{t('Collecting since {time}', { time: time(snapshot.startedAt) })}{warming ? ` · ${t('Window still filling')}` : ''}</p>}
    {stale && <p className="live-tokens-warning" role="status">{t('Current window unavailable. Showing the last received snapshot.')}</p>}
    {!stale && unavailable && <p className="live-tokens-warning">{t('Local token reports are unavailable. -- does not mean zero usage.')}</p>}
    <div className="live-tokens-footer">
      <span className="live-tokens-updated">{t(stale ? 'Snapshot at' : 'Updated at')}: {snapshot ? <time dateTime={snapshot.updatedAt} title={dateTime(snapshot.updatedAt)}>{time(snapshot.updatedAt)}</time> : '--'}</span>
      <details className="live-tokens-details">
        <summary><span className="live-tokens-memory">{t('Memory only · 1 hour')}</span><span className="live-tokens-details-label">{t('About these numbers')}</span></summary>
        <div className="live-tokens-details-content">
          {perSecond && <p>{t('Per-second input and output are the last minute totals divided by 60, not measurements sampled every second. Cache hit and task count use the same minute.')}</p>}
          <p>{t('Windows count token reports when Monitor receives them, not when tokens are generated.')}</p>
          <p>{t('These statistics stay in memory for a rolling hour and clear when Monitor restarts. No history is saved.')}</p>
          <p>{t('Independent of account and date filters. Reports cannot be attributed to the current login. New tasks may take up to one minute to appear.')}</p>
          <p>{t('Last report')}: {snapshot?.lastEventAt ? <time dateTime={snapshot.lastEventAt} title={dateTime(snapshot.lastEventAt)}>{time(snapshot.lastEventAt)}</time> : '--'}</p>
        </div>
      </details>
    </div>
  </section>;
}
