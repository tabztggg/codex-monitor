import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { createServer } from 'node:http';
import { ServiceUpdater, UPDATE_REPOSITORY } from '../service-update';
import { installServiceControl } from '../service-control';

const oldCommit = '1'.repeat(40), nextCommit = '2'.repeat(40);
let root: string;
function file(relative: string, body = '') {
  const target = path.join(root, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, body);
  return target;
}
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'monitor-update-test-'));
  file('package.json', JSON.stringify({ name: 'codex-monitor', version: '0.4.6' }));
  file('deployment.json', JSON.stringify({ commit: oldCommit }));
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });
async function until(done: () => boolean) {
  for (let i = 0; i < 200 && !done(); i++) await new Promise(resolve => setTimeout(resolve, 5));
  expect(done()).toBe(true);
}
function fixtures(stage: string) {
  for (const relative of ['scripts/Update-StandaloneMonitor.ps1', 'scripts/Run-StandaloneMonitor.ps1',
    'scripts/Build-StandaloneMonitorHost.ps1', 'dist/server/index.js', 'dist/web/index.html',
    'node_modules/express/package.json', '.cache/standalone-host/Run-StandaloneMonitor.exe']) {
    file(path.relative(root, path.join(stage, relative)));
  }
  file(path.relative(root, path.join(stage, 'package.json')), JSON.stringify({ name: 'codex-monitor', version: '0.4.7' }));
}
function setup(command: (exe: string, args: string[], cwd: string, timeout: number) => Promise<string>, onReady = vi.fn()) {
  return { updater: new ServiceUpdater({ root, supported: true, instance: 'old-instance', onReady, command,
    git: 'git.exe', npmCli: file('fake/npm-cli.js'), powershell: file('fake/pwsh.exe') }), onReady };
}

it('does not contact GitHub on reads; same deployed commit is a no-op without stopping service', async () => {
  const command = vi.fn(async (_exe: string, _args: string[]) => `${oldCommit}\trefs/heads/main\n`);
  const { updater, onReady } = setup(command);
  updater.getStatus(); updater.getStatus();
  expect(command).not.toHaveBeenCalled();
  updater.start();
  await until(() => updater.getStatus().status === 'up-to-date');
  expect(command).toHaveBeenCalledTimes(1);
  expect(command.mock.calls[0]?.[1]).toEqual(['ls-remote', `${UPDATE_REPOSITORY}.git`, 'refs/heads/main']);
  expect(onReady).not.toHaveBeenCalled();
  expect(existsSync(path.join(root, '.cache/update-request.json'))).toBe(false);
});

it('pins the downloaded SHA, builds with dev dependencies under production, and requests replacement only when complete', async () => {
  file('standalone.json', '{"port":4201}'); file('.cache/calibration.json', 'keep');
  const command = vi.fn(async (_exe: string, args: string[], cwd: string) => {
    if (args[0] === 'ls-remote') return `${nextCommit}\trefs/heads/main\n`;
    if (args[0] === 'checkout') fixtures(cwd);
    if (args[0] === 'rev-parse') return nextCommit;
    return '';
  });
  const { updater, onReady } = setup(command);
  updater.start();
  await until(() => onReady.mock.calls.length === 1);
  const request = JSON.parse(readFileSync(path.join(root, '.cache/update-request.json'), 'utf8'));
  expect(request).toMatchObject({ commit: nextCommit, targetVersion: '0.4.7', previousInstanceId: 'old-instance' });
  expect(request.stageRoot).toBe(path.join(root, '.cache/updates', request.operationId, 'source'));
  expect(command.mock.calls.map(call => call[1])).toContainEqual(['fetch', '--quiet', '--depth=1', `${UPDATE_REPOSITORY}.git`, nextCommit]);
  expect(command.mock.calls.some(call => call[1].includes('ci') && call[1].includes('--include=dev'))).toBe(true);
  expect(updater.getStatus().status).toBe('ready');
  expect(readFileSync(path.join(root, 'standalone.json'), 'utf8')).toBe('{"port":4201}');
  expect(readFileSync(path.join(root, '.cache/calibration.json'), 'utf8')).toBe('keep');
});

