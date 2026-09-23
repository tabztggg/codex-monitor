import { useMemo, useState } from 'react';
import type { HistoryAnalysis, HistoryJob, HistoryUsageAllocation } from '../../../shared/monitor';
import { groupTasksByProject, projectTitle } from '../presentation';
import { useI18n } from '../LanguageContext';
import { formatEstimatedCost, formatTokenCount, formatUsagePercent, summarizeTasks, comparisonPlans, comparePlanUsage, type ComparisonPlan } from '../usage-display';

export function TaskInsights({ jobs, analysis, allocation, periodLabel, comparisonPlan = 'pro20x', section = 'all', onShowBasis }: {
  jobs: HistoryJob[]; analysis: HistoryAnalysis | null; allocation: HistoryUsageAllocation | null; periodLabel: string; comparisonPlan?: ComparisonPlan; section?: 'summary' | 'trend' | 'all'; onShowBasis?: () => void;
}) {
  const { t, locale, language } = useI18n();
  const planLabel = comparisonPlans[comparisonPlan].label;
  const equivalentTitle = t('{plan} equivalent usage', { plan: planLabel });
  const [metric, setMetric] = useState<'cost' | 'tokens' | 'equivalent20x'>('cost');
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const totals = useMemo(() => summarizeTasks(jobs), [jobs]);
  const groups = useMemo(() => groupTasksByProject(jobs, [], metric, 'desc', new Set(), language), [jobs, metric, language]);
  const reference = allocation?.equivalent20x?.costPerPercentUsd;
  const days = analysis?.days ?? [];
  const value = (day: typeof days[number]) => metric === 'tokens' ? day.usage.totalTokens
    : metric === 'cost' ? day.costUsd : day.costUsd !== null && reference ? comparePlanUsage(day.costUsd / reference, comparisonPlan) : null;
  const format = (n: number | null, complete = true) => metric === 'tokens' ? formatTokenCount(n, locale, complete)
    : metric === 'cost' ? formatEstimatedCost(n, complete, locale) : formatUsagePercent(n, locale) + (n !== null && !complete ? '+' : '');
  const peak = Math.max(0, ...days.map(day => value(day) ?? 0));
  const rankValue = (g: typeof groups[number]) => metric === 'cost' ? g.totalEstimatedCostUsd : metric === 'tokens' ? g.totalTokens : comparePlanUsage(g.equivalent20xPercent, comparisonPlan);
  const rankComplete = (g: typeof groups[number]) => metric === 'cost' ? g.totalEstimatedCostIsComplete : metric === 'tokens' ? g.tokensIsComplete : g.equivalent20xIsComplete;
  const rankMax = Math.max(0, ...groups.map(g => rankValue(g) ?? 0));
  const selected = days.find(day => day.date === selectedDay) ?? days.at(-1);
  return <>
    {section !== 'trend' && <section className="scope-summary" aria-label={t('Scope totals')}>
      <div className="scope-summary-heading"><strong>{t('Scope totals')}</strong><span>{periodLabel} · {t('{count} tasks', { count: jobs.length })}</span></div>
      <div className="summary-metrics">
        <div className="summary-equivalent" aria-label={`${equivalentTitle} · ${t('Across accounts')}`}><span className="metric-label">{equivalentTitle} <span className="scope-badge">{t('Across accounts')}</span></span><strong>{formatUsagePercent(comparePlanUsage(totals.equivalent, comparisonPlan), locale)}{totals.equivalent !== null && !totals.equivalentComplete ? '+' : ''}</strong><small>{totals.equivalent === null ? t(reference ? 'No priced usage in this range' : 'Waiting for calibration') : `${t('One {plan} week = 100%', { plan: planLabel })} · ${t('May exceed 100%')}`}</small></div>
        <div><span className="metric-label">{t('Estimated cost')}</span><strong>{formatEstimatedCost(totals.cost, totals.costComplete, locale)}</strong><small>{t('Selected period · USD')} · {t('API-equivalent estimate')}</small></div>
        <div><span className="metric-label">{t('Total tokens')}</span><strong>{formatTokenCount(totals.tokens, locale, totals.tokensComplete)}</strong><small>{t('Selected period')} · {t('Local records')}</small></div>
      </div>
      <div className="calibration-strip">
        {allocation?.equivalent20x?.source === 'previous' ? <><p role="status">{t('Using previous calibration; updating in the background ({count}/5 percentage points).', { count: allocation.equivalent20x.calibrationQuotaPercent })}</p><span className="calibration-segments" aria-hidden="true">{Array.from({ length: 5 }, (_, index) => <i key={index} className={index < Math.floor(allocation.equivalent20x!.calibrationQuotaPercent ?? 0) ? 'filled' : ''} />)}</span></> : <p>{t(reference ? 'Based on local records and observed quota changes.' : 'Waiting for enough recorded 20x weekly quota changes; -- means unavailable.')}</p>}
        {onShowBasis && <button type="button" className="basis-link" onClick={onShowBasis}>{t('Estimation basis')} <span aria-hidden="true">→</span></button>}
      </div>
    </section>}
    {section !== 'summary' && <details className="insights-panel">
      <summary>{t('Daily trend and project ranking')}</summary>
      <div className="insights-content">
        <label className="inline-field">{t('Metric')} <select value={metric} onChange={event => setMetric(event.target.value as typeof metric)}>
          <option value="cost">{t('Estimated cost')}</option><option value="tokens">{t('Total tokens')}</option><option value="equivalent20x">{equivalentTitle}</option>
        </select></label>
        <p className="muted-note">{t('The trend shows dates with recorded usage in the selected period. Rankings use the full selected scope, including hidden rows.')}</p>
        {days.length ? <figure className="usage-trend"><figcaption>{t('Daily usage')} · {periodLabel}</figcaption>
          <div className="trend-scroll" tabIndex={0} aria-label={t('Daily usage')}>
            <div className="trend-bars">{days.map(day => <button key={day.date} type="button" className="trend-day" aria-pressed={selected?.date === day.date}
              aria-label={`${day.date}: ${format(value(day), metric === 'tokens' || day.unpricedTokens === 0)}`}
              onClick={() => setSelectedDay(day.date)} onFocus={() => setSelectedDay(day.date)}>
              <span className="trend-bar-space"><span className="trend-bar" style={{ height: `${peak > 0 ? (value(day) ?? 0) / peak * 100 : 0}%` }} /></span><span>{day.date.slice(5)}</span>
            </button>)}</div>
          </div>
          <output className="trend-reading">{selected ? `${selected.date} · ${format(value(selected), metric === 'tokens' || selected.unpricedTokens === 0)}` : '--'}</output>
        </figure> : <p>{t('No daily usage records in this period.')}</p>}
        <h4>{t('Top 5 projects')}</h4>
        <ol className="project-ranking">{groups.slice(0, 5).map(g => <li key={g.id}>
          <div><span>{projectTitle(g, language)}</span><strong>{format(rankValue(g), rankComplete(g))}</strong></div>
          <div className="ranking-track"><span style={{ width: `${rankMax > 0 ? (rankValue(g) ?? 0) / rankMax * 100 : 0}%` }} /></div>
        </li>)}</ol>
      </div>
    </details>}
  </>;
}
