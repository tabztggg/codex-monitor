import type { HistoryAnalysis, HistoryArchiveScope, HistoryJob, HistoryModelUsage, HistoryPricingCatalog, HistoryUsageAllocation, TokenUsage } from '../../shared/monitor';
import { historicalCacheHit } from './model-analytics';

export interface ReportExportInput {
  /** The complete selected scope, before table searching or hiding rows. */
  jobs: HistoryJob[];
  analysis: HistoryAnalysis | null;
  allocation: HistoryUsageAllocation | null;
  archives: HistoryArchiveScope | null;
  pricing: HistoryPricingCatalog | null;
  includeDisplayNames?: boolean;
  exportedAt?: string;
}

const tokenKeys = ['inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalTokens'] as const;
type ReportTokens = Record<typeof tokenKeys[number], number | null> & { uncachedInputTokens: number | null };
type ReportMetrics = {
  usage: ReportTokens; costUsd: number | null; tokensComplete: boolean; costComplete: boolean;
  cacheHitPercent: number | null; unpricedTokens: number | null; untimedTokens: number | null;
  equivalent20xPercent: number | null; equivalent20xComplete: boolean;
};
const amount = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const stamp = (value: unknown): string | null => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const sum = (values: (number | null)[]): number | null => {
  const known = values.filter((value): value is number => value !== null);
  return known.length ? amount(known.reduce((total, value) => total + value, 0)) : null;
};

function tokens(usage: TokenUsage | null | undefined): ReportTokens {
  const result = Object.fromEntries(tokenKeys.map(key => [key, amount(usage?.[key])])) as ReportTokens;
  if (result.inputTokens === null || result.cachedInputTokens === null || result.cachedInputTokens > result.inputTokens) result.cachedInputTokens = null;
  if (result.outputTokens === null || (result.reasoningOutputTokens !== null && result.reasoningOutputTokens > result.outputTokens)) result.reasoningOutputTokens = null;
  result.uncachedInputTokens = result.inputTokens !== null && result.cachedInputTokens !== null ? result.inputTokens - result.cachedInputTokens : null;
  return result;
}

function metrics(usage: TokenUsage | null | undefined, cost: unknown, complete: boolean, costComplete: boolean, unpriced: unknown, untimed: unknown, equivalent: unknown = null, equivalentComplete = false): ReportMetrics {
  const normalized = tokens(usage);
  const tokensComplete = complete && ['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalTokens'].every(key => normalized[key as keyof ReportTokens] !== null);
  const costUsd = amount(cost);
  return { usage: normalized, costUsd, tokensComplete, costComplete: costComplete && costUsd !== null,
    equivalent20xPercent: amount(equivalent), equivalent20xComplete: equivalentComplete && amount(equivalent) !== null,
    cacheHitPercent: historicalCacheHit(usage),
    unpricedTokens: amount(unpriced), untimedTokens: amount(untimed) };
}

function modelRows(models: HistoryModelUsage[] | undefined, reference: number | null) {
  return models?.map(row => ({ model: row.model, taskCount: amount(row.taskCount),
    ...metrics(row.usage, row.costUsd, row.tokensComplete, row.costComplete, row.unpricedTokens, null,
      reference !== null && reference > 0 && amount(row.costUsd) !== null ? row.costUsd! / reference : null, row.costComplete) })) ?? null;
}

/** Names are opt-in; even opted-in names cannot reveal known identities or paths. */
function displayName(value: string | null | undefined, fallback: string, privateValues: string[]): string {
  if (!value) return fallback;
  let clean = value;
  for (const secret of privateValues.filter(Boolean).sort((a, b) => b.length - a.length)) clean = clean.split(secret).join('[redacted]');
  clean = clean.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted]')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[redacted]')
    .replace(/(?:file:\/\/\S+|[A-Z]:[\\/][^\r\n]*|\\\\[^\r\n]*|(?:^|\s)\/(?:[^\s/]+\/)+\S*)/gi, '[redacted]');
  return clean || fallback;
}

