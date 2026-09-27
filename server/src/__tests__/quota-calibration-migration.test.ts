import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { QuotaCalibration, type QuotaCalibrationEvent } from '../quota-equivalent';

describe('quota sample migration', () => {
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
        .toMatchObject({ costPerPercent: 7, source: 'manual' });
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
