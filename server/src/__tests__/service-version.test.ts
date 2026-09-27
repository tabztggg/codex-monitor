import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { RepositoryVersionChecker, VERSION_CACHE_MS, VERSION_MANUAL_CACHE_MS, VERSION_RETRY_MS } from '../service-version';
import { installServiceControl } from '../service-control';
import { ServiceUpdater } from '../service-update';

const currentCommit = '1'.repeat(40), remoteCommit = '2'.repeat(40);
let root: string;
let time: number;
beforeEach(() => { root = mkdtempSync(path.join(os.tmpdir(), 'monitor-version-test-')); time = Date.UTC(2026, 8, 27); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });
function setup(options: { commit?: string | null; version?: string; remoteVersion?: string; remoteCommit?: string; localChanges?: boolean } = {}) {
  const request = vi.fn<typeof fetch>(async input => new Response(JSON.stringify(String(input).includes('/compare/')
    ? { status: 'ahead', ahead_by: 1, behind_by: 0 } : String(input).includes('api.github.com')
    ? { object: { sha: options.remoteCommit ?? remoteCommit, type: 'commit' } }
    : { name: 'codex-monitor', version: options.remoteVersion ?? '0.4.7' }), { status: 200 }));
  const deployment = { version: options.version ?? '0.4.6', commit: options.commit === undefined ? currentCommit : options.commit, localChanges: options.localChanges ?? false };
  const create = () => new RepositoryVersionChecker({ root, deployment, fetch: request, now: () => time });
  return { request, deployment, create, checker: create() };
}

it('compares the installed build with main and pins the version read to that revision', async () => {
  const { checker, request } = setup();
  expect(await checker.check()).toMatchObject({ currentVersion: '0.4.6', repositoryVersion: '0.4.7', repositoryCommit: remoteCommit,
    updateAvailable: true, status: 'available', stale: false, checkedAt: new Date(time).toISOString() });
  expect(request.mock.calls.map(call => call[0])).toEqual([
    'https://api.github.com/repos/tabztggg/codex-monitor/git/ref/heads/main',
    `https://raw.githubusercontent.com/tabztggg/codex-monitor/${remoteCommit}/package.json`,
    `https://api.github.com/repos/tabztggg/codex-monitor/compare/${currentCommit}...${remoteCommit}?per_page=1`,
  ]);
  for (const [, options] of request.mock.calls) {
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    expect(options?.redirect).toBe('error');
    expect(options?.headers).not.toHaveProperty('Authorization');
  }
});

it('detects new commits with an unchanged package version', async () => {
  const { checker } = setup({ remoteVersion: '0.4.6' });
  expect(await checker.check()).toMatchObject({ currentVersion: '0.4.6', repositoryVersion: '0.4.6', updateAvailable: true, status: 'available' });
});

it.each([
  [{ status: 'behind', ahead_by: 0, behind_by: 2 }, false],
  [{ status: 'diverged', ahead_by: 2, behind_by: 1 }, null],
  [{ status: 'ahead', ahead_by: 1, behind_by: 1 }, null],
] as const)('requires a confirmed forward update (%j)', async (comparison, available) => {
  const { checker, request } = setup();
  const original = request.getMockImplementation()!;
  request.mockImplementation((input, options) => String(input).includes('/compare/')
    ? Promise.resolve(new Response(JSON.stringify(comparison))) : original(input, options));
  expect(await checker.check()).toMatchObject({ updateAvailable: available, status: available === null ? 'unavailable' : 'current' });
});

it('does not publish partially verified metadata when commit comparison fails', async () => {
  const { checker, request } = setup();
  const original = request.getMockImplementation()!;
  request.mockImplementation((input, options) => String(input).includes('/compare/')
    ? Promise.resolve(new Response('{}', { status: 404 })) : original(input, options));
  expect(await checker.check()).toMatchObject({ repositoryVersion: null, repositoryCommit: null,
    updateAvailable: null, status: 'unavailable', stale: true });
});

