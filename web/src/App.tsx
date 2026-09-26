import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { BrowserRouter, Link, Route, Routes, useParams } from "react-router-dom";
import type {
  CodexUsageSnapshot,
  AccountUsageEntry,
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
  const nowMs = useNow(1000);
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
          <a href="/#usage-overview" className="brand-link">
            <svg className="brand-mark" viewBox="0 0 32 32" aria-hidden="true" focusable="false">
              <path d="M14 2 3 8v8l11-6V2Zm4 0v8l11 6V8L18 2ZM3 20v4l11 6V16L3 20Zm15-4v14l11-6v-4l-11-4Z" fill="currentColor" />
            </svg>
            <h1>Codex Monitor</h1>
          </a>
          <nav className="dashboard-nav" aria-label={t('Dashboard navigation')}>
            <a className="dashboard-nav-link" href="/#usage-overview">{t('Usage overview')}</a>
            <a className="dashboard-nav-link" href="/#task-details">{t('Task details')}</a>
            <a className="dashboard-nav-link" href="/#task-trends">{t('Trends & methodology')}</a>
          </nav>
          <div className="topbar-actions"><ServiceControls /><LanguageSwitch /></div>
        </header>

        {error ? <div className="banner banner-error">{t('Unable to load data.')} {errorText(error)}</div> : null}
        {safeSnapshot.server.lastError ? (
          <div className="banner banner-muted">{t('Unable to load data.')} {errorText(safeSnapshot.server.lastError)}</div>
        ) : null}

        <Routes>
          <Route
            path="/"
            element={<DashboardPage snapshot={safeSnapshot} nowMs={nowMs} connectionLabel={connectionLabel} />}
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

export function DashboardPage({
  snapshot,
  connectionLabel,
  nowMs
}: {
  snapshot: MonitorSnapshot;
  nowMs: number;
  connectionLabel: string;
}) {
  const { t } = useI18n();
  return (
    <main className="dashboard-page">
      <HistoryPanel
        snapshot={snapshot}
        nowMs={nowMs}
        connectionLabel={connectionLabel}
        overviewSlot={<CodexUsageCard usage={snapshot.codexUsage} accounts={snapshot.accountUsages ?? []} nowMs={nowMs} />}
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

function CodexUsageCard({
  usage: liveUsage,
  accounts,
  nowMs
}: {
  usage: CodexUsageSnapshot;
  accounts: AccountUsageEntry[];
  nowMs: number;
}) {
  const { t, locale, windowLabel, dateTime, error: errorText } = useI18n();
  const [selected, setSelected] = useState('');
  const otherAccounts = accounts.filter(account => !account.current);
  const selectedAccount = otherAccounts.find(account => account.id === selected);
  const historical = Boolean(selectedAccount);
  const usage = selectedAccount?.usage ?? liveUsage;
  const options = ['', ...otherAccounts.map(account => account.id)];
  const activeSelection = selectedAccount ? selected : '';
  function stepAccount(direction: number) {
    const index = options.indexOf(activeSelection);
    setSelected(options[(index + direction + options.length) % options.length]);
  }
  const window = overallUsageWindow(usage);
  const pace = window ? quotaPace(window, historical ? Date.parse(usage.updatedAt!) : nowMs) : null;
  const unavailable = usage.status !== "available" || !window;
  const expired = pace?.expired;
  const used = unavailable || expired ? null : window.usedPercent;
  const remaining = unavailable || expired ? null : window.remainingPercent;
  const difference = unavailable ? null : pace?.difference ?? null;
  const elapsed = unavailable ? null : pace?.elapsed ?? null;
  const heading = difference === null ? "Pace unavailable" : difference > 5 ? "Usage is ahead of elapsed time" : difference < -5 ? "Usage is below the proportional pace" : "Usage is in line with elapsed time";
  const resetAt = window?.resetsAt && Number.isFinite(Date.parse(window.resetsAt)) ? window.resetsAt : null;
  const resetDate = resetAt ? new Intl.DateTimeFormat(locale, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    hour12: false, timeZoneName: 'shortOffset'
  }).format(new Date(resetAt)).replace('GMT', 'UTC') : null;
  return (
    <section className="surface global-quota" aria-label={t('Overall Codex usage')}>
      <div className="global-quota-grid">
        <div className="quota-account-column">
          <div className="global-quota-heading">
            <h2>{t(historical ? 'Recorded account quota' : 'Current account quota')}</h2>
            {window && <span className="quota-window-badge">{windowLabel(window.label)}</span>}
          </div>
          <div className="quota-account-switcher">
            <button className="small-control" aria-label={t('Previous account')} disabled={options.length < 2} onClick={() => stepAccount(-1)}>‹</button>
            <select className="small-control" aria-label={t('View account usage')} value={activeSelection} onChange={event => setSelected(event.target.value)}>
              <option value="">{t('Current login')} · {liveUsage.account?.email ?? t('Unknown account')}</option>
              {otherAccounts.map(account => <option key={account.id} value={account.id}>{account.usage.account?.email} · {t('Last recorded')}</option>)}
            </select>
            <button className="small-control" aria-label={t('Next account')} disabled={options.length < 2} onClick={() => stepAccount(1)}>›</button>
          </div>
          <div className="quota-account" aria-label={t('Usage account')}>
            <strong>{usage.account?.email ?? t(usage.account?.type === 'apiKey' ? 'API key account' : 'Unknown account')}</strong>
            {usage.account?.planType && <span>{usage.account.planType}</span>}
            {(usage.stale || historical) && <span className="quota-account-stale">{t('Last confirmed account')}</span>}
            <details className="account-source">
              <summary>{t('CLI account · Details')}</summary>
              <small>{t('Source: Monitor’s Codex CLI login. This may differ from the account in the Codex desktop app.')}</small>
              {usage.updatedAt && <small>{t('Updated at {time}', { time: dateTime(usage.updatedAt) })}</small>}
            </details>
          </div>
        </div>
        {unavailable ? (
          <p className="usage-message quota-unavailable" role="status">{usage.status === "loading" ? t("Loading overall Codex usage…") : usage.error ? `${t('Overall Codex quota is unavailable.')} ${errorText(usage.error)}` : t("Overall Codex quota is unavailable.")}</p>
        ) : <>
          <div className="quota-balance">
            <div className="quota-number">{formatPercent(remaining)} <span>{t('remaining')}</span></div>
            <div className="usage-meter quota-remaining-meter" role="img" aria-label={t('{percent} quota remaining', { percent: formatPercent(remaining) })}>
              <span style={{ width: `${clampMeterPercent(remaining)}%` }} />
            </div>
            <div className="quota-stat-line">
              <span>{t('Quota used')} <b>{formatPercent(used)}</b></span>
              <span>{t('Time elapsed')} <b>{formatPercent(elapsed)}</b></span>
            </div>
            <details className="quota-pace">
              <summary className={`pace-note ${difference !== null && difference > 5 ? "fast" : ""}`}>{expired ? t('Waiting for the renewed quota') : t(heading)}</summary>
              <p className="quota-pace-description">
                {expired ? t("Codex has not reported the new period yet.") : difference === null ? t("The period or usage data is incomplete.") : Math.abs(difference) <= 5 ? t("Consumption follows the proportional pace of the period.") : t(difference > 0 ? '{count} percentage points above the proportional pace.' : '{count} percentage points below the proportional pace.', { count: Math.round(Math.abs(difference)) })}
              </p>
            </details>
          </div>
          <div className="quota-reset-block">
            <span className="quota-reset-label">{t(historical ? 'Recorded reset time' : 'Next reset')}</span>
            <strong className="quota-reset">{historical ? t('Last recorded') : expired ? t("Waiting for the renewed quota") : formatResetLabel(resetAt, nowMs, t)}</strong>
            {resetAt && <time className="quota-reset-at" dateTime={resetAt}>{resetDate}</time>}
          </div>
        </>}
      </div>
      {historical && usage.updatedAt && <p className="muted-note" role="status">{t('Recorded at {time}. This account is not being refreshed; switching this view does not change your login.', { time: dateTime(usage.updatedAt) })}</p>}
      {!historical && usage.stale && usage.updatedAt && <p className="muted-note" role="status">{t('Showing the last confirmed account snapshot from {time}. Retrying automatically.', { time: dateTime(usage.updatedAt) })}</p>}
      <p className="muted-note">{t('Accounts appear after Monitor reads their usage while logged in. This selector changes only the quota card, not task statistics.')}</p>
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

  useEffect(() => {
    const handle = window.setInterval(() => {
      setNowMs(Date.now());
    }, intervalMs);

    return () => {
      window.clearInterval(handle);
    };
  }, [intervalMs]);

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
