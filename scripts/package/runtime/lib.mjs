import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const json = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(temp, file);
}
export function dataDirectory(env = process.env, platform = process.platform, home = os.homedir()) {
  if (env.CODEX_MONITOR_DATA_HOME) return path.resolve(env.CODEX_MONITOR_DATA_HOME);
  if (platform === 'win32') return path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'CodexMonitorData');
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'CodexMonitor');
  return path.join(env.XDG_STATE_HOME || path.join(home, '.local', 'state'), 'codex-monitor');
}
export function readConfig(root) {
  const file = path.join(root, 'config.json');
  const value = fs.existsSync(file) ? json(file) : {};
  const config = { host: '127.0.0.1', port: 4201, allowedOrigins: '', ...value };
  if (!Number.isInteger(config.port) || config.port < 1024 || config.port > 65535
    || typeof config.host !== 'string' || !/^[a-zA-Z0-9.:-]+$/.test(config.host)
    || typeof config.allowedOrigins !== 'string'
    || (config.codexHome !== undefined && (typeof config.codexHome !== 'string' || !path.isAbsolute(config.codexHome)))) throw Error('Invalid config.json: check host, port and codexHome');
  if (!fs.existsSync(file)) writeJson(file, config);
  return config;
}
export function localUrl(config) {
  const host = config.host === '0.0.0.0' || config.host === '::' ? '127.0.0.1' : config.host;
  return `http://${host.includes(':') ? `[${host}]` : host}:${config.port}`;
}
export function inside(root, candidate) {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return rel !== '' && !rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel);
}
export function validateRuntime(root, expected) {
  const distribution = json(path.join(root, 'distribution.json'));
  if (distribution.schema !== 1 || distribution.name !== 'codex-monitor' || !/^\d+\.\d+\.\d+$/.test(distribution.version)
    || !/^[a-f0-9]{40}$/.test(distribution.commit) || distribution.platform !== process.platform || distribution.arch !== process.arch
    || (expected && (expected.version !== distribution.version || expected.commit !== distribution.commit))) throw Error('Invalid runtime identity');
  for (const entry of ['dist/server/index.js', 'dist/web/index.html', 'dist/launcher/main.mjs', `runtime/${process.platform === 'win32' ? 'node.exe' : 'node'}`, distribution.codex]) {
    if (typeof entry !== 'string' || !inside(root, path.join(root, entry)) || !fs.statSync(path.join(root, entry)).isFile()) throw Error('Incomplete runtime');
  }
  return distribution;
}
export function chooseRuntime(base, dataRoot) {
  const original = validateRuntime(base);
  try {
    const active = json(path.join(dataRoot, 'active.json'));
    const runtimes = path.join(dataRoot, 'runtimes');
    if (!inside(runtimes, active.root) || !inside(fs.realpathSync(runtimes), fs.realpathSync(active.root))) return base;
    const installed = validateRuntime(active.root, active);
    const a = installed.version.split('.').map(Number), b = original.version.split('.').map(Number);
    for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i] ? active.root : base;
    return active.root;
  } catch { return base; }
}
export function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}
export async function health(url) {
  try {
    const response = await fetch(`${url}/api/service/health`, { signal: AbortSignal.timeout(1500), redirect: 'error' });
    const result = await response.json();
    return response.ok && result.ok === true && typeof result.instance === 'string' ? result : null;
  } catch { return null; }
}
export const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
