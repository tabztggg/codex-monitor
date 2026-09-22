import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { toIsoDate } from '../../shared/monitor';
import { asRecord, asString } from './utils';

export type ArchiveMetadata = { id: string; archivedAt: string | null; parentThreadId: string | null; isSubagent: boolean };

/** Small index only: choose archive roots before opening their usage logs. */
export function readArchiveMetadata(codexHome: string): Map<string, ArchiveMetadata> {
  const metadata = new Map<string, ArchiveMetadata>();
  let database: import('node:sqlite').DatabaseSync | undefined;
  try {
    const stateFile = readdirSync(codexHome)
      .filter(name => /^state_\d+\.sqlite$/.test(name))
      .sort((a, b) => Number(b.match(/\d+/)?.[0]) - Number(a.match(/\d+/)?.[0]))[0];
    if (!stateFile) return metadata;
    // Optional on older Node installations: missing metadata falls back to activity time.
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
    database = new DatabaseSync(path.join(codexHome, stateFile), { readOnly: true });
    const columns = database.prepare('PRAGMA table_info(threads)').all().map(row => row.name);
    const sourceColumn = columns.includes('source') ? 'source' : 'NULL AS source';
    for (const row of database.prepare(`SELECT id, archived, archived_at, ${sourceColumn} FROM threads`).all()) {
      if (typeof row.id !== 'string') continue;
      let source: unknown = row.source;
      try { if (typeof source === 'string' && source.startsWith('{')) source = JSON.parse(source); } catch { /* Older source strings are plain labels. */ }
      const subagent = asRecord(source)?.subagent;
      const parent = asString(asRecord(asRecord(subagent)?.thread_spawn)?.parent_thread_id);
      metadata.set(row.id, { id: row.id, archivedAt: row.archived ? toIsoDate(row.archived_at) : null,
        parentThreadId: typeof parent === 'string' ? parent : null,
        isSubagent: Boolean(subagent) || (typeof source === 'string' && /^subagent/i.test(source)) });
    }
  } catch (error) {
    console.warn('Archive timestamps unavailable; using last activity:', error instanceof Error ? error.message : String(error));
  } finally {
    database?.close();
  }
  return metadata;
}

/** Read archive action times without altering Codex's database or session logs. */
export function readArchiveTimes(codexHome: string): Map<string, string> {
  return new Map([...readArchiveMetadata(codexHome)].flatMap(([id, entry]) => entry.archivedAt ? [[id, entry.archivedAt]] : []));
}
