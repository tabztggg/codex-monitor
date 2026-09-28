import { useMemo, useState } from 'react';
import type { HistoryAnalysis, HistoryModelUsage } from '../../../shared/monitor';
import { useI18n } from '../LanguageContext';
import { formatEstimatedCost, formatTokenCount, formatUsagePercent } from '../usage-display';
import { historicalCacheHit, modelColor, sortModelUsage, summarizeModelCache, summarizeModelCoverage, type ModelSortDirection, type ModelSortKey } from '../model-analytics';
import './ModelAnalytics.css';

const columns: { key: ModelSortKey; label: string }[] = [
  { key: 'model', label: 'Model' }, { key: 'input', label: 'Input' }, { key: 'output', label: 'Output' },
  { key: 'tokens', label: 'Total tokens' }, { key: 'cacheHit', label: 'Cache hit' }, { key: 'tasks', label: 'Reporting tasks' }, { key: 'cost', label: 'API-equivalent cost' }
];

export function ModelUsageTable({ models, caption, sortable = true }: { models: HistoryModelUsage[]; caption: string; sortable?: boolean }) {
  const { t, locale } = useI18n();
  const [sort, setSort] = useState<ModelSortKey>('tokens');
  const [direction, setDirection] = useState<ModelSortDirection>('desc');
  const rows = useMemo(() => sortModelUsage(models, sort, direction), [models, sort, direction]);
  const changeSort = (key: ModelSortKey) => {
    setDirection(sort === key ? direction === 'asc' ? 'desc' : 'asc' : key === 'model' ? 'asc' : 'desc');
    setSort(key);
  };
  return <div className="model-table-scroll" tabIndex={0} role="region" aria-label={caption}>
    <table className="model-usage-table"><caption>{caption}</caption><thead><tr>{columns.map(column => <th key={column.key} scope="col"
      aria-sort={sortable && sort === column.key ? direction === 'asc' ? 'ascending' : 'descending' : undefined}>
      {sortable ? <button type="button" onClick={() => changeSort(column.key)} aria-label={t('Sort by {column}', { column: t(column.label) })}>
        {t(column.label)}{sort === column.key && <span aria-hidden="true"> {direction === 'asc' ? '↑' : '↓'}</span>}
      </button> : t(column.label)}</th>)}</tr></thead><tbody>{rows.map(row => <tr key={row.model ?? '\u0000'}>
        <th scope="row"><span className="model-swatch" style={{ background: modelColor(row.model) }} aria-hidden="true" />{row.model ?? t('Unknown model')}</th>
        <td title={row.usage.inputTokens.toLocaleString(locale)}>{formatTokenCount(row.usage.inputTokens, locale, row.tokensComplete)}</td>
        <td title={row.usage.outputTokens.toLocaleString(locale)}>{formatTokenCount(row.usage.outputTokens, locale, row.tokensComplete)}</td>
        <td title={row.usage.totalTokens.toLocaleString(locale)}>{formatTokenCount(row.usage.totalTokens, locale, row.tokensComplete)}</td>
        <td>{formatUsagePercent(historicalCacheHit(row.usage), locale)}<small>{t('Cached within input')}: {formatTokenCount(row.usage.cachedInputTokens, locale, row.tokensComplete)}</small></td>
        <td>{row.taskCount.toLocaleString(locale)}</td><td>{formatEstimatedCost(row.costUsd, row.costComplete, locale)}</td>
      </tr>)}</tbody></table>
  </div>;
}

