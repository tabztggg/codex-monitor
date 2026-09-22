import type { HistoryPeriod, HistoryUsageDay, TokenUsage } from './monitor';

export function localDay(timestamp: number): string {
  const d = new Date(timestamp);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function periodStart(period: HistoryPeriod, now: number, quotaStart: number | null): number | null {
  if (period === 'quota') return quotaStart;
  if (period === 'lifetime') return null;
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  if (period === '7d') day.setDate(day.getDate() - 6);
  return day.getTime();
}

export function addUsage(a: TokenUsage | null, b: TokenUsage): TokenUsage {
  return {
    inputTokens: (a?.inputTokens ?? 0) + b.inputTokens,
    cachedInputTokens: (a?.cachedInputTokens ?? 0) + b.cachedInputTokens,
    cacheWriteInputTokens: (a?.cacheWriteInputTokens ?? 0) + (b.cacheWriteInputTokens ?? 0),
    outputTokens: (a?.outputTokens ?? 0) + b.outputTokens,
    reasoningOutputTokens: (a?.reasoningOutputTokens ?? 0) + b.reasoningOutputTokens,
    totalTokens: (a?.totalTokens ?? 0) + b.totalTokens
  };
}

export function mergeDays(...sets: (HistoryUsageDay[] | undefined)[]): HistoryUsageDay[] {
  const days = new Map<string, HistoryUsageDay>();
  for (const set of sets) for (const day of set ?? []) {
    const old = days.get(day.date);
    days.set(day.date, old ? {
      date: day.date, usage: addUsage(old.usage, day.usage),
      costUsd: old.costUsd === null && day.costUsd === null ? null : (old.costUsd ?? 0) + (day.costUsd ?? 0),
      unpricedTokens: old.unpricedTokens + day.unpricedTokens
    } : { ...day, usage: { ...day.usage } });
  }
  return [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
}
