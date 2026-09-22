import type { CodexUsageSnapshot, CodexUsageWindow, HistoryJob } from '../../shared/monitor';
import { translate, type Language } from './localization';

/** Select the general bucket explicitly; Spark is never a fallback. */
export function overallUsageWindow(usage: CodexUsageSnapshot): CodexUsageWindow | null {
  const limit = usage.limits.find(entry => entry.id === 'codex') ??
    (usage.primaryLimit?.id === 'codex' ? usage.primaryLimit : null);
  const windows = [limit?.primary, limit?.secondary];
  return windows.find(window => window?.windowDurationMins === 10080) ??
    limit?.primary ?? limit?.secondary ?? null;
}

export function quotaPace(window: CodexUsageWindow, nowMs: number) {
  const reset = Date.parse(window.resetsAt ?? '');
  const duration = (window.windowDurationMins ?? 0) * 60_000;
  const expired = Number.isFinite(reset) && reset <= nowMs;
  const elapsed = Number.isFinite(reset) && duration > 0 && reset - duration <= nowMs && !expired
    ? Math.max(0, Math.min(100, (nowMs - (reset - duration)) / duration * 100)) : null;
  const difference = elapsed !== null && window.usedPercent !== null
    ? window.usedPercent - elapsed : null;
  return { expired, elapsed, difference };
}

