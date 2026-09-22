import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IncrementalSessionLog } from '../session-log-reader';

vi.mock('node:fs', async original => {
  const actual = await original<typeof fs>();
  return { ...actual, readSync: vi.fn(actual.readSync) };
});

describe('incremental session log cursor', () => {
  let root: string;
  let file: string;
  let reader: IncrementalSessionLog;
  let lines: string[];
  let resets: number;
  const consume = (line: string) => { lines.push(line); };
  const reset = () => { lines = []; resets++; };
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-log-cursor-'));
    file = path.join(root, 'session.jsonl');
    reader = new IncrementalSessionLog();
    lines = [];
    resets = 0;
    vi.mocked(fs.readSync).mockClear();
  });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it('does no reads for unchanged logs and reads only the appended bytes plus small anchors', () => {
    const first = JSON.stringify({ text: 'x'.repeat(2 * 1024 * 1024) });
    fs.writeFileSync(file, first + '\n');
    reader.read(file, consume, reset);
    expect(lines).toEqual([first]);
    vi.mocked(fs.readSync).mockClear();
    expect(reader.read(file, consume, reset)).toBe(false);
    expect(fs.readSync).not.toHaveBeenCalled();
    const last = '{"tokens":123}';
    fs.appendFileSync(file, last + '\n');
    reader.read(file, consume, reset);
    expect(lines).toEqual([first, last]);
    expect(resets).toBe(1);
    const bytes = vi.mocked(fs.readSync).mock.results.reduce((sum, result) => sum + (result.type === 'return' ? Number(result.value) : 0), 0);
    expect(bytes).toBeLessThanOrEqual(Buffer.byteLength(last + '\n') + 512);
  });

  it('waits for a partial UTF-8 record and consumes it once when completed', () => {
    const line = JSON.stringify({ text: '中文🙂' });
    const bytes = Buffer.from(line + '\n');
    const split = bytes.indexOf(Buffer.from('文')) + 1;
    fs.writeFileSync(file, bytes.subarray(0, split));
    reader.read(file, consume, reset);
    expect(lines).toEqual([]);
    fs.appendFileSync(file, bytes.subarray(split));
    reader.read(file, consume, reset);
    expect(lines).toEqual([line]);
    expect(resets).toBe(1);
  });

  it('supports a valid unterminated final record without counting it twice after append', () => {
    fs.writeFileSync(file, '{"n":1}');
    reader.read(file, consume, reset);
    expect(lines).toEqual(['{"n":1}']);
    fs.appendFileSync(file, '\n{"n":2}\n');
    reader.read(file, consume, reset);
    expect(lines).toEqual(['{"n":1}', '{"n":2}']);
    expect(resets).toBe(2);
  });

  it('rebuilds after truncation, equal-size edits, larger rewrites, and file replacement', () => {
    fs.writeFileSync(file, '{"n":12345}\n');
    reader.read(file, consume, reset);
    fs.writeFileSync(file, '{"n":1}\n');
    reader.read(file, consume, reset);
    fs.writeFileSync(file, '{"n":2}\n');
    fs.utimesSync(file, new Date(), new Date(Date.now() + 1000));
    reader.read(file, consume, reset);
    fs.writeFileSync(file, '{"n":333333}\n');
    reader.read(file, consume, reset);
    fs.renameSync(file, path.join(root, 'old.jsonl'));
    fs.writeFileSync(file, '{"n":4}\n');
    reader.read(file, consume, reset);
    expect(lines).toEqual(['{"n":4}']);
    expect(resets).toBe(5);
  });

  it('retries from a clean state after a partial failed read', () => {
    fs.writeFileSync(file, '{"n":1}\n{"n":2}\n');
    expect(() => reader.read(file, line => {
      consume(line);
      if (lines.length === 2) throw new Error('transient failure');
    }, reset)).toThrow('transient failure');
    reader.read(file, consume, reset);
    expect(lines).toEqual(['{"n":1}', '{"n":2}']);
    expect(resets).toBe(2);
  });

  it('leaves concurrent appends for the next size snapshot', () => {
    fs.writeFileSync(file, '{"n":1}\n');
    reader.read(file, line => { consume(line); fs.appendFileSync(file, '{"n":2}\n'); }, reset);
    expect(lines).toEqual(['{"n":1}']);
    reader.read(file, consume, reset);
    expect(lines).toEqual(['{"n":1}', '{"n":2}']);
  });

  it('detects a rewrite performed while the previous contents are being consumed', () => {
    fs.writeFileSync(file, '{"n":1}\n');
    reader.read(file, line => {
      consume(line);
      fs.writeFileSync(file, '{"n":9}\n{"n":2}\n');
    }, reset);
    reader.read(file, consume, reset);
    expect(lines).toEqual(['{"n":9}', '{"n":2}']);
    expect(resets).toBe(2);
  });

  it('detects same-size replacement when the original mtime is restored', () => {
    fs.writeFileSync(file, '{"n":1}\n');
    const stamp = fs.statSync(file);
    reader.read(file, consume, reset);
    fs.writeFileSync(file, '{"n":9}\n');
    fs.utimesSync(file, stamp.atime, stamp.mtime);
    reader.read(file, consume, reset);
    expect(lines).toEqual(['{"n":9}']);
    expect(resets).toBe(2);
  });

  it('preserves CRLF and UTF-8 boundaries across read chunks', () => {
    const first = JSON.stringify({ text: 'x'.repeat(256 * 1024 - 12) + '中文🙂' });
    fs.writeFileSync(file, first + '\r\n{"n":2}\r\n');
    reader.read(file, consume, reset);
    expect(lines).toEqual([first, '{"n":2}']);
  });
});
