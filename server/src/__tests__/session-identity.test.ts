import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HistoryJobReader, parseHistorySessionFile } from '../history-jobs';

const timestamp = '2026-09-22T09:00:00Z';
const nowMs = Date.parse('2026-09-22T12:00:00Z');
const header = (id: string, parent?: string) => ({ timestamp, type: 'session_meta', payload: {
  id, session_id: parent ?? id, timestamp, name: id, cwd: `C:/${id}`,
  source: parent ? { subagent: { thread_spawn: { parent_thread_id: parent } } } : 'vscode'
} });
const usage = (tokens: number) => ({ timestamp, type: 'event_msg', payload: {
  type: 'token_count', info: { total_token_usage: { input_tokens: tokens, total_tokens: tokens },
    last_token_usage: { input_tokens: tokens, total_tokens: tokens } }
} });
const lines = (records: unknown[]) => records.map(record => JSON.stringify(record)).join('\n');

it('keeps a child identity when its rollout includes inherited parent and grandparent metadata', () => {
  const job = parseHistorySessionFile({ sessionId: 'child', updatedAt: timestamp, nowMs,
    fileContent: lines([header('child', 'parent'), header('parent', 'grandparent'), header('grandparent'),
      { timestamp, type: 'turn_context', payload: { model: 'gpt-5.6-sol' } }, usage(120)]) });
  expect(job).toMatchObject({ id: 'child', parentThreadId: 'parent', isSubagent: true,
    sourceKind: 'subAgentThreadSpawn', name: 'child', cwd: 'C:/child', totalUsage: { totalTokens: 120 } });
});

it('does not turn a root into a child when a different session header appears later', () => {
  const job = parseHistorySessionFile({ sessionId: null, updatedAt: timestamp, nowMs,
    fileContent: lines([header('root'), header('child', 'root'), usage(100)]) });
  expect(job).toMatchObject({ id: 'root', parentThreadId: null, isSubagent: false, sourceKind: 'vscode' });
});

it('preserves the root row and counts nested active and archived children exactly once', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'monitor-identity-'));
  try {
    const sessions = path.join(root, 'sessions');
    const archives = path.join(root, 'archived_sessions');
    mkdirSync(sessions); mkdirSync(archives);
    for (const [directory, id, parent, tokens] of [
      [sessions, 'root', undefined, 100], [sessions, 'child', 'root', 200],
      [archives, 'nested', 'child', 300]
    ] as const) {
      writeFileSync(path.join(directory, `rollout-${id}.jsonl`), lines([
        header(id, parent), ...(parent ? [header(parent), header('root')] : []),
        { timestamp, type: 'turn_context', payload: { model: 'gpt-5.6-sol' } }, usage(tokens), usage(tokens)
      ]));
    }
    const result = new HistoryJobReader(sessions).listJobs({ nowMs, period: 'today', usageWindow: {
      usedPercent: 20, startedAtMs: Date.parse('2026-09-22T00:00:00Z'),
      resetsAt: '2026-09-29T00:00:00Z', limitName: 'Overall Codex', windowLabel: 'Weekly'
    } });
    expect(result.total).toBe(1);
    expect(result.data[0]).toMatchObject({ id: 'root', archived: false,
      totalUsage: { totalTokens: 600 }, sinceResetUsage: { totalTokens: 600 },
      periodMetrics: { usage: { totalTokens: 600 } } });
    expect(result.data[0].totalEstimatedCostUsd).toBeCloseTo(0.0024);
    expect(result.analysis?.days.reduce((sum, day) => sum + day.usage.totalTokens, 0)).toBe(600);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
