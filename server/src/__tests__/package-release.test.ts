import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as tar from 'tar';
import { downloadPackage, latestPackage, newerVersion, PackageUpdater, packageDownloadUrl, safeArchiveEntry, unpackPackage, type PackageRelease } from '../package-release';
import { RepositoryVersionChecker } from '../service-version';

const directories: string[] = [];
const temporary = () => { const root = mkdtempSync(path.join(os.tmpdir(), 'package-test-')); directories.push(root); return root; };
afterEach(() => { for (const root of directories.splice(0)) rmSync(root, { recursive: true, force: true }); });
const commit = 'a'.repeat(40);
function release(bytes = Buffer.from('package'), version = '0.5.1'): PackageRelease {
  const name = `codex-monitor-${version}-${process.platform}-${process.arch}.tar.gz`;
  const asset = { name, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  return { manifest: { schema: 1, name: 'codex-monitor', version, commit, platforms: { [`${process.platform}-${process.arch}`]: asset } }, asset, url: packageDownloadUrl(version, name) };
}
function server(value: PackageRelease, bytes = Buffer.from('package')) {
  return vi.fn(async (url: any) => {
    if (String(url).endsWith('/releases/latest')) return Response.json({ tag_name: `v${value.manifest.version}`, assets: [
      { name: 'package-manifest.json', browser_download_url: packageDownloadUrl(value.manifest.version, 'package-manifest.json') },
      { name: value.asset.name, browser_download_url: value.url },
    ] });
    if (String(url).endsWith('/package-manifest.json')) return Response.json(value.manifest);
    return new Response(bytes);
  }) as unknown as typeof fetch;
}
describe('packaged releases', () => {
  it('compares versions numerically and never downgrades or accepts prereleases', () => {
    expect(newerVersion('0.10.0', '0.9.9')).toBe(true);
    for (const version of ['0.5.0', '0.4.12', '0.6.0-beta', '01.1.0']) expect(newerVersion(version, '0.5.0')).toBe(false);
  });
  it('accepts only matching GitHub assets for the current platform', async () => {
    const value = release();
    expect(await latestPackage(server(value))).toEqual(value);
    value.asset.name = 'other.tar.gz';
    await expect(latestPackage(server(value))).rejects.toThrow('manifest');
  });
  it('keeps GitHub rate limits distinct from a network failure', async () => {
    const checker = new RepositoryVersionChecker({ root: temporary(), channel: 'release', deployment: { version: '0.5.0', commit, localChanges: false },
      fetch: vi.fn(async () => new Response('', { status: 429, headers: { 'retry-after': '3600' } })) as typeof fetch });
    const result = await checker.check();
    expect(result.lastError?.kind).toBe('rate-limit');
    expect(Date.parse(result.nextCheckAt!)).toBeGreaterThan(Date.now() + 3500_000);
  });
  it('checks checksums and declared size before extracting anything', async () => {
    const root = temporary(), value = release();
    await downloadPackage(value, path.join(root, 'valid'), server(value));
    expect(readFileSync(path.join(root, 'valid'), 'utf8')).toBe('package');
    await expect(downloadPackage(value, path.join(root, 'bad'), server(value, Buffer.from('changed')))).rejects.toThrow('checksum');
    await expect(downloadPackage(value, path.join(root, 'large'), server(value, Buffer.from('way too large')))).rejects.toThrow('declared size');
  });
  it('rejects traversal, absolute paths and links', () => {
    for (const name of ['../outside', '/outside', 'a/../b', 'a\\b', 'C:/outside', 'a//b', './a']) expect(safeArchiveEntry(name, 'File')).toBe(false);
    expect(safeArchiveEntry('dist/server/index.js', 'SymbolicLink')).toBe(false);
    expect(safeArchiveEntry('dist/server/index.js', 'File')).toBe(true);
  });
  it('rejects duplicate archive paths before creating the destination', async () => {
    const root = temporary(); writeFileSync(path.join(root, 'file'), 'content');
    const archive = path.join(root, 'archive.tgz');
    await tar.c({ file: archive, cwd: root, gzip: true }, ['file', 'file']);
    await expect(unpackPackage(archive, path.join(root, 'destination'))).rejects.toThrow('Unsafe');
    expect(existsSync(path.join(root, 'destination'))).toBe(false);
  });
  it('extracts a valid package without losing executable permissions', async () => {
    const root = temporary(); writeFileSync(path.join(root, 'node'), 'executable', { mode: 0o755 });
    const archive = path.join(root, 'archive.tgz');
    await tar.c({ file: archive, cwd: root, gzip: true }, ['node']);
    await unpackPackage(archive, path.join(root, 'destination'));
    expect(readFileSync(path.join(root, 'destination/node'), 'utf8')).toBe('executable');
    if (process.platform !== 'win32') expect(statSync(path.join(root, 'destination/node')).mode & 0o111).toBe(0o111);
  });
  it('leaves the running app and user data intact when an update fails validation', async () => {
    const root = temporary(); writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '0.5.0' }));
    writeFileSync(path.join(root, 'keep'), 'user data');
    const value = release(), ready = vi.fn();
    const updater = new PackageUpdater({ appRoot: root, dataRoot: root, instance: 'test', onReady: ready, request: server(value, Buffer.from('changed')) });
    updater.start(); await vi.waitFor(() => expect(updater.getStatus().status).toBe('failed'));
    expect(ready).not.toHaveBeenCalled(); expect(readFileSync(path.join(root, 'keep'), 'utf8')).toBe('user data');
    expect(existsSync(path.join(root, '.cache/package-update-request.json'))).toBe(false);
  });
  it('uses a separate cached stable Release channel instead of main', async () => {
    const root = temporary(), request = server(release());
    const checker = new RepositoryVersionChecker({ root, channel: 'release', deployment: { version: '0.5.0', commit, localChanges: false }, fetch: request });
    expect((await checker.check()).status).toBe('available');
    expect((await checker.check()).status).toBe('available');
    expect(request).toHaveBeenCalledTimes(2);
    expect(existsSync(path.join(root, '.cache/package-version.json'))).toBe(true);
  });
});