it('invalidates the comparison cache when a different build has been installed', async () => {
  const { checker, request, deployment } = setup();
  await checker.check();
  const next = new RepositoryVersionChecker({ root, deployment: { ...deployment, commit: remoteCommit, version: '0.4.7' }, fetch: request, now: () => time });
  expect(await next.check()).toMatchObject({ currentVersion: '0.4.7', updateAvailable: false, status: 'current' });
  expect(request).toHaveBeenCalledTimes(4);
});

it('identifies a matching repository commit while retaining the local-change marker', async () => {
  const { checker } = setup({ remoteCommit: currentCommit, remoteVersion: '0.4.6', localChanges: true });
  expect(await checker.check()).toMatchObject({ updateAvailable: false, status: 'current', localChanges: true });
});

it('checks a clean matching commit with one request, independent of raw GitHub availability', async () => {
  const { checker, request } = setup({ remoteCommit: currentCommit, version: '0.4.11' });
  const original = request.getMockImplementation()!;
  request.mockImplementation((input, init) => String(input).includes('raw.githubusercontent.com')
    ? Promise.reject(new Error('unreachable')) : original(input, init));
  expect(await checker.check()).toMatchObject({ repositoryVersion: '0.4.11', status: 'current', lastError: null });
  expect(request).toHaveBeenCalledTimes(1);
  time += VERSION_CACHE_MS;
  await checker.check();
  expect(request).toHaveBeenCalledTimes(2);
});

it('does not treat an unpublished local version as the remote manifest', async () => {
  const { checker, request } = setup({ remoteCommit: currentCommit, version: '0.4.12', remoteVersion: '0.4.11', localChanges: true });
  expect(await checker.check()).toMatchObject({ repositoryVersion: '0.4.11', localChanges: true });
  expect(request).toHaveBeenCalledTimes(2);
});

it.each([
  [new DOMException('deadline', 'TimeoutError'), 'timeout', undefined],
  [new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } }), 'dns', 'ENOTFOUND'],
  [new TypeError('fetch failed', { cause: { code: 'CERT_HAS_EXPIRED' } }), 'tls', 'CERT_HAS_EXPIRED'],
  [new TypeError('fetch failed', { cause: new AggregateError([{ code: 'ECONNRESET' }]) }), 'connection', 'ECONNRESET'],
  [new Error('https://user:secret@example.com/?token=private'), 'unknown', undefined],
] as const)('records a safe, persistent reason for %s', async (error, kind, code) => {
  const { checker, request, create } = setup();
  request.mockRejectedValue(error);
  const result = await checker.check();
  expect(result).toMatchObject({ lastError: { kind, stage: 'revision' }, attemptedAt: new Date(time).toISOString(),
    nextCheckAt: new Date(time + VERSION_RETRY_MS).toISOString(), nextManualCheckAt: new Date(time + VERSION_MANUAL_CACHE_MS).toISOString() });
  expect(result.lastError?.code).toBe(code);
  expect(await create().check()).toEqual(result);
  expect(readFileSync(path.join(root, '.cache/service-version.json'), 'utf8')).not.toMatch(/secret|private|example\.com/);
});

it.each([403, 429])('honors GitHub rate-limit reset across readers and restarts (HTTP %s)', async status => {
  const { checker, request, create } = setup();
  const resetAt = time + 60 * 60_000;
  request.mockImplementation(async () => new Response('{}', { status, headers: {
    'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(resetAt / 1000),
  } }));
  const result = await checker.check();
  expect(result).toMatchObject({ lastError: { kind: 'rate-limit', httpStatus: status }, nextCheckAt: new Date(resetAt).toISOString(), nextManualCheckAt: new Date(resetAt).toISOString() });
  time += VERSION_RETRY_MS;
  await checker.check(true); await create().check();
  expect(request).toHaveBeenCalledTimes(1);
  time = resetAt;
  await checker.check(true);
  expect(request).toHaveBeenCalledTimes(2);
});