const INTERNAL_TITLE = /^(?:<|\[(?:transcription|transcript|audio)[\]: ]|```|AGENTS\.md|You are |Here is a list of plugins|The following is the Codex agent history|(?:system instructions|developer instructions|environment_context|recommended_plugins|transcription|audio transcription|user instructions|instructions for)\b)/i;
export function taskTitle(job: Pick<HistoryJob, 'name' | 'preview' | 'id'>, language: Language = 'en'): string {
  // Preserve real titles verbatim; only discard obvious injected context labels.
  if (job.name?.trim() && !INTERNAL_TITLE.test(job.name.trim())) return job.name;
  const preview = job.preview?.trim();
  if (preview && !INTERNAL_TITLE.test(preview)) {
    const firstLine = preview.split(/\r?\n/)[0].replace(/^#+\s*/, '').trim();
    if (firstLine && !INTERNAL_TITLE.test(firstLine)) return firstLine.length > 90 ? `${firstLine.slice(0, 89)}…` : firstLine;
  }
  return translate(language, 'Untitled task · {id}', { id: job.id.slice(0, 8) });
}

export function relativeActivity(value: string, nowMs: number, language: Language = 'en'): string {
  const elapsed = nowMs - Date.parse(value);
  if (!Number.isFinite(elapsed)) return translate(language, 'Unknown');
  if (elapsed < 60_000) return translate(language, 'Now');
  if (elapsed < 3_600_000) return translate(language, '{count} min ago', { count: Math.floor(elapsed / 60_000) });
  if (elapsed < 86_400_000) return translate(language, '{count} hr ago', { count: Math.floor(elapsed / 3_600_000) });
  return translate(language, '{count} d ago', { count: Math.floor(elapsed / 86_400_000) });
}

export type TaskFilter = 'active' | 'today' | 'all';
export type TaskSortColumn = 'task' | 'status' | 'usage' | 'equivalent20x' | 'cost' | 'tokens' | 'activity';
export type SortDirection = 'asc' | 'desc';

// Missing measurements sort last in either direction; zero is a known value.
function compareNumber(a: number | null | undefined, b: number | null | undefined, direction: SortDirection): number {
  const aKnown = typeof a === 'number' && Number.isFinite(a);
  const bKnown = typeof b === 'number' && Number.isFinite(b);
  if (!aKnown || !bKnown) return Number(bKnown) - Number(aKnown);
  return direction === 'asc' ? a! - b! : b! - a!;
}

function statusRank(job: HistoryJob, activeIds: Set<string>): number {
  return job.archived ? 2 : activeIds.has(job.id) ? 0 : 1;
}

function compareText(a: string, b: string, direction: SortDirection, language: Language): number {
  return a.localeCompare(b, language === 'zh' ? 'zh-CN' : 'en-US', { numeric: true, sensitivity: 'base' }) * (direction === 'asc' ? 1 : -1);
}

export interface ProjectTaskGroup {
  id: string;
  name: string;
  unknownProject?: boolean;
  jobs: HistoryJob[];
  totalTasks: number;
  quotaPercent: number | null;
  quotaIsComplete: boolean;
  equivalent20xPercent: number | null;
  equivalent20xIsComplete: boolean;
  totalEstimatedCostUsd: number | null;
  totalEstimatedCostIsComplete: boolean;
  totalTokens: number | null;
  tokensIsComplete: boolean;
  statusRank: number;
  updatedAt: string;
}

export function projectTitle(group: ProjectTaskGroup, language: Language): string {
  return group.id === 'unassigned' ? translate(language, 'Unassigned project')
    : group.unknownProject ? translate(language, 'Unknown project · {id}', { id: group.id.slice('project:'.length, 'project:'.length + 8) }) : group.name;
}

/** Summaries use the requested archive scope; row visibility never changes attribution. */
export function groupTasksByProject(allJobs: HistoryJob[], displayedJobs: HistoryJob[], sort: TaskSortColumn, direction: SortDirection = 'desc', activeIds = new Set<string>(), language: Language = 'en'): ProjectTaskGroup[] {
  const groups = new Map<string, ProjectTaskGroup>();
  const key = (job: HistoryJob) => job.project ? `project:${job.project.id}` : 'unassigned';
  for (const job of allJobs) {
    const id = key(job);
    let group = groups.get(id);
    if (!group) {
      group = { id, name: job.project?.name ?? '未分配项目', unknownProject: job.project?.missing, jobs: [], totalTasks: 0,
        quotaPercent: null, quotaIsComplete: true, totalEstimatedCostUsd: null, totalEstimatedCostIsComplete: true,
        equivalent20xPercent: null, equivalent20xIsComplete: true,
        totalTokens: null, tokensIsComplete: true,
        statusRank: statusRank(job, activeIds), updatedAt: job.updatedAt };
      groups.set(id, group);
    }
    group.totalTasks += 1;
    if (compareNumber(Date.parse(job.updatedAt), Date.parse(group.updatedAt), 'desc') < 0) group.updatedAt = job.updatedAt;
    group.statusRank = Math.min(group.statusRank, statusRank(job, activeIds));
    if (typeof job.totalEstimatedCostUsd === 'number' && Number.isFinite(job.totalEstimatedCostUsd)) {
      group.totalEstimatedCostUsd = (group.totalEstimatedCostUsd ?? 0) + job.totalEstimatedCostUsd;
      if (!job.totalEstimatedCostIsComplete) group.totalEstimatedCostIsComplete = false;
    } else group.totalEstimatedCostIsComplete = false;
    if (job.totalUsage && Number.isFinite(job.totalUsage.totalTokens)) group.totalTokens = (group.totalTokens ?? 0) + job.totalUsage.totalTokens;
      else group.tokensIsComplete = false;
      if (job.periodMetrics?.tokensComplete === false) group.tokensIsComplete = false;
    const quota = job.estimatedUsagePercentSinceReset;
    if (quota !== null && Number.isFinite(quota)) group.quotaPercent = (group.quotaPercent ?? 0) + quota;
    else group.quotaIsComplete = false;
    if (typeof job.estimated20xPercent === 'number' && Number.isFinite(job.estimated20xPercent)) {
      group.equivalent20xPercent = (group.equivalent20xPercent ?? 0) + job.estimated20xPercent;
      if (!job.estimated20xIsComplete) group.equivalent20xIsComplete = false;
    } else group.equivalent20xIsComplete = false;
  }
  for (const job of displayedJobs) groups.get(key(job))?.jobs.push(job);
  return [...groups.values()].sort((a, b) => {
    const delta = sort === 'task' ? compareText(projectTitle(a, language), projectTitle(b, language), direction, language)
      : sort === 'status' ? compareNumber(a.statusRank, b.statusRank, direction)
      : sort === 'usage' ? compareNumber(a.quotaPercent, b.quotaPercent, direction)
      : sort === 'equivalent20x' ? compareNumber(a.equivalent20xPercent, b.equivalent20xPercent, direction)
      : sort === 'cost' ? compareNumber(a.totalEstimatedCostUsd, b.totalEstimatedCostUsd, direction)
      : sort === 'tokens' ? compareNumber(a.totalTokens, b.totalTokens, direction)
      : compareNumber(Date.parse(a.updatedAt), Date.parse(b.updatedAt), direction);
    return delta || compareNumber(Date.parse(a.updatedAt), Date.parse(b.updatedAt), 'desc') || a.id.localeCompare(b.id);
  });
}

/** Choose recent archives independently of the table's cost/usage sort. */
export function limitArchivedTasks(jobs: HistoryJob[], limit = 30): HistoryJob[] {
  const recentIds = new Set(jobs.filter(job => job.archived)
    .sort((a, b) => (b.archivedAt ?? b.updatedAt).localeCompare(a.archivedAt ?? a.updatedAt) || a.id.localeCompare(b.id))
    .slice(0, limit).map(job => job.id));
  return jobs.filter(job => !job.archived || recentIds.has(job.id));
}

export function visibleTasks(jobs: HistoryJob[], activeIds: Set<string>, filter: TaskFilter, search: string, sort: TaskSortColumn, nowMs: number, hideArchived = false, language: Language = 'en', direction: SortDirection = 'desc') {
  const day = new Date(nowMs); day.setHours(0, 0, 0, 0);
  const query = search.trim().toLocaleLowerCase('en');
  return jobs.filter(job => filter === 'all' || (filter === 'active' ? activeIds.has(job.id) : activeIds.has(job.id) || Date.parse(job.updatedAt) >= day.getTime()))
    .filter(job => !hideArchived || !job.archived)
    .filter(job => `${taskTitle(job, language)} ${job.project?.name ?? translate(language, 'Unassigned project')} ${job.cwd ?? ''} ${job.id}`.toLocaleLowerCase('en').includes(query))
    .sort((a, b) => {
      const delta = sort === 'task' ? compareText(taskTitle(a, language), taskTitle(b, language), direction, language)
        : sort === 'status' ? compareNumber(statusRank(a, activeIds), statusRank(b, activeIds), direction)
        : sort === 'usage' ? compareNumber(a.estimatedUsagePercentSinceReset, b.estimatedUsagePercentSinceReset, direction)
        : sort === 'equivalent20x' ? compareNumber(a.estimated20xPercent, b.estimated20xPercent, direction)
        : sort === 'cost' ? compareNumber(a.totalEstimatedCostUsd, b.totalEstimatedCostUsd, direction)
        : sort === 'tokens' ? compareNumber(a.totalUsage?.totalTokens, b.totalUsage?.totalTokens, direction)
        : compareNumber(Date.parse(a.updatedAt), Date.parse(b.updatedAt), direction);
      return delta || (sort === 'usage' ? compareNumber(a.totalEstimatedCostUsd, b.totalEstimatedCostUsd, direction) : 0)
        || compareNumber(Date.parse(a.updatedAt), Date.parse(b.updatedAt), 'desc') || a.id.localeCompare(b.id);
    });
}
