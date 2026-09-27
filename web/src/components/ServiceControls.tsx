import { useCallback, useEffect, useRef, useState } from 'react';
import type { RepositoryVersionStatus } from '../../../shared/service-version';
import { useI18n } from '../LanguageContext';

type ServiceAction = 'update' | 'restart' | 'stop';
type UpdateStatus = 'idle' | 'checking' | 'downloading' | 'building' | 'ready' | 'applying' | 'restarting' | 'completed' | 'up-to-date' | 'failed';
interface ServiceUpdate {
  supported: boolean;
  repository: string;
  status: UpdateStatus;
  version?: string;
  targetVersion?: string;
  error?: string;
  operationId?: string;
  localChanges?: boolean;
}
interface ServiceSnapshot { enabled: boolean; instance?: string; update?: ServiceUpdate }
interface WatchedUpdate { operationId: string; instance: string; refreshed?: boolean }
const UPDATE_STORAGE_KEY = 'codex-monitor-service-update';
const VERSION_REFRESH_INTERVAL = 30 * 60 * 1000;
const activeUpdateStatuses = new Set<UpdateStatus>(['checking', 'downloading', 'building', 'ready', 'applying', 'restarting']);
const updateMessages: Record<UpdateStatus, string> = {
  idle: '',
  checking: 'Checking the latest repository version…',
  downloading: 'Downloading the update. Monitor remains available…',
  building: 'Building the update. Monitor remains available…',
  ready: 'Update prepared. Preparing to restart…',
  applying: 'Installing the update…',
  restarting: 'Update installed. Waiting for Monitor to restart…',
  completed: 'Monitor updated successfully.',
  'up-to-date': 'Monitor is already up to date.',
  failed: 'Update failed.',
};

function readWatchedUpdate(): WatchedUpdate | null {
  try {
    const value = JSON.parse(window.sessionStorage.getItem(UPDATE_STORAGE_KEY) || 'null');
    return typeof value?.operationId === 'string' && typeof value?.instance === 'string' ? value : null;
  } catch { return null; }
}

