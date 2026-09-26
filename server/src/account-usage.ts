import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import type { AccountUsageEntry, CodexUsageSnapshot } from '../../shared/monitor';
import { codexUsageFromRateLimitsRead } from './usage';

export function accountUsageId(usage: CodexUsageSnapshot) {
  const account = usage.account;
  if (!account?.email || account.type !== 'chatgpt') return null;
  return createHash('sha256').update(account.type + ':' + account.email.trim().toLowerCase()).digest('hex');
}

// Only display fields, never auth files or tokens. One last confirmed snapshot per account.
export class AccountUsageHistory {
  private entries = new Map<string, CodexUsageSnapshot>();
  constructor(private filename: string) {
    try {
      const saved = JSON.parse(readFileSync(filename, 'utf8'));
      if (saved.version === 1 && Array.isArray(saved.accounts)) {
        for (const usage of saved.accounts.slice(0, 100)) this.record(usage, false);
      }
    } catch { /* A missing/damaged history does not block live usage. */ }
  }
  record(usage: CodexUsageSnapshot, persist = true) {
    if (!usage || usage.status !== 'available' || usage.stale || !usage.updatedAt || !Number.isFinite(Date.parse(usage.updatedAt))) return;
    const id = accountUsageId(usage);
    if (!id || !Array.isArray(usage.limits)) return;
    const sanitized = codexUsageFromRateLimitsRead({rateLimitsByLimitId: Object.fromEntries(usage.limits.map(limit => [limit.id, {
      limitName: limit.name, planType: limit.planType, primary: limit.primary, secondary: limit.secondary,
      credits: limit.credits, rateLimitReachedType: limit.rateLimitReachedType
    }]))}, usage.updatedAt);
    if (sanitized.status !== 'available') return;
    sanitized.account = { type: 'chatgpt', email: usage.account!.email!.trim(), planType: typeof usage.account!.planType === 'string' ? usage.account!.planType : null };
    const old = this.entries.get(id);
    if (old && Date.parse(old.updatedAt!) > Date.parse(sanitized.updatedAt!)) return;
    if (JSON.stringify(old) === JSON.stringify(sanitized)) return;
    this.entries.delete(id); this.entries.set(id, sanitized);
    while (this.entries.size > 100) this.entries.delete(this.entries.keys().next().value!);
    if (persist) {
      try {
        mkdirSync(path.dirname(this.filename), {recursive:true});
        writeFileSync(this.filename + '.tmp', JSON.stringify({version:1, accounts:[...this.entries.values()]}));
        renameSync(this.filename + '.tmp', this.filename);
      } catch { /* Keep in-memory history if disk persistence is unavailable. */ }
    }
  }
  list(current: CodexUsageSnapshot): AccountUsageEntry[] {
    const currentId = accountUsageId(current);
    return [...this.entries].map(([id, usage]) => ({id, current:id === currentId, usage:structuredClone(usage)}))
      .sort((a,b) => Number(b.current)-Number(a.current) || Date.parse(b.usage.updatedAt!)-Date.parse(a.usage.updatedAt!));
  }
}
