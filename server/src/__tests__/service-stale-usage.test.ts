import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { expect, it } from 'vitest';
import { MonitorService } from '../service';
import { HistoryJobReader } from '../history-jobs';

it('does not attach unverified quota notifications to the old account during a switch', async () => {
  let email = 'a@example.com';
  let release: (() => void) | undefined;
  let delay: Promise<void> | undefined;
  const client = new EventEmitter() as EventEmitter & { ensureStarted(): Promise<void>; request(method: string): Promise<unknown> };
  client.ensureStarted = async () => {};
  client.request = async method => {
    if (method === 'account/read') return { account: { type: 'chatgpt', email, planType: 'pro' } };
    if (method === 'account/rateLimits/read') {
      await delay;
      return { rateLimits: { limitId: 'codex', secondary: { usedPercent: email === 'a@example.com' ? 24 : 7, windowDurationMins: 10080 } } };
    }
    throw new Error(method);
  };
  const service = new MonitorService(client as never, { listJobs: () => ({}) } as never);
  const refresh = () => (service as unknown as { refreshCodexUsage(): Promise<void> }).refreshCodexUsage();
  await refresh();
  email = 'b@example.com';
  delay = new Promise<void>(resolve => { release = resolve; });
  client.emit('notification', { method: 'account/updated', params: {} });
  client.emit('notification', { method: 'account/rateLimits/updated', params: { rateLimits: { limitId: 'codex', secondary: { usedPercent: 7, windowDurationMins: 10080 } } } });
  expect(service.getSnapshot().codexUsage).toMatchObject({ stale: true, account: { email: 'a@example.com' }, primaryLimit: { secondary: { usedPercent: 24 } } });
  release!();
  await refresh();
  expect(service.getSnapshot().codexUsage).toMatchObject({ account: { email: 'b@example.com' }, primaryLimit: { secondary: { usedPercent: 7 } } });
  expect(service.getSnapshot().codexUsage.stale).not.toBe(true);
});

it('retains quota and task metrics during failures, labels their age, and replaces them on recovery', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'monitor-stale-'));
  try {
    const sessions = path.join(root, 'sessions');
    mkdirSync(sessions);
    const now = Date.now();
    const reset = Math.floor((now - 3600000 + 604800000) / 1000);
    const tokens = { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 100, reasoning_output_tokens: 0, total_tokens: 1100 };
    writeFileSync(path.join(sessions, 'rollout-task.jsonl'), [
      { type: 'session_meta', payload: { id: 'task', cwd: 'C:/example', source: 'cli' } },
      { type: 'turn_context', payload: { model: 'gpt-6-astra' } },
      { timestamp: new Date(now - 60000).toISOString(), type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: tokens, total_token_usage: tokens } } }
    ].map(v => JSON.stringify(v)).join('\n'));
    let fail = false;
    let disconnected = false;
    const client = new EventEmitter() as EventEmitter & { ensureStarted(): Promise<void>; request(method: string): Promise<unknown> };
    client.ensureStarted = async () => { if (disconnected) throw new Error('offline'); };
    client.request = async method => {
      if (method === 'thread/list') return { data: [] };
      if (method === 'account/read') {
        client.emit('notification', { method: 'account/updated', params: {} });
        return { account: { type: 'chatgpt', email: 'a@example.com', planType: 'pro' } };
      }
      if (method === 'account/rateLimits/read') {
        if (fail) throw new Error('temporary failure');
        return { rateLimits: { limitId: 'codex', secondary: { usedPercent: 24, windowDurationMins: 10080, resetsAt: reset } } };
      }
      throw new Error('Unexpected request: ' + method);
    };
    const reader = new HistoryJobReader(sessions);
    const service = new MonitorService(client as never, reader);
    const refresh = () => (service as unknown as { refreshCodexUsage(): Promise<void> }).refreshCodexUsage();
    await refresh();
    const confirmed = service.getSnapshot().codexUsage;
    const original = (await service.listHistoryJobs({ period: 'quota' })).data[0].periodMetrics;
    expect(original).toMatchObject({ costUsd: 0.015, usage: { totalTokens: 1100 } });
    fail = true;
    await refresh();
    expect(service.getSnapshot().codexUsage).toMatchObject({ stale: true, updatedAt: confirmed.updatedAt, account: confirmed.account, limits: confirmed.limits });
    expect((await service.listHistoryJobs({ period: 'quota' })).data[0].periodMetrics).toEqual(original);
    client.emit('close', 1);
    disconnected = true;
    await refresh();
    expect(service.getSnapshot().codexUsage).toMatchObject({ stale: true, updatedAt: confirmed.updatedAt, limits: confirmed.limits });
    expect((await service.listHistoryJobs({ period: 'quota' })).data[0].periodMetrics).toEqual(original);
    fail = false;
    disconnected = false;
    await refresh();
    expect(service.getSnapshot().codexUsage.stale).not.toBe(true);
    expect(service.getSnapshot().codexUsage.error).toBeNull();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
