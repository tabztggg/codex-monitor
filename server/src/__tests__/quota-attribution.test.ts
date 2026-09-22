import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isSameQuotaWindow, QuotaAttribution } from '../quota-attribution';

const sample = (id: string, cost: number, unpriced = 0) => ({ id, cost, tokens: cost * 100 + unpriced, unpriced });
const weeklyKey = (endMs: number, name = 'Overall Codex', durationMs = 604800000) =>
  JSON.stringify([name, 'Weekly', endMs - durationMs, new Date(endMs).toISOString()]);

it('preserves allocations, pending weights, and restart state across reset timestamp jitter', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'quota-jitter-'));
  try {
    const file = path.join(root, 'ledger.json');
    const end = Date.parse('2026-09-28T17:41:50Z');
    const key = weeklyKey(end);
    const ledger = new QuotaAttribution(file);
    ledger.observe(key, 0, [], 0);
    ledger.observe(key, 3, [sample('a', 3)], 1);
    ledger.observe(weeklyKey(end - 1000), 3, [sample('a', 4)], 2);
    expect(ledger.read(weeklyKey(end - 1000))?.attributed.a).toBe(3);
    const reopened = new QuotaAttribution(file);
    reopened.observe(weeklyKey(end + 8000), 4, [sample('a', 4)], 3);
    expect(reopened.read(key)).toMatchObject({
      key, used: 4, unattributed: 0, observedAt: new Date(0).toISOString(), attributed: { a: 4 }
    });
    reopened.observe(weeklyKey(end + 604800000), 0, [], 4);
    expect(reopened.read(key)).toBeNull();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('does not merge different limits, durations, or resets outside the jitter tolerance', () => {
  const end = Date.parse('2026-09-28T17:42:00Z');
  expect(isSameQuotaWindow(weeklyKey(end), weeklyKey(end - 1000))).toBe(true);
  expect(isSameQuotaWindow(weeklyKey(end), weeklyKey(end + 61000))).toBe(false);
  expect(isSameQuotaWindow(weeklyKey(end), weeklyKey(end, 'Spark'))).toBe(false);
  expect(isSameQuotaWindow(weeklyKey(end), weeklyKey(end, 'Overall Codex', 300000))).toBe(false);
  expect(isSameQuotaWindow('invalid', weeklyKey(end))).toBe(false);
});

it('allocates only increments, retaining weights across rounded readings and preserving finished tasks', () => {
  const ledger = new QuotaAttribution();
  ledger.observe('week', 91, [sample('a', 10)], 0);
  expect(ledger.read('week')?.unattributed).toBe(91);
  ledger.observe('week', 91, [sample('a', 11), sample('b', 3)], 1);
  ledger.observe('week', 95, [sample('a', 11), sample('b', 3)], 2);
  expect(ledger.read('week')?.attributed).toEqual({ a: 1, b: 3 });
  ledger.observe('week', 96, [sample('a', 11), sample('b', 4)], 3);
  expect(ledger.read('week')?.attributed).toEqual({ a: 1, b: 4 });
  ledger.observe('week', 96, [sample('a', 11), sample('b', 4)], 4);
  expect(ledger.read('week')?.attributed).toEqual({ a: 1, b: 4 });
});

it('leaves missing and partially unpriced intervals unattributed, then recovers', () => {
  const ledger = new QuotaAttribution();
  ledger.observe('week', 10, [], 0);
  ledger.observe('week', 11, [], 1);
  ledger.observe('week', 13, [sample('a', 1, 100)], 2);
  expect(ledger.read('week')?.unattributed).toBe(13);
  ledger.observe('week', 14, [sample('a', 2, 100)], 3);
  expect(ledger.read('week')?.attributed.a).toBe(1);
});

it('does not recount usage when a session temporarily disappears', () => {
  const ledger = new QuotaAttribution();
  ledger.observe('week', 10, [sample('a', 10)], 0);
  ledger.observe('week', 11, [], 1);
  ledger.observe('week', 12, [sample('a', 10)], 2);
  expect(ledger.read('week')?.attributed).toEqual({});
  expect(ledger.read('week')?.unattributed).toBe(12);
});

it('does not treat newly included old archives as current consumption or discard pending live weights', () => {
  const ledger = new QuotaAttribution();
  ledger.observe('week', 10, [sample('live', 10)], 0);
  ledger.observe('week', 10, [sample('live', 12), { ...sample('old', 500), historical: true }], 1);
  expect(ledger.read('week')?.baseline.live.cost).toBe(10);
  expect(ledger.read('week')?.baseline.old.cost).toBe(500);
  ledger.observe('week', 12, [sample('live', 12), { ...sample('old', 500), historical: true }, { ...sample('older', 1000), historical: true }], 2);
  expect(ledger.read('week')?.attributed).toMatchObject({ live: 2 });
  expect(ledger.read('week')?.attributed.old ?? 0).toBe(0);
  expect(ledger.read('week')?.attributed.older ?? 0).toBe(0);
});

it('persists pending weights and allocations across restarts and resets on new windows or early resets', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'quota-ledger-'));
  try {
    const file = path.join(root, 'ledger.json');
    const ledger = new QuotaAttribution(file);
    ledger.observe('week', 10, [sample('a', 2)], 0);
    ledger.observe('week', 12, [sample('a', 4)], 1);
    ledger.observe('week', 12, [sample('a', 5)], 2);
    const reopened = new QuotaAttribution(file);
    reopened.observe('week', 13, [sample('a', 5)], 3);
    expect(reopened.read('week')?.attributed.a).toBe(3);
    reopened.observe('next', 1, [sample('a', 1)], 4);
    expect(reopened.read('week')).toBeNull();
    expect(reopened.read('next')?.attributed).toEqual({});
    reopened.observe('next', 0, [sample('a', 1)], 5);
    expect(reopened.read('next')?.unattributed).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
