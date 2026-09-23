import { describe, expect, it } from 'vitest';
import { comparePlanUsage, isComparisonPlan, summarizeTasks } from '../../../web/src/usage-display';
import type { HistoryJob } from '../../../shared/monitor';

describe('nominal weekly plan comparison', () => {
  it('uses the same consumption with different weekly denominators and no cap', () => {
    expect(comparePlanUsage(10, 'pro20x')).toBe(10);
    expect(comparePlanUsage(10, 'pro5x')).toBe(40);
    expect(comparePlanUsage(10, 'plus')).toBe(200);
    expect(comparePlanUsage(250, 'plus')).toBe(5000);
    expect(comparePlanUsage(0, 'plus')).toBe(0);
  });
  it('preserves unavailable values and rejects invalid saved options', () => {
    for (const value of [undefined, null, NaN, Infinity]) expect(comparePlanUsage(value, 'plus')).toBeNull();
    for (const value of ['toString', '__proto__', '', null, 20]) expect(isComparisonPlan(value)).toBe(false);
    expect(isComparisonPlan('pro5x')).toBe(true);
  });
  it('scales aggregate and individual rows consistently without changing source records', () => {
    const jobs = [{ estimated20xPercent: 10, estimated20xIsComplete: true }, { estimated20xPercent: 20, estimated20xIsComplete: false }] as HistoryJob[];
    const totals = summarizeTasks(jobs);
    expect(comparePlanUsage(totals.equivalent, 'pro5x')).toBe(120);
    expect(totals.equivalentComplete).toBe(false);
    expect(jobs.map(j => j.estimated20xPercent)).toEqual([10, 20]);
  });
});
