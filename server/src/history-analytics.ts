import type { HistoryModelUsage, TokenUsage } from '../../shared/monitor';
import { addUsage } from '../../shared/usage-period';

export interface ModelUsageEvent {
  model: string | null;
  usage: TokenUsage;
  cost: number | null;
  tokensComplete: boolean;
}

/** Merge slices from different principal tasks; callers first deduplicate each task. */
export function mergeModelUsage(...sets: (HistoryModelUsage[] | undefined)[]): HistoryModelUsage[] {
  const grouped = new Map<string | null, HistoryModelUsage>();
  for (const set of sets) for (const value of set ?? []) {
    const previous = grouped.get(value.model);
    grouped.set(value.model, previous ? {
      model: value.model,
      usage: addUsage(previous.usage, value.usage),
      costUsd: previous.costUsd === null && value.costUsd === null ? null : (previous.costUsd ?? 0) + (value.costUsd ?? 0),
      unpricedTokens: previous.unpricedTokens + value.unpricedTokens,
      taskCount: previous.taskCount + value.taskCount,
      tokensComplete: previous.tokensComplete && value.tokensComplete,
      costComplete: previous.costComplete && value.costComplete
    } : { ...value, usage: { ...value.usage } });
  }
  return [...grouped.values()].sort((a, b) => b.usage.totalTokens - a.usage.totalTokens || (a.model ?? '').localeCompare(b.model ?? ''));
}

/** All events belong to one consolidated principal task, regardless of child count. */
export function modelUsageForTask(events: ModelUsageEvent[], complete = true): HistoryModelUsage[] {
  return mergeModelUsage(events.map(event => ({
    model: event.model,
    usage: event.usage,
    costUsd: event.cost,
    unpricedTokens: event.cost === null ? event.usage.totalTokens : 0,
    taskCount: 0,
    tokensComplete: complete && event.tokensComplete,
    costComplete: complete && event.tokensComplete && event.cost !== null
  }))).map(value => ({ ...value, taskCount: value.usage.totalTokens > 0 ? 1 : 0 }));
}
