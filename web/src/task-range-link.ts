/** Only explicit, valid calendar dates can change a task deep link's scope. */
export function taskRangeFromSearch(search: string): { from: string; to: string } | undefined {
  const params = new URLSearchParams(search);
  const from = params.get('from');
  const to = params.get('to');
  const isDate = (value: string | null): value is string => {
    if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const timestamp = Date.parse(`${value}T00:00:00Z`);
    return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
  };
  return isDate(from) && isDate(to) && from <= to ? { from, to } : undefined;
}
