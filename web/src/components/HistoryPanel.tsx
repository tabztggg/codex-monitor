import { Fragment, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { HistoryJob, HistoryUsageAllocation, MonitorSnapshot, TokenUsage } from '../../../shared/monitor';
import { relativeActivity, taskTitle, visibleTasks, type TaskFilter } from '../presentation';
import { useTaskHistory } from '../useTaskHistory';

export function HistoryPanel({ snapshot, nowMs }: { snapshot: MonitorSnapshot; nowMs: number }) {
  const { jobs, allocation, updatedAt, error } = useTaskHistory();
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<TaskFilter>('today');
  const [sort, setSort] = useState('usage');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(30);
  const activeIds = useMemo(() => new Set(snapshot.activeSessions.map(session => session.id)), [snapshot.activeSessions]);
  const mergedJobs = useMemo(() => {
    const map = new Map(jobs.map(job => [job.id, job]));
    for (const session of snapshot.activeSessions) {
      const existing = map.get(session.id);
      if (existing) {
        map.set(session.id, { ...existing, name: session.name ?? existing.name, updatedAt: session.updatedAt > existing.updatedAt ? session.updatedAt : existing.updatedAt });
      } else {
        // A new session can precede its first token record. Unknown is not zero.
        map.set(session.id, { ...session, sourceKind: 'unknown', modelProvider: null, runCount: 0, lastRunStartedAt: session.lastTurnStartedAt, lastRunCompletedAt: null, lastRunDurationMs: null, totalDurationMs: 0, lastRunUsage: null, totalUsage: null, totalEstimatedCostUsd: null, totalEstimatedCostIsComplete: false, last24HoursUsage: null, last24HoursEstimatedCostUsd: null, sinceResetUsage: null, sinceResetEstimatedCostUsd: null, estimatedUsagePercentSinceReset: null });
      }
    }
    return [...map.values()];
  }, [jobs, snapshot.activeSessions]);
  const filtered = visibleTasks(mergedJobs, activeIds, filter, search, sort, nowMs);
  return (
    <section className="surface history-panel">
      <div className="panel-header">
        <h3>Tasks <span className="task-count">{filtered.length}</span></h3>
        <span className={`history-refresh ${error ? 'stale' : ''}`} title={updatedAt ? `Last successful refresh: ${formatDateTime(new Date(updatedAt).toISOString())}` : undefined}>
          {error ? 'Update failed · showing last data' : updatedAt ? 'Auto-updating · every 30 s' : 'Loading task usage…'}
        </span>
      </div>
      <div className="task-toolbar">
        <input aria-label="Search tasks" placeholder="Search tasks…" value={search} onChange={event => { setSearch(event.target.value); setVisibleCount(30); }} />
        <div className="task-filters" aria-label="Filter tasks">
          {([['active', 'Active'], ['today', 'Today'], ['all', 'All']] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={filter === value} onClick={() => { setFilter(value); setVisibleCount(30); }}>{label}</button>)}
        </div>
        <select aria-label="Sort tasks" value={sort} onChange={event => setSort(event.target.value)}><option value="usage">Highest usage</option><option value="activity">Last activity</option></select>
      </div>
      {error && <p className="history-error" role="alert">Could not refresh tasks: {error}</p>}
      {allocation?.observedSince && <p className="history-refresh" title="Consumption before observation and increments without sufficient recorded usage remain unattributed. Filters do not change attribution.">
        Attribution observed since {formatDateTime(allocation.observedSince)} · Unattributed quota: {formatUsagePercent(allocation.unattributedPercent ?? null)}
      </p>}
      <div className="task-table-scroll">
        <table className="task-table">
          <thead><tr><th scope="col">Task</th><th scope="col">Status</th><th scope="col" className="numeric">Approx. usage %<small>Since reset</small></th><th scope="col" className="numeric">Estimated total cost<small>Task lifetime · USD</small></th><th scope="col" className="numeric">Total tokens<small>Task lifetime</small></th><th scope="col" className="numeric">Activity</th></tr></thead>
          <tbody>{filtered.slice(0, visibleCount).map(job => {
            const title = taskTitle(job);
            const isExpanded = expanded === job.id;
            const active = activeIds.has(job.id);
            const linkedRun = snapshot.runs.find(run => run.rootThreadId === job.id);
            const toggle = () => setExpanded(isExpanded ? null : job.id);
            return <Fragment key={job.id}>
              <tr className={`task-row ${isExpanded ? 'expanded' : ''}`} onClick={toggle}>
                <td><button type="button" className="task-title-button" aria-expanded={isExpanded} aria-controls={`task-detail-${job.id}`} onClick={event => { event.stopPropagation(); toggle(); }} title={title}>{title}</button></td>
                <td><span className={`task-state ${active ? 'active' : ''}`}>{active ? 'Active' : 'Finished'}</span></td>
                <td className="numeric task-share" title={formatUsageAllocationTitle(allocation)}>{formatUsagePercent(job.estimatedUsagePercentSinceReset)}</td>
                <td className="numeric" title={formatEstimatedCostTitle(job)}>{formatEstimatedCost(job.totalEstimatedCostUsd, job.totalEstimatedCostIsComplete)}</td>
                <td className="numeric" title={formatTokenUsageDetails(job.totalUsage)}>{formatTokenUsage(job.totalUsage)}</td>
                <td className="numeric task-activity"><time dateTime={job.updatedAt} title={formatDateTime(job.updatedAt)}>{relativeActivity(job.updatedAt, nowMs)}</time></td>
              </tr>
              <tr hidden={!isExpanded} id={`task-detail-${job.id}`} className="task-detail"><td colSpan={6}>
                {isExpanded && <div className="task-detail-content">
                  <div className="task-detail-links"><a href={`codex://threads/${encodeURIComponent(job.id)}`}>Open in Codex ↗</a>{linkedRun && <Link to={`/runs/${linkedRun.id}`}>View live transcript and run</Link>}</div>
                  <h4>Task preview</h4><pre>{job.preview ?? 'No transcript preview available.'}</pre>
                  <dl><dt>Path</dt><dd>{job.cwd ?? 'Unavailable'}</dd><dt>Source</dt><dd>{job.sourceKind}</dd><dt>Runs</dt><dd>{job.runCount}</dd><dt>Total tokens</dt><dd>{formatTokenUsageDetails(job.totalUsage) ?? 'Unavailable'}</dd></dl>
                  <p>{formatEstimatedCostTitle(job)}</p><p>{formatUsageAllocationTitle(allocation)}</p>
                </div>}
              </td></tr>
            </Fragment>;
          })}</tbody>
        </table>
      </div>
      {!filtered.length && <div className="task-empty">{!updatedAt && !error ? 'Loading tasks…' : 'No matching tasks.'}</div>}
      {filtered.length > visibleCount && <div className="history-actions"><button type="button" className="action-button ghost" onClick={() => setVisibleCount(count => count + 30)}>Show more tasks</button></div>}
    </section>
  );
}
function formatTokenUsage(usage: TokenUsage | null): string {
  if (!usage) {
    return "--";
  }

  return new Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: 1
  }).format(usage.totalTokens);
}

