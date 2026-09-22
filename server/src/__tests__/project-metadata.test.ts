import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createProjectResolver, readProjectResolver } from '../project-metadata';
import { HistoryJobReader } from '../history-jobs';

const state = {
  'local-projects': {
    game: { name: 'Example Game', rootPaths: ['C:\\Projects\\ExampleGame'] },
    nested: { name: 'Nested project', rootPaths: ['C:\\Projects\\ExampleGame\\tools'] },
    system: { name: '系统', rootPaths: ['C:\\Projects\\System'] },
    media: { name: '影音下载', rootPaths: ['\\\\server\\media'] }
  },
  'thread-project-assignments': { assigned: { projectKind: 'local', projectId: 'system' } },
  'thread-workspace-root-hints': { worktree: 'C:\\Projects\\ExampleGame' },
  'projectless-thread-ids': ['loose']
};

describe('task project identity', () => {
  it('prefers explicit assignments and keeps explicitly projectless tasks unassigned', () => {
    const resolve = createProjectResolver(state);
    expect(resolve({ id: 'assigned', cwd: 'C:/Projects/ExampleGame' })).toEqual({ id: 'system', name: '系统' });
    expect(resolve({ id: 'loose', cwd: 'C:/Projects/ExampleGame' })).toBeNull();
    expect(resolve({ id: 'worktree', cwd: 'C:/worktrees/other-path' })).toEqual({ id: 'game', name: 'Example Game' });
  });

  it('normalizes Windows and UNC paths and matches the longest root with directory boundaries', () => {
    const resolve = createProjectResolver(state);
    expect(resolve({ id: 'a', cwd: '\\\\?\\c:\\projects\\EXAMPLEGAME\\Source' })?.id).toBe('game');
    expect(resolve({ id: 'b', cwd: 'C:/Projects/ExampleGame/tools/test' })?.id).toBe('nested');
    expect(resolve({ id: 'c', cwd: 'C:/Projects/ExampleGameExtra' })).toBeNull();
    expect(resolve({ id: 'd', cwd: '\\\\?\\UNC\\SERVER\\Media\\Films' })?.id).toBe('media');
    expect(resolve({ id: 'e', cwd: null })).toBeNull();
  });

  it('does not guess a different project when an assigned project was removed', () => {
    const resolve = createProjectResolver({ ...state,
      'thread-project-assignments': { lost: { projectId: 'removed-project' } } });
    expect(resolve({ id: 'lost', cwd: 'C:/Projects/ExampleGame' })).toEqual({ id: 'removed-project', name: '未识别项目 · removed-', missing: true });
  });

  it('applies project metadata to archived history and observes later project changes without changing source files', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'monitor-projects-'));
    try {
      const sessions = path.join(root, 'sessions');
      const archives = path.join(root, 'archived_sessions');
      mkdirSync(sessions);
      mkdirSync(archives);
      const metadataFile = path.join(root, '.codex-global-state.json');
      writeFileSync(metadataFile, JSON.stringify(state));
      const before = readFileSync(metadataFile);
      writeFileSync(path.join(archives, 'rollout-assigned.jsonl'), JSON.stringify({
        type: 'session_meta', payload: { id: 'assigned', cwd: 'C:/Projects/ExampleGame' }
      }));
      const reader = new HistoryJobReader(sessions);
      expect(reader.listJobs({}).data[0]).toMatchObject({ archived: true, project: { id: 'system', name: '系统' } });
      expect(readFileSync(metadataFile)).toEqual(before);
      writeFileSync(metadataFile, JSON.stringify({ ...state,
        'thread-project-assignments': { assigned: { projectId: 'game' } } }));
      expect(reader.listJobs({}).data[0].project).toEqual({ id: 'game', name: 'Example Game' });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('keeps tasks available when project metadata is missing or malformed', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'monitor-projects-'));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const job = { id: 'x', cwd: 'D:/work' };
      expect(readProjectResolver(root)(job)).toBeNull();
      writeFileSync(path.join(root, '.codex-global-state.json'), '{incomplete');
      expect(readProjectResolver(root)(job)).toBeNull();
      expect(warning).toHaveBeenCalled();
    } finally {
      warning.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
