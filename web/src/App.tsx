import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { BrowserRouter, Link, NavLink, Route, Routes, useLocation, useParams } from "react-router-dom";
import type {
  CodexUsageSnapshot,
  MonitorSnapshot,
  ThreadNode
} from "../../shared/monitor";
import { api } from "./api";
import { ServiceControls } from './components/ServiceControls';
import { HistoryPanel } from "./components/HistoryPanel";
import { ThreadTree } from "./components/ThreadTree";
import { TranscriptPanel } from "./components/TranscriptPanel";
import { TurnInspector } from "./components/TurnInspector";
import { overallUsageWindow, quotaPace } from "./presentation";
import { useMonitorState } from "./useMonitorState";
import { LanguageSwitch, useI18n } from './LanguageContext';
import type { Translate } from './localization';
import { DASHBOARD_CLOCK_INTERVAL_MS } from '../../shared/polling';
import { startVisiblePolling } from './visible-polling';

const EMPTY_SNAPSHOT: MonitorSnapshot = {
  generatedAt: "",
  runs: [],
  activeSessions: [],
  threads: {},
  turns: {},
  items: {},
  pendingRequests: {},
  server: {
    connected: false,
    initialized: false,
    lastError: null,
    stderrTail: []
  },
  activeShutdown: {
    scope: null,
    runId: null,
    scheduled: false,
    command: null,
    executeAt: null,
    dryRun: true
  },
  globalAutomation: {
    policy: {
      enabled: false,
      action: "shutdown",
      settleDelayMs: 30000,
      shutdownDelaySeconds: 60,
      cancelOnNewActivity: true
    },
    state: {
      status: "disabled",
      armedAt: null,
      settlesAt: null,
      shutdownAt: null,
      lastAction: null
    }
  },
  codexUsage: {
    status: "loading",
    updatedAt: null,
    error: null,
    primaryLimit: null,
    limits: []
  }
};

export default function App() {
  const { t, error: errorText } = useI18n();
  const { snapshot, error, connectionLabel } = useMonitorState();
  const safeSnapshot = snapshot ?? EMPTY_SNAPSHOT;
  const needsCountdown = safeSnapshot.globalAutomation.policy.enabled || safeSnapshot.activeShutdown.scheduled ||
    safeSnapshot.runs.some(run => run.automationPolicy.enabled);
  const nowMs = useNow(needsCountdown ? 1000 : DASHBOARD_CLOCK_INTERVAL_MS);
  const topbarRef = useRef<HTMLElement>(null);

  useLayoutEffect(() => {
    const topbar = topbarRef.current;
    if (!topbar) return;
    const root = document.documentElement;
    const property = '--monitor-topbar-height';
    const previousHeight = root.style.getPropertyValue(property);
    // Native anchor and keyboard scrolling share the actual wrapped header height.
    const updateHeight = () => root.style.setProperty(property, `${Math.ceil(topbar.getBoundingClientRect().height)}px`);
    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    observer.observe(topbar);
    return () => {
      observer.disconnect();
      if (previousHeight) root.style.setProperty(property, previousHeight);
      else root.style.removeProperty(property);
    };
  }, []);

  return (
    <BrowserRouter>
      <div className="app-shell">
        <header className="topbar" ref={topbarRef}>
          <Link to="/" className="brand-link">
            <svg className="brand-mark" viewBox="0 0 32 32" aria-hidden="true" focusable="false">
              <path d="M14 2 3 8v8l11-6V2Zm4 0v8l11 6V8L18 2ZM3 20v4l11 6V16L3 20Zm15-4v14l11-6v-4l-11-4Z" fill="currentColor" />
            </svg>
            <h1>Codex Monitor</h1>
          </Link>
          <nav className="dashboard-nav" aria-label={t('Dashboard navigation')}>
            <NavLink className="dashboard-nav-link" to="/" end>{t('Usage overview')}</NavLink>
            <NavLink className="dashboard-nav-link" to="/tasks">{t('Task details')}</NavLink>
            <NavLink className="dashboard-nav-link" to="/trends">{t('Trends & methodology')}</NavLink>
          </nav>
          <div className="topbar-actions"><ServiceControls /><LanguageSwitch /></div>
        </header>

        {error ? <div className="banner banner-error">{t('Unable to load data.')} {errorText(error)}</div> : null}
        {safeSnapshot.server.lastError ? (
          <div className="banner banner-muted">{t('Unable to load data.')} {errorText(safeSnapshot.server.lastError)}</div>
        ) : null}

        <Routes>
          <Route
            path="/*"
            element={<RoutedDashboard snapshot={safeSnapshot} nowMs={nowMs} connectionLabel={connectionLabel} />}
          />
          <Route
            path="/runs/:runId"
            element={<RunDetailPage snapshot={safeSnapshot} />}
          />
        </Routes>
      </div>
    </BrowserRouter>
  );
}

