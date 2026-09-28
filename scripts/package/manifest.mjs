import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
const root = path.resolve(process.argv[2] || 'release');
const platforms = ['win32-x64', 'darwin-x64', 'darwin-arm64', 'linux-x64', 'linux-arm64'];
let manifest;
for (const platform of platforms) {
  const current = JSON.parse(fs.readFileSync(path.join(root, `manifest-${platform}.json`), 'utf8'));
  if (!manifest) manifest = { ...current, platforms: {} };
  if (current.version !== manifest.version || current.commit !== manifest.commit || current.schema !== 1) throw Error('Build identity mismatch');
  const asset = current.platforms[platform];
  if (current.name !== 'codex-monitor' || !/^\d+\.\d+\.\d+$/.test(current.version) || !/^[a-f0-9]{40}$/.test(current.commit)
    || asset?.name !== `codex-monitor-${current.version}-${platform}.tar.gz`) throw Error('Invalid manifest');
  const file = path.join(root, asset.name);
  if (asset.size !== fs.statSync(file).size || asset.sha256 !== createHash('sha256').update(fs.readFileSync(file)).digest('hex')) throw Error('Artifact checksum mismatch');
  manifest.platforms[platform] = asset;
}
fs.writeFileSync(path.join(root, 'package-manifest.json'), JSON.stringify(manifest, null, 2));
const downloadable = fs.readdirSync(root).filter(name => /\.(exe|pkg|deb|tar\.gz)$/.test(name) || name === 'package-manifest.json');
fs.writeFileSync(path.join(root, 'SHA256SUMS.txt'), downloadable.sort().map(name => `${createHash('sha256').update(fs.readFileSync(path.join(root, name))).digest('hex')}  ${name}`).join('\n') + '\n');
