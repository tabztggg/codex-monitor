import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { health, delay, json, writeJson } from './runtime/lib.mjs';

const build = json(path.resolve('release', `build-${process.platform}-${process.arch}.json`));
const root = process.argv[2] ? path.resolve(process.argv[2]) : build.stage;
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-monitor-package-'));
const home = path.join(data, 'empty-codex-home'); fs.mkdirSync(home);
const probe = net.createServer();
await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
const url = `http://127.0.0.1:${port}`;
writeJson(path.join(data, 'config.json'), { host: '127.0.0.1', port, codexHome: home });
const env = { ...process.env, CODEX_MONITOR_DATA_HOME: data, CODEX_HOME: home, CODEX_MONITOR_DRY_RUN: '1' };
function command(action) {
  return new Promise((resolve, reject) => {
    const executable = path.join(root, process.platform === 'win32' ? 'CodexMonitor.exe' : 'codex-monitor');
    const child = spawn(executable, [action], { env, windowsHide: true, stdio: 'pipe' });
    let output = '';
    child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
    const timeout = setTimeout(() => { child.kill(); reject(Error(`Launcher timed out: ${action}`)); }, 50_000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => { clearTimeout(timeout); code === 0 ? resolve(output) : reject(Error(`Launcher ${action}: ${code} ${output}`)); });
  });
}
async function waitFor(predicate, label) {
  for (let i = 0; i < 150; i++) { if (await predicate()) return; await delay(200); }
  throw Error(`Timed out: ${label}`);
}
try {
  const distribution = json(path.join(root, 'distribution.json'));
  const cliVersion = execFileSync(path.join(root, distribution.codex), ['--version'], { env, windowsHide: true, encoding: 'utf8', timeout: 15_000 });
  assert(cliVersion.includes(distribution.codexVersion), 'Bundled Codex CLI must run on the target system');
  await command('start');
  const before = await health(url); assert(before); assert.equal(before.version, build.version);
  const service = await (await fetch(`${url}/api/service`)).json(); assert.equal(service.enabled, true); assert.equal(service.update.supported, true);
  for (const page of ['/', '/tasks', '/trends']) {
    const response = await fetch(`${url}${page}`); assert.equal(response.status, 200); assert.match(await response.text(), /<html/i);
  }
  await command('start'); assert.equal((await health(url)).instance, before.instance, 'Repeated start must reuse instance');
  const marker = path.join(data, '.cache/smoke-preserved.json'); writeJson(marker, { retained: true });
  await command('restart');
  await waitFor(async () => { const result = await health(url); return result && result.instance !== before.instance; }, 'restart');
  assert.deepEqual(json(marker), { retained: true });
  await command('stop'); await waitFor(async () => !(await health(url)), 'stop');
  assert(!fs.existsSync(path.join(data, '.cache/manager.lock')), 'Lock released');
  await command('start'); assert(await health(url)); await command('stop');
  console.log(`Packaged runtime smoke passed: startup, pages, single instance, restart, stop, data retained (${process.platform}/${process.arch}).`);
} catch (error) {
  for (const name of ['launcher.log', 'server.log']) { const file = path.join(data, 'logs', name); if (fs.existsSync(file)) console.error(fs.readFileSync(file, 'utf8').slice(-6000)); }
  throw error;
} finally { await command('stop').catch(() => {}); }