function RoutedDashboard(props: { snapshot: MonitorSnapshot; nowMs: number; connectionLabel: string }) {
  const location = useLocation();
  const page = location.pathname === '/tasks' ? 'tasks' : location.pathname === '/trends' ? 'trends' : 'overview';
  useEffect(() => {
    if (!location.hash && !new URLSearchParams(location.search).has('task')) window.scrollTo(0, 0);
  }, [page, location.hash, location.search]);
  return <DashboardPage {...props} page={page} />;
}

export function DashboardPage({
  snapshot,
  connectionLabel,
  page = 'all',
  nowMs
}: {
  snapshot: MonitorSnapshot;
  nowMs: number;
  connectionLabel: string;
  page?: 'all' | 'overview' | 'tasks' | 'trends';
}) {
  const { t } = useI18n();
  const [selected, setSelected] = useState('');
  const selectedEntry = snapshot.accountUsages?.find(a => a.id === selected && !a.current);
  const selectedUsage = selectedEntry?.usage ?? snapshot.codexUsage;
  return (
    <main className={`dashboard-page page-${page}`}>
      <HistoryPanel
        page={page}
        accountSlot={<label className="inline-field account-page-picker">{t('Selected account')}<select value={selected} onChange={event => setSelected(event.target.value)}><option value="">{snapshot.codexUsage.account?.email ?? t('Current login')}</option>{snapshot.accountUsages?.filter(a => !a.current).map(a => <option key={a.id} value={a.id}>{a.usage.account?.email ?? a.id}</option>)}</select></label>}
        snapshot={{ ...snapshot, codexUsage: selectedUsage }}
        selectedAccountId={selectedEntry?.id}
        nowMs={nowMs}
        connectionLabel={connectionLabel}
        overviewSlot={<CodexUsageCard usage={snapshot.codexUsage} nowMs={nowMs} />}
      />
      <footer className="monitor-footer">
        <details className="secondary-controls">
          <summary>{t('Auto shutdown')} · {t(snapshot.globalAutomation.policy.enabled ? snapshot.activeShutdown.dryRun ? "Dry-run" : "On" : "Off")}{getShutdownCountdown(snapshot, nowMs) ? ` · ${shutdownStatusLabel(snapshot, nowMs, t)}` : ""}</summary>
          <AutomationCard snapshot={snapshot} nowMs={nowMs} />
        </details>
        <span>{t('API-equivalent cost, not a plan charge · Codex Spark excluded')}</span>
      </footer>
    </main>
  );
}

function AutomationCard({
  snapshot,
  nowMs
}: {
  snapshot: MonitorSnapshot;
  nowMs: number;
}) {
  const { t, error: errorText } = useI18n();
  const [actionError, setActionError] = useState<string | null>(null);
  const globalAutomation = snapshot.globalAutomation;
  const shutdownCountdown = getShutdownCountdown(snapshot, nowMs);
  const phaseCountdown = getPhaseCountdown(snapshot, nowMs, t);
  const automationEnabled = globalAutomation.policy.enabled;

  return (
    <section className="surface automation-card">
      <div className="automation-main">
        <div className="automation-heading">
          <div>
            <span className="panel-meta">{t('Power')}</span>
            <strong>{t('Idle shutdown')}</strong>
          </div>
          <StatusPill
            tone={
              automationEnabled && snapshot.activeShutdown.dryRun
                ? "alert"
                : automationEnabled
                  ? "warn"
                  : "neutral"
            }
            label={
              automationEnabled && snapshot.activeShutdown.dryRun
                ? "dry-run"
                : globalAutomation.state.status
            }
          />
        </div>
        <p>{automationDescription(snapshot, nowMs, t)}</p>
        {shutdownCountdown || phaseCountdown ? (
          <p className="automation-countdown">
            {phaseCountdown ? `${phaseCountdown}. ` : ""}
            {shutdownCountdown ? t('Shutdown in {duration}', { duration: shutdownCountdown }) : ""}
          </p>
        ) : null}
      </div>
      <div className="automation-actions">
        <button
          className={`action-button${automationEnabled ? " ghost" : ""}`}
          onClick={async () => {
            try {
              setActionError(null);
              if (automationEnabled) {
                await api.cancelGlobalNoActiveSessions();
              } else {
                await api.armGlobalNoActiveSessions({});
              }
            } catch (error) {
              setActionError(error instanceof Error ? error.message : String(error));
            }
          }}
        >
          {t(automationEnabled ? "Disable" : "Enable")}
        </button>
      </div>
      {actionError ? <span className="panel-meta error-text">{t('Action failed.')} {errorText(actionError)}</span> : null}
    </section>
  );
}

