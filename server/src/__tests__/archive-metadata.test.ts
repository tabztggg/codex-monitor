import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { readArchiveTimes } from '../archive-metadata';

describe('archive timestamps', () => {
  it('reads actual archive times without modifying the state database', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'monitor-archive-times-'));
    try {
      const file = path.join(root, 'state_5.sqlite');
      const database = new DatabaseSync(file);
      database.exec('CREATE TABLE threads (id TEXT, archived INTEGER, archived_at INTEGER)');
      const insert = database.prepare('INSERT INTO threads VALUES (?, ?, ?)');
      insert.run('archived', 1, 1790000000);
      insert.run('active', 0, 1790000010);
      insert.run('unknown', 1, null);
      database.close();
      const before = readFileSync(file);
      expect([...readArchiveTimes(root)]).toEqual([['archived', new Date(1790000000000).toISOString()]]);
      expect(readFileSync(file)).toEqual(before);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('allows the task list to work when state metadata is missing or unreadable', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'monitor-archive-times-'));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(readArchiveTimes(root).size).toBe(0);
      writeFileSync(path.join(root, 'state_5.sqlite'), 'not a database');
      expect(readArchiveTimes(root).size).toBe(0);
      expect(warning).toHaveBeenCalled();
    } finally {
      warning.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
