import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as tar from 'tar';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const platform = process.platform, arch = process.arch;
if (!['win32-x64', 'darwin-x64', 'darwin-arm64', 'linux-x64', 'linux-arm64'].includes(`${platform}-${arch}`)) throw Error('Unsupported native build platform');
const key = `${platform}-${arch}`;
const output = path.join(root, 'release');
const work = path.join(root, '.cache/package-build', `${key}-${Date.now()}`);
const stage = path.join(work, 'app');
const run = (command, args, cwd = root) => execFileSync(command, args, { cwd, stdio: 'inherit', windowsHide: true });
const npmCli = process.env.npm_execpath || path.join(path.dirname(process.execPath), platform === 'win32' ? 'node_modules/npm/bin/npm-cli.js' : '../lib/node_modules/npm/bin/npm-cli.js');
const npm = (args, cwd = root) => run(process.execPath, [npmCli, ...args], cwd);
const copy = (from, to) => fs.cpSync(from, to, { recursive: true, dereference: true, filter: source => {
  if (path.basename(source) === '.bin') return false;
  if (fs.lstatSync(source).isSymbolicLink()) {
    const relative = path.relative(fs.realpathSync(from), fs.realpathSync(source));
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw Error(`External dependency symlink: ${source}`);
  }
  return true;
} });
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value, null, 2)); };
const sha = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const dirty = !!execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: root, encoding: 'utf8' }).trim();
if (dirty && process.env.CI) throw Error('Release packages require a clean checkout');
fs.mkdirSync(stage, { recursive: true }); fs.mkdirSync(output, { recursive: true });
npm(['run', 'build']);
copy(path.join(root, 'dist'), path.join(stage, 'dist'));
copy(path.join(root, 'scripts/package/runtime'), path.join(stage, 'dist/launcher'));
for (const file of ['package.json', 'package-lock.json']) copy(path.join(root, file), path.join(stage, file));
npm(['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], stage);
// .bin contains symlinks; none are used at runtime or accepted by the updater.
const bin = path.join(stage, 'node_modules/.bin');
if (fs.existsSync(bin)) fs.rmSync(bin, { recursive: true });
fs.mkdirSync(path.join(stage, 'runtime'), { recursive: true });
copy(process.execPath, path.join(stage, 'runtime', platform === 'win32' ? 'node.exe' : 'node'));
if (platform !== 'win32') fs.chmodSync(path.join(stage, 'runtime/node'), 0o755);
const codexRoot = path.join(root, '.cache/packaging-tools/codex');
const codexPackage = path.join(codexRoot, 'node_modules/@openai', `codex-${key}`);
if (!fs.existsSync(path.join(codexPackage, 'package.json')))
  npm(['install', '--prefix', codexRoot, '--no-save', '--package-lock=false', '--ignore-scripts', '--no-audit', '--no-fund', `@openai/codex-${key}@npm:@openai/codex@0.158.0-${key}`]);
const nativeMetadata = JSON.parse(fs.readFileSync(path.join(codexPackage, 'package.json'), 'utf8'));
if (nativeMetadata.version !== `0.158.0-${key}`) throw Error('Unexpected Codex CLI dependency version');
copy(path.join(codexPackage, 'vendor'), path.join(stage, 'runtime/codex'));
function files(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw Error(`Symlink in package: ${file}`);
    return entry.isDirectory() ? files(file) : [file];
  });
}
const cliName = platform === 'win32' ? 'codex.exe' : 'codex';
const binaries = files(path.join(stage, 'runtime/codex')).filter(file => path.basename(file) === cliName);
if (binaries.length !== 1) throw Error('Unable to locate bundled Codex executable');
if (platform !== 'win32') fs.chmodSync(binaries[0], 0o755);
const codex = path.relative(stage, binaries[0]).split(path.sep).join('/');
const macInfo = `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>cn.codexmonitor.package</string><key>CFBundleName</key><string>Codex Monitor</string><key>CFBundleExecutable</key><string>CodexMonitor</string><key>CFBundleShortVersionString</key><string>${pkg.version}</string><key>CFBundleVersion</key><string>${pkg.version}</string><key>LSUIElement</key><true/><key>LSMinimumSystemVersion</key><string>14.0</string></dict></plist>`;
if (platform === 'darwin') {
  copy(path.join(root, 'scripts/package/macos/app-launcher'), path.join(stage, 'macos-launcher'));
  fs.writeFileSync(path.join(stage, 'macos-Info.plist'), macInfo);
}
write(path.join(stage, 'distribution.json'), { schema: 1, name: pkg.name, version: pkg.version, commit, platform, arch, node: process.version, codexVersion: '0.158.0', codex });
write(path.join(stage, 'deployment.json'), { version: pkg.version, commit, dirty });
// Runtime third-party notices travel with every installer and update archive.
const notices = path.join(stage, 'THIRD_PARTY_NOTICES');
fs.mkdirSync(notices);
fs.writeFileSync(path.join(notices, 'README.txt'), 'Codex Monitor is based on https://github.com/manuelsh/codex-monitor\nModified distribution: https://github.com/tabztggg/codex-monitor\nNode.js: https://nodejs.org (MIT plus bundled notices)\nCodex CLI: https://github.com/openai/codex (Apache-2.0)\nDependency license files are retained under node_modules and runtime.\n');
const nodeLicense = await fetch(`https://raw.githubusercontent.com/nodejs/node/${process.version}/LICENSE`, { signal: AbortSignal.timeout(30_000) });
if (!nodeLicense.ok) throw Error('Unable to include Node.js license');
fs.writeFileSync(path.join(notices, 'Node-LICENSE.txt'), await nodeLicense.text());
const codexLicense = await fetch('https://raw.githubusercontent.com/openai/codex/rust-v0.158.0/LICENSE', { signal: AbortSignal.timeout(30_000) });
if (!codexLicense.ok) throw Error('Unable to include Codex CLI license');
fs.writeFileSync(path.join(notices, 'Codex-LICENSE.txt'), await codexLicense.text());

