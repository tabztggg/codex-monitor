import { closeSync, fstatSync, openSync, readSync, statSync, type Stats } from 'node:fs';

const CHUNK_BYTES = 256 * 1024;
const ANCHOR_BYTES = 128;
// Bounds materialized records. Oversized tool outputs are validated and projected
// in bounded chunks; statistics, metadata and unknown record types stay strict.
export const MAX_SESSION_LOG_LINE_BYTES = 8 * 1024 * 1024;

export class SessionLogReadLimitError extends Error {
  public constructor(public readonly maxLineBytes: number) {
    super(`Session log record exceeds the ${maxLineBytes}-byte read limit`);
    this.name = 'SessionLogReadLimitError';
  }
}

/** A cursor over an append-only JSONL file. Retains no transcript contents. */
export class IncrementalSessionLog {
  private observed: Stats | null = null;
  private offset = 0;
  private provisionalTail = false;
  private head: Buffer = Buffer.alloc(0);
  private anchor: Buffer = Buffer.alloc(0);
  private blocked: { observed: Stats; recordStart: number; error: SessionLogReadLimitError } | null = null;
  private pendingOutput: { scanner: ToolOutputProjection; position: number } | null = null;

  public constructor(private readonly maxLineBytes = MAX_SESSION_LOG_LINE_BYTES) {
    if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes < 1) throw new RangeError('Invalid session log line limit');
  }

  public invalidate(): void {
    this.observed = null;
    this.offset = 0;
    this.provisionalTail = false;
    this.head = Buffer.alloc(0);
    this.anchor = Buffer.alloc(0);
    this.blocked = null;
    this.pendingOutput = null;
  }

  /** Returns false for an unchanged file; oversized unchanged files stay blocked without rereading. */
  public read(file: string, consume: (line: string) => void, reset: () => void): boolean {
    let fd: number | undefined;
    let current: Stats | undefined;
    let oversizedRecordStart: number | undefined;
    try {
      const visible = statSync(file);
      if (this.blocked && unchanged(this.blocked.observed, visible)) throw this.blocked.error;
      if (this.observed && unchanged(this.observed, visible)) return false;
      fd = openSync(file, 'r');
      // Bound this pass to a single size snapshot while Codex continues appending.
      current = fstatSync(fd);
      // A growing blocked log must not repeatedly replay its potentially huge
      // prefix. Recheck just the known record, without retaining or parsing it.
      if (this.blocked && sameFile(this.blocked.observed, current) &&
        current.size > this.blocked.recordStart + this.maxLineBytes &&
        recordExceedsLimit(fd, this.blocked.recordStart, this.maxLineBytes)) {
        oversizedRecordStart = this.blocked.recordStart;
        throw this.blocked.error;
      }
      let rebuild = !this.observed || !sameFile(this.observed, current) ||
        current.size <= this.observed.size || this.provisionalTail;
      if (!rebuild && this.offset > 0) {
        rebuild = !readAt(fd, 0, this.head.length).equals(this.head) ||
          !readAt(fd, this.offset - this.anchor.length, this.anchor.length).equals(this.anchor);
      }
      if (!rebuild && this.pendingOutput) {
        const pending = this.pendingOutput;
        rebuild = !readAt(fd, this.offset, pending.scanner.first.length).equals(pending.scanner.first) ||
          !readAt(fd, pending.position - pending.scanner.last.length, pending.scanner.last.length).equals(pending.scanner.last);
      }
      if (rebuild) {
        reset();
        this.offset = 0;
        this.head = Buffer.alloc(0);
        this.anchor = Buffer.alloc(0);
        this.pendingOutput = null;
      }

      const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
      let position = this.pendingOutput?.position ?? this.offset;
      let pieces: Buffer[] = [];
      let pieceBytes = 0;
      let projection = this.pendingOutput?.scanner ?? null;
      const append = (segment: Buffer) => {
        if (!projection && pieceBytes + segment.length > this.maxLineBytes) {
          oversizedRecordStart = this.offset;
          projection = new ToolOutputProjection(this.maxLineBytes);
          for (const piece of pieces) projection.feed(piece);
          projection.feed(segment);
          if (!projection.canProject()) throw new SessionLogReadLimitError(this.maxLineBytes);
          pieces = [];
        } else if (projection) {
          projection.feed(segment);
        } else {
          pieces.push(Buffer.from(segment));
          pieceBytes += segment.length;
        }
      };
      const anchorRecord = (first: Buffer, last: Buffer, length: number) => {
        const room = ANCHOR_BYTES - this.head.length;
        if (room > 0) this.head = Buffer.concat([this.head, first.subarray(0, room),
          length < room ? Buffer.from('\n') : Buffer.alloc(0)]);
        this.anchor = Buffer.concat([this.anchor, last, Buffer.from('\n')]).subarray(-ANCHOR_BYTES);
      };
      this.provisionalTail = false;
      while (position < current.size) {
        const count = readSync(fd, buffer, 0, Math.min(buffer.length, current.size - position), position);
        if (count === 0) throw new Error('Session log changed while it was being read');
        let start = 0;
        for (let end = buffer.indexOf(10, start); end >= 0 && end < count; end = buffer.indexOf(10, start)) {
          const segment = buffer.subarray(start, end);
          if (projection || pieceBytes + segment.length > this.maxLineBytes) {
            append(segment);
            const projected = projection!;
            consume(projected.finish());
            anchorRecord(projected.first, projected.last, projected.length);
          } else {
            const raw = pieces.length ? Buffer.concat([...pieces, segment]) : segment;
            const line = raw.toString('utf8');
            consume(line.endsWith('\r') ? line.slice(0, -1) : line);
            // Anchor consumed bytes, rather than rereading a concurrent rewrite.
            anchorRecord(raw.subarray(0, ANCHOR_BYTES), raw.subarray(-ANCHOR_BYTES), raw.length);
          }
          pieces = [];
          pieceBytes = 0;
          projection = null;
          this.pendingOutput = null;
          this.offset = position + end + 1;
          start = end + 1;
        }
        if (start < count) {
          append(buffer.subarray(start, count));
        }
        position += count;
      }
      if (projection) {
        if (projection.complete) {
          consume(projection.finish());
          this.provisionalTail = true;
          this.pendingOutput = null;
        } else {
          this.pendingOutput = { scanner: projection, position };
        }
      } else if (pieces.length) {
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
      this.blocked = null;
      return true;
    } catch (error) {
      const blocked = error instanceof SessionLogReadLimitError
        ? (current ? { observed: current, recordStart: oversizedRecordStart ?? this.offset, error } : this.blocked) : null;
      this.invalidate();
      this.blocked = blocked;
      throw error;
    } finally {
      if (fd !== undefined) {
        try { closeSync(fd); } catch (error) { this.invalidate(); throw error; }
      }
    }
  }
}

