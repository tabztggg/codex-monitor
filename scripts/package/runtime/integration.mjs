import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
const [action, root] = process.argv.slice(2);
if (!['install', 'uninstall'].includes(action) || !root || !path.isAbsolute(root)) throw Error('Expected install/uninstall and an absolute runtime directory');
const home = os.homedir();
const xml = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const quote = value => `"${value.replace(/(["\\`$])/g, '\\$1')}"`;
function owned(file, text) {
  const marker = `CodexMonitorRoot=${Buffer.from(root).toString('base64')}`;
  if (fs.existsSync(file) && !fs.readFileSync(file, 'utf8').includes(marker)) throw Error(`Another installation owns ${file}`);
  if (action === 'install') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${text}\n${file.endsWith('.plist') ? `<!-- ${marker} -->` : `# ${marker}`}\n`, { mode: 0o644 });
  }
  else if (fs.existsSync(file)) fs.unlinkSync(file);
}
if (process.platform === 'darwin') {
  owned(path.join(home, 'Library/LaunchAgents/cn.codexmonitor.package.plist'), `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>cn.codexmonitor.package</string><key>ProgramArguments</key><array><string>${xml(path.join(root, 'runtime/node'))}</string><string>${xml(path.join(root, 'dist/launcher/main.mjs'))}</string><string>start</string></array><key>RunAtLoad</key><true/></dict></plist>`);
  // No KeepAlive: the webpage's Stop command must keep the service stopped.
} else if (process.platform === 'linux') {
  const command = quote(path.join(root, 'codex-monitor')).replace(/%/g, '%%');
  const desktop = `[Desktop Entry]\nType=Application\nName=Codex Monitor\nComment=Local Codex usage dashboard\nExec=${command} open\nTerminal=false\nCategories=Development;Utility;\n`;
  owned(path.join(process.env.XDG_DATA_HOME || path.join(home, '.local/share'), 'applications/codex-monitor.desktop'), desktop);
  owned(path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'autostart/codex-monitor.desktop'), desktop.replace(`${command} open`, `${command} start`));
  let desktopDirectory = path.join(home, 'Desktop');
  try { desktopDirectory = execFileSync('xdg-user-dir', ['DESKTOP'], { encoding: 'utf8' }).trim(); } catch { }
  if (desktopDirectory !== home && fs.existsSync(desktopDirectory)) {
    const shortcut = path.join(desktopDirectory, 'codex-monitor.desktop');
    owned(shortcut, desktop);
    if (action === 'install') fs.chmodSync(shortcut, 0o755);
  }
}
