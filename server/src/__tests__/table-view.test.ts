import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MonitorSnapshot } from '../../../shared/monitor';
import { HistoryPanel } from '../../../web/src/components/HistoryPanel';
import { createI18n } from '../../../web/src/localization';
import { parseTableView, tableColumns } from '../../../web/src/table-view';

vi.mock('../../../web/src/LanguageContext', () => ({ useI18n: () => createI18n('en') }));
vi.mock('../../../web/src/useTaskHistory', () => ({ useTaskHistory: () => ({
  jobs: [], allocation: null, updatedAt: null, error: null,
  archives: { mode: 'recent', included: 0, total: 0 }, loading: false, requestedMode: 'recent'
}) }));

afterEach(() => vi.unstubAllGlobals());
const keys = (raw: string | null) => tableColumns(parseTableView(raw)).map(c => c.key);

describe('saved task table preferences', () => {
  it('merges either visible legacy metric and persists hiding the combined column', () => {
    for (const hidden of [[], ['usage'], ['equivalent20x']]) {
      expect(keys(JSON.stringify({ hidden }))).toContain('usage');
      expect(keys(JSON.stringify({ hidden }))).not.toContain('equivalent20x');
    }
    const hiddenPair = parseTableView(JSON.stringify({ hidden: ['usage', 'equivalent20x'] }));
    expect(tableColumns(hiddenPair).map(c => c.key)).not.toContain('usage');
    expect(parseTableView(JSON.stringify(hiddenPair))).toEqual(hiddenPair);
    expect(keys(JSON.stringify({ layout: 'simple', metric: 'equivalent20x' }))).toEqual(['task', 'usage', 'status']);
  });
  it('keeps every column visible by default and safely handles invalid saved data', () => {
    for (const raw of [null, '{', 'null', '[]', '42', '{"layout":"unsupported","metric":"task","hidden":"tokens"}']) {
      const view = parseTableView(raw);
      expect(view).toEqual({ density: 'comfortable', hidden: [], layout: 'full', metric: 'cost' });
      expect(tableColumns(view)).toHaveLength(6);
    }
  });

  it('migrates legacy column choices without allowing hidden task names or unknown columns', () => {
    const raw = JSON.stringify({ density: 'compact', hidden: ['tokens', 'task', 'unknown', 'tokens', 'usage'] });
    expect(parseTableView(raw)).toEqual({ density: 'compact', hidden: ['tokens'], layout: 'full', metric: 'cost' });
    expect(keys(raw)).toEqual(['task', 'status', 'usage', 'cost', 'activity']);
  });

  it('restores the explicit simple metric and preserves full-table choices when switching back', () => {
    const view = parseTableView(JSON.stringify({ layout: 'simple', metric: 'tokens', hidden: ['tokens', 'status'], density: 'compact' }));
    expect(keys(JSON.stringify(view))).toEqual(['task', 'tokens', 'status']);
    expect(tableColumns({ ...view, layout: 'full' }).map(c => c.key)).toEqual(['task', 'usage', 'cost', 'activity']);
    expect(parseTableView(JSON.stringify(view))).toEqual(view);
  });
});

const snapshot = { runs: [], activeSessions: [], server: { initialized: true }, codexUsage: { status: 'loading', limits: [], primaryLimit: null } } as unknown as MonitorSnapshot;
function renderView(saved: unknown, width = 390) {
  vi.stubGlobal('window', { innerWidth: width, localStorage: { getItem: (key: string) => key === 'codex-monitor-table-view' ? JSON.stringify(saved) : null } });
  return renderToStaticMarkup(createElement(MemoryRouter, null, createElement(HistoryPanel, { snapshot, nowMs: Date.now() })));
}
const tableHeader = (html: string) => html.slice(html.indexOf('<thead>'), html.indexOf('</thead>'));

describe('explicit table layouts', () => {
  it('renders all metrics on a narrow screen until the user chooses a simple view', () => {
    const html = renderView({});
    expect(html).toContain('full-table');
    expect(html).toContain('value="full" selected');
    expect(tableHeader(html).match(/scope="col"/g)).toHaveLength(6);
    expect(html).toContain('<legend>Visible columns</legend>');
    expect(tableHeader(html)).toContain('Pro 20x equiv.');
    expect(tableHeader(html)).toContain('Current account / Across accounts');
    expect(html).toContain('value="usage:desc"');
    expect(html).toContain('value="equivalent20x:desc"');
    expect(html).not.toContain('table-metric-choice');
  });

  it('renders a saved simple view on any screen without ineffective hidden-column controls', () => {
    const html = renderView({ layout: 'simple', metric: 'tokens', hidden: ['tokens'] }, 1440);
    expect(html).toContain('simple-table');
    expect(html).toContain('value="simple" selected');
    expect(html).toContain('value="tokens" selected');
    expect(tableHeader(html).match(/scope="col"/g)).toHaveLength(3);
    expect(tableHeader(html)).toContain('metric-tokens');
    expect(tableHeader(html)).not.toContain('metric-cost');
    expect(html).not.toContain('<legend>Visible columns</legend>');
    expect(html).toContain('Expand a task for all metrics');
    expect(html).toContain('value="tokens:desc" selected');
  });

  it('honors saved hidden columns on a narrow full table and sorts a visible column', () => {
    const html = renderView({ layout: 'full', hidden: ['tokens', 'usage', 'equivalent20x'] });
    expect(tableHeader(html).match(/scope="col"/g)).toHaveLength(4);
    expect(tableHeader(html)).not.toContain('metric-tokens');
    expect(tableHeader(html)).not.toContain('metric-usage');
    expect(html).toContain('value="task:asc" selected');
  });
});
