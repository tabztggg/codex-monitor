import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export type QuotaSample = { id: string; cost: number; tokens: number; unpriced?: number };
type Ledger = {
  version: 1;
  key: string;
  used: number;
  observedAt: string;
  baseline: Record<string, { cost: number; tokens: number; unpriced?: number }>;
  attributed: Record<string, number>;
  unattributed: number;
};

// Keep weights until the next positive quota change: quota readings are rounded.
export class QuotaAttribution {
  private state: Ledger | null = null;
  constructor(private readonly file?: string) {
    if (file && existsSync(file)) {
      const state = JSON.parse(readFileSync(file, 'utf8')) as Ledger;
      if (state.version !== 1 || typeof state.key !== 'string' ||
          !Number.isFinite(state.used) || !Number.isFinite(state.unattributed) ||
          !state.baseline || !state.attributed || typeof state.observedAt !== 'string' ||
          !Object.values(state.baseline).every(v => Number.isFinite(v.cost) && Number.isFinite(v.tokens)) ||
          !Object.values(state.attributed).every(v => Number.isFinite(v) && v >= 0)) {
        throw new Error('Invalid quota attribution ledger');
      }
      this.state = state;
    }
  }

  observe(key: string, used: number, samples: QuotaSample[], nowMs: number): void {
    if (!Number.isFinite(used) || used < 0 || used > 100) return;
    const baseline = Object.fromEntries(samples.map(s => [s.id, { cost: s.cost, tokens: s.tokens, unpriced: s.unpriced ?? 0 }]));
    const previous = this.state;
    let next: Ledger;
    if (!previous || previous.key !== key || used < previous.used) {
      // Existing account consumption predates observation; never assign it retroactively.
      next = { version: 1, key, used, baseline, observedAt: new Date(nowMs).toISOString(), attributed: {}, unattributed: used };
    } else {
      const delta = used - previous.used;
      if (delta === 0) return;
      const weights = samples.map(s => {
        const old = previous.baseline[s.id] ?? { cost: 0, tokens: 0 };
        return { id: s.id, cost: Math.max(0, s.cost - old.cost), tokens: Math.max(0, s.tokens - old.tokens), unpriced: Math.max(0, (s.unpriced ?? 0) - (old.unpriced ?? 0)) };
      });
      const total = weights.reduce((sum, s) => sum + s.cost, 0);
      const complete = weights.every(s => s.unpriced === 0 && (s.tokens === 0 || s.cost > 0));
      const retainedBaseline = { ...previous.baseline };
      for (const [id, sample] of Object.entries(baseline)) {
        const old = retainedBaseline[id];
        retainedBaseline[id] = {
          cost: Math.max(sample.cost, old?.cost ?? 0),
          tokens: Math.max(sample.tokens, old?.tokens ?? 0),
          unpriced: Math.max(sample.unpriced ?? 0, old?.unpriced ?? 0)
        };
      }
      next = { ...previous, used, baseline: retainedBaseline, attributed: { ...previous.attributed } };
      if (total > 0 && complete) {
        for (const weight of weights) {
          next.attributed[weight.id] = (next.attributed[weight.id] ?? 0) + delta * weight.cost / total;
        }
      } else next.unattributed += delta;
    }
    if (this.file) {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const temporary = `${this.file}.tmp`;
      writeFileSync(temporary, JSON.stringify(next), { mode: 0o600 });
      renameSync(temporary, this.file);
    }
    this.state = next;
  }

  read(key: string) { return this.state?.key === key ? this.state : null; }
}
