import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Transform, Readable } from 'node:stream';
import path from 'node:path';
import * as tar from 'tar';
import { ACTIVE_UPDATE_PHASES, readDeployment, type UpdateStatus } from './service-update';
import type { VersionCheckError } from '../../shared/service-version';

export const PACKAGE_REPOSITORY = 'tabztggg/codex-monitor';
export const PACKAGE_SCHEMA = 1;
export interface PackageAsset { name: string; sha256: string; size: number }
export interface PackageManifest {
  schema: number; name: string; version: string; commit: string;
  platforms: Record<string, PackageAsset>;
}
export interface PackageRelease { manifest: PackageManifest; asset: PackageAsset; url: string }
export class PackageMetadataError extends Error {
  constructor(message: string, readonly detail: VersionCheckError) { super(message); }
}
function metadataHttp(response: Response, stage: VersionCheckError['stage']) {
  if (response.ok) return;
  const rateLimited = response.status === 429 || (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0');
  const retry = response.headers.get('retry-after');
  const reset = response.headers.get('x-ratelimit-reset');
  const until = retry ? /^\d+$/.test(retry) ? Date.now() + Number(retry) * 1000 : Date.parse(retry) : reset ? Number(reset) * 1000 : NaN;
  void response.body?.cancel().catch(() => {});
  throw new PackageMetadataError(`Release metadata HTTP ${response.status}`, { kind: rateLimited ? 'rate-limit' : 'http', stage, httpStatus: response.status,
    ...(Number.isFinite(until) && until > Date.now() ? { retryAt: new Date(Math.min(until, Date.now() + 86_400_000)).toISOString() } : {}) });
}
const invalidMetadata = (message: string) => new PackageMetadataError(message, { kind: 'invalid-response', stage: 'manifest' });
const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export function newerVersion(candidate: string, current: string): boolean {
  if (!stableVersion.test(candidate) || !stableVersion.test(current)) return false;
  const a = candidate.split('.').map(BigInt), b = current.split('.').map(BigInt);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}
export function atomicPackageJson(file: string, value: unknown) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(temporary, file);
}
export function readJson(file: string): any {
  return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}
