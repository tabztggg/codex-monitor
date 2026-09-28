import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { HistoryAnalysis, HistoryJob, HistoryPricingCatalog, TokenUsage } from '../../../shared/monitor';
import { buildUsageReport, escapeReportHtml, reportCsv, reportCsvCell, reportHtml, reportJson, usageReportFile, type ReportExportInput } from '../../../web/src/report-export';
import { ReportExport } from '../../../web/src/components/ReportExport';
import { historicalCacheHit } from '../../../web/src/model-analytics';

const usage = (input = 80, output = 20, cached = 60): TokenUsage => ({ inputTokens: input, outputTokens: output, cachedInputTokens: cached, cacheWriteInputTokens: 3, reasoningOutputTokens: 5, totalTokens: input + output });
const job = (id: string, name: string, overrides: Partial<HistoryJob> = {}): HistoryJob => ({
  id, name, preview: 'SECRET_CHAT_PLAINTEXT', cwd: 'D:\\PrivateWorkspace\\private-folder',
  project: { id: 'PRIVATE_PROJECT_ID', name: 'Secret Project Name' }, archived: false,
  totalUsage: usage(80000, 20000, 60000), totalEstimatedCostUsd: 10000,
  estimated20xPercent: 2, estimated20xIsComplete: true,
  periodMetrics: { usage: usage(), costUsd: 1, tokensComplete: true, costComplete: true, unpricedTokens: 0, untimedTokens: 0 },
  ...overrides
} as HistoryJob);
const pricing: HistoryPricingCatalog = {
  currency: 'USD', unit: 'perMillionTokens', verifiedAt: '2026-09-28', sourceUrl: 'https://developers.openai.com/api/docs/pricing',
  models: [{ model: 'gpt-test', input: 2, cachedInput: 0.2, cacheWriteInput: 2.5, output: 10, verifiedAt: '2026-09-28' }],
  highContext: { inputTokensThreshold: 200000, inputMultiplier: 2, outputMultiplier: 1.5 }, note: 'Public price basis'
};
const analysis: HistoryAnalysis = {
  period: 'custom', startedAt: '2026-09-27T16:00:00Z', endedAt: '2026-09-28T15:59:59Z', timeZone: 'Asia/Hong_Kong',
  unpricedTokens: 0, untimedTokens: 0,
  days: [{ date: '2026-09-28', usage: usage(160, 40, 120), costUsd: 2, unpricedTokens: 0 }],
  models: [{ model: 'gpt-test', usage: usage(160, 40, 120), costUsd: 2, unpricedTokens: 0, taskCount: 2, tokensComplete: true, costComplete: true }]
};
const input = (overrides: Partial<ReportExportInput> = {}): ReportExportInput => ({
  jobs: [job('PRIVATE_SESSION_ID_1', 'Secret Task One'), job('PRIVATE_SESSION_ID_2', 'Secret Hidden Task', { archived: true })],
  analysis, archives: { mode: 'recent', included: 1, total: 9 }, pricing,
  allocation: { currentAccount: { type: 'chatgpt', email: 'private-account@example.com', planType: 'pro' },
    equivalent20x: { costPerPercentUsd: 0.5, calibrationQuotaPercent: 15, source: 'current', calibratedAt: '2026-09-28T07:00:00Z' },
    status: 'available', usedPercent: 77, windowStartedAt: '2026-09-27', resetsAt: null, limitName: null, windowLabel: null, basis: 'apiEquivalentCost' },
  exportedAt: '2026-09-28T08:00:00Z', ...overrides
});