/** A field whitelist, never a serialization of jobs, account snapshots or transcripts. */
export function buildUsageReport(input: ReportExportInput) {
  const { jobs, analysis, archives, pricing } = input;
  const calibration = input.allocation?.equivalent20x;
  const reference = amount(calibration?.costPerPercentUsd);
  const privateValues = jobs.flatMap(job => [job.id, job.cwd ?? '', job.project?.id ?? '']);
  const account = input.allocation?.currentAccount;
  if (account?.email) privateValues.push(account.email);
  const projects = new Map<string, string>();
  const tasks = jobs.map((job, index) => {
    const projectKey = job.project?.id ?? '';
    if (!projects.has(projectKey)) projects.set(projectKey, `Project ${projects.size + 1}`);
    const taskAlias = `Task ${index + 1}`;
    const projectAlias = projects.get(projectKey)!;
    const period = job.periodMetrics;
    return {
      task: input.includeDisplayNames ? displayName(job.name, taskAlias, privateValues) : taskAlias,
      project: input.includeDisplayNames ? displayName(job.project?.name, projectAlias, privateValues) : projectAlias,
      taskAlias, projectAlias,
      archived: job.archived,
      ...metrics(period?.usage, period?.costUsd, period?.tokensComplete === true, period?.costComplete === true, period?.unpricedTokens, period?.untimedTokens,
        period ? job.estimated20xPercent : null, period?.costComplete === true && job.estimated20xIsComplete === true),
      models: modelRows(period?.models, reference)
    };
  });
  const usage = Object.fromEntries([...tokenKeys, 'uncachedInputTokens' as const].map(key => [key, sum(tasks.map(task => task.usage[key]))])) as ReportTokens;
  const tokensComplete = tasks.length > 0 && tasks.every(task => task.tokensComplete);
  // Independently summed columns must cover the same tasks before forming a ratio.
  // Incomplete logs can still provide a valid input/cache pair; missing pairs cannot.
  const cachePairsValid = tasks.every(task => task.usage.inputTokens !== null && task.usage.cachedInputTokens !== null);
  const totals: ReportMetrics = { usage, costUsd: sum(tasks.map(task => task.costUsd)), tokensComplete,
    costComplete: tasks.length > 0 && tasks.every(task => task.costComplete),
    equivalent20xPercent: sum(tasks.map(task => task.equivalent20xPercent)),
    equivalent20xComplete: tasks.length > 0 && tasks.every(task => task.equivalent20xComplete),
    cacheHitPercent: cachePairsValid && usage.inputTokens !== null && usage.cachedInputTokens !== null
      ? historicalCacheHit({ inputTokens: usage.inputTokens, cachedInputTokens: usage.cachedInputTokens }) : null,
    unpricedTokens: sum(tasks.map(task => task.unpricedTokens)), untimedTokens: sum(tasks.map(task => task.untimedTokens)) };
  return {
    schemaVersion: 1,
    exportedAt: stamp(input.exportedAt) ?? new Date().toISOString(),
    privacy: { displayNamesIncluded: input.includeDisplayNames === true, promptsPathsAndAccountIdentityOmitted: true },
    scope: { period: analysis?.period ?? null, startedAt: stamp(analysis?.startedAt), endedAt: stamp(analysis?.endedAt),
      timeZone: analysis?.timeZone ?? null, acrossAccounts: true, includesHiddenRows: true,
      archives: archives ? { mode: archives.mode, included: amount(archives.included), total: amount(archives.total) } : null },
    taskCount: tasks.length,
    equivalentBasis: { plan: 'Pro20x', denominator: 'One normalized Pro20x weekly allowance = 100%',
      calibration: { costPerPercentUsd: reference, source: calibration?.source ?? null, calibratedAt: stamp(calibration?.calibratedAt) } },
    totals,
    models: modelRows(analysis?.models, reference),
    days: analysis?.days.map(day => ({ date: /^\d{4}-\d{2}-\d{2}$/.test(day.date) ? day.date : null,
      ...metrics(day.usage, day.costUsd, tokensComplete && analysis.untimedTokens === 0,
        day.unpricedTokens === 0 && analysis.untimedTokens === 0 && totals.costComplete, day.unpricedTokens, null,
        reference !== null && reference > 0 && amount(day.costUsd) !== null ? day.costUsd! / reference : null,
        day.unpricedTokens === 0 && analysis.untimedTokens === 0 && totals.costComplete), models: modelRows(day.models, reference) })) ?? null,
    tasks,
    pricing: pricing ? { currency: pricing.currency, unit: pricing.unit, verifiedAt: pricing.verifiedAt, sourceUrl: pricing.sourceUrl,
      models: pricing.models.map(model => ({ model: model.model, input: amount(model.input), cachedInput: amount(model.cachedInput),
        cacheWriteInput: amount(model.cacheWriteInput), output: amount(model.output), verifiedAt: model.verifiedAt ?? null })),
      highContext: { inputTokensThreshold: amount(pricing.highContext.inputTokensThreshold), inputMultiplier: amount(pricing.highContext.inputMultiplier), outputMultiplier: amount(pricing.highContext.outputMultiplier) }, note: pricing.note } : null,
    notes: [
      'Selected-range local records across accounts, including hidden rows and the selected archive scope. Other devices and missing logs are not covered.',
      'Costs are API-equivalent USD estimates, not subscription charges or official account quota deductions. Tool-call fees are excluded.',
      'Equivalent usage always uses the normalized Pro20x denominator: one weekly allowance = 100%, independent of the dashboard comparison selector. It is an estimate and can exceed 100%.',
      'Cached input is part of input; reasoning output is part of output. Neither is added again to total tokens.',
      'Null means unknown or unavailable, never zero. Completeness flags describe the included records. A partial total sums only known values.',
      'Model and daily usage follow recorded incremental events. Cache hit is cached input divided by input for recorded samples only; missing records may change the result. Unknown or invalid input/cache pairs, or zero input, are unavailable.'
    ]
  };
}

