import { createHash } from 'node:crypto';
import { readFile, readdir, mkdir, writeFile, rename } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type { OfficialTaskUsage, OfficialUsageData, OfficialUsageGroup } from '../../shared/monitor';
import { asRecord, asString } from './utils';

const TTL = 5 * 60_000;
const ENDPOINT = 'https://chatgpt.com/backend-api/wham/usage/thread_usage/query_v2';
type Identity = { key: string; token: string; accountId: string; email: string | null };
type ThreadQuery = { thread_id: string; created_at: string | null; descendant_thread_ids: string[] };
type Options = {
  home?: string; cacheDir?: string; now?: () => number;
  identity?: () => Promise<Identity | null>;
  thread?: (id: string) => Promise<ThreadQuery | null>;
  fetch?: typeof fetch;
};

function jwtClaims(token: unknown) {
  try { return asRecord(JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString())); }
  catch { return null; }
}

async function readIdentity(home: string): Promise<Identity | null> {
  try {
    const auth = JSON.parse(await readFile(path.join(home, 'auth.json'), 'utf8'));
    if (auth.auth_mode !== 'chatgpt') return null;
    const token = asString(auth.tokens?.access_token);
    const accountId = asString(auth.tokens?.account_id);
    if (!token || !accountId) return null;
    const claims = jwtClaims(auth.tokens.id_token) ?? jwtClaims(token);
    const subject = asString(claims?.sub);
    if (!subject) return null;
    return { token, accountId, email: asString(claims?.email),
      key: createHash('sha256').update(`${accountId}:${subject}`).digest('hex') };
  } catch { return null; }
}

/** Read only the small thread index, never session transcripts. */
export async function readOfficialThread(home: string, id: string): Promise<ThreadQuery | null> {
  let database: import('node:sqlite').DatabaseSync | undefined;
  try {
    const filename = (await readdir(home)).filter(name => /^state_\d+\.sqlite$/.test(name))
      .sort((a, b) => Number(b.match(/\d+/)?.[0]) - Number(a.match(/\d+/)?.[0]))[0];
    if (!filename) return null;
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
    database = new DatabaseSync(path.join(home, filename), { readOnly: true });
    const root = database.prepare('SELECT created_at FROM threads WHERE id = ?').get(id);
    if (!root) return null;
    const rows = database.prepare(`WITH RECURSIVE descendants(id) AS (
      SELECT id FROM threads WHERE id = ?
      UNION SELECT t.id FROM threads t JOIN descendants d ON
        CASE WHEN json_valid(t.source) THEN coalesce(
          json_extract(t.source, '$.subagent.thread_spawn.parent_thread_id'),
          json_extract(t.source, '$.subAgent.threadSpawn.parentThreadId')) END = d.id
      LIMIT 1001
    ) SELECT id FROM descendants WHERE id <> ?`).all(id, id);
    if (rows.length >= 1000) return null;
    const created = typeof root.created_at === 'number' ? new Date(root.created_at * 1000) : null;
    return { thread_id: id, created_at: created && Number.isFinite(created.getTime()) ? created.toISOString() : null,
      descendant_thread_ids: rows.map(row => String(row.id)) };
  } catch { return null; } finally { database?.close(); }
}

