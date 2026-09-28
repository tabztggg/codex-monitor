import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { RepositoryVersionStatus, VersionCheckError } from '../../shared/service-version';
import { latestPackage, newerVersion, PackageMetadataError } from './package-release';

const REPOSITORY = 'tabztggg/codex-monitor';
export const VERSION_CACHE_MS = 30 * 60_000;
export const VERSION_RETRY_MS = 5 * 60_000;
export const VERSION_MANUAL_CACHE_MS = 5 * 60_000;
const commitPattern = /^[0-9a-f]{40}$/;
const versionPattern = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/;
interface RemoteVersion { version: string; commit: string }
interface CachedVersion {
  repository: string; currentCommit: string | null; currentVersion: string; remote: RemoteVersion | null;
  updateAvailable: boolean | null; checkedAt: number | null; attemptedAt: number; failed: boolean;
  lastError?: VersionCheckError | null;
}

class CheckFailure extends Error {
  constructor(readonly detail: VersionCheckError) { super(detail.kind); }
}

function transportFailure(error: unknown, stage: VersionCheckError['stage']): VersionCheckError {
  const codes: string[] = [];
  const names: string[] = [];
  // Do not persist exception messages: they can include proxy credentials or paths.
  const pending: unknown[] = [error];
  for (let index = 0; index < pending.length && index < 16; index++) {
    const value = pending[index] as { name?: string; code?: string; cause?: unknown; errors?: unknown[] } | null;
    if (!value || typeof value !== 'object') continue;
    if (typeof value.name === 'string') names.push(value.name);
    if (typeof value.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(value.code)) codes.push(value.code);
    if (value.cause) pending.push(value.cause);
    if (Array.isArray(value.errors)) pending.push(...value.errors.slice(0, 8));
  }
  const code = codes.find(code => /TIMEOUT|ENOTFOUND|EAI_AGAIN|CERT|TLS|SSL/.test(code)) ?? codes[0];
  const kind = names.includes('TimeoutError') || names.includes('AbortError') || code?.includes('TIMEOUT') ? 'timeout'
    : code === 'ENOTFOUND' || code === 'EAI_AGAIN' ? 'dns'
    : code && /CERT|TLS|SSL/.test(code) ? 'tls'
    : code && /^(ECONN|ENET|EHOST|EACCES|EPERM|UND_ERR_SOCKET)/.test(code) ? 'connection' : 'unknown';
  return { kind, stage, ...(code ? { code } : {}) };
}

function validError(value: unknown): value is VersionCheckError {
  if (!value || typeof value !== 'object') return false;
  const e = value as VersionCheckError;
  return ['timeout','dns','tls','connection','http','rate-limit','invalid-response','unknown'].includes(e.kind)
    && ['revision','manifest','comparison'].includes(e.stage)
    && (e.httpStatus === undefined || (Number.isInteger(e.httpStatus) && e.httpStatus >= 100 && e.httpStatus <= 599))
    && (e.code === undefined || /^[A-Z][A-Z0-9_]{1,63}$/.test(e.code))
    && (e.retryAt === undefined || Number.isFinite(Date.parse(e.retryAt)));
}
interface Options {
  root: string;
  channel?: 'source' | 'release';
  deployment: { version: string; commit: string | null; localChanges: boolean };
  now?: () => number;
  fetch?: typeof fetch;
}

// ZIP installations have no Git identity. Compare only unambiguous stable
// versions; equal versions cannot establish whether their commits are equal.
function compareStableVersions(remote: string, installed: string): number | null {
  const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
  if (!stable.test(remote) || !stable.test(installed)) return null;
  const left = remote.split('.').map(BigInt), right = installed.split('.').map(BigInt);
  for (let index = 0; index < 3; index++) {
    if (left[index] !== right[index]) return left[index] > right[index] ? 1 : -1;
  }
  return 0;
}

