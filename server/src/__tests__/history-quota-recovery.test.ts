import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HistoryJobReader } from '../history-jobs';
import { localDay } from '../../../shared/usage-period';

const at = (day: number, hour: number, minutes = 0) => new Date(2026, 9, day, hour, minutes).getTime();
const start = at(7, 12);
const reset = start + 7 * 86400000;
const now = at(9, 1);
const window = { startedAtMs: start, resetsAt: new Date(reset).toISOString(), usedPercent: 10, limitName: 'Codex', windowLabel: 'Weekly' };
const account = { type: 'chatgpt' as const, email: 'current@example.com', planType: 'pro' };
const usage = (tokens: number) => ({ input_tokens: tokens, output_tokens: 0, total_tokens: tokens });
const meta = (id: string) => ({ type: 'session_meta', timestamp: new Date(start).toISOString(), payload: { id, source: 'cli' } });
const context = (model: string) => ({ type: 'turn_context', payload: { model } });
const token = (time: number, tokens: number, cumulative: number, used: number, anchor = reset) => ({
  timestamp: new Date(time).toISOString(), type: 'event_msg', payload: { type: 'token_count',
    info: { last_token_usage: usage(tokens), total_token_usage: usage(cumulative) },
    rate_limits: { plan_type: 'pro', primary: { window_minutes: 10080, used_percent: used, resets_at: anchor / 1000 } }
  }
});

