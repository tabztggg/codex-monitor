import { useEffect, useState } from 'react';
import type { OfficialTaskUsage, OfficialUsageData } from '../../../shared/monitor';
import { api } from '../api';
import { useI18n } from '../LanguageContext';

export function officialShares(data: OfficialUsageData, dimension: 'model' | 'effort' | 'speed') {
  const sums = new Map<string, number>();
  for (const group of data.groups) {
    if (group.weeklyPercent === null) continue;
    const name = group[dimension] ?? 'Unknown';
    sums.set(name, (sums.get(name) ?? 0) + group.weeklyPercent);
  }
  return [...sums].map(([name, value]) => ({ name, share: data.weeklyPercent && data.weeklyPercent > 0 ? value / data.weeklyPercent * 100 : null }))
    .sort((a, b) => (b.share ?? -1) - (a.share ?? -1));
}

export function OfficialTaskUsagePanel({ threadId }: { threadId: string }) {
  const [usage, setUsage] = useState<OfficialTaskUsage | null>(null);
  const [failed, setFailed] = useState(false);
  const { t, locale, dateTime } = useI18n();
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      if (document.hidden) { timer = setTimeout(() => void load(), 30_000); return; }
      try {
        const next = await api.fetchOfficialTaskUsage(threadId, controller.signal);
        if (!controller.signal.aborted) { setUsage(next); setFailed(false); }
      } catch { if (!controller.signal.aborted) setFailed(true); }
      // Only an expanded, visible detail checks the local cache. Provider TTL is five minutes.
      if (!controller.signal.aborted) timer = setTimeout(() => void load(), 30_000);
    };
    void load();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [threadId]);
  const number = (value: number) => value.toLocaleString(locale, { maximumFractionDigits: 2 });
  const name = (value: string) => ({ low: t('Low'), medium: t('Medium'), high: t('High'), xhigh: t('Extra high'), max: t('Maximum'),
    minimal: t('Minimal'), none: t('None'), standard: t('Standard'), fast: t('Fast'), priority: t('Priority'), Unknown: t('Unknown') }[value]
    ?? (value.startsWith('gpt-') ? value.replace(/^gpt-/, 'GPT-').replace(/-(astra|sol|luna|terra)$/, (_, model: string) => ` ${model[0].toUpperCase()}${model.slice(1)}`) : value));
  const data = usage?.data;
  return <section className="official-task-usage" aria-label={t('Official lifetime usage')}>
    <h4>{t('Official lifetime usage')}</h4>
    <p className="muted-note">{t('Task lifetime, including subtasks. One full weekly allowance of the query account = 100%. Not this quota period; independent of the plan comparison selector.')}</p>
    {!data ? <p role="status">{t(!usage && !failed ? 'Reading official usage…' : 'Official usage is not available yet. Local estimates remain available.')}</p> : <>
      <div className="official-usage-total"><strong>{data.weeklyPercent === null ? '—' : `${number(data.weeklyPercent)}%`}</strong><span>{t('of a full weekly allowance')}</span>
        {data.credits !== null && <span>{t('Credits used')}: {number(data.credits)}</span>}</div>
      <div className="official-usage-breakdowns">{(['model', 'effort', 'speed'] as const).map(dimension => {
        const shares = officialShares(data, dimension);
        return <div key={dimension}><h5>{t({ model: 'Model', effort: 'Reasoning effort', speed: 'Speed' }[dimension])}</h5>
          <ul>{shares.length ? shares.map(item => <li key={item.name}><span>{name(item.name)}</span><strong>{item.share === null ? '—' : item.share > 0 && item.share < 0.01 ? '<0.01%' : `${number(item.share)}%`}</strong></li>) : <li>{t('Unavailable')}</li>}</ul></div>;
      })}</div>
      <p className="muted-note">{t('Breakdown percentages are shares of this task’s official included-plan usage. Credits are separate; zero credits does not mean zero plan usage.')}</p>
      <p className="muted-note">{t('Data through')}: {data.dataAsOf ? dateTime(data.dataAsOf) : t('Unavailable')} · {t('Updated at {time}', { time: dateTime(data.fetchedAt) })}</p>
      {(usage?.stale || usage?.refreshing || failed) && <p role="status">{t('Showing the last confirmed official data; background updates may be delayed.')}</p>}
    </>}
    <p className="muted-note">{t('Query account')}: {usage?.account ?? t('CLI account')} · {t('Official data can lag behind live usage. Cached for five minutes; read only when a task is expanded.')}</p>
  </section>;
}