if (platform === 'win32') {
  const compiler = path.join(process.env.WINDIR || 'C:/Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  run(compiler, ['/nologo', '/target:winexe', '/optimize+', '/reference:System.Windows.Forms.dll', `/out:${path.join(stage, 'CodexMonitor.exe')}`, path.join(root, 'scripts/package/windows/Launcher.cs'), path.join(root, 'scripts/StandaloneMonitorRuntime.cs')]);
} else {
  for (const file of ['codex-monitor', 'install.sh', 'uninstall.sh']) {
    copy(path.join(root, 'scripts/package/posix', file), path.join(stage, file)); fs.chmodSync(path.join(stage, file), 0o755);
  }
}
const name = `codex-monitor-${pkg.version}-${key}.tar.gz`;
files(stage); // Reject any link that escaped dependency normalization.
await tar.c({ file: path.join(output, name), gzip: true, cwd: stage, portable: true, noMtime: true }, fs.readdirSync(stage));
write(path.join(output, `manifest-${key}.json`), { schema: 1, name: pkg.name, version: pkg.version, commit, platforms: { [key]: { name, size: fs.statSync(path.join(output, name)).size, sha256: sha(path.join(output, name)) } } });

if (platform === 'win32') {
  const compiler = process.env.INNO_COMPILER || ['C:/Program Files (x86)/Inno Setup 6/ISCC.exe', 'C:/Program Files/Inno Setup 7/ISCC.exe', path.join(root, '.cache/build-tools/inno/ISCC.exe')].find(file => fs.existsSync(file));
  if (!compiler) throw Error('Inno Setup compiler required. Runtime archive was built; set INNO_COMPILER to build the setup.exe.');
  run(compiler, ['/Qp', `/DStage=${stage}`, `/DVersion=${pkg.version}`, `/DOutput=${output}`, path.join(root, 'scripts/package/windows/installer.iss')]);
} else if (platform === 'darwin') {
  const payload = path.join(work, 'payload');
  const app = path.join(payload, 'Applications/Codex Monitor.app/Contents');
  fs.mkdirSync(path.join(app, 'MacOS'), { recursive: true });
  copy(stage, path.join(app, 'Resources/app'));
  copy(path.join(root, 'scripts/package/macos/app-launcher'), path.join(app, 'MacOS/CodexMonitor'));
  fs.chmodSync(path.join(app, 'MacOS/CodexMonitor'), 0o755);
  fs.writeFileSync(path.join(app, 'Info.plist'), macInfo);
  const hooks = path.join(work, 'pkg-scripts'); fs.mkdirSync(hooks);
  copy(path.join(root, 'scripts/package/macos/preinstall'), path.join(hooks, 'preinstall')); fs.chmodSync(path.join(hooks, 'preinstall'), 0o755);
  run('pkgbuild', ['--root', payload, '--scripts', hooks, '--identifier', 'cn.codexmonitor.package', '--version', pkg.version, '--install-location', '/', path.join(output, `codex-monitor-${pkg.version}-macos-${arch}.pkg`)]);
} else {
  const payload = path.join(work, 'deb');
  copy(stage, path.join(payload, 'opt/codex-monitor'));
  fs.mkdirSync(path.join(payload, 'DEBIAN'), { recursive: true });
  fs.writeFileSync(path.join(payload, 'DEBIAN/control'), `Package: codex-monitor\nVersion: ${pkg.version}\nSection: utils\nPriority: optional\nArchitecture: ${arch === 'x64' ? 'amd64' : 'arm64'}\nMaintainer: Codex Monitor contributors\nDepends: libc6 (>= 2.28), libstdc++6, xdg-utils, util-linux\nDescription: Local Codex usage dashboard with bundled runtime\n`);
  for (const [from, to] of [['debian-stop', 'opt/codex-monitor/package-stop'], ['debian-stop', 'DEBIAN/preinst'], ['debian-prerm', 'DEBIAN/prerm']]) {
    copy(path.join(root, 'scripts/package/posix', from), path.join(payload, to)); fs.chmodSync(path.join(payload, to), 0o755);
  }
  fs.mkdirSync(path.join(payload, 'usr/share/applications'), { recursive: true });
  fs.writeFileSync(path.join(payload, 'usr/share/applications/codex-monitor.desktop'), '[Desktop Entry]\nType=Application\nName=Codex Monitor\nExec=/opt/codex-monitor/desktop-launch\nTerminal=false\nCategories=Development;Utility;\n');
  fs.writeFileSync(path.join(payload, 'opt/codex-monitor/desktop-launch'), '#!/bin/sh\nset -eu\n/opt/codex-monitor/runtime/node /opt/codex-monitor/dist/launcher/integration.mjs install /opt/codex-monitor\nexec /opt/codex-monitor/codex-monitor open\n', { mode: 0o755 });
  run('dpkg-deb', ['--root-owner-group', '--build', payload, path.join(output, `codex-monitor-${pkg.version}-linux-${arch}.deb`)]);
}
write(path.join(output, `build-${key}.json`), { stage, version: pkg.version, commit, dirty });
console.log(`Packages ready: ${output}`);
