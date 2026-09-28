import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { ServiceUpdater } from './service-update';
import { RepositoryVersionChecker } from './service-version';
import { PackageUpdater } from './package-release';

// Origin validation is applied by index.ts before these routes.
export function installServiceControl(app: Express, enabled: boolean, exit: (code: number) => void,
  createUpdater?: (instance: string, onReady: () => void) => ServiceUpdater,
  createVersionChecker?: (deployment: ServiceUpdater['deployment']) => Pick<RepositoryVersionChecker, 'check'>) {
  const suppliedInstance = process.env.CODEX_MONITOR_INSTANCE;
  const instance = process.env.CODEX_MONITOR_DISTRIBUTION === 'package' && suppliedInstance && /^[a-f0-9-]{36}$/.test(suppliedInstance) ? suppliedInstance : randomUUID();
  const onUpdateReady = () => setTimeout(() => exit(43), 300);
  const packaged = process.env.CODEX_MONITOR_DISTRIBUTION === 'package';
  const updater = createUpdater ? createUpdater(instance, onUpdateReady) : packaged && enabled ? new PackageUpdater({
    appRoot: process.env.CODEX_MONITOR_APP_ROOT ?? process.cwd(), dataRoot: process.cwd(), instance, onReady: onUpdateReady
  }) : new ServiceUpdater({
    root: process.cwd(), instance, onReady: onUpdateReady,
    supported: enabled && process.platform === 'win32' && process.env.CODEX_MONITOR_UPDATE_ENABLED === '1'
      && existsSync(path.join(process.cwd(), 'Update-StandaloneMonitor.ps1'))
  });
  const versions = createVersionChecker ? createVersionChecker(updater.deployment)
    : new RepositoryVersionChecker({ root: process.cwd(), deployment: updater.deployment, channel: packaged ? 'release' : 'source' });
  let pending = false;
  app.get('/api/service', (_request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.json({ enabled, instance, ...updater.deployment, update: updater.getStatus() });
  });
  app.get('/api/service/health', (_request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.json({ ok: true, instance, ...updater.deployment });
  });
  app.get('/api/service/versions', async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.json(await versions.check(request.query.refresh === '1'));
  });
  app.post('/api/service', (request, response) => {
    if (!enabled) { response.status(403).json({ error: 'Managed launcher required' }); return; }
    if (!request.is('application/json') || !['restart', 'stop', 'update'].includes(request.body?.action)) {
      response.status(400).json({ error: 'Invalid action' }); return;
    }
    if (pending || updater.isBusy()) { response.status(409).json({ error: 'Service action already pending' }); return; }
    if (request.body.action === 'update') {
      if (!updater.supported) { response.status(503).json({ error: 'Windows standalone installation required for updates.' }); return; }
      try { response.status(202).json({ accepted: true, update: updater.start() }); }
      catch { response.status(500).json({ error: 'Could not start the update. Another installation may be running, or the installation directory is not writable.' }); }
      return;
    }
    pending = true;
    const code = request.body.action === 'restart' ? 42 : 0;
    response.once('finish', () => setTimeout(() => exit(code), 300));
    response.status(202).json({ accepted: true });
  });
}
