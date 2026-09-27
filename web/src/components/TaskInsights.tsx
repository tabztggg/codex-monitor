import { useEffect, useMemo, useState } from 'react';
import type { HistoryAnalysis, HistoryJob, HistoryUsageAllocation } from '../../../shared/monitor';
import { groupTasksByProject, projectTitle, taskTitle } from '../presentation';
import { useI18n } from '../LanguageContext';
import { formatEstimatedCost, formatTokenCount, formatUsagePercent, comparisonPlans, comparePlanUsage, type ComparisonPlan } from '../usage-display';
import { summarizeOverviewUsage } from '../overview-metrics';

export function TaskInsights({ jobs, analysis, allocation, periodLabel, comparisonPlan = 'pro20x', section = 'all', expanded = false, hideCalibration = false, onShowBasis }: {
  jobs: HistoryJob[]; analysis: HistoryAnalysis | null; allocation: HistoryUsageAllocation | null; periodLabel: string; comparisonPlan?: ComparisonPlan; section?: 'summary' | 'trend' | 'all'; expanded?: boolean; hideCalibration?: boolean; onShowBasis?: () => void;
}) {
  const { t, locale, language } = useI18n();
  const planLabel = comparisonPlans[comparisonPlan].label;
  const equivalentTitle = t('{plan} equivalent usage', { plan: planLabel });
  const [metric, setMetric] = useState<'cost' | 'tokens' | 'equivalent20x'>(() => {
    try { const saved = window.localStorage.getItem('codex-monitor-trend-metric'); if (saved === 'cost' || saved === 'tokens' || saved === 'equivalent20x') return saved; } catch { /* Optional storage. */ }
    return 'equivalent20x';
  });
  useEffect(() => { try { window.localStorage.setItem('codex-monitor-trend-metric', metric); } catch { /* Optional storage. */ } }, [metric]);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const overview = useMemo(() => summarizeOverviewUsage(jobs), [jobs]);
  const { totals, tokenBreakdown } = overview;
  const groups = useMemo(() => groupTasksByProject(jobs, [], 'equivalent20x', 'desc', new Set(), language), [jobs, language]);
  const reference = allocation?.equivalent20x?.costPerPercentUsd;
  const days = analysis?.days ?? [];
  const value = (day: typeof days[number]) => metric === 'tokens' ? day.usage.totalTokens
    : metric === 'cost' ? day.costUsd : day.costUsd !== null && reference ? comparePlanUsage(day.costUsd / reference, comparisonPlan) : null;
  const format = (n: number | null, complete = true) => metric === 'tokens' ? formatTokenCount(n, locale, complete)
    : metric === 'cost' ? formatEstimatedCost(n, complete, locale) : formatUsagePercent(n, locale) + (n !== null && !complete ? '+' : '');
  const peak = Math.max(0, ...days.map(day => value(day) ?? 0));
  const rankValue = (g: typeof groups[number]) => comparePlanUsage(g.equivalent20xPercent, comparisonPlan);
  const quotaLabel = (n: number | null, complete: boolean) => formatUsagePercent(n, locale) + (n !== null && !complete ? '+' : '');
  const taskRankValue = (job: HistoryJob) => comparePlanUsage(job.estimated20xPercent, comparisonPlan);
  const rankedTasks = useMemo(() => [...jobs].filter(job => comparePlanUsage(job.estimated20xPercent, comparisonPlan) !== null)
    .sort((a, b) => comparePlanUsage(b.estimated20xPercent, comparisonPlan)! - comparePlanUsage(a.estimated20xPercent, comparisonPlan)!).slice(0, 5), [jobs, comparisonPlan]);
  const rankScale = Math.max(100, ...groups.map(g => rankValue(g) ?? 0), ...rankedTasks.map(job => taskRankValue(job) ?? 0));
  const barWidth = (n: number | null) => Math.max(0, n ?? 0) / rankScale * 100;
  const dayComplete = (day: typeof days[number]) => (analysis?.untimedTokens ?? 0) === 0 && (metric === 'tokens' || day.unpricedTokens === 0);

  const selected = days.find(day => day.date === selectedDay) ?? days.at(-1);
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
        {allocation?.equivalent20x?.source === 'manual' ? <p>{t('Manual calibration: normalized to a confirmed account total. Other accounts remain estimates.')}</p> : allocation?.equivalent20x?.source === 'previous' ? <><p role="status">{t('Using previous calibration; updating in the background ({count}/5 percentage points).', { count: allocation.equivalent20x.calibrationQuotaPercent })}</p><span className="calibration-segments" aria-hidden="true">{Array.from({ length: 5 }, (_, index) => <i key={index} className={index < Math.floor(allocation.equivalent20x!.calibrationQuotaPercent ?? 0) ? 'filled' : ''} />)}</span></> : <p>{t(reference ? 'Based on local records and observed quota changes.' : 'Waiting for enough recorded 20x weekly quota changes; -- means unavailable.')}</p>}
        {onShowBasis && <button type="button" className="basis-link" onClick={onShowBasis}>{t('Estimation basis')} <span aria-hidden="true">→</span></button>}
      </div>}
    </section>}
    {section !== 'summary' && <details className="insights-panel" open={expanded || undefined}>
      <summary>{t('Daily trend and project ranking')}</summary>
      <div className="insights-content">
        <label className="inline-field">{t('Daily trend metric')} <select value={metric} onChange={event => setMetric(event.target.value as typeof metric)}>
          <option value="cost">{t('Estimated cost')}</option><option value="tokens">{t('Total tokens')}</option><option value="equivalent20x">{equivalentTitle}</option>
        </select></label>
        <p className="muted-note">{t('The trend shows dates with recorded usage in the selected period. Rankings use the full selected scope, including hidden rows.')}</p>
        {(analysis?.untimedTokens ?? 0) > 0 && <p className="history-error" role="status">{t('Some records have no date and cannot be assigned to a day. Daily values are partial (+).')}</p>}
        {days.length ? <figure className="usage-trend"><figcaption>{t('Daily usage')} · {periodLabel}</figcaption>
          <div className="trend-scroll" tabIndex={0} aria-label={t('Daily usage')}>
            <div className="trend-bars">{days.map(day => <button key={day.date} type="button" className="trend-day" aria-pressed={selected?.date === day.date}
              aria-label={`${day.date}: ${format(value(day), dayComplete(day))}`}
              onClick={() => setSelectedDay(day.date)} onFocus={() => setSelectedDay(day.date)}>
              <span className="trend-day-value">{format(value(day), dayComplete(day))}</span><span className="trend-bar-space"><span className="trend-bar" style={{ height: `${peak > 0 ? (value(day) ?? 0) / peak * 100 : 0}%` }} /></span><span>{day.date.slice(5)}</span>
            </button>)}</div>
          </div>
          <output className="trend-reading">{selected ? `${selected.date} · ${format(value(selected), dayComplete(selected))}` : '--'}</output>
        </figure> : <p>{t('No daily usage records in this period.')}</p>}
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
