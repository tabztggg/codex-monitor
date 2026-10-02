import { useEffect, useId, useMemo, useState } from 'react';
import type { HistoryAnalysis, HistoryJob, HistoryUsageAllocation } from '../../../shared/monitor';
import { groupTasksByProject, projectTitle, taskTitle } from '../presentation';
import { useI18n } from '../LanguageContext';
import { formatEstimatedCost, formatTokenCount, formatUsagePercent, comparisonPlans, comparePlanUsage, type ComparisonPlan } from '../usage-display';
import { summarizeOverviewUsage } from '../overview-metrics';
import { historicalCacheHit, modelColor, modelTrendSegments, tasksForUsageDay } from '../model-analytics';
import { ModelUsageTable } from './ModelAnalytics';

export function TaskInsights({ jobs, analysis, allocation, periodLabel, comparisonPlan = 'pro20x', section = 'all', expanded = false, hideCalibration = false, onShowBasis }: {
  jobs: HistoryJob[]; analysis: HistoryAnalysis | null; allocation: HistoryUsageAllocation | null; periodLabel: string; comparisonPlan?: ComparisonPlan; section?: 'summary' | 'trend' | 'all'; expanded?: boolean; hideCalibration?: boolean; onShowBasis?: () => void;
}) {
  const { t, locale, language } = useI18n();
  const planLabel = comparisonPlans[comparisonPlan].label;
  const equivalentTitle = t('{plan} equivalent usage', { plan: planLabel });
  const [metric, setMetric] = useState<'cost' | 'tokens' | 'equivalent20x' | 'cacheHit'>(() => {
    try { const saved = window.localStorage.getItem('codex-monitor-trend-metric'); if (saved === 'cost' || saved === 'tokens' || saved === 'equivalent20x' || saved === 'cacheHit') return saved; } catch { /* Optional storage. */ }
    return 'equivalent20x';
  });
  useEffect(() => { try { window.localStorage.setItem('codex-monitor-trend-metric', metric); } catch { /* Optional storage. */ } }, [metric]);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [dayDetailsOpen, setDayDetailsOpen] = useState(false);
  const dayDetailsId = useId();
  const selectDay = (date: string) => { setSelectedDay(date); setDayDetailsOpen(true); };
  const overview = useMemo(() => summarizeOverviewUsage(jobs), [jobs]);
  const { totals, tokenBreakdown } = overview;
  const groups = useMemo(() => groupTasksByProject(jobs, [], 'equivalent20x', 'desc', new Set(), language), [jobs, language]);
  const reference = allocation?.equivalent20x?.costPerPercentUsd;
  const days = analysis?.days ?? [];
  const value = (day: typeof days[number]) => metric === 'cacheHit' ? historicalCacheHit(day.usage) : metric === 'tokens' ? day.usage.totalTokens
    : metric === 'cost' ? day.costUsd : day.costUsd !== null && reference ? comparePlanUsage(day.costUsd / reference, comparisonPlan) : null;
  const format = (n: number | null, complete = true) => metric === 'tokens' ? formatTokenCount(n, locale, complete)
    : metric === 'cost' ? formatEstimatedCost(n, complete, locale) : formatUsagePercent(n, locale) + (metric !== 'cacheHit' && n !== null && !complete ? '+' : '');
  const peak = metric === 'cacheHit' ? 100 : Math.max(0, ...days.map(day => value(day) ?? 0));
  const rankValue = (g: typeof groups[number]) => comparePlanUsage(g.equivalent20xPercent, comparisonPlan);
  const quotaLabel = (n: number | null, complete: boolean) => formatUsagePercent(n, locale) + (n !== null && !complete ? '+' : '');
  const taskRankValue = (job: HistoryJob) => comparePlanUsage(job.estimated20xPercent, comparisonPlan);
  const rankedTasks = useMemo(() => [...jobs].filter(job => comparePlanUsage(job.estimated20xPercent, comparisonPlan) !== null)
    .sort((a, b) => comparePlanUsage(b.estimated20xPercent, comparisonPlan)! - comparePlanUsage(a.estimated20xPercent, comparisonPlan)!).slice(0, 5), [jobs, comparisonPlan]);
  const rankScale = Math.max(100, ...groups.map(g => rankValue(g) ?? 0), ...rankedTasks.map(job => taskRankValue(job) ?? 0));
  const barWidth = (n: number | null) => Math.max(0, n ?? 0) / rankScale * 100;
  const dayComplete = (day: typeof days[number]) => (analysis?.untimedTokens ?? 0) === 0
    && (day.models?.every(row => row.tokensComplete) ?? true)
    && (metric === 'tokens' || metric === 'cacheHit' || day.unpricedTokens === 0 && (day.models?.every(row => row.costComplete) ?? true));

  const selected = days.find(day => day.date === selectedDay) ?? days.at(-1);
  const selectedTasks = selected ? tasksForUsageDay(jobs, selected.date) : [];
  const legendModels = [...new Set(days.flatMap(day => day.models?.map(row => row.model) ?? []))]
    .sort((a, b) => (a ?? '\uffff').localeCompare(b ?? '\uffff'));
  const hasMissingModels = days.some(day => !day.models?.length && day.usage.totalTokens > 0);
  return <>
    {section !== 'trend' && <section className="scope-summary" aria-label={t('Scope totals')}>
      <div className="scope-summary-heading"><strong>{t('Scope totals')}</strong><span>{periodLabel} · {t('{count} tasks with recorded usage', { count: overview.consumedTaskCount === 0 && overview.unknownTaskCount === jobs.length ? '--' : overview.consumedTaskCount })}</span></div>
      <div className="summary-metrics">
        <div className="summary-equivalent" aria-label={`${equivalentTitle} · ${t('Across accounts')}`}><span className="metric-label">{equivalentTitle} <span className="scope-badge">{t('Across accounts')}</span></span><strong>{formatUsagePercent(comparePlanUsage(totals.equivalent, comparisonPlan), locale)}{totals.equivalent !== null && !totals.equivalentComplete ? '+' : ''}</strong><small>{totals.equivalent === null ? t(reference ? 'No priced usage in this range' : 'Waiting for calibration') : `${t('One {plan} week = 100%', { plan: planLabel })} · ${t('May exceed 100%')}`}</small></div>
        <div><span className="metric-label">{t('Estimated cost')}</span><strong>{formatEstimatedCost(totals.cost, totals.costComplete, locale)}</strong><small>{t('Selected period · USD')} · {t('API-equivalent estimate')}</small></div>
        <div className="summary-tokens"><span className="metric-label">{t('Total tokens')}</span><strong>{formatTokenCount(totals.tokens, locale, totals.tokensComplete)}</strong>
          <dl className="token-breakdown"><div><dt>{t('Input')}</dt><dd>{formatTokenCount(tokenBreakdown.input.value, locale, tokenBreakdown.input.complete)}</dd></div><div><dt>{t('Output')}</dt><dd>{formatTokenCount(tokenBreakdown.output.value, locale, tokenBreakdown.output.complete)}</dd></div><div className="token-cache-subset"><dt>{t('Cached within input')}</dt><dd>{formatTokenCount(tokenBreakdown.cachedInput.value, locale, tokenBreakdown.cachedInput.complete)}</dd></div></dl>
          <small>{t('Selected period')} · {t('Local records')}</small>
        </div>
      </div>
      {!hideCalibration && <div className="calibration-strip">
        {allocation?.equivalent20x?.source === 'manual' ? <p>{t('Manual calibration: normalized to a confirmed account total. Other accounts remain estimates.')}</p> : allocation?.equivalent20x?.source === 'previous' ? <p role="status">{t('Retaining the previous cross-account reference until current-window records support a new calibration.')}</p> : <p>{t(reference ? 'Based on local records and observed quota changes.' : 'Waiting for enough recorded 20x weekly quota changes; -- means unavailable.')}</p>}
        {onShowBasis && <button type="button" className="basis-link" onClick={onShowBasis}>{t('Estimation basis')} <span aria-hidden="true">→</span></button>}
      </div>}
    </section>}
    {section !== 'summary' && <details className="insights-panel" open={expanded || undefined}>
      <summary>{t('Daily trend and project ranking')}</summary>
      <div className="insights-content">
        <label className="inline-field">{t('Daily trend metric')} <select value={metric} onChange={event => setMetric(event.target.value as typeof metric)}>
          <option value="cost">{t('Estimated cost')}</option><option value="tokens">{t('Total tokens')}</option><option value="equivalent20x">{equivalentTitle}</option><option value="cacheHit">{t('Cache hit')}</option>
        </select></label>
        <p className="muted-note">{t('The trend shows dates with recorded usage in the selected period. Rankings use the full selected scope, including hidden rows.')}</p>
        <p className="muted-note">{t(metric === 'cacheHit' ? 'Daily cache hit uses cached input / total input. Missing records may change the rate; no input is shown as --.' : 'Bars are stacked by the recorded model. Select a day to see its model usage and tasks below.')}</p>
        {hasMissingModels && metric !== 'cacheHit' && <p className="muted-note" role="status">{t('Model breakdown is unavailable for some days; their recorded totals are still shown.')}</p>}
        {(analysis?.untimedTokens ?? 0) > 0 && <p className="history-error" role="status">{t('Some records have no date and cannot be assigned to a day. Daily values are partial (+).')}</p>}
        {days.length ? <figure className="usage-trend"><figcaption>{t('Daily usage')} · {periodLabel}</figcaption>
          <div className="trend-scroll" tabIndex={0} aria-label={t('Daily usage')}>
            <div className="trend-bars">{days.map(day => <button key={day.date} type="button" className="trend-day" aria-pressed={selected?.date === day.date}
              aria-controls={dayDetailsId} aria-expanded={selected?.date === day.date && dayDetailsOpen}
              aria-label={`${day.date}: ${format(value(day), dayComplete(day))}`}
              onClick={() => selectDay(day.date)} onFocus={() => selectDay(day.date)}>
              <span className="trend-day-value">{format(value(day), dayComplete(day))}</span><span className="trend-bar-space" aria-hidden="true">{value(day) === null ? <span className="trend-missing">--</span>
                : <span className={`trend-bar${metric !== 'cacheHit' && day.models?.length ? ' model-trend-stack' : ''}`} style={{ height: `${peak > 0 ? (value(day) ?? 0) / peak * 100 : 0}%` }}>
                  {metric !== 'cacheHit' && modelTrendSegments(day, metric === 'tokens' ? 'tokens' : 'cost').map(row => <span key={row.model ?? '\u0000'} className="model-trend-segment"
                    style={{ background: modelColor(row.model), height: `${row.value / (metric === 'tokens' ? day.usage.totalTokens : day.costUsd || 1) * 100}%` }} />)}
                </span>}</span><span>{day.date.slice(5)}</span>
            </button>)}</div>
          </div>
          {metric !== 'cacheHit' && legendModels.length > 0 && <ul className="model-legend" aria-label={t('Model legend')}>{legendModels.map(model => <li key={model ?? '\u0000'}><span className="model-swatch" style={{ background: modelColor(model) }} aria-hidden="true" />{model ?? t('Unknown model')}</li>)}</ul>}
          <output className="trend-reading">{selected ? `${selected.date} · ${format(value(selected), dayComplete(selected))}` : '--'}</output>
        </figure> : <p role="status">{t(analysis ? 'No daily usage records in this period.' : 'Daily usage is unavailable. -- does not mean zero usage.')}</p>}
        {selected && <details className="day-usage-details" id={dayDetailsId} open={dayDetailsOpen || undefined} onToggle={event => setDayDetailsOpen(event.currentTarget.open)}>
          <summary>{t('Usage on {date}', { date: selected.date })}</summary>
          <p className="muted-note">{t('Across accounts')} · {t('Time zone')}: {analysis?.timeZone} · {t('Recorded cache hit')}: {formatUsagePercent(historicalCacheHit(selected.usage), locale)}</p>
          {selected.models?.length ? <ModelUsageTable models={selected.models} caption={t('Models on {date}', { date: selected.date })} sortable={false} />
            : <p className="muted-note">{t('Model breakdown is unavailable for this day.')}</p>}
          <h4>{t('Tasks on {date}', { date: selected.date })}</h4>
          <p className="muted-note">{t('These values include only this day’s recorded usage. Open a task to inspect its details.')}</p>
          {selectedTasks.length > 0 && jobs.some(job => job.periodMetrics?.days === undefined) && <p className="muted-note" role="status">{t('Daily task details are unavailable for some records.')}</p>}
          {selectedTasks.length > 0 ? <div className="model-table-scroll day-task-scroll" tabIndex={0} role="region" aria-label={t('Tasks on {date}', { date: selected.date })}>
            <table className="day-task-list"><thead><tr><th scope="col">{t('Task')}</th><th scope="col">{t('Input')}</th><th scope="col">{t('Output')}</th><th scope="col">{t('Total tokens')}</th><th scope="col">{t('Cache hit')}</th><th scope="col">{t('API-equivalent cost')}</th></tr></thead>
              <tbody>{selectedTasks.map(({ job, day, tokensComplete, costComplete }) => <tr key={job.id}><td><a href={`/tasks?task=${encodeURIComponent(job.id)}&from=${selected.date}&to=${selected.date}`}>{taskTitle(job, language)}</a></td>
                <td>{formatTokenCount(day.usage.inputTokens, locale, tokensComplete)}</td><td>{formatTokenCount(day.usage.outputTokens, locale, tokensComplete)}</td><td>{formatTokenCount(day.usage.totalTokens, locale, tokensComplete)}</td>
                <td>{formatUsagePercent(historicalCacheHit(day.usage), locale)}</td><td>{formatEstimatedCost(day.costUsd, costComplete, locale)}</td></tr>)}</tbody>
            </table></div> : <p role="status">{t(jobs.some(job => job.periodMetrics?.days === undefined) ? 'Daily task details are unavailable for some records.' : 'No task usage records for this day.')}</p>}
        </details>}
        <p className="muted-note">{t('Rankings show across-account quota consumed in the selected period. One {plan} week = 100%; not a share of total consumption.', { plan: planLabel })}</p><p className="muted-note">{t('Full bar = {percent} quota. Values keep the weekly allowance denominator.', { percent: formatUsagePercent(rankScale, locale) })}</p><div className="rankings-grid"><section><h4>{t('Top 5 projects by equivalent quota')}</h4>
        <ol className="project-ranking">{groups.slice(0, 5).map(g => <li key={g.id}>
          <div><span>{projectTitle(g, language)}</span><strong>{quotaLabel(rankValue(g), g.equivalent20xIsComplete)}</strong></div>
          <div className="ranking-track"><span style={{ width: `${barWidth(rankValue(g))}%` }} /></div>
        </li>)}</ol></section>
        <section><h4>{t('Top 5 tasks by equivalent quota')}</h4><ol className="project-ranking">{rankedTasks.map(job => <li key={job.id}><div><span>{taskTitle(job, language)}</span><strong>{quotaLabel(taskRankValue(job), job.estimated20xIsComplete === true)}</strong></div><div className="ranking-track"><span style={{width: `${barWidth(taskRankValue(job))}%`}} /></div></li>)}</ol></section></div>
      </div>
    </details>}
  </>;
}