describe('history recovery of mixed-price quota reports', () => {
  let root: string;
  let sessions: string;
  let ledger: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'monitor-quota-recovery-'));
    sessions = path.join(root, 'sessions');
    ledger = path.join(root, 'cache', 'quota.json');
    mkdirSync(sessions);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  function write(name: string, records: unknown[]) {
    writeFileSync(path.join(sessions, `rollout-${name}.jsonl`), records.map(record => JSON.stringify(record)).join('\n') + '\n');
  }
  function mixed(before: number, after = before) {
    write('priced', [meta('priced'), context('gpt-6.1-sol'), token(before - 60000, 0, 0, 0), token(before, 9900, 9900, after === before ? 10 : 0)]);
    write('unknown', [meta('unknown'), context('not-in-price-catalog'), token(after, 100, 100, 10)]);
  }

  it('recovers known and unpriced tasks without inventing unknown API costs, and keeps the result after restart', () => {
    mixed(at(8, 12));
    const args = { nowMs: now, usageWindow: window, account, period: '7d' as const };
    const reader = new HistoryJobReader(sessions, ledger);
    const result = reader.listJobs(args);
    const priced = result.data.find(job => job.id === 'priced')!;
    const unknown = result.data.find(job => job.id === 'unknown')!;
    expect(priced.currentAccountEquivalentPercent).toBeCloseTo(9.9);
    expect(unknown.currentAccountEquivalentPercent).toBeCloseTo(0.1);
    expect(priced.estimated20xPercent).toBeCloseTo(9.9);
    expect(unknown.estimated20xPercent).toBeCloseTo(0.1);
    expect(priced.currentAccountEquivalentIsComplete).toBe(false);
    expect(unknown.currentAccountEquivalentIsComplete).toBe(false);
    expect(unknown.estimated20xIsComplete).toBe(false);
    expect(unknown.totalUsage?.totalTokens).toBe(100);
    expect(unknown.totalEstimatedCostUsd).toBeNull();
    expect(unknown.periodMetrics?.costUsd).toBeNull();
    expect(unknown.periodMetrics?.costComplete).toBe(false);
    expect(result.usageAllocation).toMatchObject({ usedPercent: 10, attributedPercent: 10, unattributedPercent: 0, tokenFallbackPercent: 10 });
    expect(result.usageAllocation.equivalent20x?.source).toBe('current');
    expect(result.analysis?.unpricedTokens).toBe(100);

    const restarted = new HistoryJobReader(sessions, ledger).listJobs(args);
    expect(restarted.data.map(job => [job.id, job.currentAccountEquivalentPercent, job.estimated20xPercent]))
      .toEqual(result.data.map(job => [job.id, job.currentAccountEquivalentPercent, job.estimated20xPercent]));
    expect(restarted.usageAllocation.unattributedPercent).toBe(0);
  });

  it('limits today and custom-day equivalents to the actual response date while the account column remains weekly', () => {
    mixed(at(8, 23, 59), at(9, 0, 1));
    const reader = new HistoryJobReader(sessions, ledger);
    const args = { nowMs: now, usageWindow: window, account };
    const today = reader.listJobs({ ...args, period: 'today' });
    const yesterday = reader.listJobs({ ...args, period: 'custom', dateFrom: localDay(at(8, 12)), dateTo: localDay(at(8, 12)) });
    const week = reader.listJobs({ ...args, period: '7d' });
    const todayUnknown = today.data.find(job => job.id === 'unknown')!;
    expect(todayUnknown.estimated20xPercent).toBeCloseTo(0.1);
    expect(today.data.find(job => job.id === 'priced')?.estimated20xPercent).toBe(0);
    expect(today.data.find(job => job.id === 'priced')?.currentAccountEquivalentPercent).toBeCloseTo(9.9);
    expect(yesterday.data.find(job => job.id === 'priced')?.estimated20xPercent).toBeCloseTo(9.9);
    const total = (result: typeof today) => result.data.reduce((sum, job) => sum + (job.estimated20xPercent ?? 0), 0);
    expect(total(today)).toBeCloseTo(0.1);
    expect(total(yesterday)).toBeCloseTo(9.9);
    expect(total(week)).toBeCloseTo(total(today) + total(yesterday));
    expect(today.analysis?.days.map(day => day.date)).toEqual([localDay(now)]);
    expect(today.analysis?.days[0].estimated20xPercent).toBeCloseTo(0.1);
    expect(todayUnknown.periodMetrics?.days?.[0].estimated20xPercent).toBeCloseTo(0.1);
    expect(today.analysis?.days[0].costUsd).toBeNull();
  });

  it('keeps another account in the cross-account range without assigning it to the selected account', () => {
    mixed(at(8, 12));
    const olderReset = reset - 86400000;
    write('foreign', [meta('foreign'), context('not-in-price-catalog'),
      token(at(8, 12), 0, 0, 0, olderReset), token(at(8, 12, 1), 1000, 1000, 20, olderReset)]);
    const result = new HistoryJobReader(sessions, ledger).listJobs({ nowMs: now, usageWindow: window, account, period: '7d' });
    const foreign = result.data.find(job => job.id === 'foreign')!;
    expect(foreign.currentAccountEquivalentPercent).toBe(0);
    expect(foreign.estimated20xPercent).toBeCloseTo(20);
    expect(foreign.totalEstimatedCostUsd).toBeNull();
    expect(result.data.reduce((sum, job) => sum + (job.estimated20xPercent ?? 0), 0)).toBeCloseTo(30);
    expect(result.usageAllocation.attributedPercent).toBeCloseTo(10);
    expect(result.usageAllocation.unattributedPercent).toBe(0);
  });

  it('does not upgrade a corrupt token report into a valid fallback merely because its total counter is positive', () => {
    const time = at(8, 12);
    write('priced', [meta('priced'), context('gpt-6.1-sol'), token(time - 60000, 0, 0, 0), token(time, 9900, 9900, 10)]);
    const corrupt = token(time, 100, 100, 10);
    write('corrupt', [meta('corrupt'), context('not-in-price-catalog'), {
      ...corrupt, payload: { ...corrupt.payload, info: { ...corrupt.payload.info,
        last_token_usage: { ...corrupt.payload.info.last_token_usage, cached_input_tokens: 101 }
      } }
    }]);
    const result = new HistoryJobReader(sessions, ledger).listJobs({ nowMs: now, usageWindow: window, account, period: '7d' });
    expect(result.usageAllocation.attributedPercent).toBe(0);
    expect(result.usageAllocation.unattributedPercent).toBe(10);
    expect(result.data.find(job => job.id === 'corrupt')?.currentAccountEquivalentPercent).toBeNull();
    expect(result.data.find(job => job.id === 'corrupt')?.periodMetrics?.tokensComplete).toBe(false);
    expect(result.data.find(job => job.id === 'corrupt')?.periodMetrics?.costComplete).toBe(false);
  });
});
