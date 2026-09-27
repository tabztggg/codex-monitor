import { describe, expect, it } from 'vitest';
import type { HistoryJob } from '../../../shared/monitor';
import { calendarDate, visibleTasks } from '../../../web/src/presentation';

const task = (id: string, updatedAt: string): HistoryJob => ({ id, name: id, updatedAt } as HistoryJob);
const shownToday = (jobs: HistoryJob[], now: string, timeZone: string, activeIds = new Set<string>()) =>
  visibleTasks(jobs, activeIds, 'today', '', 'activity', Date.parse(now), false, 'en', 'desc', timeZone)
    .map(job => job.id).sort();

describe('task activity day uses the Monitor timezone', () => {
  it('provides a date-input value from the server calendar day', () => {
    expect(calendarDate('2026-09-26T18:00:00Z', 'Asia/Hong_Kong')).toBe('2026-09-27');
    expect(calendarDate('2026-09-26T18:00:00Z', 'America/New_York')).toBe('2026-09-26');
    expect(calendarDate('invalid', 'UTC')).toBe('');
  });

  it('uses Hong Kong midnight, excludes tomorrow, and keeps already active older tasks', () => {
    const jobs = [
      task('yesterday', '2026-09-26T15:59:59Z'),
      task('midnight', '2026-09-26T16:00:00Z'),
      task('today', '2026-09-27T09:00:00Z'),
      task('tomorrow', '2026-09-27T16:00:00Z'),
      task('active-old', '2026-09-20T00:00:00Z'),
      task('invalid-date', 'invalid')
    ];
    expect(shownToday(jobs, '2026-09-27T10:00:00Z', 'Asia/Hong_Kong', new Set(['active-old'])))
      .toEqual(['active-old', 'midnight', 'today']);
    expect(shownToday(jobs, '2026-09-27T10:00:00Z', 'UTC')).toEqual(['today', 'tomorrow']);
  });

  it('handles the 25-hour New York day when daylight saving time ends', () => {
    const jobs = [
      task('before', '2026-11-01T03:59:59Z'),
      task('midnight', '2026-11-01T04:00:00Z'),
      task('first-0130', '2026-11-01T05:30:00Z'),
      task('second-0130', '2026-11-01T06:30:00Z'),
      task('late', '2026-11-02T04:59:59Z'),
      task('after', '2026-11-02T05:00:00Z')
    ];
    expect(shownToday(jobs, '2026-11-02T04:30:00Z', 'America/New_York'))
      .toEqual(['first-0130', 'late', 'midnight', 'second-0130']);
  });
});
