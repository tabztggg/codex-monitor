import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { QuotaCalibrationEvent } from '../quota-equivalent';
import { quotaEquivalentRange } from '../quota-equivalent-range';
import { reconcileAcrossAccounts, reconcileQuotaUsage } from '../quota-reconciliation';
import { HistoryJobReader } from '../history-jobs';

const start = Date.parse('2026-10-07T04:07:10Z');
const reset = start + 604800000;
const minute = 60000;
const sample = (id: string, offset: number, used: number, cost: number | null, tokens: number, anchor = reset): QuotaCalibrationEvent => ({
  id, taskId: id.split(':')[0], streamId: id.split(':')[0],
  at: start + offset * minute, cost, tokens, limit: { used, resetsAt: anchor }
});

describe('quota equivalent range accounting boundaries', () => {
  it('keeps complete zero-token reports as zero, even without a model price', () => {
    const zero = sample('idle:1', 1, 10, null, 0);
    expect(quotaEquivalentRange([zero], [], new Set(), 10, null, start + 2 * minute, true))
      .toEqual({ percent: 0, complete: true });
    const result = reconcileQuotaUsage([
      sample('baseline:0', 0, 0, 0, 0), sample('active:1', 1, 10, 100, 10000), zero
    ], { startedAtMs: start, resetsAt: new Date(reset).toISOString(), usedPercent: 10 }, start + 2 * minute)!;
    expect(result.attributedPercent).toBeCloseTo(10);
    expect(result.unattributedPercent).toBeCloseTo(0);
    expect(result.tokenFallbackPercent).toBe(0);
  });

  it('lets a full-log proven duplicate suppress a fragment apparent increment in either order', () => {
    const apparent = sample('copy:1', 1, 10, 100, 10000);
    const proven = { ...apparent, cost: 0, tokens: 0, duplicateUsage: true };
    for (const order of [[apparent, proven], [proven, apparent]]) {
      expect(quotaEquivalentRange([sample('zero:0', 0, 0, 0, 0), ...order], [], new Set(), 10, null, start + 2 * minute, true))
        .toEqual({ percent: 0, complete: true });
    }
  });

  it('counts observed responses once and extrapolates only the uncovered response', () => {
    const observed = sample('task:1', 1, 6, 600, 60000);
    const uncovered = sample('task:2', 2, 6, 40, 4000);
    expect(quotaEquivalentRange([observed, uncovered], [
      { taskId: 'task', at: observed.at, percent: 6, estimated: false }
    ], new Set([observed.id!]), 10, null, start + 3 * minute, true))
      .toEqual({ percent: 10, complete: false });
  });

  it('excludes earlier observed slices and future fallback responses from a selected range', () => {
    const before = sample('task:1', 1, 6, 600, 60000);
    const selected = sample('task:2', 2, 6, 20, 2000);
    const future = sample('task:4', 4, 6, 10000, 1000000);
    expect(quotaEquivalentRange([before, selected, future], [
      { taskId: 'task', at: before.at, percent: 6, estimated: false }
    ], new Set([before.id!]), 10, start + 2 * minute, start + 3 * minute, true))
      .toEqual({ percent: 2, complete: false });
  });

  it('does not replay one ambiguous reset-anchor event into two account windows', () => {
    const events = [
      sample('baseline-a:0', 100, 0, 0, 0),
      sample('baseline-b:0', 100, 0, 0, 0, reset + 90000),
      sample('bridge:1', 101, 5, 10, 100, reset + 45000),
      sample('baseline-b:2', 102, 5, 0, 0, reset + 90000)
    ];
    const result = reconcileAcrossAccounts(events, start + 103 * minute);
    const bridgeSlices = result.slices.filter(slice => slice.taskId === 'bridge');
    expect(bridgeSlices).toHaveLength(1);
    expect(bridgeSlices[0].percent).toBeCloseTo(5);
    expect(result.slices.reduce((sum, slice) => sum + slice.percent, 0)).toBeCloseTo(5);
  });

  it('assigns a selected jittered reset anchor to only one replay window', () => {
    const events = [
      sample('baseline-a:0', 100, 0, 0, 0),
      sample('baseline-b:0', 100, 0, 0, 0, reset + 90000),
      sample('bridge:1', 101, 5, 10, 100, reset + 45000),
      sample('baseline-b:2', 102, 5, 0, 0, reset + 90000)
    ];
    const result = reconcileAcrossAccounts(events, start + 103 * minute, {
      startedAtMs: start + 45000, resetsAt: new Date(reset + 45000).toISOString(), usedPercent: 5
    });
    const bridgeSlices = result.slices.filter(slice => slice.taskId === 'bridge');
    expect(bridgeSlices).toHaveLength(1);
    expect(bridgeSlices[0].percent).toBeCloseTo(5);
  });

  it('retains complete priced usage without timestamps in lifetime but not in a calendar range', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'monitor-untimed-range-'));
    try {
      const sessions = path.join(root, 'sessions');
      const cache = path.join(root, 'cache');
      mkdirSync(sessions); mkdirSync(cache);
      writeFileSync(path.join(cache, 'quota-calibration.json'), JSON.stringify({
        version: 1, costPerPercent: 10, quotaPercent: 5, windowStart: start, updatedAt: start
      }));
      writeFileSync(path.join(sessions, 'rollout-untimed.jsonl'), [
        { type: 'session_meta', payload: { id: 'untimed' } },
        { type: 'turn_context', payload: { model: 'gpt-6.1-sol' } },
        { type: 'event_msg', payload: { type: 'token_count', info: {
          last_token_usage: { input_tokens: 1000000, output_tokens: 0, total_tokens: 1000000 },
          total_token_usage: { input_tokens: 1000000, output_tokens: 0, total_tokens: 1000000 }
        } } }
      ].map(record => JSON.stringify(record)).join('\n') + '\n');
      const reader = new HistoryJobReader(sessions, path.join(cache, 'quota.json'));
      const args = { nowMs: start + 60 * minute };
      const lifetime = reader.listJobs({ ...args, period: 'lifetime' }).data[0];
      expect(lifetime.totalUsage?.totalTokens).toBe(1000000);
      expect(lifetime.totalEstimatedCostUsd).toBeCloseTo(4);
      expect(lifetime.lifetime20xPercent).toBeCloseTo(0.4);
      expect(lifetime.estimated20xPercent).toBeCloseTo(0.4);
      expect(lifetime.lifetime20xIsComplete).toBe(false);
      const today = reader.listJobs({ ...args, period: 'today' }).data[0];
      expect(today.estimated20xPercent).toBeNull();
      expect(today.lifetime20xPercent).toBeCloseTo(0.4);
      expect(today.periodMetrics?.usage).toBeNull();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('keeps an explicitly reported complete zero usage at zero despite missing timestamps', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'monitor-untimed-zero-'));
    try {
      const sessions = path.join(root, 'sessions');
      mkdirSync(sessions);
      writeFileSync(path.join(sessions, 'rollout-zero.jsonl'), [
        { type: 'session_meta', payload: { id: 'zero' } },
        { type: 'turn_context', payload: { model: 'gpt-6.1-sol' } },
        { type: 'event_msg', payload: { type: 'token_count', info: {
          last_token_usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
          total_token_usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 }
        } } }
      ].map(record => JSON.stringify(record)).join('\n') + '\n');
      const job = new HistoryJobReader(sessions).listJobs({ nowMs: start + minute, period: 'lifetime' }).data[0];
      expect(job.totalUsage?.totalTokens).toBe(0);
      expect(job.totalEstimatedCostUsd).toBe(0);
      expect(job.lifetime20xPercent).toBe(0);
      expect(job.estimated20xPercent).toBe(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