it('honors Retry-After without misclassifying HTTP 503 as a local network failure', async () => {
  const { checker, request } = setup();
  request.mockResolvedValue(new Response('{}', { status: 503, headers: { 'retry-after': '900' } }));
  expect(await checker.check()).toMatchObject({ lastError: { kind: 'http', httpStatus: 503 }, nextCheckAt: new Date(time + 900_000).toISOString() });
});

it('preserves the entire confirmed result when a new commit fails verification, then clears the error on recovery', async () => {
  const { checker, request } = setup({ remoteCommit: currentCommit, version: '0.4.6' });
  const known = await checker.check();
  time += VERSION_CACHE_MS;
  request.mockImplementation(async input => {
    if (String(input).includes('/compare/')) return new Response('{}', { status: 404 });
    return new Response(JSON.stringify(String(input).includes('api.github.com')
      ? { object: { sha: remoteCommit, type: 'commit' } } : { name: 'codex-monitor', version: '0.4.7' }));
  });
  expect(await checker.check()).toMatchObject({ repositoryCommit: currentCommit, repositoryVersion: known.repositoryVersion,
    checkedAt: known.checkedAt, updateAvailable: false, stale: true, lastError: { kind: 'http', stage: 'comparison', httpStatus: 404 } });
  time += VERSION_RETRY_MS;
  const original = request.getMockImplementation()!;
  request.mockImplementation((input, init) => String(input).includes('/compare/')
    ? Promise.resolve(new Response(JSON.stringify({ status: 'ahead', ahead_by: 1, behind_by: 0 }))) : original(input, init));
  expect(await checker.check()).toMatchObject({ repositoryCommit: remoteCommit, repositoryVersion: '0.4.7', updateAvailable: true, stale: false, lastError: null });
});

it.each(['<html>error</html>', 'null', '{}'])('reports invalid ref JSON without guessing the network is down (%s)', async body => {
  const { checker, request } = setup();
  request.mockResolvedValue(new Response(body));
  expect(await checker.check()).toMatchObject({ lastError: { kind: 'invalid-response', stage: 'revision' }, repositoryVersion: null });
});

it('reads old failure caches as unknown, retaining their confirmed version', async () => {
  const { checker, create } = setup();
  await checker.check();
  const file = path.join(root, '.cache/service-version.json');
  const value = JSON.parse(readFileSync(file, 'utf8'));
  delete value.lastError; value.failed = true;
  writeFileSync(file, JSON.stringify(value));
  expect(await create().check()).toMatchObject({ repositoryVersion: '0.4.7', stale: true, lastError: { kind: 'unknown' } });
});

it.each(['0.4.6', 'unknown', '0.4.6-beta.1', '01.2.3'])('does not infer commit equivalence from version %s without an installed commit', async version => {
  const { checker } = setup({ commit: null, version, remoteVersion: '0.4.6' });
  expect(await checker.check()).toMatchObject({ updateAvailable: null, status: 'unavailable', repositoryVersion: '0.4.6', stale: false });
});

it.each([
  ['0.4.9', '0.4.10', true], ['0.4.10', '0.4.9', false], ['1.9.9', '2.0.0', true],
  ['10.0.0', '2.0.0', false], ['0.4.10', '0.4.11-beta.1', null],
] as const)('allows only an unambiguous forward stable release for ZIP %s -> %s', async (version, remoteVersion, available) => {
  const { checker, request } = setup({ commit: null, version, remoteVersion });
  expect(await checker.check()).toMatchObject({ updateAvailable: available, stale: false,
    status: available === null ? 'unavailable' : available ? 'available' : 'current' });
  expect(request).toHaveBeenCalledTimes(2);
});

it('invalidates version-only ZIP cache after replacing the installed version', async () => {
  const { checker, request, deployment } = setup({ commit: null, version: '0.4.9', remoteVersion: '0.4.10' });
  expect(await checker.check()).toMatchObject({ updateAvailable: true });
  const updated = new RepositoryVersionChecker({ root, deployment: { ...deployment, version: '0.4.10' }, fetch: request, now: () => time });
  expect(await updated.check()).toMatchObject({ updateAvailable: null, currentVersion: '0.4.10' });
  expect(request).toHaveBeenCalledTimes(4);
});

