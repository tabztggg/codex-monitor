import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';

const fixture = vi.hoisted(() => ({
  server: null as Server | null,
  webRoot: '',
  start: vi.fn(async () => {}),
  snapshot: { source: 'isolated test fixture' }
}));

// Exercise index.ts itself without starting Codex or touching account/session data.
vi.mock('../service', async () => {
  const { EventEmitter } = await import('node:events');
  return { MonitorService: class extends EventEmitter {
    start = fixture.start;
    getSnapshot() { return fixture.snapshot; }
  } };
});
vi.mock('node:http', async importOriginal => {
  const actual = await importOriginal<typeof import('node:http')>();
  return { ...actual, createServer: (...args: Parameters<typeof actual.createServer>) => {
    const server = actual.createServer(...args);
    fixture.server = server;
    const listen = server.listen.bind(server);
    vi.spyOn(server, 'listen').mockImplementation((...listenArgs: unknown[]) => {
      const callback = listenArgs.find(arg => typeof arg === 'function') as (() => void) | undefined;
      return listen(0, '127.0.0.1', callback);
    });
    return server;
  } };
});
vi.mock('node:path', async importOriginal => {
  const actual = await importOriginal<typeof import('node:path')>();
  const resolve = (...parts: string[]) => parts.at(-1) === 'dist/web'
    ? fixture.webRoot : actual.resolve(...parts);
  return { ...actual, default: { ...actual, resolve }, resolve };
});

const httpOrigin = 'http://dashboard.example.test';
const httpsOrigin = 'https://dashboard.example.test';
const lanOrigin = 'http://192.0.2.10:4201';
const sockets = new Set<WebSocket>();
let port = 0;

beforeAll(() => {
  fixture.webRoot = mkdtempSync(path.join(tmpdir(), 'codex-monitor-origin-test-'));
  writeFileSync(path.join(fixture.webRoot, 'index.html'), '<!doctype html><title>Monitor test fixture</title>');
  writeFileSync(path.join(fixture.webRoot, 'app.js'), 'globalThis.monitorFixture = true;');
});
afterAll(() => {
  const target = path.resolve(fixture.webRoot);
  if (path.dirname(target) !== path.resolve(tmpdir()) || !path.basename(target).startsWith('codex-monitor-origin-test-')) {
    throw new Error('Refusing to remove an unexpected fixture directory');
  }
  rmSync(target, { recursive: true, force: true });
});
afterEach(async () => {
  sockets.forEach(socket => socket.terminate());
  sockets.clear();
  const server = fixture.server;
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  fixture.server = null;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function startServer(allowedOrigins?: string) {
  vi.resetModules();
  vi.stubEnv('CODEX_MONITOR_HOST', '192.0.2.10');
  vi.stubEnv('PORT', '4201');
  vi.stubEnv('CODEX_MONITOR_ALLOWED_ORIGINS', allowedOrigins);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  await import('../index');
  const server = fixture.server!;
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing isolated HTTP listener');
  port = address.port;
}

function http(pathname: string, origin?: string, method = 'GET', headers: Record<string, string> = {}) {
  return new Promise<{ status: number; headers: import('node:http').IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path: pathname, method, agent: false,
      headers: { ...(origin ? { Origin: origin } : {}), ...headers } }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode!, headers: response.headers, body }));
      response.on('error', reject);
    });
    req.setTimeout(3_000, () => req.destroy(new Error('Isolated HTTP test timed out')));
    req.on('error', reject);
    req.end();
  });
}

function websocket(origin?: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; payload?: unknown }>((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin, headers });
    sockets.add(socket);
    let rejected = false;
    const timeout = setTimeout(() => { socket.terminate(); reject(new Error('Isolated WebSocket test timed out')); }, 3_000);
    socket.once('unexpected-response', (_request, response) => {
      rejected = true;
      clearTimeout(timeout);
      response.destroy();
      socket.terminate();
      resolve({ status: response.statusCode! });
    });
    socket.once('message', data => {
      clearTimeout(timeout);
      const payload = JSON.parse(data.toString());
      socket.close();
      resolve({ status: 101, payload });
    });
    socket.on('error', error => {
      clearTimeout(timeout);
      if (!rejected) reject(error);
    });
  });
}