type JsonFrame = {
  kind: 'object' | 'array';
  scope: 'root' | 'payload' | 'other';
  expected: 'keyOrEnd' | 'key' | 'colon' | 'valueOrEnd' | 'value' | 'commaOrEnd';
  key: string | null;
};

/** Validates a whole oversized tool-output envelope without retaining its body.
 * A prefix only permits streaming; projection is emitted after the whole JSON
 * object closes. Duplicate identity fields and ambiguous structures fail closed.
 */
class ToolOutputProjection {
  public first = Buffer.alloc(0);
  public last = Buffer.alloc(0);
  public length = 0;
  public complete = false;
  private readonly stack: JsonFrame[] = [];
  private started = false;
  private string = false;
  private stringKey = false;
  private escaped = false;
  private unicode = 0;
  private stringBytes: number[] | null = null;
  private primitive: string | null = null;
  private type: unknown;
  private payloadType: unknown;
  private timestamp: unknown;
  private readonly seen = new Set<string>();

  constructor(private readonly limit: number) {}

  canProject(): boolean {
    return this.type === 'response_item' &&
      (this.payloadType === 'function_call_output' || this.payloadType === 'custom_tool_call_output');
  }

  finish(): string {
    if (!this.complete || this.string || this.primitive !== null || !this.canProject()) this.fail();
    return JSON.stringify({ type: 'response_item', timestamp: this.timestamp,
      payload: { type: this.payloadType } });
  }

  feed(bytes: Buffer): void {
    this.length += bytes.length;
    const room = ANCHOR_BYTES - this.first.length;
    if (room > 0) this.first = Buffer.concat([this.first, bytes.subarray(0, room)]);
    this.last = bytes.length >= ANCHOR_BYTES ? Buffer.from(bytes.subarray(-ANCHOR_BYTES)) :
      Buffer.concat([this.last, bytes]).subarray(-ANCHOR_BYTES);
    for (const byte of bytes) this.byte(byte);
  }

