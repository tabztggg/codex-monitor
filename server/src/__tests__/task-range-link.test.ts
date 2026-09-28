import { describe, expect, it } from 'vitest';
import { taskRangeFromSearch } from '../../../web/src/task-range-link';

describe('day drilldown task links', () => {
  it('preserves a selected day and explicit date range', () => {
    expect(taskRangeFromSearch('?task=example&from=2026-09-27&to=2026-09-27')).toEqual({ from: '2026-09-27', to: '2026-09-27' });
    expect(taskRangeFromSearch('?from=2024-02-29&to=2024-03-01')).toEqual({ from: '2024-02-29', to: '2024-03-01' });
  });
  it.each(['?task=example', '?from=2026-02-29&to=2026-03-01', '?from=2026-09-29&to=2026-09-28', '?from=2026-9-2&to=2026-09-28', '?from=invalid&to=invalid', '?from=2026-09-27'])('ignores invalid or incomplete range: %s', search => {
    expect(taskRangeFromSearch(search)).toBeUndefined();
  });
});
