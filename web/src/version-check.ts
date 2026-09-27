import type { RepositoryVersionStatus, VersionCheckError } from '../../shared/service-version';

export const VERSION_REFRESH_INTERVAL = 30 * 60_000;
export const VERSION_FAILURE_INTERVAL = 5 * 60_000;

export function versionCheckState(value: RepositoryVersionStatus | null, failed: boolean, now: number) {
  const unavailable = failed || Boolean(value?.stale);
  const nextManual = Date.parse(value?.nextManualCheckAt ?? '');
  return {
    unavailable,
    current: !unavailable && value?.status === 'current' && value.updateAvailable === false,
    available: !unavailable && value?.status === 'available' && value.updateAvailable === true,
    lastCurrent: unavailable && !!value?.checkedAt && value.updateAvailable === false,
    coolingDown: Number.isFinite(nextManual) && nextManual > now,
  };
}

export const versionErrorMessages: Record<VersionCheckError['kind'], string> = {
  timeout: 'The repository request timed out after 10 seconds.',
  dns: 'The repository hostname could not be resolved.',
  tls: 'The repository TLS connection or certificate check failed.',
  connection: 'The repository connection was refused or interrupted.',
  http: 'The repository returned an HTTP error.',
  'rate-limit': 'GitHub temporarily limited version-check requests.',
  'invalid-response': 'The repository returned invalid version data.',
  unknown: 'The check did not complete; no specific cause was recorded.',
};

/** One wake-up per due check. Hidden tabs stay idle; returning runs an overdue check. */
export function scheduleVersionCheck(dueAt: number, check: () => void, visibility: Pick<Document, 'hidden' | 'addEventListener' | 'removeEventListener'> = document) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let done = false;
  const schedule = () => {
    clearTimeout(timer);
    if (done || visibility.hidden) return;
    const delay = Math.max(0, dueAt - Date.now());
    timer = setTimeout(() => {
      if (!visibility.hidden && !done) { done = true; check(); }
    }, delay + 25);
  };
  visibility.addEventListener('visibilitychange', schedule);
  schedule();
  return () => { done = true; clearTimeout(timer); visibility.removeEventListener('visibilitychange', schedule); };
}
