import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { HistoryJob, HistoryProject } from '../../shared/monitor';
import { asRecord, asString } from './utils';

type ProjectResolver = (job: Pick<HistoryJob, 'id' | 'cwd'>) => HistoryProject | null;

/** Desktop assignments also cover archived tasks and worktrees outside the project root. */
export function readProjectResolver(codexHome: string): ProjectResolver {
  const file = path.join(codexHome, '.codex-global-state.json');
  if (!existsSync(file)) return () => null;
  try {
    return createProjectResolver(JSON.parse(readFileSync(file, 'utf8')));
  } catch (error) {
    console.warn('Project metadata unavailable; tasks remain unassigned:', error instanceof Error ? error.message : String(error));
    return () => null;
  }
}

export function createProjectResolver(value: unknown): ProjectResolver {
  const state = asRecord(value);
  const projects = new Map<string, HistoryProject>();
  const roots: { root: string; project: HistoryProject }[] = [];
  for (const [id, raw] of Object.entries(asRecord(state?.['local-projects']) ?? {})) {
    const record = asRecord(raw);
    const name = asString(record?.name)?.trim();
    if (!name) continue;
    const project = { id, name };
    projects.set(id, project);
    if (Array.isArray(record?.rootPaths)) {
      for (const root of record.rootPaths) {
        if (typeof root === 'string' && root.trim()) roots.push({ root: normalizeProjectPath(root), project });
      }
    }
  }
  roots.sort((a, b) => b.root.length - a.root.length);
  const assignments = asRecord(state?.['thread-project-assignments']);
  const hints = asRecord(state?.['thread-workspace-root-hints']);
  const projectless = new Set(Array.isArray(state?.['projectless-thread-ids']) ? state['projectless-thread-ids'] : []);
  return job => {
    const assignedId = asString(asRecord(assignments?.[job.id])?.projectId);
    if (assignedId) return projects.get(assignedId) ?? { id: assignedId, name: `未识别项目 · ${assignedId.slice(0, 8)}`, missing: true };
    // Explicitly projectless tasks must not be assigned merely because of their cwd.
    if (projectless.has(job.id)) return null;
    const directory = asString(hints?.[job.id]) ?? job.cwd;
    if (!directory) return null;
    const normalized = normalizeProjectPath(directory);
    return roots.find(({ root }) => normalized === root || normalized.startsWith(root.endsWith('/') ? root : `${root}/`))?.project ?? null;
  };
}

function normalizeProjectPath(value: string): string {
  const normalized = value.replaceAll('\\', '/').replace(/^\/\/\?\/UNC\//i, '//')
    .replace(/^\/\/\?\//, '').replace(/\/+$/, '') || '/';
  return /^[a-z]:/i.test(normalized) || normalized.startsWith('//') ? normalized.toLowerCase() : normalized;
}
