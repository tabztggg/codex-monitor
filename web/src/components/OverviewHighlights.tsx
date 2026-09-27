import { Link } from 'react-router-dom';
import type { ActiveSession, HistoryJob } from '../../../shared/monitor';
import { useI18n } from '../LanguageContext';
import { relativeActivity, taskTitle } from '../presentation';
import { comparePlanUsage, comparisonPlans, formatUsagePercent, type ComparisonPlan } from '../usage-display';

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
  const latest = latestRecordedActivity(jobs, sessions);
  const activeCount = new Set(sessions.map(session => session.id)).size;
  return <div className="overview-highlights">
    <section className="overview-highlight" aria-label={t('Top 3 tasks in this range')}>
      <div className="overview-highlight-heading"><h3>{t('Top 3 tasks in this range')}</h3><Link to="/tasks">{t('Task details')} <span aria-hidden="true">→</span></Link></div>
      <p className="overview-scope-note">{periodLabel} · {t('Across accounts')} · {comparisonPlans[comparisonPlan].label}</p>
      {ranked.length ? <ol className="overview-top-tasks">{ranked.map(job => <li key={job.id}>
        <Link to={`/tasks?task=${encodeURIComponent(job.id)}`} title={taskTitle(job, language)}>{taskTitle(job, language)}</Link>
        <strong>{formatUsagePercent(comparePlanUsage(job.estimated20xPercent, comparisonPlan), locale)}{job.estimated20xIsComplete === true ? '' : '+'}</strong>
      </li>)}</ol> : <p className="overview-empty">{t(ready ? 'No positive quota estimates in this range.' : 'Waiting for range data…')}</p>}
      <small className="overview-scope-note">{t('One {plan} week = 100%', { plan: comparisonPlans[comparisonPlan].label })}</small>
    </section>
    <section className="overview-highlight" aria-label={t('Current activity')}>
      <div className="overview-highlight-heading"><h3>{t('Current activity')}</h3><span className={`activity-status ${live ? 'live' : ''}`}>{t(live ? 'Live' : 'Last recorded')}</span></div>
      <p className="overview-scope-note">{t('Monitor activity now · independent of the date filter')}</p>
      <dl className="overview-activity-metrics">
        <div><dt>{t('Active tasks')}</dt><dd>{live || sessions.length ? activeCount : '--'}</dd></div>
        <div><dt>{t('Latest recorded activity')}</dt><dd className="activity-time">{latest ? <time dateTime={latest} title={dateTime(latest)}>{relativeActivity(latest, nowMs, language)}</time> : '--'}</dd></div>
      </dl>
      {!live && <small className="overview-scope-note">{t('Activity connection unavailable; showing the last records.')}</small>}
    </section>
  </div>;
}