it('deduplicates concurrent clients and reuses a 30 minute cache across restarts', async () => {
  const { checker, request, create } = setup();
  await Promise.all(Array.from({ length: 20 }, () => checker.check()));
  expect(request).toHaveBeenCalledTimes(3);
  time += VERSION_CACHE_MS - 1;
  await create().check();
  await checker.check();
  expect(request).toHaveBeenCalledTimes(3);
  time++;
  await checker.check();
  expect(request).toHaveBeenCalledTimes(5);
});

it('lets manual checks bypass a successful cache after a shared, persisted 5 minute cooldown', async () => {
  const { checker, request, create } = setup();
  const known = await checker.check();
  time += VERSION_MANUAL_CACHE_MS - 1;
  expect(await checker.check(true)).toEqual(known);
  expect(await create().check(true)).toEqual(known);
  expect(request).toHaveBeenCalledTimes(3);
  time++;
  await checker.check();
  expect(request).toHaveBeenCalledTimes(3);
  const results = await Promise.all(Array.from({ length: 20 }, () => checker.check(true)));
  expect(request).toHaveBeenCalledTimes(5);
  for (const result of results) expect(result).toMatchObject({ status: 'available', checkedAt: new Date(time).toISOString() });
  expect(await create().check(true)).toEqual(results[0]);
  expect(request).toHaveBeenCalledTimes(5);
});

it('shares an in-flight manual refresh with automatic and manual readers', async () => {
  const { checker, request } = setup();
  await checker.check();
  time += VERSION_MANUAL_CACHE_MS;
  const original = request.getMockImplementation()!;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  request.mockImplementationOnce(async (input, options) => { await gate; return original(input, options); });
  const refresh = checker.check(true);
  expect(checker.check()).toBe(refresh);
  expect(checker.check(true)).toBe(refresh);
  expect(request).toHaveBeenCalledTimes(4);
  release();
  expect(await refresh).toMatchObject({ status: 'available', checkedAt: new Date(time).toISOString() });
  expect(request).toHaveBeenCalledTimes(5);
});

it.each([false, true])('lets manual checks retry failures after 5 minutes, preserving prior results when present (%s)', async withPreviousResult => {
  const { checker, request, create } = setup();
  const original = request.getMockImplementation()!;
  const known = withPreviousResult ? await checker.check() : null;
  if (withPreviousResult) time += VERSION_MANUAL_CACHE_MS;
  request.mockRejectedValue(new Error('offline'));
  const failed = await checker.check(true);
  expect(failed).toMatchObject({ status: 'unavailable', stale: true,
    repositoryVersion: known?.repositoryVersion ?? null, checkedAt: known?.checkedAt ?? null });
  const failedCallCount = request.mock.calls.length;
  time += VERSION_MANUAL_CACHE_MS - 1;
  const cached = await Promise.all(Array.from({ length: 20 }, () => checker.check(true)));
  for (const result of cached) expect(result).toEqual(failed);
  expect(await create().check(true)).toEqual(failed);
  expect(request).toHaveBeenCalledTimes(failedCallCount);
  await checker.check();
  expect(request).toHaveBeenCalledTimes(failedCallCount);
  time++;
  request.mockImplementation(original);
  expect(await checker.check(true)).toMatchObject({ status: 'available', stale: false, checkedAt: new Date(time).toISOString() });
  expect(request).toHaveBeenCalledTimes(failedCallCount + (withPreviousResult ? 2 : 3));
});