describe('privacy-preserving selected-range reports', () => {
  it('whitelists all formats and omits names, account identity, IDs, paths and transcript by default', () => {
    const report = buildUsageReport(input());
    for (const output of [reportJson(report), reportCsv(report), reportHtml(report)]) {
      for (const secret of ['PRIVATE_SESSION_ID_1', 'PRIVATE_SESSION_ID_2', 'PRIVATE_PROJECT_ID', 'Secret Task One', 'Secret Hidden Task',
        'Secret Project Name', 'SECRET_CHAT_PLAINTEXT', 'private-account@example.com', 'PrivateWorkspace', 'private-folder']) expect(output).not.toContain(secret);
      expect(output).toContain('Task 1');
      expect(output).toContain('Project 1');
    }
    expect(report.privacy.displayNamesIncluded).toBe(false);
    expect(report.tasks.map(task => task.archived)).toEqual([false, true]);
  });

  it('uses all supplied scoped jobs including hidden and archived rows, never lifetime or quota totals', () => {
    const report = buildUsageReport(input());
    expect(report.totals.usage).toEqual({ inputTokens: 160, outputTokens: 40, cachedInputTokens: 120, cacheWriteInputTokens: 6, reasoningOutputTokens: 10, totalTokens: 200, uncachedInputTokens: 40 });
    expect(report.totals.costUsd).toBe(2);
    expect(report.totals.cacheHitPercent).toBe(75);
    expect(report.totals.equivalent20xPercent).toBe(4);
    expect(report.totals.equivalent20xComplete).toBe(true);
    expect(report.tasks[0].equivalent20xPercent).toBe(2);
    expect(report.models?.[0].equivalent20xPercent).toBe(4);
    expect(report.equivalentBasis).toEqual({ plan: 'Pro20x', denominator: 'One normalized Pro20x weekly allowance = 100%', calibration: { costPerPercentUsd: 0.5, source: 'current', calibratedAt: '2026-09-28T07:00:00.000Z' } });
    expect(report.taskCount).toBe(2);
    expect(report.scope).toMatchObject({ period: 'custom', startedAt: '2026-09-27T16:00:00.000Z', endedAt: '2026-09-28T15:59:59.000Z', timeZone: 'Asia/Hong_Kong', acrossAccounts: true, includesHiddenRows: true, archives: { mode: 'recent', included: 1, total: 9 } });
    expect(report.models?.[0].usage.totalTokens).toBe(200);
    expect(report.days?.[0].usage.totalTokens).toBe(200);
    expect(report.pricing).toEqual(pricing);
    expect(reportJson(report)).not.toContain('usedPercent');
    expect(reportCsv(report)).toContain('"model-price"');
  });

  it('preserves unavailable versus recorded zero, and marks partial totals', () => {
    const noPeriod = job('PRIVATE_SESSION_ID_3', 'Missing metrics', { periodMetrics: undefined });
    const unknown = buildUsageReport(input({ jobs: [noPeriod], analysis: null, pricing: null }));
    expect(unknown.totals.usage.totalTokens).toBeNull();
    expect(unknown.totals.costUsd).toBeNull();
    expect(unknown.totals.cacheHitPercent).toBeNull();
    expect(unknown.totals.equivalent20xPercent).toBeNull();
    expect(unknown.totals.equivalent20xComplete).toBe(false);
    expect(unknown.totals.tokensComplete).toBe(false);
    expect(unknown.models).toBeNull();
    expect(unknown.pricing).toBeNull();
    const zeroUsage = { ...usage(0, 0, 0), cacheWriteInputTokens: 0, reasoningOutputTokens: 0 };
    const zero = buildUsageReport(input({ jobs: [job('ZERO', 'Zero', { periodMetrics: { usage: zeroUsage, costUsd: 0, tokensComplete: true, costComplete: true, unpricedTokens: 0, untimedTokens: 0 } })] }));
    expect(zero.totals.usage.totalTokens).toBe(0);
    expect(zero.totals.costUsd).toBe(0);
    expect(zero.totals.tokensComplete).toBe(true);
    expect(zero.totals.cacheHitPercent).toBeNull();
    const partial = buildUsageReport(input({ jobs: [job('KNOWN', 'Known'), noPeriod] }));
    expect(partial.totals.usage.totalTokens).toBe(100);
    expect(partial.totals.costUsd).toBe(1);
    expect(partial.totals.tokensComplete).toBe(false);
    expect(partial.totals.costComplete).toBe(false);
    expect(partial.totals.cacheHitPercent).toBeNull();
    expect(partial.totals.equivalent20xPercent).toBe(2);
    expect(partial.totals.equivalent20xComplete).toBe(false);
  });

  it('only includes opted-in display names, with known identities and paths redacted even in those names', () => {
    const report = buildUsageReport(input({ includeDisplayNames: true }));
    expect(reportJson(report)).toContain('Secret Task One');
    expect(reportJson(report)).toContain('Secret Project Name');
    expect(reportJson(report)).not.toContain('SECRET_CHAT_PLAINTEXT');
    const redacted = buildUsageReport(input({ includeDisplayNames: true, jobs: [job('PRIVATE_SESSION_ID_1', 'Report private-account@example.com PRIVATE_SESSION_ID_1 D:\\PrivateWorkspace\\private-folder')] }));
    const json = reportJson(redacted);
    for (const secret of ['private-account@example.com', 'PRIVATE_SESSION_ID_1', 'PrivateWorkspace', 'private-folder']) expect(json).not.toContain(secret);
    expect(redacted.tasks[0].task).toContain('[redacted]');
  });

  it('escapes HTML in tables and embedded data without scripts or external dependencies', () => {
    const attack = '</script><img src=x onerror="alert(1)">&\'';
    const report = buildUsageReport(input({ includeDisplayNames: true, jobs: [job('ATTACK_ID', attack)],
      analysis: { ...analysis, models: [{ ...analysis.models![0], model: attack }] }, pricing: { ...pricing, note: attack } }));
    const html = reportHtml(report);
    expect(html).not.toMatch(/<script\b|<img\b|<link\b/i);
    expect(html).not.toContain('</script>');
    expect(html).toContain('&lt;/script&gt;&lt;img');
    expect(html).toContain('&quot;alert(1)&quot;');
    expect(html).toContain("default-src 'none'");
    expect(escapeReportHtml('<>&"\'')).toBe('&lt;&gt;&amp;&quot;&#39;');
    expect(reportHtml(report, 'zh')).toContain('Codex 用量报告');
  });

  it('neutralizes CSV formulas including whitespace/control prefixes and escapes quotes/newlines', () => {
    for (const value of ['=1+1', '+SUM(1,2)', '-cmd', '@SUM(1,2)', ' \t=HYPERLINK("url")', '\r\n+1']) expect(reportCsvCell(value)).toMatch(/^"'/);
    expect(reportCsvCell('safe,"value"\nnext')).toBe('"safe,""value""\nnext"');
    expect(reportCsvCell(0)).toBe('"0"');
    expect(reportCsvCell(null)).toBe('""');
    const csv = reportCsv(buildUsageReport(input({ includeDisplayNames: true, jobs: [job('FORMULA_ID', '=HYPERLINK("bad")')] })));
    expect(csv).toContain('"\'=HYPERLINK(""bad"")"');
    expect(csv.startsWith('\uFEFF')).toBe(true);
  });

  it('rejects malformed cache data without inventing efficiency or a zero value', () => {
    const report = buildUsageReport(input({ jobs: [job('BAD', 'Bad cache', { periodMetrics: { usage: usage(80, 20, 90), costUsd: null, tokensComplete: true, costComplete: false, unpricedTokens: 100, untimedTokens: 0 } })] }));
    expect(report.totals.usage.cachedInputTokens).toBeNull();
    expect(report.totals.cacheHitPercent).toBeNull();
    expect(report.totals.tokensComplete).toBe(false);
    expect(report.totals.costUsd).toBeNull();
  });

  it('retains valid recorded cache ratios for partial task, total, model and daily usage', () => {
    const partialUsage = usage(80, 20, 60);
    const partialModel = { ...analysis.models![0], usage: partialUsage, tokensComplete: false, costComplete: false };
    const partialJob = job('PARTIAL', 'Partial', { periodMetrics: { usage: partialUsage, costUsd: 1, tokensComplete: false, costComplete: false,
      unpricedTokens: 0, untimedTokens: 100, models: [partialModel] } });
    const report = buildUsageReport(input({ jobs: [partialJob], analysis: { ...analysis, untimedTokens: 100, models: [partialModel],
      days: [{ ...analysis.days[0], usage: partialUsage, models: [partialModel] }] } }));
    for (const row of [report.totals, report.tasks[0], report.models![0], report.days![0], report.tasks[0].models![0], report.days![0].models![0]]) {
      expect(row.cacheHitPercent).toBe(historicalCacheHit(partialUsage));
      expect(row.cacheHitPercent).toBe(75);
      expect(row.tokensComplete).toBe(false);
    }
    expect(reportHtml(report, 'en')).toContain('recorded samples only; missing records may change the result');
    expect(reportHtml(report, 'zh')).toContain('仅已记录样本的比率，缺失记录可能改变结果');
    expect(reportCsv(report)).toContain('recorded samples only; missing records may change the result');
  });

  it('does not divide independently summed input and cache from unpaired task data', () => {
    for (const invalid of [
      { ...usage(), cachedInputTokens: Number.NaN },
      { ...usage(), inputTokens: Number.NaN },
      { ...usage(), cachedInputTokens: 90 }
    ]) {
      const unpaired = job('UNPAIRED', 'Unpaired', { periodMetrics: { usage: invalid, costUsd: 1, tokensComplete: false, costComplete: false, unpricedTokens: 0, untimedTokens: 0 } });
      const report = buildUsageReport(input({ jobs: [job('VALID', 'Valid'), unpaired] }));
      expect(report.tasks[0].cacheHitPercent).toBe(75);
      expect(report.tasks[1].cacheHitPercent).toBeNull();
      expect(report.totals.cacheHitPercent).toBeNull();
      expect(report.totals.tokensComplete).toBe(false);
    }
    const zero = job('ZERO_INPUT', 'Zero input', { periodMetrics: { usage: usage(0, 20, 0), costUsd: 1, tokensComplete: false, costComplete: false, unpricedTokens: 0, untimedTokens: 0 } });
    const combined = buildUsageReport(input({ jobs: [job('VALID', 'Valid'), zero] }));
    expect(combined.tasks[1].cacheHitPercent).toBeNull();
    expect(combined.totals.cacheHitPercent).toBe(75);
    expect(combined.totals.tokensComplete).toBe(false);
  });

  it('keeps per-model price verification unknown without inheriting the catalog date', () => {
    const report = buildUsageReport(input({ pricing: { ...pricing, models: [{ ...pricing.models[0], verifiedAt: undefined }] } }));
    expect(report.pricing?.models[0].verifiedAt).toBeNull();
    expect(reportHtml(report)).toContain('individual rates have their own verification dates');
    expect(reportHtml(report)).toContain('<td>—</td>');
    const csv = reportCsv(report);
    expect(csv).toContain('"verifiedAt",""');
    expect(reportHtml(report)).toContain('One normalized Pro20x weekly allowance = 100%');
  });

  it('names downloads from only the timestamp and renders explicit opt-in buttons', () => {
    const report = buildUsageReport(input());
    expect(usageReportFile(report, 'html').filename).toBe('codex-usage-2026-09-28T08-00-00-000Z.html');
    expect(usageReportFile(report, 'csv').mimeType).toContain('text/csv');
    expect(usageReportFile(report, 'json').content).toBe(reportJson(report));
    const html = renderToStaticMarkup(createElement(ReportExport, input()));
    expect(html).toContain('Download HTML');
    expect(html).toContain('Download CSV');
    expect(html).toContain('Download JSON');
    expect(html).not.toContain('checked=""');
    expect(html).not.toContain('Secret Task One');
    const unavailable = renderToStaticMarkup(createElement(ReportExport, input({ analysis: null })));
    expect(unavailable.match(/disabled=""/g)).toHaveLength(3);
  });
});
