import { describe, expect, it } from 'vitest';
import { reconcileQuotaUsage } from '../quota-reconciliation';
import type { QuotaCalibrationEvent } from '../quota-equivalent';

const start = Date.parse('2026-09-30T02:19:56Z');
const end = start + 604800000;
const window = { startedAtMs: start, resetsAt: new Date(end).toISOString(), usedPercent: 79 };
const event = (minute: number, used: number, cost: number | null, taskId = 'a', reset: number | null = end): QuotaCalibrationEvent =>
  ({ id: `${taskId}:${minute}`, taskId, streamId: taskId, at: start + minute * 60000, cost, limit: reset === null ? null : { used, resetsAt: reset } });
const replay = (events: QuotaCalibrationEvent[], quota = window) => reconcileQuotaUsage(events, quota, start + 3600000)!;

describe('account quota reconciliation', () => {
  it('replays parallel rounded snapshots and leaves pre-observation and later official consumption unassigned', () => {
    const events = [event(0, 20, 999), event(1, 20, 10), event(2, 30, 30, 'b'), event(2, 29, 10)];
    for (const input of [events, [...events].reverse()]) {
      const result = replay(input);
      expect(result.attributed.get('a')).toBeCloseTo(4);
      expect(result.attributed.get('b')).toBeCloseTo(6);
      expect(result.unattributedPercent).toBe(69);
      expect(result.attributedPercent + result.unattributedPercent).toBe(79);
      expect(result.costPerPercent).toBe(5);
    }
  });

  it('never invents task allocations across unknown windows, missing prices, gaps or account switches', () => {
    const result = replay([event(0, 0, 0), event(1, 5, 10), event(2, 5, 10, 'unknown', null),
      event(3, 10, 10), event(4, 15, null), event(5, 20, 10), event(6, 20, 10, 'other', end + 86400000),
      event(7, 25, 10), event(39, 30, 10), event(40, 35, 10)]);
    expect(result.attributed.get('a')).toBe(15);
    expect(result.attributed.has('unknown')).toBe(false);
    expect(result.attributed.has('other')).toBe(false);
    expect(result.unattributedPercent).toBe(64);
    expect(result.partialTasks.has('a')).toBe(true);
    expect(result.partialTasks.has('unknown')).toBe(true);
  });

  it('deduplicates fragments and inherited fork usage before assigning quota', () => {
    const response = event(1, 10, 10);
    const duplicate = { ...event(1, 10, 50, 'b'), cost: 0, duplicateUsage: true };
    const fragment = { ...duplicate, cost: 50, duplicateUsage: false };
    for (const overlapping of [[duplicate, fragment], [fragment, duplicate]]) {
      const result = replay([event(0, 0, 0), response, response, ...overlapping]);
      expect(result.attributed.get('a')).toBe(10);
      expect(result.attributed.has('b')).toBe(false);
    }
  });

  it('respects the selected account window and its snapshot time, including corrections', () => {
    const events = [event(0, 0, 0), event(1, 10, 10), event(2, 20, 10), event(3, 20, 10, 'other', end + 86400000)];
    const result = replay(events, { ...window, usedPercent: 7, observedAtMs: start + 60000 } as typeof window);
    expect(result.attributed.get('a')).toBe(7);
    expect(result.unattributedPercent).toBe(0);
    const other = replay(events, { ...window, startedAtMs: start + 86400000, resetsAt: new Date(end + 86400000).toISOString() });
    expect(other.attributed.size).toBe(0);
    expect(other.unattributedPercent).toBe(79);
    expect(reconcileQuotaUsage(events, { ...window, usedPercent: NaN }, start + 3600000)).toBeNull();
  });

  it('rejects a quota regression within the same source but permits lagging parallel sources', () => {
    const result = replay([event(0, 10, 0), event(1, 15, 10), event(2, 14, 10), event(3, 20, 10),
      event(4, 19, 10, 'b'), event(5, 25, 10, 'b')]);
    expect(result.attributed.get('a')).toBe(5);
    expect(result.attributed.get('b')).toBe(5);
    expect(result.unattributedPercent).toBe(69);
  });
});