// Separate from updater state/health reads. All clients share one bounded metadata
// check, and the cache survives service restarts. Checking never installs anything.
export class RepositoryVersionChecker {
  private readonly file: string;
  private readonly now: () => number;
  private readonly request: typeof fetch;
  private cached: CachedVersion | null = null;
  private inFlight: Promise<RepositoryVersionStatus> | null = null;
  constructor(private readonly options: Options) {
    this.file = path.join(options.root, options.channel === 'release' ? '.cache/package-version.json' : '.cache/service-version.json');
    this.now = options.now ?? Date.now;
    this.request = options.fetch ?? fetch;
    try {
      const value = JSON.parse(readFileSync(this.file, 'utf8').replace(/^\uFEFF/, ''));
      const validTime = (time: unknown) => typeof time === 'number' && Number.isFinite(time) && time > 0 && time <= this.now();
      const remote = value.remote;
      if (value.repository === REPOSITORY && value.currentCommit === options.deployment.commit
        && value.currentVersion === options.deployment.version
        && (typeof value.updateAvailable === 'boolean' || value.updateAvailable === null)
        && validTime(value.attemptedAt) && typeof value.failed === 'boolean'
        && ((remote === null && value.checkedAt === null && value.failed)
          || (typeof remote?.version === 'string' && versionPattern.test(remote.version)
            && typeof remote?.commit === 'string' && commitPattern.test(remote.commit)
            && validTime(value.checkedAt) && value.checkedAt <= value.attemptedAt))) {
        this.cached = value;
        // Old caches contain only a failure flag, not evidence of a network error.
        this.cached!.lastError = value.failed ? validError(value.lastError) ? {
          kind: value.lastError.kind, stage: value.lastError.stage, httpStatus: value.lastError.httpStatus,
          code: value.lastError.code, retryAt: value.lastError.retryAt,
        } : { kind: 'unknown', stage: 'revision' } : null;
      }
    } catch { /* A missing/corrupt cache is checked on demand. */ }
  }
  private snapshot(): RepositoryVersionStatus {
    const { deployment } = this.options;
    const remote = this.cached?.remote;
    const stale = !remote || this.cached!.failed || this.now() - this.cached!.checkedAt! >= VERSION_CACHE_MS;
    const updateAvailable = this.cached?.updateAvailable ?? null;
    return {
      currentVersion: deployment.version, currentCommit: deployment.commit, localChanges: deployment.localChanges,
      repositoryVersion: remote?.version ?? null, repositoryCommit: remote?.commit ?? null,
      updateAvailable, checkedAt: this.cached?.checkedAt ? new Date(this.cached.checkedAt).toISOString() : null,
      stale, status: stale || updateAvailable === null ? 'unavailable' : updateAvailable ? 'available' : 'current',
      attemptedAt: this.cached ? new Date(this.cached.attemptedAt).toISOString() : null,
      nextCheckAt: this.cached ? new Date(this.nextAttempt(false)).toISOString() : null,
      nextManualCheckAt: this.cached ? new Date(this.nextAttempt(true)).toISOString() : null,
      lastError: this.cached?.lastError ?? null,
    };
  }
  private nextAttempt(manual: boolean): number {
    if (!this.cached) return 0;
    const delay = manual ? VERSION_MANUAL_CACHE_MS : this.cached.failed ? VERSION_RETRY_MS : VERSION_CACHE_MS;
    const retryAt = Date.parse(this.cached.lastError?.retryAt ?? '');
    return Math.max(this.cached.attemptedAt + delay, Number.isFinite(retryAt) ? retryAt : 0);
  }
  check(manual = false): Promise<RepositoryVersionStatus> {
    if (this.inFlight) return this.inFlight;
    if (this.cached) {
      if (this.now() >= this.cached.attemptedAt && this.now() < this.nextAttempt(manual)) return Promise.resolve(this.snapshot());
    }
    this.inFlight = this.refresh().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }
  private async json(url: string, stage: VersionCheckError['stage']): Promise<unknown> {
    let response: Response;
    try { response = await this.request(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'Codex-Monitor-Version-Check' },
      signal: AbortSignal.timeout(10_000), redirect: 'error',
    }); } catch (error) { throw new CheckFailure(transportFailure(error, stage)); }
    if (!response.ok) {
      const rateLimited = response.status === 429 || (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0');
      const after = response.headers.get('retry-after');
      const reset = response.headers.get('x-ratelimit-reset');
      const until = after ? /^\d+$/.test(after) ? this.now() + Number(after) * 1000 : Date.parse(after)
        : rateLimited && reset ? Number(reset) * 1000 : NaN;
      const retryAt = Number.isFinite(until) && until > this.now()
        ? new Date(Math.min(until, this.now() + 24 * 60 * 60_000)).toISOString() : undefined;
      await response.body?.cancel().catch(() => {});
      throw new CheckFailure({ kind: rateLimited ? 'rate-limit' : 'http', stage, httpStatus: response.status, ...(retryAt ? { retryAt } : {}) });
    }
    try { return await response.json(); }
    catch (error) { throw new CheckFailure(error instanceof SyntaxError ? { kind: 'invalid-response', stage } : transportFailure(error, stage)); }
  }
  private async refresh(): Promise<RepositoryVersionStatus> {
    const currentCommit = this.options.deployment.commit;
    let stage: VersionCheckError['stage'] = 'revision';
    try {
      if (this.options.channel === 'release') {
        const { manifest } = await latestPackage(this.request);
        const time = this.now();
        this.cached = { repository: REPOSITORY, currentCommit, currentVersion: this.options.deployment.version,
          remote: { version: manifest.version, commit: manifest.commit }, updateAvailable: newerVersion(manifest.version, this.options.deployment.version),
          checkedAt: time, attemptedAt: time, failed: false, lastError: null };
      } else {
      const ref = await this.json(`https://api.github.com/repos/${REPOSITORY}/git/ref/heads/main`, stage) as { object?: { sha?: string; type?: string } };
      const commit = ref?.object?.sha;
      if (!commit || !commitPattern.test(commit) || ref.object?.type !== 'commit') throw new CheckFailure({ kind: 'invalid-response', stage });
      // Pin package.json to the same commit used for comparison, even if main moves.
      // A previously verified immutable commit needs no second metadata download.
      const knownVersion = this.cached?.remote?.commit === commit ? this.cached.remote.version
        : currentCommit === commit && !this.options.deployment.localChanges && versionPattern.test(this.options.deployment.version)
          ? this.options.deployment.version : null;
      stage = 'manifest';
      const manifest = knownVersion ? { name: 'codex-monitor', version: knownVersion }
        : await this.json(`https://raw.githubusercontent.com/${REPOSITORY}/${commit}/package.json`, stage) as { name?: string; version?: string };
      if (manifest?.name !== 'codex-monitor' || typeof manifest.version !== 'string' || !versionPattern.test(manifest.version)) throw new CheckFailure({ kind: 'invalid-response', stage });
      const remote = { version: manifest.version, commit };
      let updateAvailable: boolean | null = currentCommit === commit ? false : null;
      if (!currentCommit) {
        const order = compareStableVersions(manifest.version, this.options.deployment.version);
        updateAvailable = order === null || order === 0 ? null : order > 0;
      }
      if (currentCommit && currentCommit !== commit) {
        stage = 'comparison';
        const comparison = await this.json(`https://api.github.com/repos/${REPOSITORY}/compare/${currentCommit}...${commit}?per_page=1`, stage) as { status?: string; ahead_by?: number; behind_by?: number };
        if (!comparison || typeof comparison.status !== 'string') throw new CheckFailure({ kind: 'invalid-response', stage });
        if (comparison.status === 'ahead' && comparison.ahead_by! > 0 && comparison.behind_by === 0) updateAvailable = true;
        else if ((comparison.status === 'behind' && comparison.ahead_by === 0 && comparison.behind_by! > 0)
          || (comparison.status === 'identical' && comparison.ahead_by === 0 && comparison.behind_by === 0)) updateAvailable = false;
        // A divergent or unknown revision is not evidence of an available upgrade.
      }
      const time = this.now();
      this.cached = { repository: REPOSITORY, currentCommit, currentVersion: this.options.deployment.version,
        remote, updateAvailable, checkedAt: time, attemptedAt: time, failed: false, lastError: null };
      }
    } catch (error) {
      this.cached = { repository: REPOSITORY, currentCommit, currentVersion: this.options.deployment.version,
        remote: this.cached?.remote ?? null, updateAvailable: this.cached?.updateAvailable ?? null,
        checkedAt: this.cached?.checkedAt ?? null, attemptedAt: this.now(), failed: true,
        lastError: error instanceof CheckFailure || error instanceof PackageMetadataError ? error.detail : transportFailure(error, stage) };
    }
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      writeFileSync(temporary, JSON.stringify(this.cached), 'utf8');
      renameSync(temporary, this.file);
    } catch { /* A read-only cache directory must not block version display. */ }
    return this.snapshot();
  }
}
