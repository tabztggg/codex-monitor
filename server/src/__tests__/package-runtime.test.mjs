import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { chooseRuntime, dataDirectory, inside, localUrl, readConfig, validateRuntime, writeJson } from '../../../scripts/package/runtime/lib.mjs';
const roots = [];
function temporary() { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-test-')); roots.push(root); return root; }
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));
function fixture(root, version) {
  const codex = 'runtime/codex';
  for (const file of ['dist/server/index.js', 'dist/web/index.html', 'dist/launcher/main.mjs', codex, `runtime/${process.platform === 'win32' ? 'node.exe' : 'node'}`]) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), 'test');
  }
  writeJson(path.join(root, 'distribution.json'), { schema: 1, name: 'codex-monitor', version, commit: 'a'.repeat(40), platform: process.platform, arch: process.arch, codex });
}
it('puts data outside installation files and supports an isolated override', () => {
  expect(dataDirectory({ CODEX_MONITOR_DATA_HOME: '/isolated' })).toBe(path.resolve('/isolated'));
  expect(dataDirectory({}, 'linux', '/home/demo')).toBe(path.join('/home/demo', '.local/state/codex-monitor'));
  expect(dataDirectory({}, 'darwin', '/Users/demo')).toBe(path.join('/Users/demo', 'Library/Application Support/CodexMonitor'));
});
it('validates config and uses a reachable loopback URL for all-interface listeners', () => {
  const root = temporary(); expect(readConfig(root).host).toBe('127.0.0.1');
  expect(localUrl({ host: '0.0.0.0', port: 4201 })).toBe('http://127.0.0.1:4201');
  expect(localUrl({ host: '::1', port: 4201 })).toBe('http://[::1]:4201');
  writeJson(path.join(root, 'config.json'), { port: 80 }); expect(() => readConfig(root)).toThrow('Invalid config');
});
it('selects verified newer runtime but never trusts a pointer outside the data directory', () => {
  const data = temporary(), base = path.join(data, 'base'), update = path.join(data, 'runtimes/update'), outside = temporary();
  fixture(base, '0.5.0'); fixture(update, '0.6.0'); fixture(outside, '0.9.0');
  writeJson(path.join(data, 'active.json'), { root: update, version: '0.6.0', commit: 'a'.repeat(40) });
  expect(chooseRuntime(base, data)).toBe(update);
  fixture(base, '0.7.0'); expect(chooseRuntime(base, data)).toBe(base);
  writeJson(path.join(data, 'active.json'), { root: outside, version: '0.9.0', commit: 'a'.repeat(40) });
  expect(chooseRuntime(base, data)).toBe(base);
  expect(inside(data, `${data}-other`)).toBe(false);
});
it('rejects incomplete and wrong architecture updates', () => {
  const root = temporary(); fixture(root, '0.5.0');
  fs.unlinkSync(path.join(root, 'dist/web/index.html')); expect(() => validateRuntime(root)).toThrow();
  fixture(root, '0.5.0'); const file = path.join(root, 'distribution.json');
  writeJson(file, { ...JSON.parse(fs.readFileSync(file, 'utf8')), arch: 'other' }); expect(() => validateRuntime(root)).toThrow('identity');
});
