import { closeSync, fstatSync, openSync, readSync, statSync, type Stats } from 'node:fs';

const CHUNK_BYTES = 256 * 1024;
const ANCHOR_BYTES = 128;

/** A cursor over an append-only JSONL file. Retains no transcript contents. */
export class IncrementalSessionLog {
  private observed: Stats | null = null;
  private offset = 0;
  private provisionalTail = false;
  private head: Buffer = Buffer.alloc(0);
  private anchor: Buffer = Buffer.alloc(0);

  public invalidate(): void {
    this.observed = null;
    this.offset = 0;
    this.provisionalTail = false;
    this.head = Buffer.alloc(0);
    this.anchor = Buffer.alloc(0);
  }

  /** Returns false for an unchanged file. Errors invalidate the cursor for a full retry. */
  public read(file: string, consume: (line: string) => void, reset: () => void): boolean {
    let fd: number | undefined;
    try {
      const visible = statSync(file);
      if (this.observed && unchanged(this.observed, visible)) return false;
      fd = openSync(file, 'r');
      // Bound this pass to a single size snapshot while Codex continues appending.
      const current = fstatSync(fd);
      let rebuild = !this.observed || !sameFile(this.observed, current) ||
        current.size <= this.observed.size || this.provisionalTail;
      if (!rebuild && this.offset > 0) {
        rebuild = !readAt(fd, 0, this.head.length).equals(this.head) ||
          !readAt(fd, this.offset - this.anchor.length, this.anchor.length).equals(this.anchor);
      }
      if (rebuild) {
        reset();
        this.offset = 0;
        this.head = Buffer.alloc(0);
        this.anchor = Buffer.alloc(0);
      }

      const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
      let position = this.offset;
      let pieces: Buffer[] = [];
      this.provisionalTail = false;
      while (position < current.size) {
        const count = readSync(fd, buffer, 0, Math.min(buffer.length, current.size - position), position);
        if (count === 0) throw new Error('Session log changed while it was being read');
        let start = 0;
        for (let end = buffer.indexOf(10, start); end >= 0 && end < count; end = buffer.indexOf(10, start)) {
          const segment = buffer.subarray(start, end);
          const raw = pieces.length ? Buffer.concat([...pieces, segment]) : segment;
          const line = raw.toString('utf8');
          consume(line.endsWith('\r') ? line.slice(0, -1) : line);
          // Anchor the bytes actually consumed, not a fresh read that could already
          // contain a concurrent rewrite. A later pass will detect that rewrite.
          const room = ANCHOR_BYTES - this.head.length;
          if (room > 0) this.head = Buffer.concat([this.head, raw.subarray(0, room),
            raw.length < room ? Buffer.from('\n') : Buffer.alloc(0)]);
          this.anchor = Buffer.concat([this.anchor, raw.subarray(Math.max(0, raw.length - ANCHOR_BYTES)), Buffer.from('\n')]).subarray(-ANCHOR_BYTES);
          pieces = [];
          this.offset = position + end + 1;
          start = end + 1;
        }
        if (start < count) pieces.push(Buffer.from(buffer.subarray(start, count)));
        position += count;
      }
      if (pieces.length) {
        const tail = Buffer.concat(pieces).toString('utf8');
        // Existing exports can end with a complete record and no newline. Include it,
        // but rebuild on the next append so a provisional record is never counted twice.
        let complete = false;
        try { JSON.parse(tail); complete = true; } catch { /* A writer may be between chunks. */ }
        if (complete) {
          consume(tail);
          this.provisionalTail = true;
        }
      }
      this.observed = current;
      return true;
    } catch (error) {
      this.invalidate();
      throw error;
    } finally {
      if (fd !== undefined) {
        try { closeSync(fd); } catch (error) { this.invalidate(); throw error; }
      }
    }
  }
}

function sameFile(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.birthtimeMs === b.birthtimeMs;
}

function unchanged(a: Stats, b: Stats): boolean {
  return sameFile(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

function readAt(fd: number, start: number, length: number): Buffer {
  const result = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const count = readSync(fd, result, offset, length - offset, start + offset);
    if (count === 0) throw new Error('Session log changed while its cursor was checked');
    offset += count;
  }
  return result;
}
