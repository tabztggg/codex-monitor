import { spawn, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const UPDATE_REPOSITORY = 'https://github.com/tabztggg/codex-monitor';
export type UpdatePhase = 'idle' | 'checking' | 'downloading' | 'building' | 'ready' | 'applying' | 'restarting' | 'completed' | 'up-to-date' | 'failed';
export interface UpdateStatus {
  supported: boolean;
  repository: string;
  status: UpdatePhase;
  version?: string;
  targetVersion?: string;
  operationId?: string;
  commit?: string;
  startedAt?: string;
  updatedAt?: string;
  error?: string;
  localChanges?: boolean;
}
export const ACTIVE_UPDATE_PHASES = new Set<UpdatePhase>(['checking', 'downloading', 'building', 'ready', 'applying', 'restarting']);
const phases = new Set<UpdatePhase>([...ACTIVE_UPDATE_PHASES, 'idle', 'completed', 'up-to-date', 'failed']);
type Command = (executable: string, args: string[], cwd: string, timeoutMs: number) => Promise<string>;
interface Options {
  root: string;
  supported: boolean;
  instance: string;
  onReady: () => void;
  command?: Command;
  git?: string;
  npmCli?: string;
  powershell?: string;
}

export function readDeployment(root: string): { version: string; commit: string | null; localChanges: boolean } {
  let version = 'unknown';
  let commit: string | null = null;
  let localChanges = false;
  try { version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8').replace(/^\uFEFF/, '')).version ?? version; } catch { }
  try {
    const metadata = JSON.parse(readFileSync(path.join(root, 'deployment.json'), 'utf8').replace(/^\uFEFF/, ''));
    if (/^[0-9a-f]{40}$/.test(metadata.commit)) commit = metadata.commit;
    localChanges = metadata.dirty === true;
  } catch { }
  return { version, commit, localChanges };
}

function atomicJson(file: string, value: unknown) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2), 'utf8');
  renameSync(temporary, file);
}

function findGit(): string {
  return [
    ...(process.env.PATH ?? '').split(path.delimiter).map(folder => path.join(folder, 'git.exe')),
    path.join(process.env.ProgramFiles ?? 'C:/Program Files', 'Git/cmd/git.exe')
  ].find(file => existsSync(file)) ?? 'git.exe';
}

// Commands are fixed by this module; neither executables nor arguments come from HTTP input.
export function runUpdateCommand(logFile: string): Command {
  return (executable, args, cwd, timeoutMs) => new Promise((resolve, reject) => {
    let output = '';
    let settled = false;
    let expired = false;
    const child = spawn(executable, args, {
      cwd, windowsHide: true, shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never', CI: '1' }
    });
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Keep diagnostics local, bounded per command, without sending output to the public API.
      try { appendFileSync(logFile, `\n${path.basename(executable)} ${args[0] ?? ''}\n${output}\n`, 'utf8'); } catch { }
      error ? reject(error) : resolve(output);
    };
    const capture = (chunk: Buffer) => { output = (output + chunk.toString('utf8')).slice(-32_768); };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    const timer = setTimeout(() => {
      expired = true;
      if (child.pid && process.platform === 'win32') {
        execFile(path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32/taskkill.exe'),
          ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {
            finish(new Error('Update command timed out. Check logs/service-update.log.'));
          });
      } else {
        child.kill('SIGKILL');
        finish(new Error('Update command timed out. Check logs/service-update.log.'));
      }
    }, timeoutMs);
    child.once('error', () => finish(new Error(`Cannot start ${path.basename(executable)}. Check that Git, Node.js and PowerShell 7 are installed.`)));
    child.once('close', code => finish(code === 0 && !expired ? undefined : new Error(
      expired ? 'Update command timed out. Check logs/service-update.log.' : `${path.basename(executable)} failed (${code ?? 'interrupted'}). Check logs/service-update.log.`)));
  });
}