export type UsageReport = ReturnType<typeof buildUsageReport>;
export type UsageReportFormat = 'html' | 'csv' | 'json';
export const reportJson = (report: UsageReport): string => JSON.stringify(report, null, 2);

/** Excel also recognizes formulas after whitespace or control characters. */
export function reportCsvCell(value: unknown): string {
  const raw = value === null || value === undefined ? '' : String(value);
  const safe = typeof value === 'string' && /^[\s\u0000-\u001f]*[=+\-@]/u.test(raw) ? `'${raw}` : raw;
  return `"${safe.replace(/"/g, '""')}"`;
}

export function reportCsv(report: UsageReport): string {
  const headers = ['section', 'name', 'project', 'taskAlias', 'projectAlias', 'date', 'model', ...tokenKeys, 'uncachedInputTokens', 'cacheHitPercent', 'costUsd', 'tokensComplete', 'costComplete', 'equivalent20xPercent', 'equivalent20xComplete', 'unpricedTokens', 'untimedTokens', 'taskCount', 'attribute', 'value'];
  const rows: Record<string, unknown>[] = [];
  const meta = (attribute: string, value: unknown, section = 'metadata') => rows.push({ section, attribute, value });
  meta('exportedAt', report.exportedAt);
  meta('schemaVersion', report.schemaVersion);
  for (const [key, value] of Object.entries(report.scope)) meta(key, typeof value === 'object' && value !== null ? JSON.stringify(value) : value);
  meta('displayNamesIncluded', report.privacy.displayNamesIncluded);
  meta('taskCount', report.taskCount);
  meta('equivalentBasis', JSON.stringify(report.equivalentBasis));
  meta('emptyNumericCells', 'Unknown or unavailable, not zero');
  meta('modelBreakdownAvailable', report.models !== null);
  report.notes.forEach(note => meta('note', note));
  const addMetrics = (row: ReportMetrics, fields: Record<string, unknown>) => rows.push({ ...fields, ...row.usage,
    costUsd: row.costUsd, tokensComplete: row.tokensComplete, costComplete: row.costComplete, cacheHitPercent: row.cacheHitPercent,
    equivalent20xPercent: row.equivalent20xPercent, equivalent20xComplete: row.equivalent20xComplete,
    unpricedTokens: row.unpricedTokens, untimedTokens: row.untimedTokens });
  addMetrics(report.totals, { section: 'total' });
  for (const row of report.models ?? []) addMetrics(row, { section: 'model', model: row.model, taskCount: row.taskCount });
  for (const day of report.days ?? []) {
    addMetrics(day, { section: 'day', date: day.date });
    for (const row of day.models ?? []) addMetrics(row, { section: 'day-model', date: day.date, model: row.model, taskCount: row.taskCount });
  }
  for (const row of report.tasks) {
    addMetrics(row, { section: 'task', name: row.task, project: row.project, taskAlias: row.taskAlias, projectAlias: row.projectAlias });
    meta(`archived:${row.taskAlias}`, row.archived, 'task-metadata');
    for (const model of row.models ?? []) addMetrics(model, { section: 'task-model', name: row.task, project: row.project, taskAlias: row.taskAlias, projectAlias: row.projectAlias, model: model.model, taskCount: model.taskCount });
  }
  if (report.pricing) {
    for (const [key, value] of Object.entries(report.pricing)) if (key !== 'models') meta(key, typeof value === 'object' ? JSON.stringify(value) : value, 'pricing');
    for (const model of report.pricing.models) for (const field of ['input', 'cachedInput', 'cacheWriteInput', 'output', 'verifiedAt'] as const) rows.push({ section: 'model-price', model: model.model, attribute: field, value: model[field] });
  } else meta('pricing', null, 'pricing');
  return '\uFEFF' + [headers, ...rows.map(row => headers.map(key => row[key]))].map(row => row.map(reportCsvCell).join(',')).join('\r\n');
}

