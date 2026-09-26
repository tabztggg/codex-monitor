import type { TaskSortColumn } from './presentation';

export const taskColumns: { key: TaskSortColumn; title: string; numeric?: boolean; width: number }[] = [
  { key: 'task', title: 'Task', width: 300 }, { key: 'status', title: 'Status', width: 120 },
  { key: 'usage', title: 'Equivalent usage', numeric: true, width: 260 },
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
      // The pair stays visible if either old column was visible. Persist both aliases when hidden.
      hidden: taskColumns.filter(c => c.key !== 'task' && hidden.includes(c.key) && (c.key !== 'usage' || hidden.includes('equivalent20x')))
        .flatMap(c => c.key === 'usage' ? ['usage', 'equivalent20x'] as TaskSortColumn[] : [c.key]),
      layout: value.layout === 'simple' ? 'simple' : 'full',
      metric: value.metric === 'equivalent20x' ? 'usage' : taskColumns.find(c => c.numeric && c.key === value.metric)?.key ?? defaults.metric
    };
  } catch { return defaults; }
}

export function tableColumns(view: TableView) {
  return view.layout === 'simple'
    ? [taskColumns[0], taskColumns.find(c => c.numeric && c.key === view.metric) ?? taskColumns.find(c => c.key === 'cost')!, taskColumns[1]]
    : taskColumns.filter(c => !view.hidden.includes(c.key));
}