  private byte(byte: number): void {
    if (this.string) {
      if (this.stringBytes) {
        if (this.stringBytes.length < 1024) this.stringBytes.push(byte);
        else this.stringBytes = null;
      }
      if (this.unicode > 0) {
        if (!((byte >= 48 && byte <= 57) || (byte >= 65 && byte <= 70) || (byte >= 97 && byte <= 102))) this.fail();
        this.unicode--;
      } else if (this.escaped) {
        if (byte === 117) this.unicode = 4;
        else if (![34, 92, 47, 98, 102, 110, 114, 116].includes(byte)) this.fail();
        this.escaped = false;
      } else if (byte === 92) {
        this.escaped = true;
      } else if (byte === 34) {
        this.string = false;
        let value: string | undefined;
        if (this.stringBytes) {
          try { value = JSON.parse(Buffer.from(this.stringBytes).toString('utf8')); }
          catch { this.fail(); }
        }
        this.stringBytes = null;
        if (this.stringKey) {
          const frame = this.stack.at(-1)!;
          frame.key = value ?? null;
          frame.expected = 'colon';
          if ((frame.scope === 'root' && ['type', 'payload', 'timestamp'].includes(value ?? '')) ||
            (frame.scope === 'payload' && value === 'type')) {
            const identity = `${frame.scope}:${value}`;
            if (this.seen.has(identity)) this.fail();
            this.seen.add(identity);
          }
        } else this.value(value);
      } else if (byte < 32) this.fail();
      return;
    }
    const whitespace = byte === 32 || byte === 9 || byte === 13;
    if (this.primitive !== null) {
      if (whitespace || byte === 44 || byte === 93 || byte === 125) {
        let value: unknown;
        try { value = JSON.parse(this.primitive); } catch { this.fail(); }
        this.primitive = null;
        this.value(value);
      } else {
        if (this.primitive.length >= 128) this.fail();
        this.primitive += String.fromCharCode(byte);
        return;
      }
    }
    if (whitespace) return;
    if (this.complete) this.fail();
    const frame = this.stack.at(-1);
    if (byte === 34) {
      this.stringKey = frame?.kind === 'object' && (frame.expected === 'key' || frame.expected === 'keyOrEnd');
      if (!this.stringKey) this.expectValue();
      this.string = true;
      this.stringBytes = [34];
      return;
    }
    if (byte === 123 || byte === 91) {
      let scope: JsonFrame['scope'] = 'other';
      if (!this.started) {
        if (byte !== 123) this.fail();
        this.started = true;
        scope = 'root';
      } else {
        if (frame?.scope === 'root' && frame.key === 'payload' && byte === 123) scope = 'payload';
        this.value(undefined);
      }
      if (this.stack.length >= 64) this.fail();
      this.stack.push({ kind: byte === 123 ? 'object' : 'array', scope,
        expected: byte === 123 ? 'keyOrEnd' : 'valueOrEnd', key: null });
      return;
    }
    if (byte === 125 || byte === 93) {
      if (!frame || frame.kind !== (byte === 125 ? 'object' : 'array') ||
        !['keyOrEnd', 'valueOrEnd', 'commaOrEnd'].includes(frame.expected)) this.fail();
      this.stack.pop();
      if (!this.stack.length) this.complete = true;
      return;
    }
    if (byte === 58) {
      if (frame?.kind !== 'object' || frame.expected !== 'colon') this.fail();
      frame.expected = 'value';
      return;
    }
    if (byte === 44) {
      if (!frame || frame.expected !== 'commaOrEnd') this.fail();
      frame.expected = frame.kind === 'object' ? 'key' : 'value';
      return;
    }
    this.expectValue();
    if (!(byte === 45 || (byte >= 48 && byte <= 57) || byte === 116 || byte === 102 || byte === 110)) this.fail();
    this.primitive = String.fromCharCode(byte);
  }

  private expectValue(): void {
    const frame = this.stack.at(-1);
    if (!frame || (frame.expected !== 'value' && frame.expected !== 'valueOrEnd')) this.fail();
  }

  private value(value: unknown): void {
    this.expectValue();
    const frame = this.stack.at(-1)!;
    if (frame.scope === 'root' && frame.key === 'type') this.type = value;
    if (frame.scope === 'root' && frame.key === 'timestamp') {
      if (typeof value !== 'string') this.fail();
      this.timestamp = value;
    }
    if (frame.scope === 'payload' && frame.key === 'type') this.payloadType = value;
    frame.expected = 'commaOrEnd';
  }

  private fail(): never { throw new SessionLogReadLimitError(this.limit); }
}

function sameFile(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.birthtimeMs === b.birthtimeMs;
}

function unchanged(a: Stats, b: Stats): boolean {
  return sameFile(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

function recordExceedsLimit(fd: number, start: number, limit: number): boolean {
  // If a rewrite moved record boundaries, fall back to a clean rebuild.
  if (start > 0 && readAt(fd, start - 1, 1)[0] !== 10) return false;
  const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
  const projection = new ToolOutputProjection(limit);
  let projectable = true;
  let read = 0;
  while (read <= limit) {
    const count = readSync(fd, buffer, 0, Math.min(buffer.length, limit + 1 - read), start + read);
    if (count === 0) throw new Error('Session log changed while its record limit was checked');
    const newline = buffer.indexOf(10);
    if (newline >= 0 && newline < count) return false;
    if (projectable) {
      try { projection.feed(buffer.subarray(0, count)); } catch { projectable = false; }
    }
    read += count;
  }
  // A repaired record may now be an allowed tool output: rebuild and validate
  // its full envelope rather than keeping a stale size-only rejection.
  return !projectable || !projection.canProject();
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