export function escapeReportHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));
}

export function reportHtml(report: UsageReport, language: 'en' | 'zh' = 'en'): string {
  const zh = language === 'zh';
  const label = (en: string, cn: string) => zh ? cn : en;
  const title = label('Codex usage report', 'Codex 用量报告');
  const cell = (value: unknown) => escapeReportHtml(value === null || value === undefined ? '—' : value);
  const number = (value: number | null) => value === null ? '—' : value.toLocaleString(zh ? 'zh-CN' : 'en-US', { maximumFractionDigits: 6 });
  const status = (row: ReportMetrics) => label(`Tokens: ${row.tokensComplete ? 'complete' : 'partial/unknown'}; cost: ${row.costComplete ? 'complete' : 'partial/unknown'}; equivalent: ${row.equivalent20xComplete ? 'complete' : 'partial/unknown'}`, `Token：${row.tokensComplete ? '完整' : '部分／未知'}；费用：${row.costComplete ? '完整' : '部分／未知'}；等效：${row.equivalent20xComplete ? '完整' : '部分／未知'}`);
  const table = (heading: string, rows: { name: string | null; metrics: ReportMetrics }[]) => `<section><h2>${cell(heading)}</h2><div class="table-scroll"><table><thead><tr>${[
    label('Item', '项目'), label('Input', '输入'), label('Cached input', '缓存输入'), label('Uncached input', '非缓存输入'), label('Cache writes', '缓存写入'), label('Output', '输出'), label('Reasoning', '推理输出'), label('Total tokens', '总 Token'), label('Cache hit %', '缓存命中 %'), 'USD', 'Pro20x %', label('Completeness', '完整性')
  ].map(header => `<th>${cell(header)}</th>`).join('')}</tr></thead><tbody>${rows.length ? rows.map(({ name, metrics: row }) => `<tr><th>${cell(name)}</th>${[row.usage.inputTokens, row.usage.cachedInputTokens, row.usage.uncachedInputTokens, row.usage.cacheWriteInputTokens, row.usage.outputTokens, row.usage.reasoningOutputTokens, row.usage.totalTokens, row.cacheHitPercent, row.costUsd, row.equivalent20xPercent].map(value => `<td>${cell(number(value))}</td>`).join('')}<td>${cell(status(row))}</td></tr>`).join('') : `<tr><td colspan="12">${label('Unavailable', '不可用')}</td></tr>`}</tbody></table></div></section>`;
  const priceTable = report.pricing ? `<p>${cell(report.pricing.sourceUrl)} · USD / 1,000,000 tokens</p><p>${label('Catalog review date; individual rates have their own verification dates', '价目表复核日期；各模型价格的核验日期分别列出')}: ${cell(report.pricing.verifiedAt)}</p><table><thead><tr>${['Model', 'Input', 'Cached input', 'Cache writes', 'Output', label('Rate verified', '价格核验日期')].map(value => `<th>${cell(value)}</th>`).join('')}</tr></thead><tbody>${report.pricing.models.map(row => `<tr><th>${cell(row.model)}</th>${[row.input, row.cachedInput, row.cacheWriteInput, row.output].map(value => `<td>${cell(number(value))}</td>`).join('')}<td>${cell(row.verifiedAt)}</td></tr>`).join('')}</tbody></table><p>${cell(report.pricing.note)}</p><p>${label('High-context pricing', '长上下文价格')}：${cell(JSON.stringify(report.pricing.highContext))}</p>` : `<p>${label('Pricing unavailable', '价格依据不可用')}</p>`;
  const equivalentBasis = `<section><h2>${label('Normalized Pro20x equivalent basis', '标准化 Pro20x 等效依据')}</h2><p>${label('One normalized Pro20x weekly allowance = 100%. This estimate is independent of the dashboard comparison selector and may exceed 100%.', '一份标准化 Pro20x 周额度 = 100%。该估算独立于页面的套餐比较选择，可以超过 100%。')}</p><p>${label('Estimated USD per 1%', '每 1% 对应估算美元')}: ${cell(number(report.equivalentBasis.calibration.costPerPercentUsd))} · ${label('Calibration source', '校准来源')}: ${cell(report.equivalentBasis.calibration.source)} · ${label('Calibration updated', '校准更新时间')}: ${cell(report.equivalentBasis.calibration.calibratedAt)}</p></section>`;
  // No executable scripts, remote assets or unescaped embedded JSON.
  return `<!doctype html><html lang="${zh ? 'zh-CN' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${title}</title><style>body{font:14px/1.6 system-ui,sans-serif;color:#172c36;background:#f6f8fa;margin:0;padding:36px}main{max-width:1400px;margin:auto}h1{font-size:30px;margin-bottom:4px}h2{font-size:19px}section{background:white;border:1px solid #dce4e9;border-radius:10px;padding:20px;margin:20px 0}p{overflow-wrap:anywhere}.table-scroll{overflow:auto}table{border-collapse:collapse;width:100%;font-size:12px}th,td{padding:9px 10px;border-bottom:1px solid #e3e8ec;text-align:right;vertical-align:top}th:first-child{text-align:left}thead{background:#edf3f7}tbody th{font-weight:500;overflow-wrap:anywhere;max-width:280px}.muted{color:#536772}details pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:11px}@media print{body{padding:0;background:white}section{break-inside:avoid}.table-scroll{overflow:visible}}</style></head><body><main><h1>${title}</h1><p class="muted">${label('Exported', '导出时间')}: ${cell(report.exportedAt)}</p><section><h2>${label('Scope and data coverage', '统计范围与数据覆盖')}</h2><p>${cell(report.scope.period)} · ${cell(report.scope.startedAt)} → ${cell(report.scope.endedAt)} · ${cell(report.scope.timeZone)}</p><p>${label('Across accounts · includes hidden rows', '跨账号 · 包含隐藏行')} · ${report.taskCount} ${label('tasks', '个任务')} · ${label('Archives', '归档')}: ${cell(report.scope.archives?.included)} / ${cell(report.scope.archives?.total)} (${cell(report.scope.archives?.mode)})</p><p>${label('Unpriced tokens', '未定价 Token')}: ${cell(number(report.totals.unpricedTokens))} · ${label('Tokens without timestamps', '缺少时间戳的 Token')}: ${cell(number(report.totals.untimedTokens))}</p><p>${label('Display names included', '包含显示名称')}: ${cell(report.privacy.displayNamesIncluded)}</p><ul>${(zh ? ['仅统计所选范围的本地记录；包含隐藏行及选定归档，其他设备和缺失日志不在覆盖范围。','费用为 API 等价美元估算，不是订阅账单或官方额度扣减，不含工具调用费用。','缓存输入包含在输入中，推理输出包含在输出中，不重复计入总 Token。','— 表示未知或不可用，不等于零；部分合计只累加已知值。','模型和日期按日志中的增量记录归属；缓存命中率为缓存输入除以输入，是仅已记录样本的比率，缺失记录可能改变结果。输入与缓存输入无法配对、未知、非法或分母为零时不计算。'] : report.notes).map(note => `<li>${cell(note)}</li>`).join('')}</ul></section>${equivalentBasis}${table(label('Selected-range totals', '所选范围合计'), [{ name: label('Total', '合计'), metrics: report.totals }])}${table(label('Models', '模型'), (report.models ?? []).map(row => ({ name: row.model, metrics: row })))}${table(label('Daily usage', '每日用量'), (report.days ?? []).map(row => ({ name: row.date, metrics: row })))}${table(label('Tasks', '任务'), report.tasks.map(row => ({ name: `${row.project} / ${row.task}`, metrics: row })))}<section><h2>${label('Price basis', '价格依据')}</h2>${priceTable}</section><section><details><summary>${label('Complete report data (JSON)', '完整报告数据（JSON）')}</summary><pre>${escapeReportHtml(reportJson(report))}</pre></details></section></main></body></html>`;
}

export function usageReportFile(report: UsageReport, format: UsageReportFormat, language: 'en' | 'zh' = 'en') {
  return { filename: `codex-usage-${report.exportedAt.replace(/[^0-9TZ]/g, '-')}.${format}`,
    mimeType: { html: 'text/html;charset=utf-8', csv: 'text/csv;charset=utf-8', json: 'application/json;charset=utf-8' }[format],
    content: format === 'html' ? reportHtml(report, language) : format === 'csv' ? reportCsv(report) : reportJson(report) };
}
