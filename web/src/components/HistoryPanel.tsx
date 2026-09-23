import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { HistoryAnalysis, HistoryJob, HistoryPeriod, HistoryUsageAllocation, MonitorSnapshot, TokenUsage } from '../../../shared/monitor';
import { groupTasksByProject, projectTitle, relativeActivity, taskTitle, visibleTasks, type ProjectTaskGroup, type TaskFilter, type TaskSortColumn, type SortDirection } from '../presentation';
import { useTaskHistory } from '../useTaskHistory';
import { useI18n } from '../LanguageContext';
import type { I18n, Translate } from '../localization';
import { TaskInsights } from './TaskInsights';
import { formatEstimatedCost, formatTokenCount, formatUsagePercent, comparePlanUsage, comparisonPlans, isComparisonPlan, type ComparisonPlan } from '../usage-display';
import { parseTableView, tableColumns, taskColumns as columns, type TableView } from '../table-view';

const refreshIntervals = [30_000, 60_000, 120_000, 300_000, 600_000];
const periods: Record<HistoryPeriod, string> = { quota: 'Current quota period', today: 'Today', '7d': 'Last 7 days', lifetime: 'Task lifetime' };
function readView() {
  try { return parseTableView(window.localStorage.getItem('codex-monitor-table-view')); }
  catch { return parseTableView(null); }
}

