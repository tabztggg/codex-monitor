import { expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { delay, health, json, writeJson } from '../../../scripts/package/runtime/lib.mjs';

it('rolls back a broken update and persists a successful update across full restarts', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-supervisor-'));
  const base = path.join(data, 'base'), broken = path.join(data, 'runtimes/broken'), next = path.join(data, 'runtimes/next');
  const probe = net.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const url = `http://127.0.0.1:${port}`;
  writeJson(path.join(data, 'config.json'), { host: '127.0.0.1', port });
  function runtime(root, version, bad = false) {
    fs.mkdirSync(path.join(root, 'runtime'), { recursive: true });
    const node = path.join(root, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node');
    try { fs.linkSync(process.execPath, node); } catch { fs.copyFileSync(process.execPath, node); }
    fs.writeFileSync(path.join(root, 'runtime/codex'), 'unused');
    fs.mkdirSync(path.join(root, 'dist/server'), { recursive: true });
    fs.mkdirSync(path.join(root, 'dist/web'), { recursive: true });
    fs.cpSync(path.resolve('scripts/package/runtime'), path.join(root, 'dist/launcher'), { recursive: true });
    fs.writeFileSync(path.join(root, 'dist/web/index.html'), 'test');
    fs.writeFileSync(path.join(root, 'dist/server/index.js'), bad ? 'process.exit(1)' : `
      const http = require('node:http');
      const server = http.createServer((req, res) => {
        if (req.method === 'GET') { res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({ ok:true, instance:process.env.CODEX_MONITOR_INSTANCE, version:'${version}', commit:'${'a'.repeat(40)}' })); }
        else { let body=''; req.on('data', chunk=>body+=chunk); req.on('end',()=>{ const code={update:43,restart:42,stop:0}[JSON.parse(body).action]; res.writeHead(202); res.end('{}'); setTimeout(()=>process.exit(code),50); }); }
      }); server.listen(Number(process.env.PORT),'127.0.0.1');
      process.on('message',()=>process.exit(0)); process.on('disconnect',()=>process.exit(0));
    `);
    writeJson(path.join(root, 'distribution.json'), { schema: 1, name: 'codex-monitor', version, commit: 'a'.repeat(40), platform: process.platform, arch: process.arch, codex: 'runtime/codex' });
  }
  runtime(base, '0.5.0'); runtime(broken, '0.5.1', true); runtime(next, '0.5.2');
  let manager;
  const start = () => { manager = spawn(process.execPath, [path.join(base, 'dist/launcher/main.mjs'), 'serve'], { env: { ...process.env, CODEX_MONITOR_DATA_HOME: data }, windowsHide: true, stdio: 'ignore' }); return once(manager, 'exit'); };
  const wait = async predicate => { for (let i = 0; i < 100; i++) { if (await predicate()) return; await delay(100); } throw Error('Supervisor timeout'); };
  const action = action => fetch(`${url}/api/service`, { method: 'POST', body: JSON.stringify({ action }) });
  try {
    let exited = start(); await wait(async () => (await health(url))?.version === '0.5.0');
    await wait(() => fs.existsSync(path.join(data, '.cache/manager.json')));
    const first = await health(url);
    writeJson(path.join(data, '.cache/package-update-request.json'), { schema: 1, runtimeRoot: broken, version: '0.5.1', commit: 'a'.repeat(40), previousInstance: first.instance });
    await action('update');
    await wait(async () => { const state = await health(url); return state && state.instance !== first.instance && state.version === '0.5.0'; });
    await wait(() => json(path.join(data, '.cache/manager.json')).instance !== first.instance);
    expect(json(path.join(data, '.cache/service-update.json')).status).toBe('failed');
    expect(fs.existsSync(path.join(data, 'active.json'))).toBe(false);
    const current = await health(url);
    writeJson(path.join(data, '.cache/package-update-request.json'), { schema: 1, runtimeRoot: next, version: '0.5.2', commit: 'a'.repeat(40), previousInstance: current.instance });
    await action('update'); await wait(async () => (await health(url))?.version === '0.5.2');
    await wait(() => fs.existsSync(path.join(data, 'active.json')));
    expect(json(path.join(data, 'active.json')).root).toBe(next);
    await action('stop'); await exited;
    exited = start(); await wait(async () => (await health(url))?.version === '0.5.2');
    await action('stop'); await exited;
    expect(fs.existsSync(path.join(data, '.cache/manager.lock'))).toBe(false);
  } catch (error) {
    for (const log of ['launcher.log', 'server.log']) { const file = path.join(data, 'logs', log); if (fs.existsSync(file)) console.error(fs.readFileSync(file, 'utf8')); }
    throw error;
  } finally {
    if (manager?.exitCode === null) { await action('stop').catch(() => {}); await delay(300); manager.kill(); }
    fs.rmSync(data, { recursive: true, force: true });
  }
}, 30_000);
