import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { CodexUsageSnapshot } from '../../shared/monitor';
import { CodexAppServerClient } from './codex-client';
import { emptyCodexUsage, readAccountUsage, staleCodexUsage } from './usage';

export interface CurrentAccountSource {
  shutdown?(): void;
  hasChanged(): Promise<boolean>;
  read(previous: CodexUsageSnapshot): Promise<CodexUsageSnapshot>;
}
type UsageClient = { request(method: string, params?: unknown): Promise<unknown>; shutdown(): void };

/** Local hints only. Never publish/save credentials, and do not trust file mtime:
 * account switchers can restore a backup with its original modification time. */
export async function readAuthIdentityFingerprint(home: string): Promise<string | null> {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(path.join(home, 'auth.json'), 'r');
    const buffer = Buffer.alloc(128 * 1024 + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = await file.read(buffer, length, buffer.length - length, null);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (length === buffer.length) return null;
    const auth = JSON.parse(buffer.subarray(0, length).toString('utf8').replace(/^\uFEFF/, ''));
    const token = auth.tokens?.id_token;
    let claims: Record<string, unknown> | null = null;
    if (typeof token === 'string') {
      try { claims = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')); }
      catch { return null; }
    }
    const identity = [auth.auth_mode ?? null, auth.tokens?.account_id ?? null, claims?.sub ?? null, claims?.email ?? null,
      // API key identity also remains only a one-way, in-memory fingerprint.
      typeof auth.OPENAI_API_KEY === 'string' ? auth.OPENAI_API_KEY : null];
    if (!identity.some(Boolean)) return null;
    return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : null; }
  finally { await file?.close(); }
}

/** A long-lived app-server can keep its old login after another app switches
 * auth.json/keychain. Each low-frequency quota read gets a fresh private client. */
export class FreshCurrentAccountSource implements CurrentAccountSource {
  private identity: string | undefined;
  private stopped = false;
  private readonly clients = new Set<UsageClient>();
  constructor(
    private readonly createClient: () => UsageClient = () => new CodexAppServerClient(),
    private readonly fingerprint = () => readAuthIdentityFingerprint(process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex')),
  ) {}
  async hasChanged(): Promise<boolean> {
    const next = await this.fingerprint();
    if (next === null) return false; // A partial write/temporary read failure is not logout.
    const changed = this.identity !== undefined && next !== this.identity;
    this.identity = next;
    return changed;
  }
  async read(previous: CodexUsageSnapshot): Promise<CodexUsageSnapshot> {
    if (this.stopped) return previous;
    const before = await this.fingerprint();
    if (this.stopped) return previous;
    const client = this.createClient();
    this.clients.add(client);
    try {
      const next = await readAccountUsage(client, previous);
      const after = await this.fingerprint();
      if (before !== null) this.identity = before;
      // Paired RPC identity reads alone cannot detect an external switch while
      // this private client's in-memory credentials are unchanged.
      if (before !== after) return previous.limits.length
        ? staleCodexUsage(previous, 'Account changed while reading usage. Waiting for the next refresh.')
        : emptyCodexUsage('unavailable', 'Account changed while reading usage. Waiting for the next refresh.');
      return next;
    } finally { this.clients.delete(client); client.shutdown(); }
  }
  shutdown(): void {
    this.stopped = true;
    for (const client of this.clients) client.shutdown();
    this.clients.clear();
  }
}
