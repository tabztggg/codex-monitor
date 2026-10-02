import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { QuotaCalibration, type QuotaCalibrationEvent } from '../quota-equivalent';

describe('quota sample migration', () => {
  it('scopes manual overrides to their account and quota window and preserves a historical reference without hiding reconciliation', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'quota-manual-scope-'));
    const file = path.join(dir, 'reference.json');
    const start = Date.parse('2026-09-30T00:00:00Z');
    const resetsAt = new Date(start + 604800000).toISOString();
    const scope = { accountId: 'account-a', startedAtMs: start, resetsAt, usedPercent: 10 };
    const events: QuotaCalibrationEvent[] = [
      { id: 'baseline', taskId: 'task', at: start, cost: 0, limit: { used: 0, resetsAt: start + 604800000 } },
      { id: 'response', taskId: 'task', at: start + 60000, cost: 20, limit: { used: 10, resetsAt: start + 604800000 } }
    ];
    try {
      writeFileSync(file + '.manual.json', JSON.stringify({ version: 1, costPerPercent: 7, updatedAt: start, accountId: 'account-a', resetsAt }));
      const calibration = new QuotaCalibration(file);
      const matching = calibration.resolve(events, start, start + 120000, scope);
      expect(matching).toMatchObject({ costPerPercent: 7, source: 'manual' });
      expect(matching.reconciliation?.attributed.get('task')).toBe(10);
      expect(calibration.resolve(events, start, start + 120000, { ...scope, accountId: 'account-b' }))
        .toMatchObject({ costPerPercent: 2, source: 'current' });
      const changed = events.map(e => ({ ...e, cost: e.cost! * 5 }));
      expect(calibration.resolve(changed, start, start + 180000, { ...scope, accountId: 'history-account', allowUpdate: false }))
        .toMatchObject({ costPerPercent: 2, source: 'previous' });
      const nextPeriod = { ...scope, startedAtMs: start + 604800000, resetsAt: new Date(start + 2 * 604800000).toISOString() };
      expect(calibration.resolve([], nextPeriod.startedAtMs, nextPeriod.startedAtMs + 120000, nextPeriod))
        .toMatchObject({ costPerPercent: 2, source: 'previous' });
      expect(new QuotaCalibration(file).resolve([], null, nextPeriod.startedAtMs + 180000))
        .toMatchObject({ costPerPercent: 2, source: 'previous' });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('retains a reference when readable intervals cover too little cost and persists attribution metadata before calibration qualifies', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'quota-partial-coverage-'));
    const file = path.join(dir, 'reference.json');
    const start = Date.parse('2026-09-30T00:00:00Z');
    const end = start + 604800000;
    const scope = { accountId: 'account-a', startedAtMs: start, resetsAt: new Date(end).toISOString(), usedPercent: 10 };
    const event = (minute: number, used: number, cost: number | null, reset: number | null = end): QuotaCalibrationEvent =>
      ({ id: `sample-${minute}`, taskId: 'task', at: start + minute * 60000, cost, limit: reset === null ? null : { used, resetsAt: reset } });
    try {
      const first = new QuotaCalibration(file);
      expect(first.resolve([event(0, 0, 0), event(1, 2, 20)], start, start + 120000, { ...scope, usedPercent: 2 }))
        .toMatchObject({ costPerPercent: null });
      expect(new QuotaCalibration(file).recordedEvents()).toHaveLength(2);
      writeFileSync(file + '.manual.json', JSON.stringify({ version: 1, accountId: 'old-account',
        resetsAt: new Date(start).toISOString(), costPerPercent: 12, updatedAt: start - 60000 }));
      const restarted = new QuotaCalibration(file);
      const result = restarted.resolve([event(2, 2, 1, null), event(3, 3, 100), event(4, 8, 1), event(5, 10, 1)], start, start + 360000, scope);
      expect(result).toMatchObject({ costPerPercent: 12, source: 'previous' });
      expect(result.reconciliation?.attributedPercent).toBe(9);
      expect(result.coverage?.cost).toBeLessThan(0.9);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('keeps v3 calibration visible as previous across restarts, but replaces it using only fresh corrected samples', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'quota-parser-migration-'));
    const file = path.join(dir, 'reference.json');
    const start = Date.parse('2026-09-23T00:00:00Z');
    const event = (minute: number, used: number, cost: number): QuotaCalibrationEvent => ({
      id: `corrected-${minute}`, streamId: 'task', at: start + minute * 60000,
      cost, limit: { used, resetsAt: start + 604800000 }
    });
    try {
      const old = [event(0, 0, 0), event(1, 10, 100)];
      writeFileSync(file, JSON.stringify({ version: 1, calibrationPolicy: 2, sampleVersion: 3,
        costPerPercent: 10, quotaPercent: 10, windowStart: start, updatedAt: start + 60000,
        referenceSamplesKnown: true, samples: old }));
      expect(new QuotaCalibration(file).resolve([], start, start + 120000)).toMatchObject({
        costPerPercent: 10, source: 'previous', quotaPercent: 0
      });
      expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ sampleVersion: 4, samples: [], referenceSamplesKnown: false });
      const restarted = new QuotaCalibration(file);
      // Re-parsed older events must not overwrite the preserved reference with
      // a narrower selection of the old archive scope.
      expect(restarted.resolve([event(0, 0, 0), event(1, 10, 10)], start, start + 120000))
        .toMatchObject({ costPerPercent: 10, source: 'previous' });
      const fresh = [event(2, 10, 0), event(3, 14, 8)];
      expect(restarted.resolve(fresh, start, start + 240000)).toMatchObject({ costPerPercent: 10, source: 'previous' });
      expect(restarted.resolve([event(4, 15, 2)], start, start + 300000))
        .toMatchObject({ costPerPercent: 2, source: 'current', quotaPercent: 5 });
      expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ calibrationPolicy: 3, sampleVersion: 4 });
      writeFileSync(file + '.manual.json', JSON.stringify({ version: 1, costPerPercent: 7, updatedAt: start }));
      expect(new QuotaCalibration(file).resolve([], start, start + 300000))
        .toMatchObject({ costPerPercent: 2, source: 'previous' });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('recognizes the same current reference when the account window arrives after startup recovery', () => {
    const start = Date.parse('2026-09-23T00:00:00Z');
    const events: QuotaCalibrationEvent[] = [0, 1].map(minute => ({
      id: `event-${minute}`, streamId: 'task', at: start + minute * 60000,
      cost: minute * 60, limit: { used: minute * 5, resetsAt: start + 604800000 }
    }));
    const calibration = new QuotaCalibration();
    expect(calibration.resolve(events, null, start + 120000)).toMatchObject({
      costPerPercent: 12, source: 'previous'
    });
    expect(calibration.resolve(events, start, start + 180000)).toMatchObject({
      costPerPercent: 12, quotaPercent: 5, source: 'current'
    });
  });

  it('retains the displayed reference while replacing incompatible sample identities without double counting', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'quota-migration-'));
    const file = path.join(dir, 'reference.json');
    const start = Date.parse('2026-09-23T00:00:00Z');
    const event = (minute: number, used: number, cost: number): QuotaCalibrationEvent => ({
      id: `v3:sample-${minute}`, streamId: 'stream-a', at: start + minute * 60000,
      cost, limit: { used, resetsAt: start + 604800000 }
    });
    try {
      const oldSamples = [event(0, 0, 0), event(1, 5, 5)].map((e, i) => ({ ...e, id: `old:${i}` }));
      writeFileSync(file, JSON.stringify({ version: 1, costPerPercent: 4, quotaPercent: 20,
        windowStart: start - 86400000, updatedAt: start - 60000,
        referenceSamplesKnown: true, samples: oldSamples }));
      const calibration = new QuotaCalibration(file);
      const fresh = [event(0, 0, 0), event(1, 3, 36)];
      expect(calibration.resolve(fresh, start, start + 120000)).toMatchObject({
        costPerPercent: 4, source: 'previous', quotaPercent: 3
      });
      expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ sampleVersion: 4, samples: fresh });
      const restarted = new QuotaCalibration(file);
      expect(restarted.resolve([...fresh, event(3, 5, 24)], start, start + 240000)).toMatchObject({
        costPerPercent: 12, source: 'current', quotaPercent: 5
      });
      expect(new QuotaCalibration(file).resolve([], start, start + 300000).costPerPercent).toBe(12);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
