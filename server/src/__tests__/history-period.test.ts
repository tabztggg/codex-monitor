import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HistoryJobReader } from '../history-jobs';
import { localDay } from '../../../shared/usage-period';
import { summarizeTasks } from '../../../web/src/usage-display';
import { groupTasksByProject } from '../../../web/src/presentation';
import type { HistoryJob } from '../../../shared/monitor';

// Local calendar boundaries work in both the workstation and UTC CI time zones.
const now = new Date(2026, 8, 22, 18).getTime();
const at = (days: number, hour = 10) => new Date(2026, 8, 22 - days, hour).getTime();
const window = { startedAtMs: at(2, 12), resetsAt: new Date(at(2, 12) + 604800000).toISOString(), usedPercent: 10, limitName: 'Overall Codex', windowLabel: 'Weekly' };
const usage = (tokens: number) => ({ input_tokens: tokens, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: tokens });

describe('selected usage periods', () => {
  let root: string;
  let sessions: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-period-')); sessions = path.join(root, 'sessions'); fs.mkdirSync(sessions); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  function write(id: string, events: { at: number | null; tokens: number; model?: string; repeat?: boolean }[], parent?: string) {
    let cumulative = 0;
    const lines: unknown[] = [{ type: 'session_meta', payload: { id, source: parent ? 'subAgent' : 'cli', parent_thread_id: parent } }];
    for (const event of events) {
      lines.push({ type: 'turn_context', payload: { model: event.model ?? 'gpt-5.6-sol' } });
      cumulative += event.tokens;
      const line = { timestamp: event.at === null ? undefined : new Date(event.at).toISOString(), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: usage(cumulative), last_token_usage: usage(event.tokens) } } };
      lines.push(line); if (event.repeat) lines.push(line);
    }
    fs.writeFileSync(path.join(sessions, `rollout-${id}.jsonl`), lines.map(line => JSON.stringify(line)).join('\n'));
  }
  it('uses calendar days, exact midday quota boundaries, and deduplicated counters without reparsing for each range', () => {
    write('root', [{ at: at(8), tokens: 100 }, { at: at(6), tokens: 200 }, { at: at(2, 11), tokens: 300 }, { at: at(2, 13), tokens: 400 }, { at: at(0), tokens: 500, repeat: true }]);
    const reader = new HistoryJobReader(sessions);
    const totals = { quota: 900, today: 500, '7d': 1400, lifetime: 1500 } as const;
    for (const period of Object.keys(totals) as (keyof typeof totals)[]) {
      const result = reader.listJobs({ nowMs: now, usageWindow: window, period });
      expect(result.data[0].periodMetrics).toMatchObject({ usage: { totalTokens: totals[period] }, tokensComplete: true, costComplete: true });
      expect(result.analysis?.days.reduce((sum, day) => sum + day.usage.totalTokens, 0)).toBe(totals[period]);
      expect(result.data[0].totalUsage?.totalTokens).toBe(1500); // Lifetime API fields remain stable.
    }
    expect(reader.listJobs({ nowMs: now, usageWindow: window, period: 'today' }).analysis?.days[0].date).toBe(localDay(now));
  });
  it('consolidates child usage in daily totals once, with complete analysis across paginated results', () => {
    write('a', [{ at: at(0), tokens: 100 }]);
    write('child', [{ at: at(0), tokens: 50 }], 'a');
    write('b', [{ at: at(0), tokens: 200, model: 'unknown-unpriced' }]);
    const result = new HistoryJobReader(sessions).listJobs({ nowMs: now, period: 'today', limit: 1 });
    expect(result.total).toBe(2);
    expect(result.data).toHaveLength(1);
    expect(result.analysis?.days[0]).toMatchObject({ usage: { totalTokens: 350 }, unpricedTokens: 200 });
    expect(result.analysis?.days[0].costUsd).toBeGreaterThan(0);
    expect(result.analysis?.unpricedTokens).toBe(200);
  });
  it('distinguishes known zero, unavailable quota and usage without timestamps', () => {
    write('old', [{ at: at(8), tokens: 100 }]);
    write('untimed', [{ at: null, tokens: 50, model: 'unknown-unpriced' }]);
    const reader = new HistoryJobReader(sessions);
    const today = reader.listJobs({ nowMs: now, period: 'today' });
    expect(today.data.find(j => j.id === 'old')?.periodMetrics).toMatchObject({ usage: { totalTokens: 0 }, costUsd: 0, costComplete: true });
    expect(today.data.find(j => j.id === 'untimed')?.periodMetrics).toMatchObject({ usage: null, costUsd: null, tokensComplete: false, untimedTokens: 50 });
    expect(reader.listJobs({ nowMs: now }).data.every(j => j.periodMetrics?.usage === null)).toBe(true);
    const lifetime = reader.listJobs({ nowMs: now, period: 'lifetime' });
    expect(lifetime.data.find(j => j.id === 'untimed')?.periodMetrics).toMatchObject({ usage: { totalTokens: 50 }, tokensComplete: true, costComplete: false });
    expect(lifetime.analysis?.unpricedTokens).toBe(50);
  });
  it('keeps totals above 100%, marks partial groups, and includes hidden rows in project totals', () => {
    const base = { id: 'a', updatedAt: new Date(now).toISOString(), project: { id: 'p', name: 'Project' }, totalEstimatedCostUsd: 2, totalEstimatedCostIsComplete: true, totalUsage: { totalTokens: 100 }, estimated20xPercent: 120, estimated20xIsComplete: true } as HistoryJob;
    const jobs = [base, { ...base, id: 'b', estimated20xPercent: 250, estimated20xIsComplete: false, periodMetrics: { tokensComplete: false } } as HistoryJob];
    expect(summarizeTasks(jobs)).toMatchObject({ cost: 4, tokens: 200, tokensComplete: false, equivalent: 370, equivalentComplete: false });
    expect(groupTasksByProject(jobs, [base], 'tokens')[0]).toMatchObject({ totalTokens: 200, tokensIsComplete: false, equivalent20xPercent: 370, jobs: [base] });
    expect(summarizeTasks([{ ...base, totalUsage: null, totalEstimatedCostUsd: null, estimated20xPercent: null }])).toMatchObject({ cost: null, tokens: null, equivalent: null });
  });
});