export function HistoryPanel({ snapshot, nowMs, connectionLabel = 'connecting', overviewSlot }: { snapshot: MonitorSnapshot; nowMs: number; connectionLabel?: string; overviewSlot?: ReactNode }) {
  const i18n = useI18n();
  const { t, locale, language, dateTime, label } = i18n;
  const [interval, setInterval] = useState(() => {
    try { const saved = Number(window.localStorage.getItem('codex-monitor-refresh-interval-ms')); if (refreshIntervals.includes(saved)) return saved; } catch { /* Storage is optional. */ }
    return 30_000;
  });
  const [comparisonPlan, setComparisonPlan] = useState<ComparisonPlan>(() => {
    try { const saved = window.localStorage.getItem('codex-monitor-comparison-plan'); if (isComparisonPlan(saved)) return saved; } catch { /* Storage is optional. */ }
    return 'pro20x';
  });
  useEffect(() => { try { window.localStorage.setItem('codex-monitor-comparison-plan', comparisonPlan); } catch { /* Storage is optional. */ } }, [comparisonPlan]);
  const planLabel = comparisonPlans[comparisonPlan].label;
  const equivalentTitle = t('{plan} equivalent usage', { plan: planLabel });
  const columnTitle = (c: typeof columns[number]) => c.key === 'equivalent20x' ? equivalentTitle : t(c.title);
  const columnHeading = (c: typeof columns[number]) => c.key === 'equivalent20x' ? t('{plan} equiv.', { plan: planLabel })
    : c.key === 'usage' ? t('Quota %') : c.key === 'cost' ? t('Est. cost') : c.key === 'tokens' ? t('Tokens') : columnTitle(c);
  const [period, setPeriod] = useState<HistoryPeriod>('quota');
  // Retry the initial history read as soon as the account/window becomes ready.
  // Ignore quota percentages and reset timestamp jitter so normal updates still
  // respect the chosen refresh interval.
  const quota = snapshot.codexUsage;
  const quotaLimit = quota.limits.find(limit => limit.id === 'codex') ?? (quota.primaryLimit?.id === 'codex' ? quota.primaryLimit : null);
  const accountReadyKey = JSON.stringify([quota.account?.type ?? null, quota.account?.email ?? null,
    Boolean(quotaLimit?.primary?.resetsAt || quotaLimit?.secondary?.resetsAt)]);
  const { jobs, allocation, analysis, nextRefreshAt, refreshNow, rebuildStatistics, updatedAt, error, archives, loading, requestedMode, loadArchives } = useTaskHistory(interval, period, accountReadyKey);
  const activePeriod = analysis?.period ?? 'quota';
  const [view, setView] = useState(readView);
  useEffect(() => { try { window.localStorage.setItem('codex-monitor-table-view', JSON.stringify(view)); } catch { /* Storage is optional. */ } }, [view]);
  useEffect(() => { try { window.localStorage.setItem('codex-monitor-refresh-interval-ms', String(interval)); } catch { /* Storage is optional. */ } }, [interval]);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<TaskFilter>('all');
  const [hideArchived, setHideArchived] = useState(false);
  const [groupByProject, setGroupByProject] = useState(false);
  const [sort, setSort] = useState<TaskSortColumn>(() => view.layout === 'simple' ? view.metric : view.hidden.includes('usage') ? 'task' : 'usage');
  const [direction, setDirection] = useState<SortDirection>(() => view.layout === 'full' && view.hidden.includes('usage') ? 'asc' : 'desc');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(new Set<string>());
  const basisRef = useRef<HTMLDetailsElement>(null);
  const showBasis = () => {
    if (!basisRef.current) return;
    basisRef.current.open = true;
    basisRef.current.scrollIntoView({ block: 'start' });
    basisRef.current.querySelector('summary')?.focus();
  };
  const shown = (key: TaskSortColumn) => !view.hidden.includes(key);
  const simple = view.layout === 'simple';
  const visibleColumns = tableColumns(view);
  const changeLayout = (layout: TableView['layout']) => {
    const next = { ...view, layout };
    setView(next);
    if (!tableColumns(next).some(c => c.key === sort)) {
      setSort(layout === 'simple' ? next.metric : 'task');
      setDirection(layout === 'simple' ? 'desc' : 'asc');
    }
  };
  const shortPeriod = t(activePeriod === 'quota' ? 'This period' : activePeriod === 'lifetime' ? 'Lifetime' : activePeriod === '7d' ? '7 days' : 'Today');
  const subtitle = (key: TaskSortColumn) => key === 'usage' ? t('Current account · This period') : key === 'equivalent20x' ? `${t('Across accounts')} · ${shortPeriod}`
    : key === 'cost' ? `${shortPeriod} · USD` : key === 'tokens' ? shortPeriod : null;
  const headerDescription = (c: typeof columns[number]) => `${columnTitle(c)}${c.key === 'usage' ? ` · ${t('Current account · This period')}`
    : c.key === 'equivalent20x' ? ` · ${t('All accounts')} · ${t(periods[activePeriod])}` : c.key === 'cost' || c.key === 'tokens' ? ` · ${t(periods[activePeriod])}` : ''}`;
  const activeIds = useMemo(() => new Set(snapshot.activeSessions.map(s => s.id)), [snapshot.activeSessions]);
  const mergedJobs = useMemo(() => {
    const map = new Map(jobs.map(job => [job.id, job]));
    for (const session of snapshot.activeSessions) {
      const old = map.get(session.id);
      if (old) map.set(session.id, { ...old, name: session.name ?? old.name, updatedAt: session.updatedAt > old.updatedAt ? session.updatedAt : old.updatedAt });
      else map.set(session.id, { ...session, archived: false, sourceKind: 'unknown', modelProvider: null, runCount: 0, lastRunStartedAt: session.lastTurnStartedAt, lastRunCompletedAt: null, lastRunDurationMs: null, totalDurationMs: 0, lastRunUsage: null, totalUsage: null, totalEstimatedCostUsd: null, totalEstimatedCostIsComplete: false, last24HoursUsage: null, last24HoursEstimatedCostUsd: null, sinceResetUsage: null, sinceResetEstimatedCostUsd: null, estimatedUsagePercentSinceReset: null });
    }
    return [...map.values()].map(job => ({ ...job,
      totalUsage: job.periodMetrics ? job.periodMetrics.usage : job.totalUsage,
      totalEstimatedCostUsd: job.periodMetrics ? job.periodMetrics.costUsd : job.totalEstimatedCostUsd,
      totalEstimatedCostIsComplete: job.periodMetrics ? job.periodMetrics.costComplete : job.totalEstimatedCostIsComplete,
      estimatedUsagePercentSinceReset: activePeriod === 'quota' ? job.estimatedUsagePercentSinceReset : null
    }));
  }, [jobs, snapshot.activeSessions, activePeriod]);
  const displayed = visibleTasks(mergedJobs, activeIds, filter, search, sort, nowMs, hideArchived, language, direction);
  const projectGroups = groupByProject ? groupTasksByProject(mergedJobs, displayed, sort, direction, activeIds, language).filter(g => !search.trim() || g.jobs.length > 0) : [];
  const sections = groupByProject ? projectGroups.map(group => ({ id: group.id, group, jobs: collapsed.has(group.id) ? [] : group.jobs })) : [{ id: 'ungrouped', group: null, jobs: displayed }];
  const nextDirection = (key: TaskSortColumn): SortDirection => sort === key ? direction === 'asc' ? 'desc' : 'asc' : key === 'task' || key === 'status' ? 'asc' : 'desc';
  const seconds = nextRefreshAt ? Math.min(interval / 1000, Math.max(0, Math.ceil((nextRefreshAt - nowMs) / 1000))) : 0;
  const quotaTitle = activePeriod === 'quota' ? formatUsageAllocationTitle(allocation, i18n) : t('Account attribution is available only for the current quota period.');
  const groupValue = (g: ProjectTaskGroup, key: TaskSortColumn) => key === 'usage' ? <span className={g.quotaPercent ? 'value-quota' : 'value-muted'}>{formatUsagePercent(g.quotaPercent, locale)}{g.quotaPercent !== null && !g.quotaIsComplete ? '+' : ''}</span>
    : key === 'equivalent20x' ? <span className={g.equivalent20xPercent ? 'value-equivalent' : 'value-muted'}>{formatUsagePercent(comparePlanUsage(g.equivalent20xPercent, comparisonPlan), locale)}{g.equivalent20xPercent !== null && !g.equivalent20xIsComplete ? '+' : ''}</span>
    : key === 'cost' ? formatEstimatedCost(g.totalEstimatedCostUsd, g.totalEstimatedCostIsComplete, locale)
    : key === 'tokens' ? formatTokenCount(g.totalTokens, locale, g.tokensIsComplete)
    : key === 'activity' ? <time dateTime={g.updatedAt} title={dateTime(g.updatedAt)}>{relativeActivity(g.updatedAt, nowMs, language)}</time> : null;
  const taskValue = (job: HistoryJob, key: TaskSortColumn) => {
    const projectLabel = job.project?.missing ? t('Unknown project · {id}', { id: job.project.id.slice(0, 8) }) : job.project?.name ?? t('No project');
    if (key === 'task') return <div className="task-identity"><span className={`task-icon ${job.archived ? 'archived' : activeIds.has(job.id) ? 'active' : ''}`} aria-hidden="true">{job.archived ? '▤' : '▥'}</span><div><button type="button" className="task-title-button" aria-expanded={expanded === job.id} aria-controls={`task-detail-${job.id}`} title={taskTitle(job, language)} onClick={e => { e.stopPropagation(); setExpanded(expanded === job.id ? null : job.id); }}>{taskTitle(job, language)}</button><small className="task-project" title={projectLabel}>{projectLabel}</small></div></div>;
    if (key === 'status') return <span className={`task-state ${activeIds.has(job.id) ? 'active' : ''}`} title={job.archivedAt ? t('Archived at {time}', { time: dateTime(job.archivedAt) }) : undefined}>{t(job.archived ? 'Archived' : activeIds.has(job.id) ? 'Active' : 'Finished')}</span>;
    if (key === 'usage') return <span className={job.estimatedUsagePercentSinceReset ? 'value-quota' : 'value-muted'} title={quotaTitle}>{formatUsagePercent(job.estimatedUsagePercentSinceReset, locale)}</span>;
    if (key === 'equivalent20x' && job.estimated20xPercent == null) return <span className="value-muted metric-pending">{t(allocation?.equivalent20x?.costPerPercentUsd ? 'Unavailable' : 'Waiting for calibration')}</span>;
    if (key === 'equivalent20x') return <span className={job.estimated20xPercent ? 'value-equivalent' : 'value-muted'} title={t('One {plan} week = 100%', { plan: planLabel })}>{formatUsagePercent(comparePlanUsage(job.estimated20xPercent, comparisonPlan), locale)}{job.estimated20xPercent != null && !job.estimated20xIsComplete ? '+' : ''}</span>;
    if (key === 'cost') return <span title={formatEstimatedCostTitle(job, t)}>{formatEstimatedCost(job.totalEstimatedCostUsd, job.totalEstimatedCostIsComplete, locale)}</span>;
    if (key === 'tokens') return <span title={formatTokenUsageDetails(job.totalUsage, i18n)}>{formatTokenCount(job.totalUsage?.totalTokens ?? null, locale, job.periodMetrics?.tokensComplete !== false)}</span>;
    return <time dateTime={job.updatedAt} title={dateTime(job.updatedAt)}>{relativeActivity(job.updatedAt, nowMs, language)}</time>;
  };
  return <section className={`history-panel density-${view.density} ${simple ? 'simple-table' : 'full-table'}`} aria-busy={loading}>
    <div className="dashboard-heading" id="usage-overview">
      <div className="dashboard-title"><h2>{t('Usage overview')}</h2><p>{t('Current account quota and cross-account usage, clearly separated.')}</p></div>
      <div className="history-refresh-controls">
        <span className={`connection-status ${connectionLabel === 'live' && snapshot.server.initialized ? 'connected' : ''}`}>{connectionLabel === 'live' && snapshot.server.initialized ? t('Connected') : t('Connection: {status}', { status: label(connectionLabel) })}</span>
        <label className="refresh-interval"><span className="sr-only">{t('Task refresh interval')}</span><select value={interval} onChange={e => { const n = Number(e.target.value); if (refreshIntervals.includes(n)) setInterval(n); }}>{refreshIntervals.map(n => <option key={n} value={n}>{n === 30000 ? t('30 seconds') : n === 60000 ? t('1 minute') : t('{count} minutes', { count: n / 60000 })}</option>)}</select></label>
        <button type="button" className="small-control refresh-button" disabled={loading} onClick={refreshNow}><span aria-hidden="true">↻</span> {t(loading ? 'Refreshing…' : 'Refresh now')}</button>
        <details className="view-settings refresh-menu"><summary aria-label={t('More actions')} title={t('More actions')}>···</summary><div className="view-settings-content">
          <span className={`history-refresh ${error ? 'stale' : ''}`}>{t(error ? 'Update failed · showing last data' : loading ? 'Refreshing…' : 'Auto-updating')}</span>
          {updatedAt && <span className="muted-note">{t('Last successful refresh: {time}', { time: dateTime(new Date(updatedAt).toISOString()) })}</span>}
          <span className="refresh-countdown">{loading ? t('Refreshing…') : nextRefreshAt ? t('Next refresh in {time}', { time: `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` }) : t('Automatic refresh paused')}</span>
          <button type="button" className="small-control" disabled={loading} onClick={rebuildStatistics} title={t('Re-read logs in the current archive scope. Saved quota attribution is preserved.')}>{t('Rebuild statistics')}</button>
        </div></details>
      </div>
    </div>
    {overviewSlot}
    <section className="cross-account-section" aria-labelledby="cross-account-title">
      <div className="statistics-heading">
        <h2 id="cross-account-title">{t('Cross-account usage estimate')} <span className="scope-badge">{t('Local records')}</span></h2>
        <div className="statistics-controls">
          <div className="period-control"><span id="statistics-range-label">{t('Statistics time range')}</span><div className="period-buttons" role="group" aria-labelledby="statistics-range-label" aria-describedby="statistics-range-help">{(['today', '7d', 'quota', 'lifetime'] as const).map(key => <button type="button" key={key} aria-pressed={period === key} onClick={() => setPeriod(key)}>{t(key === 'quota' ? 'This period' : key === 'lifetime' ? 'Lifetime' : key === '7d' ? '7 days' : 'Today')}</button>)}</div></div>
          <label className="inline-field comparison-control">{t('Equivalent usage comparison')}<select aria-describedby="comparison-plan-help" value={comparisonPlan} onChange={e => { if (isComparisonPlan(e.target.value)) setComparisonPlan(e.target.value); }}>{Object.entries(comparisonPlans).map(([key, plan]) => <option value={key} key={key}>{plan.label}</option>)}</select></label>
        </div>
      </div>
      <p className="statistics-applies">{t('Equivalent usage · Cost · Tokens')}</p>
      {error && <p className="history-error" role="alert">{t('Could not refresh tasks: {error}', { error: i18n.error(error) })}</p>}
      {period !== activePeriod && <p className="muted-note" role="status">{t('Loading the selected period. Previous results remain labeled with their original period.')}</p>}
      <HistoryPeriodScope analysis={analysis ?? null} allocation={allocation} nowMs={nowMs} />
      <TaskInsights jobs={mergedJobs} analysis={analysis ?? null} allocation={allocation} periodLabel={t(periods[activePeriod])} comparisonPlan={comparisonPlan} section="summary" onShowBasis={showBasis} />
    </section>
    <section className="task-list-section" id="task-details" aria-labelledby="task-list-title">
      <div className="task-section-heading"><h2 id="task-list-title">{t('Task details')} <span className="task-count">{displayed.length}</span></h2>
    <div className="archive-scope-controls"><span role="status">{loading && requestedMode === 'all' ? t('Calculating all archives… Keeping the previous results until complete.') : t(archives.mode === 'all' ? 'Statistics include all {count} archived tasks.' : 'Statistics include only the {count} most recently archived tasks.', { count: archives.included })}</span>
      <div className="task-filters"><button type="button" disabled={loading} onClick={() => loadArchives(error && requestedMode === 'all' ? 'all' : archives.mode === 'all' ? 'recent' : 'all')}>{t(error && requestedMode === 'all' ? 'Retry all archive statistics' : archives.mode === 'all' ? 'Only calculate the latest 30 archives' : 'Calculate all archives')}</button></div>
      {loading && requestedMode === 'all' && <button type="button" className="small-control" onClick={() => loadArchives('recent')}>{t('Return to the latest 30 archives')}</button>}
    </div>
      </div>
      <div className="task-data-panel">
    <div className="task-toolbar">
      <input aria-label={t('Search tasks')} placeholder={t('Search tasks or projects…')} value={search} onChange={e => setSearch(e.target.value)} />
      <div className="task-filters" aria-label={t('Filter tasks')}>{([['all', 'All'], ['active', 'Active'], ['today', 'Today']] as const).map(([v, text]) => <button key={v} type="button" aria-pressed={filter === v} onClick={() => setFilter(v)}>{t(text)}</button>)}</div>
      <div className="task-filters"><button type="button" aria-pressed={hideArchived} title={t('Only hide archived rows; the selected archive scope still counts toward usage.')} onClick={() => setHideArchived(v => !v)}>{t(hideArchived ? 'Show archived tasks' : 'Hide archived tasks')}</button></div>
      <div className="task-filters"><button type="button" aria-pressed={groupByProject} onClick={() => setGroupByProject(v => !v)}>{t('Group by project')}</button></div>
      <label className="inline-field table-view-choice">{t('Table view')}<select value={view.layout} onChange={e => changeLayout(e.target.value === 'simple' ? 'simple' : 'full')}><option value="full">{t('Full table')}</option><option value="simple">{t('Simple view')}</option></select></label>
      {simple && <label className="inline-field table-metric-choice">{t('Shown metric')}<select value={view.metric} onChange={e => { const key = e.target.value as TaskSortColumn; setView(v => ({ ...v, metric: key })); setSort(key); setDirection('desc'); }}>{columns.filter(c => c.numeric).map(c => <option key={c.key} value={c.key}>{columnTitle(c)}</option>)}</select></label>}
      <details className="view-settings"><summary>{t('View options')}</summary><div className="view-settings-content">
        <label className="inline-field">{t('Density')}<select value={view.density} onChange={e => setView(v => ({ ...v, density: e.target.value === 'compact' ? 'compact' : 'comfortable' }))}><option value="comfortable">{t('Comfortable')}</option><option value="compact">{t('Compact')}</option></select></label>
        {!simple && <fieldset><legend>{t('Visible columns')}</legend>{columns.map(c => <label key={c.key}><input type="checkbox" checked={shown(c.key)} disabled={c.key === 'task'} onChange={e => {
          const checked = e.target.checked; setView(v => ({ ...v, hidden: checked ? v.hidden.filter(k => k !== c.key) : [...v.hidden, c.key] }));
          if (!checked && sort === c.key) { setSort('task'); setDirection('asc'); }
        }} />{columnTitle(c)}</label>)}</fieldset>}
        {simple && <p className="view-mode-help">{t('Simple view shows one metric. Expand a task for all metrics, or select Full table to choose columns.')}</p>}
        <label className="inline-field">{t('Sort tasks')}<select aria-label={t('Sort tasks')} value={`${sort}:${direction}`} onChange={e => { const [key, dir] = e.target.value.split(':') as [TaskSortColumn, SortDirection]; setSort(key); setDirection(dir); }}>{visibleColumns.flatMap(c => (['asc', 'desc'] as const).map(dir => <option key={`${c.key}:${dir}`} value={`${c.key}:${dir}`}>{t('{column} · {direction}', { column: columnTitle(c), direction: t(dir === 'asc' ? 'Ascending' : 'Descending') })}</option>))}</select></label>
      </div></details>
    </div>
    {!simple && <p className="full-table-hint">{t('Scroll horizontally for more columns, or choose Simple view.')}</p>}
    <div className="task-table-scroll" tabIndex={0} aria-label={t('Scrollable task table')}><table className="task-table" style={simple ? undefined : { minWidth: `calc(var(--task-name-width, ${columns[0].width}px) + ${visibleColumns.filter(c => c.key !== 'task').reduce((sum, c) => sum + c.width, 0)}px)` }}>
      {!simple && <colgroup>{visibleColumns.map(c => <col key={c.key} style={c.key === 'task' ? undefined : { width: c.width }} />)}</colgroup>}
      <thead><tr>{visibleColumns.map(c => <th key={c.key} scope="col" title={headerDescription(c)} className={`metric-${c.key} ${c.numeric ? 'numeric' : ''} ${c.key === 'task' ? 'sticky-name' : ''}`} aria-sort={sort === c.key ? direction === 'asc' ? 'ascending' : 'descending' : undefined}>
        <button type="button" className="table-sort-button" title={t('Sort {column}: {direction}', { column: columnTitle(c), direction: t(nextDirection(c.key) === 'asc' ? 'Ascending' : 'Descending') })} onClick={() => { setDirection(nextDirection(c.key)); setSort(c.key); }}>{columnHeading(c)} <span className="sort-indicator" aria-hidden="true">{sort === c.key ? direction === 'asc' ? '↑' : '↓' : '↕'}</span></button>{subtitle(c.key) && <small>{subtitle(c.key)}</small>}
      </th>)}</tr></thead>
      {sections.map(section => <tbody key={section.id} data-project-id={section.group?.id}>
        {section.group && <tr className="project-group-row">{visibleColumns.map(c => c.key === 'task' ? <th className="sticky-name" key={c.key} scope="rowgroup"><button type="button" className="project-group-button" title={projectTitle(section.group, language)} aria-expanded={!collapsed.has(section.id)} onClick={() => setCollapsed(old => { const next = new Set(old); if (next.has(section.id)) next.delete(section.id); else next.add(section.id); return next; })}><span aria-hidden="true">{collapsed.has(section.id) ? '▸' : '▾'}</span> {projectTitle(section.group!, language)}</button><small>{t('{shown} shown / {total} total tasks', { shown: section.group!.jobs.length, total: section.group!.totalTasks })}</small></th> : <td className={c.numeric ? `metric-${c.key} numeric ${c.key === 'usage' || c.key === 'equivalent20x' ? 'task-share' : ''}` : undefined} key={c.key}>{groupValue(section.group!, c.key)}</td>)}</tr>}
        {section.jobs.map(job => <Fragment key={job.id}>
          <tr className={`task-row ${expanded === job.id ? 'expanded' : ''}`} onClick={() => setExpanded(expanded === job.id ? null : job.id)}>{visibleColumns.map(c => <td key={c.key} className={`${c.numeric ? 'numeric' : ''} ${c.key === 'task' ? 'sticky-name' : c.key === 'usage' || c.key === 'equivalent20x' ? 'task-share' : ''}`}>{taskValue(job, c.key)}</td>)}</tr>
          <tr hidden={expanded !== job.id} id={`task-detail-${job.id}`} className="task-detail"><td colSpan={visibleColumns.length}>{expanded === job.id && <div className="task-detail-content">
            <div className="task-detail-links"><a href={`codex://threads/${encodeURIComponent(job.id)}`}>{t('Open in Codex ↗')}</a>{snapshot.runs.filter(run => run.rootThreadId === job.id).map(run => <Link key={run.id} to={`/runs/${run.id}`}>{t('View live transcript and run')}</Link>)}</div>
            <h4>{taskTitle(job, language)}</h4>
            {(simple || view.hidden.length > 0) && <dl className="expanded-metrics">{columns.filter(c => c.key !== 'task').map(c => <Fragment key={c.key}><dt>{columnTitle(c)}</dt><dd>{taskValue(job, c.key)}</dd></Fragment>)}</dl>}
            <h4>{t('Task preview')}</h4><pre>{job.preview ?? t('No transcript preview available.')}</pre>
            <dl><dt>{t('Path')}</dt><dd>{job.cwd ?? t('Unavailable')}</dd><dt>{t('Source')}</dt><dd>{label(job.sourceKind)}</dd><dt>{t('Runs')}</dt><dd>{job.runCount}</dd><dt>{t('Total tokens')}</dt><dd>{formatTokenUsageDetails(job.totalUsage, i18n) ?? t('Unavailable')}</dd></dl><p>{formatEstimatedCostTitle(job, t)}</p><p>{quotaTitle}</p>
          </div>}</td></tr>
        </Fragment>)}
      </tbody>)}
    </table></div>
    {!displayed.length && <div className="task-empty">{t(!updatedAt && !error ? 'Loading tasks…' : 'No matching tasks.')}</div>}
    <p className="table-footnote">{t('Includes hidden tasks · + partial data · -- unavailable')}</p>
      </div>
    </section>
    <div id="task-trends"><TaskInsights jobs={mergedJobs} analysis={analysis ?? null} allocation={allocation} periodLabel={t(periods[activePeriod])} comparisonPlan={comparisonPlan} section="trend" /></div>
    <details className="metric-explanation" id="estimation-basis" ref={basisRef}><summary>{t('Statistics help and estimation basis')}</summary>
      <p id="statistics-range-help">{t('Applies to equivalent usage, estimated cost, tokens, summaries and trends. Account quota attribution is only available for the current quota period.')}</p>
      <p id="comparison-plan-help">{t('Changes only equivalent usage: task and project rows, summary and trend. One {plan} weekly allowance = 100%.', { plan: planLabel })}</p>
      <p>{t('Equivalent usage compares all locally recorded accounts with one {plan} weekly allowance in the selected period. Values may exceed 100%.', { plan: planLabel })}</p>
      <p>{t('All recorded Pro accounts are treated as 20x, as confirmed by the owner. The conversion uses observed weekly quota changes and API-equivalent token costs; it is not an official allowance or bill. Missing logs, other devices, tools and unpriced models can affect the estimate.')}</p>
      {allocation?.observedSince && <p>{t('Attribution observed since {time} · Unattributed quota: {percent}', { time: dateTime(allocation.observedSince), percent: formatUsagePercent(allocation.unattributedPercent ?? null, locale) })}</p>}
      {!allocation?.equivalent20x?.costPerPercentUsd && <p>{t('Waiting for enough recorded 20x weekly quota changes; -- means unavailable.')}</p>}
      <p>{t('Nominal comparison: Pro 20x : Pro 5x : Plus = 20 : 5 : 1. The same usage is multiplied by 1, 4 or 20 from the calibrated 20x estimate. This does not change the recorded account tier or represent an official bill.')}</p>
      <dl className="estimation-facts">
        <dt>{t('Calibration observations')}</dt><dd>{t('{count} percentage points', { count: allocation?.equivalent20x?.calibrationQuotaPercent ?? 0 })}</dd>
        {allocation?.equivalent20x?.calibratedAt && <><dt>{t('Calibration reference updated')}</dt><dd>{new Date(allocation.equivalent20x.calibratedAt).toLocaleString(locale)}</dd></>}
        <dt>{t('Estimated cost per 1% of 20x')}</dt><dd>{formatEstimatedCost(allocation?.equivalent20x?.costPerPercentUsd ?? null, true, locale)}</dd>
        <dt>{t('Unpriced tokens')}</dt><dd>{analysis ? new Intl.NumberFormat(locale).format(analysis.unpricedTokens) : '--'}</dd>
        <dt>{t('Tokens without timestamps')}</dt><dd>{analysis ? new Intl.NumberFormat(locale).format(analysis.untimedTokens) : '--'}</dd>
        <dt>{t('Daily boundary time zone')}</dt><dd>{analysis?.timeZone ?? '--'}</dd>
        <dt>{t('Last successful refresh')}</dt><dd>{updatedAt ? dateTime(new Date(updatedAt).toISOString()) : '--'}</dd>
      </dl>
      <p>{t('Today and Last 7 days use calendar days on the monitor computer. Current quota period follows the account reset window. Account quota attribution is only available for that period; no historical account totals are fabricated.')}</p>
      <p>{t('Project and scope totals include hidden rows. Click column headings to sort. + means incomplete data; -- means unavailable.')}</p>
    </details>
  </section>;
}