export function packageDownloadUrl(version: string, name: string): string {
  if (!stableVersion.test(version) || !/^[A-Za-z0-9][A-Za-z0-9._-]+$/.test(name)) throw Error('Invalid package name');
  return `https://github.com/${PACKAGE_REPOSITORY}/releases/download/v${version}/${name}`;
}
export async function latestPackage(request: typeof fetch = fetch, platform = process.platform, arch = process.arch): Promise<PackageRelease> {
  const options = { headers: { Accept: 'application/json', 'User-Agent': 'Codex-Monitor-Packages' }, signal: AbortSignal.timeout(10_000) };
  const response = await request(`https://api.github.com/repos/${PACKAGE_REPOSITORY}/releases/latest`, { ...options, redirect: 'error' });
  metadataHttp(response, 'revision');
  const release = await response.json() as { tag_name?: string; draft?: boolean; prerelease?: boolean; assets?: { name: string; browser_download_url: string }[] };
  const version = release.tag_name?.replace(/^v/, '') ?? '';
  if (release.draft || release.prerelease || !stableVersion.test(version) || !Array.isArray(release.assets)) throw invalidMetadata('Invalid stable release');
  const manifestUrl = packageDownloadUrl(version, 'package-manifest.json');
  if (!release.assets.some(asset => asset.name === 'package-manifest.json' && asset.browser_download_url === manifestUrl)) throw invalidMetadata('This release has no packaged downloads');
  const manifestResponse = await request(manifestUrl, { ...options, signal: AbortSignal.timeout(10_000) });
  metadataHttp(manifestResponse, 'manifest');
  const manifest = await manifestResponse.json() as PackageManifest;
  const asset = manifest?.platforms?.[`${platform}-${arch}`];
  const expectedName = `codex-monitor-${version}-${platform}-${arch}.tar.gz`;
  if (manifest.schema !== PACKAGE_SCHEMA || manifest.name !== 'codex-monitor' || manifest.version !== version || !/^[a-f0-9]{40}$/.test(manifest.commit)
      || !asset || asset.name !== expectedName || !/^[a-f0-9]{64}$/.test(asset.sha256) || !Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > 600_000_000) throw invalidMetadata('Invalid or unsupported package manifest');
  const url = packageDownloadUrl(version, asset.name);
  if (!release.assets.some(item => item.name === asset.name && item.browser_download_url === url)) throw invalidMetadata('Package asset missing from release');
  return { manifest, asset, url };
}
export async function downloadPackage(release: PackageRelease, file: string, request: typeof fetch = fetch) {
  const response = await request(release.url, { signal: AbortSignal.timeout(300_000), headers: { 'User-Agent': 'Codex-Monitor-Packages' } });
  if (!response.ok || !response.body) throw Error(`Package download HTTP ${response.status}`);
  let bytes = 0;
  const hash = createHash('sha256');
  const verify = new Transform({ transform(chunk: Buffer, _encoding, callback) {
    bytes += chunk.length;
    if (bytes > release.asset.size) { callback(Error('Package exceeds declared size')); return; }
    hash.update(chunk); callback(null, chunk);
  } });
  await pipeline(Readable.fromWeb(response.body as any), verify, createWriteStream(file, { flags: 'wx', mode: 0o600 }));
  if (bytes !== release.asset.size || hash.digest('hex') !== release.asset.sha256) throw Error('Package checksum mismatch; current installation kept');
}
export function safeArchiveEntry(name: string, type: string): boolean {
  const normalized = name.replace(/\/$/, '');
  return ['File', 'Directory'].includes(type) && normalized.length > 0 && normalized.length < 1024
    && !/[\\:\x00-\x1f]/.test(name) && !name.startsWith('/') && normalized.split('/').every(part => part && part !== '.' && part !== '..'
      && !/[. ]$/.test(part) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}
export async function unpackPackage(archive: string, destination: string) {
  let count = 0, total = 0;
  const seen = new Set<string>();
  const parser = new tar.Parser({ strict: true, onReadEntry(entry) {
    const key = entry.path.replace(/\/$/, '').toLowerCase();
    if (!safeArchiveEntry(entry.path, entry.type) || seen.has(key) || ++count > 100_000 || (total += entry.size) > 2_000_000_000) {
      parser.abort(Error('Unsafe package archive')); return;
    }
    seen.add(key);
    entry.resume();
  } });
  await pipeline(createReadStream(archive), parser);
  if (existsSync(destination)) throw Error('Package destination already exists');
  mkdirSync(destination, { recursive: true });
  await tar.x({ file: archive, cwd: destination, strict: true, preservePaths: false, noChmod: true,
    filter: (name, entry) => safeArchiveEntry(name, 'type' in entry ? entry.type : '') });
}
export class PackageUpdater {
  readonly supported = true;
  readonly deployment: ReturnType<typeof readDeployment>;
  private readonly stateFile: string;
  private state: UpdateStatus;
  private busy = false;
  constructor(private readonly options: { appRoot: string; dataRoot: string; instance: string; onReady: () => void; request?: typeof fetch }) {
    this.deployment = readDeployment(options.appRoot);
    this.stateFile = path.join(options.dataRoot, '.cache/service-update.json');
    this.state = { supported: true, repository: `https://github.com/${PACKAGE_REPOSITORY}`, status: 'idle' };
    try { const old = readJson(this.stateFile); if (old?.status === 'completed' || old?.status === 'failed') this.state = { ...this.state, ...old }; } catch { }
  }
  getStatus(): UpdateStatus {
    if (!this.busy) {
      try { const saved = readJson(this.stateFile); if (saved.status === 'completed' || saved.status === 'failed') this.state = { ...this.state, ...saved }; } catch { }
    }
    return { ...this.state, supported: true, version: this.deployment.version, localChanges: this.deployment.localChanges };
  }
  isBusy() { return this.busy || ACTIVE_UPDATE_PHASES.has(this.state.status); }
  private save(status: UpdateStatus['status'], fields: Partial<UpdateStatus> = {}) {
    this.state = { ...this.state, ...fields, status, updatedAt: new Date().toISOString() };
    atomicPackageJson(this.stateFile, this.state);
  }
  start() {
    if (this.isBusy()) throw Error('An update is already running');
    this.save('checking', { startedAt: new Date().toISOString(), operationId: randomUUID() });
    this.busy = true;
    void this.prepare().catch(error => {
      try { this.save('failed', { error: error instanceof Error ? error.message : 'Package update failed' }); }
      catch { this.state = { ...this.state, status: 'failed', error: 'Unable to save update state' }; }
    }).finally(() => { this.busy = false; });
    return this.getStatus();
  }
  private async prepare() {
    const release = await latestPackage(this.options.request);
    if (!newerVersion(release.manifest.version, this.deployment.version)) { this.save('up-to-date'); return; }
    this.save('downloading', { targetVersion: release.manifest.version, commit: release.manifest.commit });
    const staging = path.join(this.options.dataRoot, '.cache/package-updates', this.state.operationId!);
    mkdirSync(staging, { recursive: true });
    const archive = path.join(staging, 'runtime.tar.gz');
    await downloadPackage(release, archive, this.options.request);
    const runtimeRoot = path.join(this.options.dataRoot, 'runtimes', `${release.manifest.version}-${this.state.operationId}`);
    await unpackPackage(archive, runtimeRoot);
    const distribution = readJson(path.join(runtimeRoot, 'distribution.json'));
    if (distribution.schema !== PACKAGE_SCHEMA || distribution.version !== release.manifest.version || distribution.commit !== release.manifest.commit || distribution.platform !== process.platform || distribution.arch !== process.arch) throw Error('Package identity mismatch');
    for (const name of ['dist/server/index.js', 'dist/launcher/main.mjs', 'dist/web/index.html', `runtime/${process.platform === 'win32' ? 'node.exe' : 'node'}`]) {
      if (!existsSync(path.join(runtimeRoot, name))) throw Error('Incomplete package');
    }
    unlinkSync(archive);
    atomicPackageJson(path.join(this.options.dataRoot, '.cache/package-update-request.json'), { schema: PACKAGE_SCHEMA, runtimeRoot, version: distribution.version, commit: distribution.commit, previousInstance: this.options.instance });
    this.save('ready');
    this.options.onReady();
  }
}