export class ServiceUpdater {
  readonly deployment;
  private readonly stateFile: string;
  private readonly requestFile: string;
  private readonly command: Command;
  private preparing = false;
  private state: UpdateStatus;
  constructor(private readonly options: Options) {
    this.deployment = readDeployment(options.root);
    this.stateFile = path.join(options.root, '.cache/service-update.json');
    this.requestFile = path.join(options.root, '.cache/update-request.json');
    this.command = options.command ?? runUpdateCommand(path.join(options.root, 'logs/service-update.log'));
    this.state = { supported: options.supported, repository: UPDATE_REPOSITORY, status: 'idle', version: this.deployment.version };
    this.getStatus();
    // A prior preparer disappeared. Applying/restarting is owned by the outer Windows runner.
    if (options.supported && ['checking', 'downloading', 'building', 'ready'].includes(this.state.status)) {
      this.save('failed', { error: 'The previous update was interrupted before installation. The installed version is unchanged.' });
    }
  }
  get supported() { return this.options.supported; }
  getStatus(): UpdateStatus {
    try {
      const stored = JSON.parse(readFileSync(this.stateFile, 'utf8').replace(/^\uFEFF/, ''));
      if (phases.has(stored.status)) {
        // Only expose defined status fields, never internal stage paths or logs.
        for (const key of ['status', 'targetVersion', 'operationId', 'commit', 'startedAt', 'updatedAt', 'error'] as const) {
          if (typeof stored[key] === 'string') (this.state as unknown as Record<string, string>)[key] = stored[key];
          else delete (this.state as unknown as Record<string, string | undefined>)[key];
        }
      }
    } catch { }
    return { ...this.state, supported: this.supported, repository: UPDATE_REPOSITORY, version: this.deployment.version, localChanges: this.deployment.localChanges };
  }
  isBusy() { return this.preparing || ACTIVE_UPDATE_PHASES.has(this.getStatus().status); }
  private save(status: UpdatePhase, fields: Partial<UpdateStatus> = {}) {
    this.state = { ...this.state, ...fields, status, updatedAt: new Date().toISOString() };
    atomicJson(this.stateFile, this.state);
  }
  start(): UpdateStatus {
    if (!this.supported) throw new Error('Windows standalone installation required for updates.');
    if (this.isBusy()) throw new Error('Service action already pending');
    // Windows installers open this file with FileShare.None. Keep a handle
    // through preparation so either launcher can exclude the other before
    // stopping the service. The durable ready state protects the handoff.
    mkdirSync(path.dirname(this.stateFile), { recursive: true });
    const deploymentLock = openSync(path.join(this.options.root, '.cache/deploy.lock'), 'a+');
    const previousState = this.state;
    this.preparing = true;
    this.state = { supported: true, repository: UPDATE_REPOSITORY, status: 'checking', version: this.deployment.version,
      operationId: randomUUID(), startedAt: new Date().toISOString() };
    try { this.save('checking'); }
    catch (error) { this.state = previousState; this.preparing = false; closeSync(deploymentLock); throw error; }
    void this.prepare().catch(error => {
      const message = error instanceof Error ? error.message : 'Update failed. Check logs/service-update.log.';
      try { this.save('failed', { error: message }); }
      catch { this.state = { ...this.state, status: 'failed', error: message }; }
      finally { this.preparing = false; }
    }).finally(() => { closeSync(deploymentLock); });
    return this.getStatus();
  }
  private async prepare() {
    const { root } = this.options;
    const git = this.options.git ?? findGit();
    const npmCli = this.options.npmCli ?? path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
    const powershell = this.options.powershell ?? process.env.CODEX_MONITOR_POWERSHELL_PATH ?? '';
    mkdirSync(path.join(root, 'logs'), { recursive: true });
    writeFileSync(path.join(root, 'logs/service-update.log'), `Update started ${this.state.startedAt}\n`, 'utf8');
    const remote = await this.command(git, ['ls-remote', `${UPDATE_REPOSITORY}.git`, 'refs/heads/main'], root, 60_000);
    const commit = remote.match(/^([0-9a-f]{40})\s+refs\/heads\/main\s*$/m)?.[1];
    if (!commit) throw new Error('Cannot read the latest main commit from the update repository.');
    if (commit === this.deployment.commit) {
      this.save('up-to-date', { commit, targetVersion: this.deployment.version });
      this.preparing = false;
      return;
    }
    if (!existsSync(npmCli) || !powershell || !existsSync(powershell)) {
      throw new Error('Updates require npm and PowerShell 7. The running service was not changed.');
    }
    const stageRoot = path.join(root, '.cache/updates', this.state.operationId!, 'source');
    mkdirSync(stageRoot, { recursive: true });
    this.save('downloading', { commit });
    await this.command(git, ['init', '--quiet'], stageRoot, 30_000);
    await this.command(git, ['fetch', '--quiet', '--depth=1', `${UPDATE_REPOSITORY}.git`, commit], stageRoot, 180_000);
    await this.command(git, ['checkout', '--quiet', '--detach', 'FETCH_HEAD'], stageRoot, 30_000);
    const checkedOut = (await this.command(git, ['rev-parse', 'HEAD'], stageRoot, 30_000)).trim();
    if (checkedOut !== commit) throw new Error('Downloaded revision did not match the requested commit.');
    const manifest = JSON.parse(readFileSync(path.join(stageRoot, 'package.json'), 'utf8').replace(/^\uFEFF/, ''));
    if (manifest.name !== 'codex-monitor' || typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(manifest.version)) {
      throw new Error('The repository did not contain a valid Codex Monitor package.');
    }
    for (const script of ['Update-StandaloneMonitor.ps1', 'Run-StandaloneMonitor.ps1', 'Build-StandaloneMonitorHost.ps1']) {
      if (!existsSync(path.join(stageRoot, 'scripts', script))) throw new Error('The selected repository version does not support safe in-app updates. The running version was kept.');
    }
    this.save('building', { targetVersion: manifest.version });
    await this.command(process.execPath, [npmCli, 'ci', '--include=dev', '--no-audit', '--no-fund'], stageRoot, 600_000);
    await this.command(process.execPath, [npmCli, 'run', 'build'], stageRoot, 600_000);
    await this.command(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(stageRoot, 'scripts/Build-StandaloneMonitorHost.ps1')], stageRoot, 120_000);
    await this.command(process.execPath, [npmCli, 'prune', '--omit=dev', '--no-audit', '--no-fund'], stageRoot, 300_000);
    for (const artifact of ['dist/server/index.js', 'dist/web/index.html', 'node_modules/express/package.json', '.cache/standalone-host/Run-StandaloneMonitor.exe']) {
      if (!existsSync(path.join(stageRoot, artifact))) throw new Error('The update build is incomplete. The running service was not changed.');
    }
    atomicJson(this.requestFile, { operationId: this.state.operationId, stageRoot, commit,
      targetVersion: manifest.version, previousInstanceId: this.options.instance });
    this.save('ready');
    // Only now stop Node. The outer Windows runner owns replacement, health checks and rollback.
    this.options.onReady();
  }
}
