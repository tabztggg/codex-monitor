import { describe, expect, it } from 'vitest';
import { QuotaCalibration, type QuotaCalibrationEvent } from '../quota-equivalent';
import { reconcileAcrossAccounts, reconcileQuotaUsage } from '../quota-reconciliation';

const start = Date.parse('2026-10-07T04:07:10Z');
const end = start + 7 * 86400000;
const minute = 60000;
const scope: { accountId: string; startedAtMs: number; resetsAt: string; usedPercent: number; observedAtMs?: number } =
  { accountId: 'account-a', startedAtMs: start, resetsAt: new Date(end).toISOString(), usedPercent: 10 };
const record = (
  offset: number,
  used: number,
  cost: number | null,
  tokens: number | undefined,
  taskId = 'priced',
  reset: number | null = end,
  streamId = taskId
): QuotaCalibrationEvent => ({
  id: `${taskId}:${offset}:${reset}`,
  taskId,
  streamId,
  at: start + offset * minute,
  cost,
  ...(tokens === undefined ? {} : { tokens }),
  limit: reset === null ? null : { used, resetsAt: reset }
});
const baseline = () => record(0, 0, 0, 0);
const replay = (events: QuotaCalibrationEvent[], overrides: Partial<typeof scope> = {}, now = start + 60 * minute) =>
  reconcileQuotaUsage(events, { ...scope, ...overrides }, now)!;
const allocated = (result: ReturnType<typeof replay>, taskId: string) => result.attributed.get(taskId) ?? 0;
const assertConserved = (result: ReturnType<typeof replay>, official = scope.usedPercent) => {
  expect(result.attributedPercent).toBeCloseTo([...result.attributed.values()].reduce((sum, value) => sum + value, 0));
  expect(result.attributedPercent + result.unattributedPercent).toBeCloseTo(official);
  expect(result.attributedPercent).toBeGreaterThanOrEqual(0);
  expect(result.unattributedPercent).toBeGreaterThanOrEqual(0);
};

