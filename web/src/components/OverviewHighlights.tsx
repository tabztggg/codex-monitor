import { Link } from 'react-router-dom';
import type { ActiveSession, HistoryJob } from '../../../shared/monitor';
import { useI18n } from '../LanguageContext';
import { relativeActivity, taskTitle } from '../presentation';
import { comparePlanUsage, comparisonPlans, formatUsagePercent, type ComparisonPlan } from '../usage-display';
import './OverviewHighlights.css';

export function overviewTopTasks(jobs: HistoryJob[]) {
  return jobs.filter(job => job.periodMetrics && typeof job.estimated20xPercent === 'number' && Number.isFinite(job.estimated20xPercent) && job.estimated20xPercent > 0)
    .sort((a, b) => b.estimated20xPercent! - a.estimated20xPercent! || a.id.localeCompare(b.id)).slice(0, 3);
}

export function latestRecordedActivity(jobs: HistoryJob[], sessions: ActiveSession[]) {
  return [...jobs, ...sessions].map(item => item.updatedAt).filter(time => Number.isFinite(Date.parse(time)))
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;
}

export function OverviewHighlights({ jobs, sessions, ready, live, periodLabel, comparisonPlan, nowMs }: {
  jobs: HistoryJob[]; sessions: ActiveSession[]; ready: boolean; live: boolean; periodLabel: string; comparisonPlan: ComparisonPlan; nowMs: number;
}) {
  const { t, locale, language, dateTime } = useI18n();
  const ranked = ready ? overviewTopTasks(jobs) : [];
  const largestEstimate = ranked[0]?.estimated20xPercent ?? 1;
  const latest = latestRecordedActivity(jobs, sessions);
  const activeCount = new Set(sessions.map(session => session.id)).size;
  return <div className="overview-highlight-cards">
    <section className="overview-highlight-card" aria-label={t('Top 3 tasks in this range')}>
      <div className="overview-highlight-card-heading"><h3>{t('Top 3 tasks in this range')}</h3></div>
      <p className="overview-highlight-note">{periodLabel} · {t('Across accounts')} · {comparisonPlans[comparisonPlan].label}</p>
      {ranked.length ? <ol className="overview-rank-list">{ranked.map((job, index) => <li key={job.id}>
        <span className="overview-rank-number" aria-hidden="true">{index + 1}</span>
        <Link className="overview-rank-name" to={`/tasks?task=${encodeURIComponent(job.id)}`} title={taskTitle(job, language)}>{taskTitle(job, language)}</Link>
        <strong className="overview-rank-value">{formatUsagePercent(comparePlanUsage(job.estimated20xPercent, comparisonPlan), locale)}{job.estimated20xIsComplete === true ? '' : '+'}</strong>
        <span className="overview-rank-track" aria-hidden="true"><span style={{ width: `${Math.min(100, Math.max(0, job.estimated20xPercent! / largestEstimate * 100))}%` }} /></span>
      </li>)}</ol> : <p className="overview-empty">{t(ready ? 'No positive quota estimates in this range.' : 'Waiting for range data…')}</p>}
      <div className="overview-highlight-card-footer">
        <Link to="/tasks">{t('Task details')} <span aria-hidden="true">→</span></Link>
        <small>{t('One {plan} week = 100%', { plan: comparisonPlans[comparisonPlan].label })}{ranked.length > 0 && <> · {t('Bars compare tasks within this list.')}</>}</small>
      </div>
    </section>
    <section className="overview-highlight-card" aria-label={t('Current activity')}>
      <div className="overview-highlight-card-heading"><h3>{t('Current activity')}</h3><span className={`activity-status ${live ? 'live' : ''}`}>{t(live ? 'Live' : 'Last recorded')}</span></div>
      <p className="overview-highlight-note">{t('Monitor activity now · independent of the date filter')}</p>
      <dl className="overview-highlight-stats">
        <div><dt>{t('Active tasks')}</dt><dd>{live || sessions.length ? activeCount : '--'}</dd><small>{t('Tasks')}</small></div>
        <div><dt>{t('Latest recorded activity')}</dt><dd className="activity-time">{latest ? <time dateTime={latest} title={dateTime(latest)}>{relativeActivity(latest, nowMs, language)}</time> : '--'}</dd></div>
      </dl>
      {!live && <small className="overview-highlight-note">{t('Activity connection unavailable; showing the last records.')}</small>}
    </section>
  </div>;
}