describe('index HTTP/CORS/static/WebSocket origin policy', () => {
  it('permits both explicitly configured tunnel schemes for the API and static resources', async () => {
    await startServer(`${httpOrigin}, ${httpsOrigin}`);
    for (const origin of [httpOrigin, httpsOrigin]) {
      const api = await http('/api/snapshot', origin);
      expect(api.status).toBe(200);
      expect(JSON.parse(api.body)).toEqual(fixture.snapshot);
      expect(api.headers['access-control-allow-origin']).toBe(origin);
      const script = await http('/app.js', origin);
      expect(script.status).toBe(200);
      expect(script.body).toContain('monitorFixture');
      expect(script.headers['access-control-allow-origin']).toBe(origin);
    }
    expect(fixture.start).toHaveBeenCalled();
  });

  it('uses the same explicit allowlist for CORS preflight requests', async () => {
    await startServer(httpsOrigin);
    const headers = { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' };
    const allowed = await http('/api/automation/cancel-shutdown', httpsOrigin, 'OPTIONS', headers);
    expect(allowed.status).toBe(204);
    expect(allowed.headers['access-control-allow-origin']).toBe(httpsOrigin);
    expect(allowed.headers['access-control-allow-methods']).toContain('POST');
    const denied = await http('/api/automation/cancel-shutdown', httpOrigin, 'OPTIONS', headers);
    expect(denied.status).toBe(403);
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('denies unrelated origins before both API and static routes, regardless of forged forwarding headers', async () => {
    await startServer(httpsOrigin);
    for (const origin of ['https://other.example.test', 'https://dashboard.example.test.attacker.test']) {
      const headers = { Host: 'other.example.test', 'X-Forwarded-Host': 'other.example.test',
        'X-Forwarded-Proto': 'https', Forwarded: 'host=other.example.test;proto=https' };
      for (const route of ['/api/snapshot', '/app.js', '/']) {
        const denied = await http(route, origin, 'GET', headers);
        expect(denied.status).toBe(403);
        expect(JSON.parse(denied.body)).toEqual({ error: 'Forbidden origin' });
        expect(denied.headers['access-control-allow-origin']).toBeUndefined();
      }
    }
  });

  it('retains missing, loopback and configured LAN origins without allowing an unconfigured tunnel', async () => {
    await startServer();
    for (const origin of [undefined, 'http://localhost:5173', 'http://127.0.0.1:4201', 'http://[::1]:5173', lanOrigin]) {
      const response = await http('/', origin);
      expect(response.status).toBe(200);
      expect(response.body).toContain('Monitor test fixture');
    }
    const denied = await http('/api/snapshot', httpsOrigin, 'GET', { Host: 'dashboard.example.test',
      'X-Forwarded-Host': 'dashboard.example.test', 'X-Forwarded-Proto': 'https' });
    expect(denied.status).toBe(403);
    expect((await websocket(httpsOrigin)).status).toBe(401);
  });

  it('permits configured HTTP/HTTPS and existing local origins in the actual WebSocket handshake', async () => {
    await startServer(`${httpOrigin},${httpsOrigin}`);
    for (const origin of [httpOrigin, httpsOrigin, undefined, 'http://localhost:5173', lanOrigin]) {
      const result = await websocket(origin);
      expect(result).toEqual({ status: 101, payload: { type: 'snapshot', payload: fixture.snapshot } });
    }
  });

  it('rejects WebSockets with absent allowlist entries or unrelated/forged origins', async () => {
    await startServer(httpsOrigin);
    for (const origin of [httpOrigin, 'https://other.example.test', 'null']) {
      const result = await websocket(origin, { Host: 'other.example.test', 'X-Forwarded-Host': 'other.example.test',
        'X-Forwarded-Proto': 'https', Forwarded: 'host=other.example.test;proto=https' });
      // ws preserves its existing 401 response when verifyClient returns false.
      expect(result.status).toBe(401);
    }
  });
});