export function ModelAnalytics({ analysis, periodLabel }: { analysis: HistoryAnalysis | null; periodLabel: string }) {
  const { t, locale } = useI18n();
  const models = analysis?.models;
  const cache = summarizeModelCache(models);
  const coverage = summarizeModelCoverage(models);
  const pricing = analysis?.pricing;
  const rate = (value: number) => new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD', maximumFractionDigits: 4 }).format(value);
  return <section className="model-analytics" aria-label={t('Model comparison')}>
    <div className="model-analytics-heading"><h3>{t('Model comparison')}</h3><span className="scope-badge">{t('Across accounts')}</span></div>
    <p className="muted-note">{periodLabel} · {t('Local records')} · {t('Models are taken from each recorded usage event. Task counts can overlap across models.')}</p>
    {models?.length ? <>
      <ModelUsageTable models={models} caption={t('Models in the selected period')} />
      <p className="muted-note">{t('Input includes cached input. Output includes reasoning output. + marks partial totals; -- means unavailable, not zero.')}</p>
      <section className="historical-cache" aria-label={t('Historical cache efficiency')}>
        <h4>{t('Historical cache efficiency')}</h4><dl>
          <div><dt>{t('Recorded cache hit')}</dt><dd>{formatUsagePercent(cache.hit, locale)}</dd></div>
          <div><dt>{t('Cached within input')}</dt><dd>{formatTokenCount(cache.cached, locale, cache.complete)}</dd></div>
          <div><dt>{t('Uncached input')}</dt><dd>{formatTokenCount(cache.uncached, locale, cache.complete)}</dd></div>
          <div><dt>{t('Total input')}</dt><dd>{formatTokenCount(cache.input, locale, cache.complete)}</dd></div>
        </dl><p className="muted-note">{t('Cache hit = total cached input / total input in this period; it is not an average of model percentages. Missing records may change this rate.')}</p>
      </section>
    </> : <p role="status">{t(models ? 'No model usage records in this period.' : 'Model usage is unavailable. -- does not mean zero usage.')}</p>}
    <details className="model-price-basis"><summary>{t('Model price basis')}</summary>
      <p className="muted-note">{t('API-equivalent token estimates use the stored rate catalog; they are not subscription charges or official quota deductions. Tool-call fees are excluded.')}</p>
      <dl className="pricing-coverage"><div><dt>{t('Priced share of recorded tokens')}</dt><dd>{formatUsagePercent(coverage.percent, locale)}</dd></div>
        <div><dt>{t('Priced recorded tokens')}</dt><dd>{formatTokenCount(coverage.priced, locale, coverage.complete)}</dd></div>
        <div><dt>{t('Unpriced recorded tokens')}</dt><dd>{formatTokenCount(coverage.unpriced, locale, coverage.complete)}</dd></div></dl>
      <p className="muted-note">{t('Price coverage is weighted by recorded total tokens. Missing records may change this percentage.')}</p>
      {coverage.unpricedModels.length > 0 && <p className="muted-note">{t('Unpriced models')}: {coverage.unpricedModels.map(model => model ?? t('Unknown model')).join(', ')}</p>}
      {pricing ? <>
        <p className="muted-note">{t('USD per 1 million tokens')} · {t('Latest recorded price check')}: <time dateTime={pricing.verifiedAt}>{pricing.verifiedAt.slice(0, 10)}</time> · <a href={pricing.sourceUrl} target="_blank" rel="noreferrer">{t('Official pricing reference')}</a></p>
        <div className="model-table-scroll" tabIndex={0} role="region" aria-label={t('Model price basis')}><table className="model-usage-table model-price-table">
          <caption>{t('Rates used for estimates')}</caption><thead><tr>{['Model', 'Input', 'Cached within input', 'Cache write input', 'Output', 'Recorded price check'].map(label => <th key={label} scope="col">{t(label)}</th>)}</tr></thead>
          <tbody>{pricing.models.map(row => <tr key={row.model}><th scope="row">{row.model}</th><td>{rate(row.input)}</td><td>{rate(row.cachedInput)}</td><td>{rate(row.cacheWriteInput)}</td><td>{rate(row.output)}</td><td>{row.verifiedAt ? <time dateTime={row.verifiedAt}>{row.verifiedAt.slice(0, 10)}</time> : t('Not recorded')}</td></tr>)}</tbody>
        </table></div>
        <p className="muted-note">{t('The stored long-context calculation assumes {input}× input and {output}× output rates above {tokens} input tokens; these multipliers are not verified universal official rates.', {
          tokens: pricing.highContext.inputTokensThreshold.toLocaleString(locale), input: pricing.highContext.inputMultiplier, output: pricing.highContext.outputMultiplier
        })}</p>
        {pricing.note && <p className="muted-note">{t(pricing.note)}</p>}
      </> : <p role="status">{t('Price basis is unavailable.')}</p>}
      <p className="muted-note">{t('Models without a matching price remain unpriced; priced usage is shown as a partial estimate when other usage is missing.')}</p>
    </details>
  </section>;
}
