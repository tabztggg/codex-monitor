import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promisify } from 'node:util';
import { closeSync, mkdtempSync, mkdirSync, openSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ServiceUpdater } from '../service-update';

const execFileAsync = promisify(execFile);
const powershell = process.env.CODEX_MONITOR_POWERSHELL_PATH ?? 'pwsh.exe';
const commit = '1'.repeat(40);

describe.skipIf(process.platform !== 'win32')('Windows deployment lock interoperability', () => {
  let root: string;
  let lockFile: string;
  let helper: string;
  const holders = new Set<ChildProcessWithoutNullStreams>();

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'monitor-deployment-lock-'));
    mkdirSync(path.join(root, '.cache'));
    lockFile = path.join(root, '.cache/deploy.lock');
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'codex-monitor', version: '0.4.10' }));
    writeFileSync(path.join(root, 'deployment.json'), JSON.stringify({ commit }));
    helper = path.join(root, 'lock-fixture.ps1');
    // Exercise the actual installer sharing mode in another Windows process.
    // The helper never starts/stops a service and touches only this fixture.
    writeFileSync(helper, `param([string]$LockPath, [switch]$Hold)
$ErrorActionPreference = 'Stop'
$lock = $null
try {
  try { $lock = [IO.File]::Open($LockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
  catch [IO.IOException] { [Console]::Out.WriteLine('BLOCKED'); exit 0 }
  [Console]::Out.WriteLine('LOCKED')
  if ($Hold) { [void][Console]::In.ReadLine() }
} finally { if ($null -ne $lock) { $lock.Dispose() } }
`, 'utf8');
  });

  afterEach(async () => {
    await Promise.all([...holders].map(release));
    const resolved = path.resolve(root);
    if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(resolved).startsWith('monitor-deployment-lock-')) {
      throw new Error('Refusing cleanup outside the deployment-lock fixture');
    }
    rmSync(resolved, { recursive: true, force: true });
  });

  async function probeExclusive(): Promise<string> {
    const result = await execFileAsync(powershell, ['-NoProfile', '-NonInteractive', '-File', helper, '-LockPath', lockFile],
      { windowsHide: true, timeout: 10_000 });
    return result.stdout.trim();
  }

  function holdExclusive(): Promise<ChildProcessWithoutNullStreams> {
    const child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-File', helper, '-LockPath', lockFile, '-Hold'],
      { windowsHide: true, stdio: 'pipe' });
    holders.add(child);
    return new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => { child.kill(); reject(new Error('Lock helper did not become ready')); }, 10_000);
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('close', code => { clearTimeout(timer); holders.delete(child); reject(new Error(`Lock helper closed before release (${code})`)); });
      child.stdout.on('data', chunk => {
        output += chunk.toString();
        if (output.trim() === 'LOCKED') { clearTimeout(timer); resolve(child); }
        else if (output.trim() === 'BLOCKED') { clearTimeout(timer); reject(new Error('Expected fixture lock to be free')); }
      });
    });
  }

  async function release(child: ChildProcessWithoutNullStreams): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) { holders.delete(child); return; }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error('Lock helper did not release')); }, 5000);
      child.once('close', () => { clearTimeout(timer); holders.delete(child); resolve(); });
      child.stdin.end('\n');
    });
  }

  function updaterWith(command: () => Promise<string>) {
    const onReady = vi.fn();
    return { updater: new ServiceUpdater({ root, supported: true, instance: 'lock-fixture', onReady, command, git: 'fixture-git' }), onReady };
  }

  it('rejects Node opens during FileShare.None and rejects FileShare.None while a Node descriptor is open', async () => {
    const holder = await holdExclusive();
    try { expect(() => { const unexpected = openSync(lockFile, 'a+'); closeSync(unexpected); }).toThrow(); }
    finally { await release(holder); }
    const fd = openSync(lockFile, 'a+');
    try { expect(await probeExclusive()).toBe('BLOCKED'); }
    finally { closeSync(fd); }
    expect(await probeExclusive()).toBe('LOCKED');
  });

  it('does not start a command or change durable/in-memory state when the installer owns the lock', async () => {
    const stateFile = path.join(root, '.cache/service-update.json');
    writeFileSync(stateFile, JSON.stringify({ status: 'completed', operationId: 'existing-operation' }));
    const command = vi.fn(async () => `${commit}\trefs/heads/main\n`);
    const { updater, onReady } = updaterWith(command);
    const before = updater.getStatus();
    const stored = readFileSync(stateFile, 'utf8');
    const holder = await holdExclusive();
    try {
      expect(() => updater.start()).toThrow();
      expect(command).not.toHaveBeenCalled();
      expect(onReady).not.toHaveBeenCalled();
      expect(updater.getStatus()).toEqual(before);
      expect(readFileSync(stateFile, 'utf8')).toBe(stored);
      expect(updater.isBusy()).toBe(false);
    } finally { await release(holder); }
  });

  it.each(['up-to-date', 'failed'] as const)('blocks installer access throughout preparation and releases it after %s', async outcome => {
    let finish!: (value: string) => void;
    let fail!: (error: Error) => void;
    const command = vi.fn(() => new Promise<string>((resolve, reject) => { finish = resolve; fail = reject; }));
    const { updater, onReady } = updaterWith(command);
    updater.start();
    try {
      expect(command).toHaveBeenCalledTimes(1);
      expect(updater.getStatus().status).toBe('checking');
      expect(await probeExclusive()).toBe('BLOCKED');
    } finally {
      if (outcome === 'up-to-date') finish(`${commit}\trefs/heads/main\n`);
      else fail(new Error('Fixture command failure'));
    }
    await vi.waitFor(() => expect(updater.getStatus().status).toBe(outcome));
    expect(updater.isBusy()).toBe(false);
    expect(onReady).not.toHaveBeenCalled();
    expect(await probeExclusive()).toBe('LOCKED');
  });

  it('releases the descriptor and allows retry after saving the initial state fails', async () => {
    // A directory at the destination forces atomic state replacement to fail.
    mkdirSync(path.join(root, '.cache/service-update.json'));
    const command = vi.fn(async () => `${commit}\trefs/heads/main\n`);
    const { updater } = updaterWith(command);
    expect(() => updater.start()).toThrow();
    expect(command).not.toHaveBeenCalled();
    expect(updater.getStatus().status).toBe('idle');
    expect(updater.isBusy()).toBe(false);
    expect(await probeExclusive()).toBe('LOCKED');
    rmdirSync(path.join(root, '.cache/service-update.json'));
    updater.start();
    await vi.waitFor(() => expect(updater.getStatus().status).toBe('up-to-date'));
    expect(command).toHaveBeenCalledTimes(1);
    expect(updater.isBusy()).toBe(false);
    expect(await probeExclusive()).toBe('LOCKED');
  });
});