function CodexUsageCard(props: { usage: CodexUsageSnapshot; nowMs: number }) {
  const { t } = useI18n();
  return <section className="account-stack" aria-label={t('Overall Codex usage')}>
    <AccountUsageRow {...props} />
  </section>;
}

function AccountUsageRow({
  usage,
  nowMs
}: {
  usage: CodexUsageSnapshot;
  nowMs: number;
}) {
  const { t, locale, windowLabel, dateTime, error: errorText } = useI18n();
  const window = overallUsageWindow(usage);
  const pace = window ? quotaPace(window, nowMs) : null;
  const unavailable = usage.status !== "available" || !window;
  const expired = pace?.expired;
  const used = unavailable || expired ? null : window.usedPercent;
  const remaining = unavailable || expired ? null : window.remainingPercent;
  const difference = unavailable ? null : pace?.difference ?? null;
  const elapsed = unavailable ? null : pace?.elapsed ?? null;
  const remainingTime = elapsed === null ? null : 100 - elapsed;
  const heading = difference === null ? "Pace unavailable" : difference > 5 ? "Usage is ahead of elapsed time" : difference < -5 ? "Usage is below the proportional pace" : "Usage is in line with elapsed time";
  const resetAt = window?.resetsAt && Number.isFinite(Date.parse(window.resetsAt)) ? window.resetsAt : null;
  const periodFormatter = new Intl.DateTimeFormat(locale, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    hour12: false, timeZoneName: 'shortOffset'
  });
  const periodDuration = window?.windowDurationMins;
  const periodStartMs = resetAt && typeof periodDuration === 'number' && Number.isFinite(periodDuration) && periodDuration > 0
    ? Date.parse(resetAt) - periodDuration * 60_000 : NaN;
  const periodStartAt = Number.isFinite(periodStartMs) && Math.abs(periodStartMs) <= 8.64e15 ? new Date(periodStartMs).toISOString() : null;
  const formatPeriodDate = (value: string) => periodFormatter.format(new Date(value)).replace('GMT', 'UTC');
  return (
    <section className="surface global-quota account-usage-row selected" aria-label={usage.account?.email ?? t('Unknown account')}>
      <div className="global-quota-grid">
        <div className="quota-account-column">
          <div className="global-quota-heading">
            <h3>{usage.account?.email ?? t('Unknown account')}</h3>

          </div>

          <div className="quota-account" aria-label={t('Usage account')}>

            <span className={`account-kind ${usage.stale ? 'recorded' : 'live'}`}>{t(usage.stale ? 'Last recorded' : 'Current login')}</span>
            {usage.account?.planType && <span>{usage.account.planType}</span>}
            {window && <span className="quota-window-badge">{windowLabel(window.label)}</span>}


          </div>
          {usage.updatedAt && <small className="account-updated-at">{t(usage.stale ? 'Last confirmed at {time}' : 'Updated at {time}', { time: dateTime(usage.updatedAt) })}</small>}
        </div>
        {unavailable ? (
          <p className="usage-message quota-unavailable" role="status">{usage.status === "loading" ? t("Loading overall Codex usage…") : usage.error ? `${t('Overall Codex quota is unavailable.')} ${errorText(usage.error)}` : t("Overall Codex quota is unavailable.")}</p>
        ) : <>
          <div className="quota-balance">
            <div className="quota-number">{formatPercent(used)} <span>{t('Quota used')}</span></div>
            <div className="quota-meter-pair">
              <div className="quota-meter-row">
                <div className="quota-meter-label"><span>{t('Remaining quota')}</span><b>{formatPercent(remaining)}</b></div>
                <div className="usage-meter quota-remaining-meter" role="progressbar" aria-label={t('Remaining quota')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={remaining === null ? undefined : clampMeterPercent(remaining)} aria-valuetext={formatPercent(remaining)}>
                  <span style={{ width: `${clampMeterPercent(remaining)}%` }} />
                </div>
              </div>
              <div className="quota-meter-row quota-time-row">
                <div className="quota-meter-label"><span>{t('Time remaining in this period')}</span><b>{formatPercent(remainingTime)}</b></div>
                <div className="usage-meter quota-remaining-meter quota-time-meter" role="progressbar" aria-label={t('Time remaining in this period')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={remainingTime === null ? undefined : clampMeterPercent(remainingTime)} aria-valuetext={formatPercent(remainingTime)}>
                  <span style={{ width: `${clampMeterPercent(remainingTime)}%` }} />
                </div>
              </div>
            </div>
            <details className="quota-pace">
              <summary className={`pace-note ${difference !== null && difference > 5 ? "fast" : ""}`}>{expired ? t('Waiting for the renewed quota') : t(heading)}</summary>
              <p className="quota-pace-description">
                {expired ? t("Codex has not reported the new period yet.") : difference === null ? t("The period or usage data is incomplete.") : Math.abs(difference) <= 5 ? t("Consumption follows the proportional pace of the period.") : t(difference > 0 ? '{count} percentage points above the proportional pace.' : '{count} percentage points below the proportional pace.', { count: Math.round(Math.abs(difference)) })}
              </p>
            </details>
          </div>
          <div className="quota-reset-block">
            <span className="quota-reset-label">{t('Next reset')}</span>
            <strong className="quota-reset">{expired ? t("Waiting for the renewed quota") : formatResetLabel(resetAt, nowMs, t)}</strong>
            {resetAt && <div className="quota-period-range">
              {periodStartAt && <>
                <span className="quota-period-label">{t('Quota period')}</span>
                <time className="quota-reset-at" dateTime={periodStartAt}>{formatPeriodDate(periodStartAt)}</time>
                <span aria-hidden="true"> → </span>
              </>}
              <time className="quota-reset-at" dateTime={resetAt}>{formatPeriodDate(resetAt)}</time>
            </div>}
          </div>
        </>}
      </div>
      <details className="account-source account-details">
        <summary>{t('Account details')}</summary>
        <small>{t('Source: Monitor’s Codex CLI login. This may differ from the account in the Codex desktop app.')}</small>
        {usage.stale && usage.updatedAt ? <small>{t('Showing the last confirmed account snapshot from {time}. Retrying automatically.', { time: dateTime(usage.updatedAt) })}</small>
          : null}
      </details>
    </section>
  );
}

export function RunDetailPage({ snapshot }: { snapshot: MonitorSnapshot }) {
  const { t, label, time, error: errorText } = useI18n();
  const { runId } = useParams();
  const run = snapshot.runs.find((entry) => entry.id === runId) ?? null;
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (run) {
      setSelectedThreadId(run.rootThreadId);
    }
  }, [run?.id, run?.rootThreadId]);

  const threadMap = useMemo(() => {
    if (!run) {
      return {};
    }

    return Object.fromEntries(
      run.trackedThreadIds
        .map((threadId) => snapshot.threads[threadId])
        .filter((thread): thread is ThreadNode => Boolean(thread))
        .map((thread) => [thread.id, thread])
    );
  }, [run, snapshot.threads]);

  const selectedThread =
    (selectedThreadId ? threadMap[selectedThreadId] : null) ??
    (run ? threadMap[run.rootThreadId] : null);
  const selectedTurn =
    selectedThread?.latestTurnId
      ? snapshot.turns[selectedThread.latestTurnId] ?? null
      : null;
  const pendingRequests = Object.values(snapshot.pendingRequests).filter(
    (request) =>
      request.status === "pending" && request.threadId === selectedThread?.id
  );

  if (!run) {
    return (
      <main className="detail-page">
        <div className="panel">
          <p className="eyebrow">{t('Run detail')}</p>
          <h2>{t('Waiting for this run to appear.')}</h2>
          <p className="body-copy">
            {t('If you opened a stale URL, go back to the dashboard.')}
          </p>
          <Link to="/" className="text-link">
            {t('Back to dashboard')}
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="detail-page">
      <section className="panel detail-banner">
        <div className="detail-banner-header">
          <div>
            <Link to="/" className="text-link">
              {t('Back to dashboard')}
            </Link>
            <h2>{run.prompt}</h2>
            <p className="body-copy">{run.settings.cwd}</p>
          </div>
          <div className="status-strip">
            <StatusPill tone={toneFromRun(run.status)} label={run.status} />
            <StatusPill
              tone={run.waitingOnHuman ? "warn" : "neutral"}
              label={t(run.waitingOnHuman ? "waiting on you" : "autonomous")}
            />
            <StatusPill
              tone={run.automationState.status === "scheduled" ? "alert" : "neutral"}
              label={t('automation {status}', { status: label(run.automationState.status) })}
            />
          </div>
        </div>

        <div className="metrics-row">
          <Metric label={t('Tracked threads')} value={String(run.trackedThreadIds.length)} />
          <Metric label={t('Root thread')} value={run.rootThreadId} />
          <Metric
            label={t('Shutdown')}
            value={
              snapshot.activeShutdown.runId === run.id && snapshot.activeShutdown.executeAt
                ? time(snapshot.activeShutdown.executeAt)
                : t("not scheduled")
            }
          />
        </div>

        <div className="banner-actions">
          <button
            className="action-button"
            onClick={async () => {
              try {
                setActionError(null);
                await api.armAutomation(run.id, {});
              } catch (error) {
                setActionError(error instanceof Error ? error.message : String(error));
              }
            }}
          >
            {t('Arm shutdown rule')}
          </button>
          <button
            className="action-button ghost"
            onClick={async () => {
              try {
                setActionError(null);
                await api.cancelShutdown();
              } catch (error) {
                setActionError(error instanceof Error ? error.message : String(error));
              }
            }}
          >
            {t('Cancel shutdown')}
          </button>
          {actionError ? <span className="panel-meta error-text">{t('Action failed.')} {errorText(actionError)}</span> : null}
        </div>
      </section>

      <section className="detail-grid">
        <ThreadTree
          rootThreadId={run.rootThreadId}
          threads={threadMap}
          selectedThreadId={selectedThread?.id ?? null}
          onSelect={setSelectedThreadId}
        />
        <TranscriptPanel
          thread={selectedThread}
          turns={snapshot.turns}
          items={snapshot.items}
        />
        <TurnInspector
          thread={selectedThread}
          turn={selectedTurn}
          items={snapshot.items}
          pendingRequests={pendingRequests}
          activeShutdown={snapshot.activeShutdown}
        />
      </section>
    </main>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric-card">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function StatusPill({
  tone,
  label,
  title
}: {
  tone: "good" | "warn" | "alert" | "neutral";
  label: string;
  title?: string;
}) {
  const { label: localize } = useI18n();
  return (
    <span className={`status-pill ${tone}`} title={title} aria-label={title}>
      {localize(label)}
    </span>
  );
}