it('retains the last successful result on failure and applies a persisted retry cooldown', async () => {
  const { checker, request, create } = setup();
  const known = await checker.check();
  time += VERSION_CACHE_MS;
  request.mockRejectedValue(new Error('offline'));
  expect(await checker.check()).toMatchObject({ repositoryVersion: '0.4.7', repositoryCommit: remoteCommit,
    updateAvailable: true, stale: true, status: 'unavailable', checkedAt: known.checkedAt });
  for (let i = 0; i < 10; i++) await checker.check();
  await create().check();
  expect(request).toHaveBeenCalledTimes(4);
  time += VERSION_RETRY_MS;
  await checker.check();
  expect(request).toHaveBeenCalledTimes(5);
});

it('shows unknown on an initial rate limit instead of claiming the installed version is current', async () => {
  const { checker, request } = setup();
  request.mockResolvedValue(new Response('{}', { status: 429 }));
  expect(await checker.check()).toMatchObject({ currentVersion: '0.4.6', repositoryVersion: null,
    updateAvailable: null, status: 'unavailable', stale: true, checkedAt: null });
  await checker.check();
  expect(request).toHaveBeenCalledTimes(1);
});

it.each(['wrong package', 'bad version', 'bad commit'])('rejects %s without reporting an update', async kind => {
  const { checker, request } = setup();
  request.mockImplementation(async input => new Response(JSON.stringify(String(input).includes('api.github.com')
    ? { object: { sha: kind === 'bad commit' ? '../../main' : remoteCommit, type: 'commit' } }
    : { name: kind === 'wrong package' ? 'other' : 'codex-monitor', version: kind === 'bad version' ? '<markup>' : '0.4.7' })));
  expect(await checker.check()).toMatchObject({ repositoryVersion: null, updateAvailable: null, status: 'unavailable' });
  if (kind === 'bad commit') expect(request).toHaveBeenCalledTimes(1);
});

it('ignores corrupt, foreign, or future-dated persistent results', async () => {
  const { checker, request, create } = setup();
  await checker.check();
  const file = path.join(root, '.cache/service-version.json');
  const good = JSON.parse(readFileSync(file, 'utf8'));
  for (const value of ['{bad', JSON.stringify({ ...good, repository: 'other/project' }), JSON.stringify({ ...good, attemptedAt: time + 1 })]) {
    writeFileSync(file, value);
    await create().check();
  }
  expect(request).toHaveBeenCalledTimes(12);
});

it('keeps health/status reads offline and exposes version checks only through the dedicated read-only route', async () => {
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '0.4.6' }));
  mkdirSync(path.join(root, '.cache'), { recursive: true });
  const { checker, request } = setup();
  const exits = vi.fn(), command = vi.fn(async () => '');
  const app = express(); app.use(express.json());
  installServiceControl(app, true, exits,
    (instance, onReady) => new ServiceUpdater({ root, instance, onReady, supported: true, command }), () => checker);
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  try {
    await fetch(`${base}/api/service`); await fetch(`${base}/api/service/health`);
    expect(request).not.toHaveBeenCalled();
    const response = await fetch(`${base}/api/service/versions?repository=ignored&force=true`);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toMatchObject({ status: 'available', repositoryVersion: '0.4.7' });
    expect(request).toHaveBeenCalledTimes(3);
    time += VERSION_MANUAL_CACHE_MS;
    for (const query of ['', '?refresh=0', '?refresh=true', '?refresh=01', '?refresh=1&refresh=1', '?refresh[]=1', '?refresh[value]=1', '?force=true']) {
      await fetch(`${base}/api/service/versions${query}`);
      expect(request).toHaveBeenCalledTimes(3);
    }
    const refreshed = await fetch(`${base}/api/service/versions?refresh=1`);
    expect(refreshed.headers.get('cache-control')).toBe('no-store');
    expect(await refreshed.json()).toMatchObject({ status: 'available', checkedAt: new Date(time).toISOString() });
    expect(request).toHaveBeenCalledTimes(5);
    await fetch(`${base}/api/service/versions?refresh=1`);
    expect(request).toHaveBeenCalledTimes(5);
    expect(command).not.toHaveBeenCalled(); expect(exits).not.toHaveBeenCalled();
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