it.each(['checkout mismatch', 'build failed', 'missing updater', 'incomplete artifact'])('preserves service on %s', async failure => {
  const { updater, onReady } = setup(async (_exe, args, cwd) => {
    if (args[0] === 'ls-remote') return `${nextCommit}\trefs/heads/main\n`;
    if (args[0] === 'checkout') {
      fixtures(cwd);
      if (failure === 'missing updater') rmSync(path.join(cwd, 'scripts/Update-StandaloneMonitor.ps1'));
      if (failure === 'incomplete artifact') rmSync(path.join(cwd, 'dist/web/index.html'));
    }
    if (args[0] === 'rev-parse') return failure === 'checkout mismatch' ? oldCommit : nextCommit;
    if (args.includes('build') && failure === 'build failed') throw new Error('Build failed');
    return '';
  });
  updater.start();
  await until(() => updater.getStatus().status === 'failed');
  expect(onReady).not.toHaveBeenCalled();
  expect(existsSync(path.join(root, '.cache/update-request.json'))).toBe(false);
  expect(updater.isBusy()).toBe(false);
  expect(JSON.parse(readFileSync(path.join(root, 'deployment.json'), 'utf8')).commit).toBe(oldCommit);
});

it('restores durable completion without exposing internal paths and recovers interrupted preparation', () => {
  file('.cache/service-update.json', JSON.stringify({ status: 'completed', operationId: 'test', stageRoot: 'private-path', targetVersion: '0.4.7' }));
  const { updater } = setup(async () => { throw new Error('Must not fetch'); });
  expect(updater.getStatus()).toMatchObject({ status: 'completed', targetVersion: '0.4.7' });
  expect(updater.getStatus()).not.toHaveProperty('stageRoot');
  file('.cache/service-update.json', JSON.stringify({ status: 'building', operationId: 'interrupted' }));
  const next = setup(async () => '').updater;
  expect(next.getStatus()).toMatchObject({ status: 'failed', operationId: 'interrupted' });
  expect(next.isBusy()).toBe(false);
});

it('identifies unpublished local changes when the repository commit is already included', async () => {
  file('deployment.json', JSON.stringify({ commit: oldCommit, dirty: true }));
  const { updater, onReady } = setup(async () => `${oldCommit}\trefs/heads/main\n`);
  updater.start();
  await until(() => updater.getStatus().status === 'up-to-date');
  expect(updater.getStatus().localChanges).toBe(true);
  expect(onReady).not.toHaveBeenCalled();
});

it('accepts one update and blocks stop/restart/duplicate updates while preparing, without taking arbitrary targets', async () => {
  let finishCheck!: (output: string) => void;
  const command = vi.fn((_exe: string, _args: string[]) => new Promise<string>(resolve => { finishCheck = resolve; }));
  const app = express(); app.use(express.json()); const exits = vi.fn();
  installServiceControl(app, true, exits, (instance, onReady) => new ServiceUpdater({ root, supported: true, instance, onReady, command }));
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/api/service`;
  try {
    const send = (action: string) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, repository: 'https://attacker.invalid/', command: 'invalid' }) });
    expect((await send('update')).status).toBe(202);
    for (const action of ['update', 'restart', 'stop']) expect((await send(action)).status).toBe(409);
    expect(command.mock.calls[0]?.[1]).toEqual(['ls-remote', `${UPDATE_REPOSITORY}.git`, 'refs/heads/main']);
    finishCheck(`${oldCommit}\trefs/heads/main\n`);
    await until(() => existsSync(path.join(root, '.cache/service-update.json')) && JSON.parse(readFileSync(path.join(root, '.cache/service-update.json'), 'utf8')).status === 'up-to-date');
    const health = await fetch(`${url}/health`).then(r => r.json());
    expect(health).toMatchObject({ ok: true, version: '0.4.6', commit: oldCommit });
    expect(exits).not.toHaveBeenCalled();
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

it('rejects updates for unsupported manual launchers', () => {
  const updater = new ServiceUpdater({ root, supported: false, instance: 'manual', onReady: vi.fn() });
  expect(() => updater.start()).toThrow('Windows standalone');
});