function toneFromRun(status: string): "good" | "warn" | "alert" | "neutral" {
  switch (status) {
    case "settled":
      return "good";
    case "error":
      return "alert";
    case "running":
      return "warn";
    default:
      return "neutral";
  }
}

function formatPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return "--%";
  }

  return `${Math.round(value)}%`;
}

function clampMeterPercent(value: number | null): number {
  if (value === null || !Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.min(100, value));
}

function formatResetLabel(isoValue: string | null, nowMs: number, t: Translate): string {
  if (!isoValue || !Number.isFinite(Date.parse(isoValue))) {
    return t("Reset time unavailable");
  }

  return t('Resets in {duration}', { duration: formatCompactDuration(Date.parse(isoValue) - nowMs, t) });
}

function formatCompactDuration(durationMs: number, t: Translate): string {
  const totalMinutes = Math.max(0, Math.ceil(durationMs / 60000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) {
    return t('{days}d {hours}h', { days, hours });
  }

  if (hours > 0) {
    return t('{hours}h {minutes}m', { hours, minutes });
  }

  return t('{minutes}m', { minutes });
}

function automationDescription(snapshot: MonitorSnapshot, nowMs: number, t: Translate): string {
  const automation = snapshot.globalAutomation;
  const activeCount = snapshot.activeSessions.length;
  const idleDelaySeconds = Math.round(automation.policy.settleDelayMs / 1000);
  const shutdownDelaySeconds = automation.policy.shutdownDelaySeconds;

  if (!automation.policy.enabled) {
    return t("Off. Enable it to shut down after Codex work finishes.");
  }

  if (snapshot.activeShutdown.dryRun) {
    return t("Dry-run mode is on. Countdown will not shut down this computer.");
  }

  if (snapshot.activeShutdown.executeAt || automation.state.shutdownAt) {
    return t('Windows shutdown is scheduled. New Codex activity will cancel it.');
  }

  if (automation.state.settlesAt) {
    return t('No active sessions. Scheduling Windows shutdown after {seconds}s idle.', { seconds: idleDelaySeconds });
  }

  if (activeCount > 0) {
    return t(activeCount === 1 ? 'Waiting for one active Codex session to finish.' : 'Waiting for {count} active Codex sessions to finish.', { count: activeCount });
  }

  const phaseCountdown = getPhaseCountdown(snapshot, nowMs, t);
  if (phaseCountdown) {
    return phaseCountdown;
  }

  return t('Armed. Shutdown starts after {idle}s idle, then Windows waits {delay}s.', { idle: idleDelaySeconds, delay: shutdownDelaySeconds });
}

function useNow(intervalMs: number): number {
  const [nowMs, setNowMs] = useState(Date.now());

  useEffect(() => startVisiblePolling({ intervalMs, task: async () => { setNowMs(Date.now()); } }), [intervalMs]);

  return nowMs;
}

function shutdownStatusLabel(snapshot: MonitorSnapshot, nowMs: number, t: Translate): string {
  const countdown = getShutdownCountdown(snapshot, nowMs);
  if (countdown) {
    return t('Shutdown in {duration}', { duration: countdown });
  }

  return isShutdownScheduled(snapshot)
    ? t('Shutdown {status}', { status: t(snapshot.activeShutdown.dryRun ? 'Dry-run' : 'Armed') })
    : t("No shutdown scheduled");
}

function isShutdownScheduled(snapshot: MonitorSnapshot): boolean {
  return Boolean(getScheduledShutdownAt(snapshot) ?? snapshot.activeShutdown.scheduled);
}

function getScheduledShutdownAt(snapshot: MonitorSnapshot): string | null {
  return (
    snapshot.activeShutdown.executeAt ??
    snapshot.globalAutomation.state.shutdownAt ??
    snapshot.runs.find((run) => run.automationState.shutdownAt)?.automationState
      .shutdownAt ??
    null
  );
}

function getShutdownCountdown(
  snapshot: MonitorSnapshot,
  nowMs: number
): string | null {
  const scheduledShutdownAt = getScheduledShutdownAt(snapshot);
  if (scheduledShutdownAt) {
    return formatCountdown(scheduledShutdownAt, nowMs);
  }

  const settlesAtMs = Date.parse(snapshot.globalAutomation.state.settlesAt ?? "");
  if (!Number.isFinite(settlesAtMs)) {
    return null;
  }

  const projectedShutdownAt =
    settlesAtMs + snapshot.globalAutomation.policy.shutdownDelaySeconds * 1000;
  return formatCountdown(projectedShutdownAt, nowMs);
}

function getPhaseCountdown(
  snapshot: MonitorSnapshot,
  nowMs: number,
  t: Translate
): string | null {
  if (getScheduledShutdownAt(snapshot)) {
    const countdown = getShutdownCountdown(snapshot, nowMs);
    return countdown ? t('Windows timer {duration}', { duration: countdown }) : null;
  }

  if (snapshot.globalAutomation.state.settlesAt) {
    return t('Schedules in {duration}', { duration: formatCountdown(snapshot.globalAutomation.state.settlesAt, nowMs) });
  }

  return null;
}

function formatCountdown(target: string | number, nowMs: number): string {
  const targetMs = typeof target === "number" ? target : Date.parse(target);
  if (!Number.isFinite(targetMs)) {
    return "00:00";
  }

  const totalSeconds = Math.max(0, Math.ceil((targetMs - nowMs) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