export function HistoryPeriodScope({ analysis, allocation, nowMs }: {
  analysis: HistoryAnalysis | null; allocation: HistoryUsageAllocation | null; nowMs: number;
}) {
  const { t, locale, windowLabel } = useI18n();
  const period = analysis?.period ?? 'quota';
  let timeZone = analysis?.timeZone || 'UTC';
  try { new Intl.DateTimeFormat(locale, { timeZone }); }
  catch { timeZone = 'UTC'; }
  const formatter = new Intl.DateTimeFormat(locale, { timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZoneName: 'shortOffset' });
  const validTime = (value: string | null | undefined): value is string => Boolean(value && Number.isFinite(Date.parse(value)));
  const time = (value: string | null | undefined) => validTime(value)
    ? <time dateTime={value}>{formatter.format(new Date(value)).replace('GMT', 'UTC')}</time> : <span>{t('Unavailable')}</span>;
  const start = allocation?.windowStartedAt;
  const end = allocation?.resetsAt;
  const hasWindow = validTime(start) && validTime(end) && Date.parse(start) < Date.parse(end);
  return <div className="period-scope">
    <div className="period-scope-heading"><strong>{t(periods[period])}{period === 'quota' && hasWindow && allocation?.windowLabel ? ` · ${windowLabel(allocation.windowLabel)}` : ''}</strong><span>{t('Time zone: {zone}', { zone: timeZone })}</span></div>
    <dl className="period-scope-times">
      {period === 'quota' ? <>
        <div><dt>{t('Starts')}</dt><dd>{hasWindow ? time(start) : t('Period unavailable')}</dd></div>
        <div><dt>{t('Ends / resets')}</dt><dd>{hasWindow ? time(end) : t('Period unavailable')}</dd></div>
      </> : <div><dt>{t('Statistics start')}</dt><dd>{period === 'lifetime' ? t('All available history') : time(analysis?.startedAt)}</dd></div>}
      <div><dt>{t('Data through')}</dt><dd>{time(analysis?.endedAt)}</dd></div>
    </dl>
    {period === 'quota' && <p>{t('The current account’s quota window defines this range; equivalent usage combines local records across accounts.')}</p>}
    {period === 'quota' && hasWindow && Date.parse(end!) <= nowMs && <p role="status">{t('This quota period has ended. Waiting for the renewed quota window.')}</p>}
  </div>;
}