export function ServiceControls() {
  const { t, dateTime } = useI18n();
  const [enabled, setEnabled] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [update, setUpdate] = useState<ServiceUpdate | undefined>(() => {
    const watched = readWatchedUpdate();
    // Keep polling if the user refreshed during the brief installation outage.
    return watched && !watched.refreshed ? {
      supported: false, repository: 'tabztggg/codex-monitor', status: 'restarting', operationId: watched.operationId,
    } : undefined;
  });
  const [connectionLost, setConnectionLost] = useState(false);
  const [pending, setPending] = useState<ServiceAction | null>(null);
  const [dismissedStatus, setDismissedStatus] = useState('');
  const [versions, setVersions] = useState<RepositoryVersionStatus | null>(null);
  const [checkingVersions, setCheckingVersions] = useState(true);
  const [versionCheckFailed, setVersionCheckFailed] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const instance = useRef('');
  const watchedUpdate = useRef<WatchedUpdate | null>(readWatchedUpdate());
  const mounted = useRef(false);
  const readingStatus = useRef<AbortController | null>(null);
  const readingVersions = useRef<AbortController | null>(null);
  const updating = Boolean(update && activeUpdateStatuses.has(update.status));

  const rememberUpdate = useCallback((value: WatchedUpdate) => {
    watchedUpdate.current = value;
    try { window.sessionStorage.setItem(UPDATE_STORAGE_KEY, JSON.stringify(value)); } catch { /* The current page can still track the update. */ }
  }, []);

  const receiveSnapshot = useCallback((value: ServiceSnapshot) => {
    if (!mounted.current) return;
    setEnabled(Boolean(value.enabled));
    setConnectionLost(false);
    const next = value.update;
    if (next) {
      setUpdate(next);
      if (next.operationId && activeUpdateStatuses.has(next.status)) {
        if (watchedUpdate.current?.operationId !== next.operationId) {
          rememberUpdate({ operationId: next.operationId, instance: value.instance || instance.current });
        }
        setStatus('');
        setError('');
      }
      // Completion must be reported by the updater. A disconnected request or a new
      // server instance alone is not proof that an update succeeded.
      const watched = watchedUpdate.current;
      if (next.status === 'completed' && next.operationId && watched?.operationId === next.operationId && !watched.refreshed) {
        rememberUpdate({ ...watched, refreshed: true });
        window.location.reload();
      }
      if ((next.status === 'failed' || next.status === 'up-to-date') && watched && !watched.refreshed) {
        rememberUpdate({ ...watched, refreshed: true });
      }
    }
    if (value.instance) instance.current = value.instance;
  }, [rememberUpdate]);

  const readStatus = useCallback(async () => {
    if ((readingStatus.current && !readingStatus.current.signal.aborted) || !mounted.current) return;
    const controller = new AbortController();
    readingStatus.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch('/api/service', { signal: controller.signal, cache: 'no-store' });
      if (!response.ok) throw new Error();
      const snapshot = await response.json();
      if (readingStatus.current === controller) receiveSnapshot(snapshot);
    } catch {
      if (mounted.current && readingStatus.current === controller) setConnectionLost(true);
    } finally {
      window.clearTimeout(timeout);
      if (readingStatus.current === controller) readingStatus.current = null;
    }
  }, [receiveSnapshot]);

  const readVersions = useCallback(async (manual = false) => {
    if ((readingVersions.current && !readingVersions.current.signal.aborted) || !mounted.current) return;
    const controller = new AbortController();
    readingVersions.current = controller;
    setCheckingVersions(true);
    // Allow three sequential repository requests of up to 10 seconds, plus transport overhead.
    const timeout = window.setTimeout(() => controller.abort(), 35_000);
    try {
      const response = await fetch(`/api/service/versions${manual ? '?refresh=1' : ''}`, { signal: controller.signal, cache: 'no-store' });
      if (!response.ok) throw new Error();
      const next: RepositoryVersionStatus = await response.json();
      if (mounted.current && readingVersions.current === controller) {
        setVersions(next);
        setVersionCheckFailed(false);
      }
    } catch {
      // Keep previous version information, but never present it as a fresh check.
      if (mounted.current && readingVersions.current === controller) setVersionCheckFailed(true);
    } finally {
      window.clearTimeout(timeout);
      if (readingVersions.current === controller) {
        readingVersions.current = null;
        if (mounted.current) setCheckingVersions(false);
      }
    }
  }, []);

  useEffect(() => {
    if (pending) dialog.current?.showModal();
    else dialog.current?.close();
  }, [pending]);
  useEffect(() => {
    mounted.current = true;
    void readStatus();
    void readVersions();
    const onFocus = () => { void readStatus(); void readVersions(); };
    window.addEventListener('focus', onFocus);
    const versionTimer = window.setInterval(() => { void readVersions(); }, VERSION_REFRESH_INTERVAL);
    return () => {
      mounted.current = false;
      window.removeEventListener('focus', onFocus);
      window.clearInterval(versionTimer);
      readingStatus.current?.abort();
      readingVersions.current?.abort();
    };
  }, [readStatus, readVersions]);
  useEffect(() => {
    if (!updating) return;
    // This endpoint only reads local updater state; polling never checks GitHub.
    const timer = window.setInterval(() => { void readStatus(); }, 2000);
    return () => window.clearInterval(timer);
  }, [updating, readStatus]);

  async function control(action: ServiceAction) {
    setPending(null);
    setBusy(true);
    setStatus(action === 'update' ? 'Requesting repository update…' : '');
    setError('');
    try {
      const response = await fetch('/api/service', { method: 'POST', headers: {
        'Content-Type': 'application/json'
      }, body: JSON.stringify({ action }), signal: AbortSignal.timeout(10_000) });
      const result = await response.json().catch(() => null);
      if (!mounted.current) return;
      if (!response.ok) {
        setStatus(response.status === 409 ? 'Another service action is in progress.' : 'Service action failed.');
        setError(typeof result?.error === 'string' ? result.error : '');
        setBusy(false);
        await readStatus();
        return;
      }
      if (action === 'update') {
        if (result?.update) receiveSnapshot({ enabled: true, instance: instance.current, update: result.update });
        setStatus('');
        setBusy(false);
        await readStatus();
        return;
      }
      setStatus(action === 'stop' ? 'Monitor stopped. Use the desktop shortcut to start it again.' : 'Restarting Monitor…');
      if (action === 'restart') {
        const previousInstance = instance.current;
        // A new process has a new instance identifier. Do not mistake the old server for a completed restart.
        for (let attempt = 0; attempt < 30 && mounted.current; attempt++) {
          await new Promise(resolve => setTimeout(resolve, 1000));
          if (!mounted.current) return;
          try {
            const response = await fetch('/api/service', { signal: AbortSignal.timeout(1500), cache: 'no-store' });
            if (!response.ok) continue;
            const next = await response.json();
            if (mounted.current && next.instance && next.instance !== previousInstance) { window.location.reload(); return; }
          } catch { }
        }
        if (mounted.current) { setStatus('Restart not confirmed. Try the desktop shortcut.'); setBusy(false); }
      }
    } catch {
      // Never replay an unconfirmed POST. Read the local state to reconcile it.
      if (mounted.current) {
        setStatus('Service action not confirmed. Refresh to check its state.');
        setBusy(false);
        await readStatus();
      }
    }
  }

  const updateMessage = update?.status === 'up-to-date' && update.localChanges
    ? 'Latest repository commit is already installed. Local unpublished changes were kept.'
    : update ? updateMessages[update.status] : '';
  const message = status || (updating && connectionLost ? 'Connection interrupted. Waiting for update status…' : updateMessage);
  const errorDetail = error || (update?.status === 'failed' ? update.error : '');
  const statusKey = `${update?.operationId || ''}:${message}:${errorDetail || ''}`;
  const actionsDisabled = !enabled || busy || updating;
  const initialVersionCheck = checkingVersions && !versions;
  const versionFetchUnavailable = versionCheckFailed || Boolean(versions?.stale);
  const versionsUnavailable = versionFetchUnavailable || versions?.status === 'unavailable';
  const updateAvailable = !versionsUnavailable && versions?.status === 'available' && versions.updateAvailable === true;
  const versionsCurrent = !versionsUnavailable && versions?.status === 'current' && versions.updateAvailable === false;
  const currentVersion = update?.version || versions?.currentVersion || t(initialVersionCheck ? 'Checking…' : 'Unknown');
  const repositoryVersion = versions?.repositoryVersion || t(initialVersionCheck ? 'Checking…' : 'Unknown');
  const currentVersionTitle = [
    `${t('Current version')}: ${currentVersion}`,
    versions?.currentCommit,
    versions?.localChanges ? t('Includes local unpublished changes.') : '',
  ].filter(Boolean).join('\n');
  const versionCheckDetail = initialVersionCheck ? t('Checking the repository version…')
    : versionFetchUnavailable ? t(versions?.repositoryVersion ? 'Repository check unavailable. Showing the last known version.' : 'Repository check unavailable. Update status is unknown.')
    : versionsCurrent ? t('Includes the latest repository changes.')
    : updateAvailable ? t('A newer repository commit is available.')
    : t('Update status is unknown.');
  const repositoryVersionTitle = [
    `${t('Repository version')}: ${repositoryVersion}`,
    versions?.repositoryCommit,
    versionCheckDetail,
    versions?.checkedAt ? t('Last confirmed at {time}', { time: dateTime(versions.checkedAt) }) : '',
  ].filter(Boolean).join('\n');
  const versionButtonLabel = updating ? t('Updating…') : checkingVersions ? t('Checking…')
    : updateAvailable ? (versions?.repositoryVersion === versions?.currentVersion ? t('Update available · Update')
      : t('Update to v{version}', { version: repositoryVersion }))
    : versionFetchUnavailable ? t('Check failed · Retry') : versionsCurrent ? t('Up to date') : t('Check for updates');
  const versionButtonDisabled = busy || updating || checkingVersions || (updateAvailable && (!enabled || !update?.supported));
  const versionButtonTitle = updateAvailable
    ? t(!update?.supported ? 'Repository updates require a managed Windows installation.' : 'Update from tabztggg/codex-monitor · main')
    : `${versionCheckDetail}\n${t('Click to check again. Checks are limited to once every 5 minutes.')}`;
  return <div className="service-controls" role="group" aria-label={t('Service')}>
    <div className="service-version-summary" role="status" aria-live="polite" aria-atomic="true">
      <dl className="service-version-values">
        <div title={currentVersionTitle}><dt>{t('Current version')}</dt><dd>{currentVersion}{versions?.currentCommit && <code className="service-version-commit">{versions.currentCommit.slice(0, 7)}</code>}{versions?.localChanges && <span aria-label={t('Includes local unpublished changes.')}>*</span>}</dd></div>
        <div title={repositoryVersionTitle}><dt>{t('Repository version')}</dt><dd>{repositoryVersion}{versions?.repositoryCommit && <code className="service-version-commit">{versions.repositoryCommit.slice(0, 7)}</code>}</dd></div>
      </dl>
    </div>
    <button className={`language-switch service-control-button service-version-button${updateAvailable ? ' service-control-update-available' : versionsCurrent ? ' service-version-current' : versionFetchUnavailable ? ' service-version-retry' : ''}`}
      disabled={versionButtonDisabled} aria-busy={checkingVersions || updating} title={versionButtonTitle}
      onClick={() => { if (updateAvailable) setPending('update'); else void readVersions(true); }}>
      {!checkingVersions && !updating && (updateAvailable ? <span className="service-update-dot" aria-hidden="true" />
        : versionsCurrent && <span aria-hidden="true">✓</span>)}{versionButtonLabel}
    </button>
    <button className="language-switch service-control-button" disabled={actionsDisabled} title={!enabled ? t('Available with a managed launcher.') : undefined} onClick={() => setPending('restart')}>{t('Restart service')}</button>
    <button className="language-switch service-control-button" disabled={actionsDisabled} title={!enabled ? t('Available with a managed launcher.') : undefined} onClick={() => setPending('stop')}>{t('Stop service')}</button>
    <dialog ref={dialog} className="service-dialog" aria-labelledby="service-dialog-title" onCancel={() => setPending(null)}>
      <h2 id="service-dialog-title">{t(pending === 'update' ? 'Update Monitor from the repository?' : pending === 'stop' ? 'Stop Monitor? Use the desktop shortcut to start it again.' : 'Restart Monitor service?')}</h2>
      {pending === 'update' && <>
        <p>{t('Install the latest main commit from tabztggg/codex-monitor. Your configuration and usage cache are preserved.')}</p>
        <p>{t('Monitor stays available during download and build, then stops briefly to install and restart. The page reconnects automatically. If installation fails, the previous version is restored.')}</p>
      </>}
      {pending === 'restart' && <p>{t('The page reconnects when the service is ready.')}</p>}
      <div className="service-dialog-actions"><button autoFocus className="small-control" onClick={() => setPending(null)}>{t('Cancel')}</button><button className="action-button" disabled={busy || updating} onClick={() => { if (pending) void control(pending); }}>{t(pending === 'update' ? 'Confirm update' : pending === 'stop' ? 'Confirm stop' : 'Confirm restart')}</button></div>
    </dialog>
    {message && statusKey !== dismissedStatus && <small className={`service-control-status${errorDetail ? ' service-control-status-error' : ''}`} role="status">
      {!updating && !busy && <button className="service-status-dismiss" aria-label={t('Dismiss')} onClick={() => setDismissedStatus(statusKey)}>×</button>}
      {t(message)}
      {update?.targetVersion && !status && <span className="service-update-version">{t('Version')}: {update.targetVersion}</span>}
      {errorDetail && <span className="service-update-error">{t(errorDetail)}</span>}
    </small>}
  </div>;
}
