import { randomUUID } from 'node:crypto';
import type { Express } from 'express';

// Origin validation is applied by index.ts before these routes.
export function installServiceControl(app: Express, enabled: boolean, exit: (code: number) => void) {
  const instance = randomUUID();
  let pending = false;
  app.get('/api/service', (_request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.json({ enabled, instance });
  });
  app.post('/api/service', (request, response) => {
    if (!enabled) { response.status(403).json({ error: 'Managed launcher required' }); return; }
    if (!request.is('application/json') || !['restart', 'stop'].includes(request.body?.action)) {
      response.status(400).json({ error: 'Invalid action' }); return;
    }
    if (pending) { response.status(409).json({ error: 'Service action already pending' }); return; }
    pending = true;
    const code = request.body.action === 'restart' ? 42 : 0;
    response.once('finish', () => setTimeout(() => exit(code), 300));
    response.status(202).json({ accepted: true });
  });
}
