import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { QuotaAttribution } from '../quota-attribution';

const sample = (id: string, cost: number, unpriced = 0) => ({ id, cost, tokens: cost * 100 + unpriced, unpriced });

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
