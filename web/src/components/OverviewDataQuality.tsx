import type { HistoryAnalysis, HistoryArchiveScope, HistoryJob, HistoryUsageAllocation } from '../../../shared/monitor';
import { useI18n } from '../LanguageContext';
import { formatTokenCount } from '../usage-display';
import { summarizeOverviewUsage } from '../overview-metrics';

export function OverviewDataQuality({ jobs, analysis, archives, allocation, updatedAt, onShowBasis }: {
  jobs: HistoryJob[]; analysis: HistoryAnalysis; archives: HistoryArchiveScope; allocation: HistoryUsageAllocation | null; updatedAt: number | null; onShowBasis: () => void;
}) {
  const { t, locale, dateTime } = useI18n();
  const { totals, unknownTaskCount } = summarizeOverviewUsage(jobs);
  const partial = !totals.tokensComplete || !totals.costComplete || !totals.equivalentComplete || analysis.unpricedTokens > 0 || analysis.untimedTokens > 0;
  const limitedArchives = archives.included < archives.total;
  return <details className="overview-data-quality">
    <summary><span>{t('Data coverage')}</span><span className={partial || limitedArchives ? 'quality-partial' : 'quality-complete'}>{t(partial ? 'Partial data' : 'Included records complete')}{limitedArchives ? ` · ${t('Archive scope limited')}` : ''}</span><span className="quality-toggle">{t('Details')}</span></summary>
    <div className="overview-quality-content">
      <p>{t('Local records only. + marks a partial value; -- means unavailable, not zero.')}</p>
      <dl>
        <div><dt>{t('Included tasks')}</dt><dd>{jobs.length}</dd></div>
        <div><dt>{t('Tasks with unknown consumption')}</dt><dd>{unknownTaskCount}</dd></div>
        <div><dt>{t('Archive coverage')}</dt><dd>{t(archives.mode === 'all' ? 'Archives: all {count}' : 'Archives: latest {count} of {total}', { count: archives.included, total: archives.total })}</dd></div>
        <div><dt>{t('Unpriced tokens')}</dt><dd>{formatTokenCount(analysis.unpricedTokens ?? null, locale)}</dd></div>
        <div><dt>{t('Tokens without timestamps')}</dt><dd>{formatTokenCount(analysis.untimedTokens ?? null, locale)}</dd></div>
        <div><dt>{t('Last successful refresh')}</dt><dd>{updatedAt ? dateTime(new Date(updatedAt).toISOString()) : '--'}</dd></div>
      </dl>
      <div className="overview-calibration-note">
        <p>{allocation?.equivalent20x?.source === 'manual' ? t('Manual calibration: normalized to a confirmed account total. Other accounts remain estimates.') : allocation?.equivalent20x?.source === 'previous' ? t('Retaining the previous cross-account reference until current-window records support a new calibration.') : t(allocation?.equivalent20x?.costPerPercentUsd ? 'Based on local records and observed quota changes.' : 'Waiting for enough recorded 20x weekly quota changes; -- means unavailable.')}</p>
        <button type="button" className="basis-link" onClick={onShowBasis}>{t('Estimation basis')} <span aria-hidden="true">→</span></button>
      </div>
    </div>
  </details>;
}