function formatTokenUsageDetails(usage: TokenUsage | null, { t, locale }: I18n): string | undefined {
  if (!usage) {
    return undefined;
  }

  const numberFormat = new Intl.NumberFormat(locale);
  return [
    t('{count} total', { count: numberFormat.format(usage.totalTokens) }),
    t('{count} input', { count: numberFormat.format(usage.inputTokens) }),
    t('{count} cached', { count: numberFormat.format(usage.cachedInputTokens) }),
    t('{count} cache writes', { count: numberFormat.format(usage.cacheWriteInputTokens ?? 0) }),
    t('{count} output', { count: numberFormat.format(usage.outputTokens) }),
    t('{count} reasoning', { count: numberFormat.format(usage.reasoningOutputTokens) })
  ].join(", ");
}

function formatEstimatedCostTitle(job: HistoryJob, t: Translate): string {
  if (job.totalEstimatedCostUsd === null) {
    return t("No API-equivalent cost can be estimated because the recorded model has no matching standard API price. This is not a billed ChatGPT or Codex charge.");
  }

  if (!job.totalEstimatedCostIsComplete) {
    return t("Lower-bound API-equivalent estimate for recorded usage whose model has a standard API token price. The + indicates that usage from unpriced internal or unknown models is excluded. This is not a billed ChatGPT or Codex charge and excludes tool-call fees.");
  }

  return t('API-equivalent cost for recorded usage in the selected period. This is an estimate, not a ChatGPT subscription charge, and excludes tool-call fees.');
}

function formatUsageAllocationTitle(
  allocation: HistoryUsageAllocation | null,
  i18n: I18n
): string {
  const { t, dateTime, windowLabel } = i18n;
  if (
    !allocation ||
    allocation.status !== "available" ||
    !allocation.windowStartedAt ||
    !allocation.resetsAt
  ) {
    return t("Approximate per-task usage is unavailable because Codex did not expose the current primary quota limit and reset period.");
  }

  const limit = t(allocation.limitName ?? "Overall Codex");
  const window = allocation.windowLabel
    ? windowLabel(allocation.windowLabel)
    : "";
  const basis =
    allocation.basis === "apiEquivalentCost"
      ? "API-equivalent cost of priced usage"
      : "available local activity";

  return t('Estimated share of {limit} {window} quota attributed to this task during observation. Each quota increase is allocated using {basis}, then accumulated. Earlier allocations are preserved. Pre-observation consumption and increments with missing or unpriced usage remain unattributed. -- means no allocation yet or unavailable data, not zero consumption. This is an estimate, not an official OpenAI per-task measurement. Resets at {time}.', { limit, window, basis: t(basis), time: dateTime(allocation.resetsAt) });
}
