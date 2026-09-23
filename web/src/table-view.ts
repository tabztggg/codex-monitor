import type { TaskSortColumn } from './presentation';

export const taskColumns: { key: TaskSortColumn; title: string; numeric?: boolean; width: number }[] = [
  { key: 'task', title: 'Task', width: 300 }, { key: 'status', title: 'Status', width: 120 },
  { key: 'usage', title: 'Approx. quota %', numeric: true, width: 165 },
  { key: 'equivalent20x', title: '20x equivalent usage', numeric: true, width: 195 },
  { key: 'cost', title: 'Estimated cost', numeric: true, width: 150 },
  { key: 'tokens', title: 'Total tokens', numeric: true, width: 160 },
  { key: 'activity', title: 'Activity', numeric: true, width: 135 }
];

export interface TableView {
  density: 'comfortable' | 'compact';
  hidden: TaskSortColumn[];
  layout: 'full' | 'simple';
  metric: TaskSortColumn;
}

// Accept existing density/column preferences without silently hiding metrics on small screens.
export function parseTableView(raw: string | null): TableView {
  const defaults: TableView = { density: 'comfortable', hidden: [], layout: 'full', metric: 'cost' };
  try {
    const saved: unknown = JSON.parse(raw ?? '{}');
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return defaults;
    const value = saved as Record<string, unknown>;
    const hidden = Array.isArray(value.hidden) ? value.hidden : [];
    return {
      density: value.density === 'compact' ? 'compact' : 'comfortable',
      hidden: taskColumns.filter(c => c.key !== 'task' && hidden.includes(c.key)).map(c => c.key),
      layout: value.layout === 'simple' ? 'simple' : 'full',
      metric: taskColumns.find(c => c.numeric && c.key === value.metric)?.key ?? defaults.metric
    };
  } catch { return defaults; }
}

export function tableColumns(view: TableView) {
  return view.layout === 'simple'
    ? [taskColumns[0], taskColumns.find(c => c.numeric && c.key === view.metric) ?? taskColumns[4], taskColumns[1]]
    : taskColumns.filter(c => !view.hidden.includes(c.key));
}
