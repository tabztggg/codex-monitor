import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { alive, chooseRuntime, dataDirectory, delay, health, inside, json, localUrl, readConfig, validateRuntime, writeJson } from './lib.mjs';

const base = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const data = dataDirectory();
const config = readConfig(data);
const url = localUrl(config);
const stateFile = path.join(data, '.cache/manager.json');
const lockFile = path.join(data, '.cache/manager.lock');
const requestFile = path.join(data, '.cache/package-update-request.json');
const updateFile = path.join(data, '.cache/service-update.json');
const token = randomUUID();
let child;
let stopping = false;
let lockOwned = false;
fs.mkdirSync(path.join(data, '.cache'), { recursive: true });
fs.mkdirSync(path.join(data, 'logs'), { recursive: true });

function log(message) {
  const file = path.join(data, 'logs/launcher.log');
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > 2_000_000) fs.renameSync(file, `${file}.previous`);
    fs.appendFileSync(file, `${new Date().toISOString()} ${message}\n`);
  } catch { /* Logging must not prevent stopping the service. */ }
}
function readState() { try { return json(stateFile); } catch { return null; } }
async function verifiedState() {
  const state = readState();
  if (!state || state.url !== url || !alive(state.managerPid)) return null;
  const current = await health(url);
  return current?.instance === state.instance ? state : null;
}
function releaseLock() {
  try { if (json(lockFile).token === token) fs.unlinkSync(lockFile); } catch { }
  try { if (json(stateFile).token === token) fs.unlinkSync(stateFile); } catch { }
  lockOwned = false;
}
function acquireLock() {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, token }), { flag: 'wx', mode: 0o600 });
      lockOwned = true; return;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // A newly created lock may not have finished writing. Never remove a live or ambiguous lock.
      let old;
      try { old = json(lockFile); } catch { throw Error('Launcher is already starting; try again shortly'); }
      if (alive(old.pid)) throw Error('Monitor is already running or starting');
      fs.unlinkSync(lockFile);
    }
  }
  throw Error('Could not acquire launcher lock');
}
function browser() {
  const command = process.platform === 'win32' ? 'rundll32.exe' : process.platform === 'darwin' ? '/usr/bin/open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  const opened = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
  opened.on('error', error => log(`Browser: ${error.message}`)); opened.unref();
}
async function stop(action = 'stop') {
  const state = await verifiedState();
  if (!state) {
    if (alive(readState()?.managerPid)) throw Error('Monitor is starting or updating; try again shortly');
    return;
  }
  const response = await fetch(`${url}/api/service`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }), signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw Error(`Service ${action} refused: HTTP ${response.status}`);
  if (action === 'stop') {
    for (let i = 0; i < 150; i++) { if (!alive(state.managerPid)) return; await delay(100); }
    throw Error('Monitor did not stop; installation left unchanged');
  }
}
function finishChild(signal = 'SIGTERM') {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform !== 'win32') { try { process.kill(-child.pid, signal); } catch { } }
  else child.kill(signal);
}
async function shutdown() {
  if (stopping) return;
  stopping = true;
  if (child?.connected) child.send({ type: 'shutdown' });
  else finishChild();
  const timeout = setTimeout(() => { finishChild('SIGKILL'); process.exit(0); }, 5000);
  timeout.unref();
}
function launch(root) {
  const manifest = validateRuntime(root);
  const instance = randomUUID();
  const logFile = path.join(data, 'logs/server.log');
  if (fs.existsSync(logFile) && fs.statSync(logFile).size > 5_000_000) fs.renameSync(logFile, `${logFile}.previous`);
  const output = fs.openSync(logFile, 'a');
  const executable = path.join(root, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node');
  child = spawn(executable, [path.join(root, 'dist/server/index.js')], {
    cwd: data, detached: process.platform !== 'win32', windowsHide: true,
    stdio: ['ignore', output, output, 'ipc'], env: {
      ...process.env, CODEX_MONITOR_APP_ROOT: root, CODEX_MONITOR_DISTRIBUTION: 'package', CODEX_MONITOR_MANAGED: '1',
      CODEX_MONITOR_INSTANCE: instance,
      CODEX_MONITOR_HOST: config.host, PORT: String(config.port), CODEX_MONITOR_ALLOWED_ORIGINS: config.allowedOrigins,
      CODEX_MONITOR_CODEX_PATH: path.join(root, manifest.codex), ...(config.codexHome ? { CODEX_HOME: config.codexHome } : {}),
    },
  });
  fs.closeSync(output);
  const running = child;
  const exited = new Promise(resolve => {
    running.once('error', error => { log(error.message); resolve(-1); });
    running.once('exit', code => resolve(code ?? -1));
  });
  return { running, exited, manifest, instance };
}
async function waitHealthy(started) {
  for (let i = 0; i < 100 && !stopping; i++) {
    if (started.running.exitCode !== null || started.running.signalCode !== null) return null;
    const current = await health(url);
    if (current && current.instance === started.instance && current.version === started.manifest.version && current.commit === started.manifest.commit) return current;
    await delay(200);
  }
  return null;
}
function updateState(status, extra = {}) {
  let previous = {};
  try { previous = json(updateFile); } catch { }
  writeJson(updateFile, { ...previous, status, ...extra, updatedAt: new Date().toISOString() });
}
async function serve(root) {
  acquireLock();
  if (await health(url)) throw Error(`Port ${config.port} is already used by another installation`);
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
  let pending = null;
  let failures = 0;
  while (!stopping) {
    const started = launch(root);
    const current = await waitHealthy(started);
    if (!current) {
      finishChild('SIGKILL'); await started.exited;
      if (pending) {
        root = pending.previous; pending = null;
        updateState('failed', { error: 'New package did not start; previous version restored.' });
        continue;
      }
      throw Error('Monitor failed to start. See logs/server.log in the data directory.');
    }
    writeJson(stateFile, { token, managerPid: process.pid, serverPid: started.running.pid, instance: current.instance, url, root });
    if (pending) {
      writeJson(path.join(data, 'active.json'), { root, version: started.manifest.version, commit: started.manifest.commit });
      updateState('completed', { error: undefined }); pending = null;
    }
    const readyAt = Date.now();
    const code = await started.exited;
    // Descendants (Codex app-server) share this child's process group on POSIX.
    if (process.platform !== 'win32') { try { process.kill(-started.running.pid, 'SIGTERM'); } catch { } }
    if (stopping || code === 0) break;
    if (code === 42) { failures = 0; continue; }
    if (code === 43) {
      try {
        const request = json(requestFile);
        fs.unlinkSync(requestFile);
        const runtimes = path.join(data, 'runtimes');
        if (request.schema !== 1 || request.previousInstance !== current.instance || !inside(runtimes, request.runtimeRoot)
          || !inside(fs.realpathSync(runtimes), fs.realpathSync(request.runtimeRoot))) throw Error('Invalid update request');
        validateRuntime(request.runtimeRoot, request);
        pending = { previous: root }; root = request.runtimeRoot;
        updateState('applying');
      } catch (error) { updateState('failed', { error: error.message }); }
      continue;
    }
    if (Date.now() - readyAt > 60_000) failures = 0;
    if (++failures > 3) throw Error('Monitor repeatedly stopped unexpectedly; automatic restart paused');
    await delay(failures * 2000);
  }
}
async function start(open) {
  if (await verifiedState()) { if (open) browser(); return; }
  if (await health(url)) throw Error(`Port ${config.port} belongs to another installation. Stop that installation first or change config.json.`);
  const root = chooseRuntime(base, data);
  let manager;
  if (process.platform === 'win32') {
    manager = spawn(path.join(root, 'CodexMonitor.exe'), ['--host'], { detached: true, stdio: 'ignore', windowsHide: true, env: process.env });
  } else {
    manager = spawn(path.join(root, 'runtime/node'), [path.join(root, 'dist/launcher/main.mjs'), 'serve'], { detached: true, stdio: 'ignore', env: process.env });
  }
  manager.on('error', error => log(error.message)); manager.unref();
  for (let i = 0; i < 120; i++) {
    if (await verifiedState()) { if (open) browser(); return; }
    await delay(250);
  }
  throw Error(`Startup timed out. See ${path.join(data, 'logs/launcher.log')}`);
}
process.on('exit', () => { if (lockOwned) { finishChild(); releaseLock(); } });
const command = process.argv[2] || 'open';
try {
  if (command === 'serve') await serve(chooseRuntime(base, data));
  else if (command === 'open' || command === 'start') await start(command === 'open');
  else if (command === 'stop' || command === 'restart') await stop(command);
  else if (command === 'status') { const state = await verifiedState(); console.log(JSON.stringify({ running: !!state, url, data, runtime: state?.root ?? null })); process.exitCode = state ? 0 : 1; }
  else throw Error(`Unknown command: ${command}`);
} catch (error) { log(error.stack || error.message); console.error(error.message); process.exitCode = 1; }