function formatTokenUsageDetails(usage: TokenUsage | null): string | undefined {
  if (!usage) {
    return undefined;
  }

  const numberFormat = new Intl.NumberFormat("en");
  return [
    `${numberFormat.format(usage.totalTokens)} total`,
    `${numberFormat.format(usage.inputTokens)} input`,
    `${numberFormat.format(usage.cachedInputTokens)} cached`,
    `${numberFormat.format(usage.cacheWriteInputTokens ?? 0)} cache writes`,
    `${numberFormat.format(usage.outputTokens)} output`,
    `${numberFormat.format(usage.reasoningOutputTokens)} reasoning`
  ].join(", ");
}

function formatEstimatedCost(
  costUsd: number | null,
  complete = true
): string {
  if (costUsd === null || !Number.isFinite(costUsd)) {
    return "--";
  }

  const formatted = new Intl.NumberFormat("en", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: costUsd < 0.01 ? 3 : 2,
    maximumFractionDigits: costUsd < 0.01 ? 3 : 2
  }).format(costUsd);
  return complete ? formatted : `${formatted}+`;
}

function formatEstimatedCostTitle(job: HistoryJob): string {
  if (job.totalEstimatedCostUsd === null) {
    return "No API-equivalent cost can be estimated because the recorded model has no matching standard API price. This is not a billed ChatGPT or Codex charge.";
  }

  if (!job.totalEstimatedCostIsComplete) {
    return "Lower-bound API-equivalent estimate for recorded usage whose model has a standard API token price. The + indicates that usage from unpriced internal or unknown models is excluded. This is not a billed ChatGPT or Codex charge and excludes tool-call fees.";
  }

  return "Estimated API-equivalent cost for all recorded token usage in this task, using the recorded model and standard API token prices. It is not a billed ChatGPT or Codex charge and excludes tool-call fees.";
}

function formatUsagePercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return "--";
  }

  return `${new Intl.NumberFormat("en", {
    minimumFractionDigits: value > 0 && value < 0.1 ? 2 : 1,
    maximumFractionDigits: value > 0 && value < 0.1 ? 2 : 1
  }).format(value)}%`;
}

function formatUsageAllocationTitle(
  allocation: HistoryUsageAllocation | null
): string {
  if (
    !allocation ||
    allocation.status !== "available" ||
    !allocation.windowStartedAt ||
    !allocation.resetsAt
  ) {
    return "Approximate per-task usage is unavailable because Codex did not expose the current primary quota limit and reset period.";
  }

  const limit = allocation.limitName ?? "Overall Codex";
  const window = allocation.windowLabel
    ? ` ${allocation.windowLabel.toLocaleLowerCase()}`
    : "";
  const basis =
    allocation.basis === "apiEquivalentCost"
      ? "the API-equivalent cost of priceable recorded usage"
      : "available local activity";

  return `Estimated percentage of the total ${limit}${window} quota consumed by this task since reset. Each observed quota increase is allocated using ${basis} recorded since the previous increase, then accumulated. Previous allocations are preserved. Consumption before observation and increments with missing or unpriced usage remain unattributed. This is an estimate, not an OpenAI per-task measurement. Resets at ${formatDateTime(allocation.resetsAt)}.`;
}

function formatDateTime(isoValue: string): string {
  const date = new Date(isoValue);
  if (Number.isNaN(date.getTime())) {
    return "n/a";
  }

  return date.toLocaleString("en");
}