describe('quota reconciliation with incomplete model prices', () => {
  it('reuses unchanged replay data without waiting for a pending ledger save, and invalidates it on new samples', () => {
    const calibration = new QuotaCalibration();
    const events = [baseline(), record(1, 10, 99, 9900), record(1, 10, null, 100, 'unpriced')];
    calibration.resolve(events, start, start + 2 * minute, scope);
    const first = calibration.replayAcrossAccounts(start + 2 * minute, scope);
    calibration.resolve(events, start, start + 3 * minute, scope);
    expect(calibration.replayAcrossAccounts(start + 3 * minute, scope)).toBe(first);
    const nextScope = { ...scope, usedPercent: 20 };
    calibration.resolve([record(4, 20, 100, 10000)], start, start + 5 * minute, nextScope);
    const changed = calibration.replayAcrossAccounts(start + 5 * minute, nextScope);
    expect(changed).not.toBe(first);
    expect(changed.slices.reduce((sum, e) => sum + e.percent, 0)).toBeCloseTo(20);
  });

  it('keeps a mixed interval instead of losing its priced responses', () => {
    const known = record(1, 10, 99, 9900);
    const unknown = record(1, 10, null, 100, 'unpriced');
    const result = replay([baseline(), known, unknown]);
    expect(allocated(result, 'priced')).toBeCloseTo(9.9);
    expect(allocated(result, 'unpriced')).toBeCloseTo(0.1);
    expect(result.tokenFallbackPercent).toBeCloseTo(10);
    expect(result.partialTasks.has('priced')).toBe(true);
    expect(result.partialTasks.has('unpriced')).toBe(true);
    expect(result.coveredEventIds.has(known.id!)).toBe(true);
    expect(result.coveredEventIds.has(unknown.id!)).toBe(true);
    // A proxy supplies quota weights only. Unknown API cost remains unknown.
    expect(unknown.cost).toBeNull();
    expect(result.costPerPercent).toBeCloseTo(10);
    expect(result.calibrationPercent).toBeCloseTo(9.9);
    expect(result.pricedCoverage).toBeCloseTo(0.99);
    expect(result.referenceIsComplete).toBe(false);
    assertConserved(result);
  });

  it('uses token weights when every response in an observed interval is unpriced, without inventing a USD calibration', () => {
    const result = replay([baseline(), record(1, 10, null, 100, 'a'), record(1, 10, null, 300, 'b')]);
    expect(allocated(result, 'a')).toBeCloseTo(2.5);
    expect(allocated(result, 'b')).toBeCloseTo(7.5);
    expect(result.tokenFallbackPercent).toBeCloseTo(10);
    expect(result.costPerPercent).toBeNull();
    expect(result.partialTasks.has('a')).toBe(true);
    expect(result.partialTasks.has('b')).toBe(true);
    assertConserved(result);
  });

  it('rejects a mixed calibration dominated by unknown prices even though quota attribution remains useful', () => {
    const result = replay([baseline(), record(1, 10, 50, 5000), record(1, 10, null, 5000, 'unpriced')]);
    expect(allocated(result, 'priced')).toBeCloseTo(5);
    expect(allocated(result, 'unpriced')).toBeCloseTo(5);
    expect(result.pricedCoverage).toBeCloseTo(0.5);
    expect(result.costPerPercent).toBeNull();
    assertConserved(result);
  });

  it('still requires five priced percentage points before publishing a new calibration', () => {
    const result = replay([baseline(), record(1, 5, 49.5, 9900), record(1, 5, null, 100, 'unpriced')], { usedPercent: 5 });
    expect(result.calibrationPercent).toBeCloseTo(4.95);
    expect(result.costPerPercent).toBeNull();
    expect(result.attributedPercent).toBeCloseTo(5);
    assertConserved(result, 5);
  });

  it.each([undefined, -10, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity])('does not make missing or invalid token quantities (%s) into a quota weight', tokens => {
    const result = replay([baseline(), record(1, 10, 90, 900), record(1, 10, null, tokens, 'unquantifiable')]);
    expect(result.attributedPercent).toBe(0);
    expect(result.unattributedPercent).toBe(10);
    expect(result.costPerPercent).toBeNull();
    expect(result.partialTasks.has('unquantifiable')).toBe(true);
    assertConserved(result);
  });

  it.each([NaN, Infinity, -1])('does not treat corrupted cost metadata (%s) as a legitimate unknown model price', cost => {
    const result = replay([baseline(), record(1, 10, 90, 900), record(1, 10, cost, 100, 'invalid')]);
    expect(result.attributedPercent).toBe(0);
    expect(result.unattributedPercent).toBe(10);
    expect(result.costPerPercent).toBeNull();
    assertConserved(result);
  });

  it('keeps pending known responses when a separate report lacks an account window, reserving its unknown share', () => {
    const unknown = record(1.5, 0, null, 100, 'unknown-account', null);
    const result = replay([baseline(), record(1, 0, 90, 900), unknown, record(2, 10, 0, 0)]);
    expect(allocated(result, 'priced')).toBeCloseTo(9);
    expect(result.attributed.has('unknown-account')).toBe(false);
    expect(result.unattributedPercent).toBeCloseTo(1);
    expect(result.tokenFallbackPercent).toBeCloseTo(9);
    expect(result.partialTasks.has('unknown-account')).toBe(true);
    expect(result.coveredEventIds.has(unknown.id!)).toBe(false);
    assertConserved(result);
  });

  it('does not let an independent foreign-account stream erase current-account pending costs', () => {
    const foreign = record(1.5, 10, 1000, 10000, 'foreign', end + 86400000);
    const result = replay([baseline(), record(1, 0, 6, 600), foreign, record(2, 10, 4, 400)]);
    expect(allocated(result, 'priced')).toBeCloseTo(10);
    expect(result.attributed.has('foreign')).toBe(false);
    expect(result.coveredEventIds.has(foreign.id!)).toBe(false);
    expect(result.tokenFallbackPercent).toBe(0);
    assertConserved(result);
  });

  it('breaks the interval when that same source explicitly switches account windows', () => {
    const result = replay([
      baseline(), record(1, 0, 5, 500), record(2, 50, 100, 1000, 'priced', end + 86400000),
      record(3, 10, 5, 500), record(4, 20, 10, 1000)
    ], { usedPercent: 20 });
    expect(allocated(result, 'priced')).toBeCloseTo(10);
    expect(result.unattributedPercent).toBeCloseTo(10);
    expect(result.partialTasks.has('priced')).toBe(true);
    assertConserved(result, 20);
  });

  it('retains explicit account switches when replaying all accounts for the cross-account column', () => {
    const events = [baseline(), record(1, 0, 5, 500), record(2, 50, 100, 1000, 'priced', end - 86400000),
      record(3, 10, 5, 500), record(4, 20, 10, 1000)];
    const result = reconcileAcrossAccounts(events, start + 60 * minute, { ...scope, usedPercent: 20 });
    expect(result.slices.reduce((sum, slice) => sum + slice.percent, 0)).toBeCloseTo(10);
    expect(result.coveredEventIds.has(events[1].id!)).toBe(false);
    expect(result.coveredEventIds.has(events[3].id!)).toBe(false);
    expect(result.coveredEventIds.has(events[4].id!)).toBe(true);
  });

  it('prefers proven duplicate usage over overlapping apparent increments in either input order', () => {
    const known = record(1, 10, 99, 9900);
    const unknown = record(1, 10, null, 100, 'unpriced');
    const fragment = record(1, 10, null, 100000, 'fork-copy');
    const provenDuplicate = { ...fragment, cost: 0, tokens: 0, duplicateUsage: true };
    for (const overlapping of [[fragment, provenDuplicate], [provenDuplicate, fragment]]) {
      const result = replay([baseline(), known, known, unknown, unknown, ...overlapping]);
      expect(allocated(result, 'priced')).toBeCloseTo(9.9);
      expect(allocated(result, 'unpriced')).toBeCloseTo(0.1);
      expect(result.attributed.has('fork-copy')).toBe(false);
      expect(result.coveredEventIds.has(fragment.id!)).toBe(false);
      assertConserved(result);
    }
  });

  it('is independent of simultaneous report order', () => {
    const events = [baseline(), record(1, 10, 99, 9900), record(1, 9, null, 100, 'unpriced'), record(1, 8, 0, 0, 'idle')];
    const expected = replay(events);
    for (const input of [[...events].reverse(), [events[2], events[0], events[3], events[1]]]) {
      const result = replay(input);
      expect(allocated(result, 'priced')).toBeCloseTo(allocated(expected, 'priced'));
      expect(allocated(result, 'unpriced')).toBeCloseTo(allocated(expected, 'unpriced'));
      expect(result.costPerPercent).toBe(expected.costPerPercent);
      expect(result.tokenFallbackPercent).toBe(expected.tokenFallbackPercent);
      assertConserved(result);
    }
  });

  it('excludes responses after the account snapshot cutoff even when they have the same reset', () => {
    const later = record(2, 20, null, 100000, 'later');
    const result = replay([baseline(), record(1, 10, 99, 9900), record(1, 10, null, 100, 'unpriced'), later],
      { observedAtMs: start + minute });
    expect(result.attributedPercent).toBeCloseTo(10);
    expect(result.attributed.has('later')).toBe(false);
    expect(result.coveredEventIds.has(later.id!)).toBe(false);
    assertConserved(result);
  });

  it('does not use token weights to bridge a long observation gap', () => {
    const result = replay([baseline(), record(1, 0, 90, 900), record(32, 10, null, 100, 'unpriced')]);
    expect(result.attributedPercent).toBe(0);
    expect(result.unattributedPercent).toBe(10);
    expect(result.costPerPercent).toBeNull();
    assertConserved(result);
  });

  it('preserves pre-observation quota rather than distributing it as new task usage', () => {
    const result = replay([record(0, 20, 1000, 100000), record(1, 30, 99, 9900), record(1, 30, null, 100, 'unpriced')],
      { usedPercent: 30 });
    expect(result.attributedPercent).toBeCloseTo(10);
    expect(result.unattributedPercent).toBeCloseTo(20);
    expect(allocated(result, 'priced')).toBeCloseTo(9.9);
    assertConserved(result, 30);
  });

  it('keeps actual response timestamps across local midnight instead of assigning the interval entirely to today', () => {
    // Los Angeles midnight on Oct 8 is 07:00 UTC. A rounded quota reading
    // arriving later must not move the earlier response into the next day.
    const midnight = Date.parse('2026-10-08T07:00:00Z');
    const before = { ...record(1, 0, 10, 100, 'yesterday'), at: midnight - minute };
    const after = { ...record(2, 10, null, 100, 'today'), at: midnight + minute };
    const initial = { ...baseline(), at: midnight - 2 * minute };
    const result = replay([initial, before, after], {}, midnight + 2 * minute);
    const yesterday = result.slices.filter(slice => slice.at < midnight).reduce((sum, slice) => sum + slice.percent, 0);
    const today = result.slices.filter(slice => slice.at >= midnight).reduce((sum, slice) => sum + slice.percent, 0);
    expect(yesterday).toBeCloseTo(5);
    expect(today).toBeCloseTo(5);
    expect(result.slices.find(slice => slice.taskId === 'yesterday')?.at).toBe(before.at);
    expect(result.slices.find(slice => slice.taskId === 'today')?.at).toBe(after.at);
    expect(result.slices.every(slice => slice.estimated)).toBe(true);
    assertConserved(result);
  });

  it('keeps calibration sample token quantities during merging and rejects a duplicate fragment from retraining', () => {
    const calibration = new QuotaCalibration();
    const known = record(1, 10, 99, 9900);
    const unknown = record(1, 10, null, 100, 'unpriced');
    const result = calibration.resolve([baseline(), known, unknown], start, start + 2 * minute, scope);
    expect(result.costPerPercent).toBeCloseTo(10);
    expect(result.source).toBe('current');
    expect(calibration.recordedEvents().find(event => event.id === unknown.id)?.tokens).toBe(100);

    const duplicate = { ...unknown, cost: 0, tokens: 0, duplicateUsage: true };
    calibration.resolve([duplicate], start, start + 3 * minute, scope);
    calibration.resolve([unknown], start, start + 4 * minute, scope);
    expect(calibration.recordedEvents().find(event => event.id === unknown.id)).toMatchObject({ cost: 0, tokens: 0, duplicateUsage: true });
  });
});