function percent(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

export function parseOfficialUsage(payload: unknown, id: string, fetchedAt: string): OfficialUsageData {
  const data = asRecord(payload);
  const thread = Array.isArray(data?.threads) ? data.threads.map(asRecord).find(row => row?.thread_id === id) : null;
  if (!thread || thread.data_status !== 'available') throw new Error('Official usage unavailable');
  const groups: OfficialUsageGroup[] = (Array.isArray(thread.groups) ? thread.groups : []).flatMap(value => {
    const group = asRecord(value);
    return group ? [{ model: asString(group.model), effort: asString(group.reasoning_effort), speed: asString(group.speed),
      weeklyPercent: percent(group.weekly_limit_percent) }] : [];
  });
  const credits = thread.balance_usage_credits;
  return { weeklyPercent: percent(thread.weekly_limit_percent),
    credits: (typeof credits === 'string' || typeof credits === 'number') && Number.isFinite(Number(credits)) && Number(credits) >= 0 ? Number(credits) : null,
    dataAsOf: typeof data?.data_as_of === 'string' && Number.isFinite(Date.parse(data.data_as_of)) ? data.data_as_of : null,
    fetchedAt, groups };
}

/** On-demand, account-isolated cache. Ordinary dashboard refreshes never call this provider. */
export class OfficialUsageReader {
  private readonly home: string;
  private readonly cacheDir: string;
  private readonly now: () => number;
  private readonly identity: () => Promise<Identity | null>;
  private readonly thread: (id: string) => Promise<ThreadQuery | null>;
  private readonly transport: typeof fetch;
  private readonly cache = new Map<string, OfficialUsageData>();
  private readonly attempts = new Map<string, number>();
  private readonly pending = new Map<string, Promise<void>>();
  private requests: number[] = [];
  private blockedUntil = 0;

  constructor(options: Options = {}) {
    this.home = options.home ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
    this.cacheDir = options.cacheDir ?? path.resolve('.cache/official-usage');
    this.now = options.now ?? Date.now;
    this.identity = options.identity ?? (() => readIdentity(this.home));
    this.thread = options.thread ?? (id => readOfficialThread(this.home, id));
    this.transport = options.fetch ?? fetch;
  }

  async read(id: string): Promise<OfficialTaskUsage> {
    const empty: OfficialTaskUsage = { data: null, account: null, stale: false, refreshing: false };
    if (!/^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i.test(id)) return empty;
    const identity = await this.identity();
    if (!identity) return empty;
    const key = `${identity.key}-${id}`;
    if (!this.cache.has(key)) {
      try {
        const stored = JSON.parse(await readFile(path.join(this.cacheDir, `${key}.json`), 'utf8'));
        if (stored.version === 1 && stored.key === key && Number.isFinite(Date.parse(stored.data?.fetchedAt))) {
          // Persist only the sanitized shape; validate again before returning it to a client.
          const d = stored.data;
          this.cache.set(key, parseOfficialUsage({ data_as_of: d.dataAsOf, threads: [{ thread_id: id, data_status: 'available',
            weekly_limit_percent: d.weeklyPercent, balance_usage_credits: d.credits,
            groups: Array.isArray(d.groups) ? d.groups.map((g: OfficialUsageGroup) => ({ model: g.model, reasoning_effort: g.effort, speed: g.speed, weekly_limit_percent: g.weeklyPercent })) : [] }] }, id, d.fetchedAt));
        }
      } catch { /* Missing or damaged cache is not usage zero. */ }
    }
    const previous = this.cache.get(key);
    const stale = !previous || this.now() - Date.parse(previous.fetchedAt) >= TTL;
    this.requests = this.requests.filter(time => this.now() - time < 60_000);
    if (stale && !this.pending.has(key) && this.pending.size < 2 && this.requests.length < 10 && this.now() >= this.blockedUntil &&
      (!this.attempts.has(key) || this.now() - this.attempts.get(key)! >= TTL)) {
      this.attempts.set(key, this.now());
      this.requests.push(this.now());
      const refresh = this.refresh(id, key, identity).finally(() => this.pending.delete(key));
      this.pending.set(key, refresh);
    }
    // First load waits once; subsequent reads immediately serve the last good value.
    if (!previous) await this.pending.get(key);
    if ((await this.identity())?.key !== identity.key) return empty;
    const data = this.cache.get(key) ?? null;
    const result = { data, account: identity.email, stale: Boolean(data && this.now() - Date.parse(data.fetchedAt) >= TTL), refreshing: this.pending.has(key) };
    // Bound memory independently of the number of browser clients.
    if (this.cache.size > 256) this.cache.delete(this.cache.keys().next().value!);
    if (this.attempts.size > 512) this.attempts.delete(this.attempts.keys().next().value!);
    return result;
  }

  private async refresh(id: string, key: string, identity: Identity) {
    try {
      const thread = await this.thread(id);
      if (!thread) return;
      const response = await this.transport(ENDPOINT, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
        headers: { Authorization: `Bearer ${identity.token}`, 'ChatGPT-Account-Id': identity.accountId,
          'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ threads: [thread] }) });
      if (!response.ok) {
        this.blockedUntil = this.now() + TTL;
        return;
      }
      const data = parseOfficialUsage(await response.json(), id, new Date(this.now()).toISOString());
      if ((await this.identity())?.key !== identity.key) return;
      this.cache.set(key, data);
      await mkdir(this.cacheDir, { recursive: true });
      const filename = path.join(this.cacheDir, `${key}.json`);
      await writeFile(`${filename}.tmp`, JSON.stringify({ version: 1, key, data }), 'utf8');
      await rename(`${filename}.tmp`, filename);
    } catch { this.blockedUntil = this.now() + TTL; /* Never expose provider errors or credentials; keep the previous value. */ }
  }
}
