import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { RepositoryVersionStatus } from '../../shared/service-version';

const REPOSITORY = 'tabztggg/codex-monitor';
export const VERSION_CACHE_MS = 30 * 60_000;
export const VERSION_RETRY_MS = 5 * 60_000;
export const VERSION_MANUAL_CACHE_MS = 5 * 60_000;
const commitPattern = /^[0-9a-f]{40}$/;
const versionPattern = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/;
interface RemoteVersion { version: string; commit: string }
interface CachedVersion {
  repository: string; currentCommit: string | null; remote: RemoteVersion | null;
  updateAvailable: boolean | null; checkedAt: number | null; attemptedAt: number; failed: boolean;
}
interface Options {
  root: string;
  deployment: { version: string; commit: string | null; localChanges: boolean };
  now?: () => number;
  fetch?: typeof fetch;
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
    this.file = path.join(options.root, '.cache/service-version.json');
    this.now = options.now ?? Date.now;
    this.request = options.fetch ?? fetch;
    try {
      const value = JSON.parse(readFileSync(this.file, 'utf8').replace(/^\uFEFF/, ''));
      const validTime = (time: unknown) => typeof time === 'number' && Number.isFinite(time) && time > 0 && time <= this.now();
      const remote = value.remote;
      if (value.repository === REPOSITORY && value.currentCommit === options.deployment.commit
        && (typeof value.updateAvailable === 'boolean' || value.updateAvailable === null)
        && validTime(value.attemptedAt) && typeof value.failed === 'boolean'
        && ((remote === null && value.checkedAt === null && value.failed)
          || (typeof remote?.version === 'string' && versionPattern.test(remote.version)
            && typeof remote?.commit === 'string' && commitPattern.test(remote.commit)
            && validTime(value.checkedAt) && value.checkedAt <= value.attemptedAt))) this.cached = value;
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
    };
  }
  check(manual = false): Promise<RepositoryVersionStatus> {
    if (this.inFlight) return this.inFlight;
    if (this.cached) {
      const age = this.now() - this.cached.attemptedAt;
      const cacheMs = manual ? VERSION_MANUAL_CACHE_MS : this.cached.failed ? VERSION_RETRY_MS : VERSION_CACHE_MS;
      if (age >= 0 && age < cacheMs) return Promise.resolve(this.snapshot());
    }
    this.inFlight = this.refresh().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }
  private async json(url: string): Promise<unknown> {
    const response = await this.request(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'Codex-Monitor-Version-Check' },
      signal: AbortSignal.timeout(10_000), redirect: 'error',
    });
    if (!response.ok) throw new Error('Repository version unavailable');
    return response.json();
  }
  private async refresh(): Promise<RepositoryVersionStatus> {
    const currentCommit = this.options.deployment.commit;
    let remote = this.cached?.remote ?? null;
    let checkedAt = this.cached?.checkedAt ?? null;
    let updateAvailable = this.cached?.updateAvailable ?? null;
    try {
      const ref = await this.json(`https://api.github.com/repos/${REPOSITORY}/git/ref/heads/main`) as { object?: { sha?: string; type?: string } };
      const commit = ref.object?.sha;
      if (!commit || !commitPattern.test(commit) || ref.object?.type !== 'commit') throw new Error('Invalid repository revision');
      // Pin package.json to the same commit used for comparison, even if main moves.
      const manifest = await this.json(`https://raw.githubusercontent.com/${REPOSITORY}/${commit}/package.json`) as { name?: string; version?: string };
      if (manifest.name !== 'codex-monitor' || typeof manifest.version !== 'string' || !versionPattern.test(manifest.version)) throw new Error('Invalid repository version');
      remote = { version: manifest.version, commit };
      checkedAt = this.now();
      updateAvailable = currentCommit === commit ? false : null;
      if (currentCommit && currentCommit !== commit) {
        const comparison = await this.json(`https://api.github.com/repos/${REPOSITORY}/compare/${currentCommit}...${commit}?per_page=1`) as { status?: string; ahead_by?: number; behind_by?: number };
        if (comparison.status === 'ahead' && comparison.ahead_by! > 0 && comparison.behind_by === 0) updateAvailable = true;
        else if ((comparison.status === 'behind' && comparison.ahead_by === 0 && comparison.behind_by! > 0)
          || (comparison.status === 'identical' && comparison.ahead_by === 0 && comparison.behind_by === 0)) updateAvailable = false;
        // A divergent or unknown revision is not evidence of an available upgrade.
      }
      const time = this.now();
      this.cached = { repository: REPOSITORY, currentCommit, remote, updateAvailable, checkedAt: time, attemptedAt: time, failed: false };
    } catch {
      this.cached = { repository: REPOSITORY, currentCommit, remote, updateAvailable, checkedAt, attemptedAt: this.now(), failed: true };
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
