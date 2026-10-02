import type { HistoryUsageAllocation } from '../../../shared/monitor';
import { useI18n } from '../LanguageContext';
import { formatUsagePercent } from '../usage-display';

export function QuotaReconciliation({ allocation }: { allocation: HistoryUsageAllocation | null }) {
  const { t, locale } = useI18n();
  if (allocation?.attributionBasis !== 'observedQuotaIncrements') return null;
  const amount = (value: number | null | undefined) => formatUsagePercent(value ?? null, locale);
  return <details className="quota-reconciliation">
    <summary>
      <span className="reconciliation-label">{t('Account quota reconciliation')} <small>{t('This period')}</small></span>
      <span>{t('Account used')} <strong>{amount(allocation.usedPercent)}</strong></span>
      <span>{t('Included tasks')} <strong>{amount(allocation.includedAttributedPercent)}</strong></span>
      {(allocation.outsideScopePercent ?? 0) > 0.00001 && <span>{t('Outside task scope')} <strong>{amount(allocation.outsideScopePercent)}</strong></span>}
      <span className={(allocation.unattributedPercent ?? 0) > 0 ? 'reconciliation-unassigned' : ''}>{t('Unattributed quota')} <strong>{amount(allocation.unattributedPercent)}</strong></span>
      <span className="quality-toggle">{t('Details')}</span>
    </summary>
    <div className="reconciliation-details">
      <p>{t('Included tasks + outside task scope + unattributed quota = account used. Search, hidden rows and sorting do not change these totals.')}</p>
      <p>{t('Recorded account quota increases are allocated by response cost weights in the same observation interval. Missing account windows, prices, observation gaps and consumption before the first reading remain unattributed. This is an estimate, not official per-task usage.')}</p>
      <p>{t('Matching weekly resets (within 60 seconds) estimate account identity; they do not prove it. Account reconciliation uses the account’s own quota, independently of the cross-account calibration reference.')}</p>
    </div>
  </details>;
}
