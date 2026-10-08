import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IncrementalSessionLog, MAX_SESSION_LOG_LINE_BYTES, SessionLogReadLimitError } from '../session-log-reader';

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

  it.each(['\n', ''])('rejects oversized records before concatenating them, including tails (%j)', suffix => {
    const limit = 512 * 1024;
    reader = new IncrementalSessionLog(limit);
    fs.writeFileSync(file, JSON.stringify({ text: 'x'.repeat(limit * 4) }) + suffix);
    expect(() => reader.read(file, consume, reset)).toThrow(SessionLogReadLimitError);
    expect(lines).toEqual([]);
    const bytes = vi.mocked(fs.readSync).mock.results.reduce((sum, result) => sum + (result.type === 'return' ? Number(result.value) : 0), 0);
    expect(bytes).toBeLessThanOrEqual(limit + 256 * 1024);
    vi.mocked(fs.readSync).mockClear();
    expect(() => reader.read(file, consume, reset)).toThrow(/read limit/);
    expect(fs.readSync).not.toHaveBeenCalled();
    fs.writeFileSync(file, '{"n":1}\n');
    expect(reader.read(file, consume, reset)).toBe(true);
    expect(lines).toEqual(['{"n":1}']);
  });

  it('reads files far larger than the record limit when each record is bounded', () => {
    const line = JSON.stringify({ text: 'x'.repeat(64 * 1024) });
    const recordCount = 256;
    fs.writeFileSync(file, (line + '\n').repeat(recordCount));
    expect(fs.statSync(file).size).toBeGreaterThan(MAX_SESSION_LOG_LINE_BYTES);
    let consumed = 0;
    reader.read(file, record => { expect(record.length).toBe(line.length); consumed++; }, () => {});
    expect(consumed).toBe(recordCount);
  });

  it('rechecks only the oversized record when a blocked file continues growing', () => {
    const limit = 512 * 1024;
    reader = new IncrementalSessionLog(limit);
    const prefix = (JSON.stringify({ text: 'x'.repeat(128 * 1024) }) + '\n').repeat(12);
    fs.writeFileSync(file, prefix + 'x'.repeat(limit * 2));
    expect(() => reader.read(file, consume, reset)).toThrow(SessionLogReadLimitError);
    fs.appendFileSync(file, '\n{"n":2}\n');
    vi.mocked(fs.readSync).mockClear();
    const consumeAgain = vi.fn();
    expect(() => reader.read(file, consumeAgain, reset)).toThrow(SessionLogReadLimitError);
    expect(consumeAgain).not.toHaveBeenCalled();
    const bytes = vi.mocked(fs.readSync).mock.results.reduce((sum, result) => sum + (result.type === 'return' ? Number(result.value) : 0), 0);
    expect(bytes).toBeLessThanOrEqual(limit + 2);
    // An in-place repair of the oversized line is detected even when the file grows.
    fs.writeFileSync(file, prefix + ('{"n":3}\n').repeat(limit / 2));
    reader.read(file, consume, reset);
    expect(lines.at(-1)).toBe('{"n":3}');
  });

  const toolOutput = (text: string, type = 'custom_tool_call_output') => JSON.stringify({
    timestamp: '2026-09-27T10:00:00.000Z', type: 'response_item', payload: { type, output: text }
  });

  it.each(['custom_tool_call_output', 'function_call_output'])('projects oversized %s while retaining adjacent statistics and time', type => {
    reader = new IncrementalSessionLog(1024);
    const first = '{"type":"event_msg","payload":{"type":"token_count","n":1}}';
    const last = '{"type":"event_msg","payload":{"type":"task_complete"}}';
    const output = toolOutput('x'.repeat(600 * 1024) + '\\"嵌套 {"type":"token_count"}', type);
    fs.writeFileSync(file, `${first}\n${output}\r\n${last}\n`);
    reader.read(file, consume, reset);
    expect(lines).toEqual([first, JSON.stringify({ type: 'response_item', timestamp: '2026-09-27T10:00:00.000Z', payload: { type } }), last]);
    vi.mocked(fs.readSync).mockClear();
    expect(reader.read(file, consume, reset)).toBe(false);
    expect(fs.readSync).not.toHaveBeenCalled();
    fs.appendFileSync(file, '{"n":2}\n');
    reader.read(file, consume, reset);
    expect(lines.at(-1)).toBe('{"n":2}');
    expect(resets).toBe(1);
  });

  it('streams an incomplete oversized tail across appends without rereading or retaining its body', () => {
    reader = new IncrementalSessionLog(1024);
    const output = toolOutput('x'.repeat(600 * 1024) + '🙂');
    fs.writeFileSync(file, output.slice(0, -5));
    reader.read(file, consume, reset);
    expect(lines).toEqual([]);
    vi.mocked(fs.readSync).mockClear();
    fs.appendFileSync(file, output.slice(-5));
    reader.read(file, consume, reset);
    expect(lines).toHaveLength(1);
    const bytes = vi.mocked(fs.readSync).mock.results.reduce((sum, result) => sum + (result.type === 'return' ? Number(result.value) : 0), 0);
    expect(bytes).toBeLessThan(1024);
    fs.appendFileSync(file, '\n{"n":2}\n');
    reader.read(file, consume, reset);
    expect(lines).toHaveLength(2);
    expect(lines.at(-1)).toBe('{"n":2}');
  });

  it('rebuilds a rewritten pending output instead of consuming an obsolete projection', () => {
    reader = new IncrementalSessionLog(1024);
    fs.writeFileSync(file, toolOutput('x'.repeat(300 * 1024)).slice(0, -2));
    reader.read(file, consume, reset);
    fs.writeFileSync(file, '{"n":1}\n' + toolOutput('y'.repeat(600 * 1024)) + '\n');
    reader.read(file, consume, reset);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('{"n":1}');
    expect(resets).toBe(2);
  });

  it('projects oversized DynamicToolCall completion envelopes while preserving neighboring statistics', () => {
    reader = new IncrementalSessionLog(1024);
    const completion = { type: 'event_msg', timestamp: '2026-10-02T00:00:00Z', payload: {
      type: 'item_completed', item: { type: 'DynamicToolCall', content: [{ type: 'inputText', text: 'x'.repeat(300 * 1024) }] }
    } };
    fs.writeFileSync(file, JSON.stringify(completion) + '\n{"type":"event_msg","payload":{"type":"token_count","info":{"n":42}}}\n');
    reader.read(file, consume, reset);
    expect(lines.map(line => JSON.parse(line))).toEqual([
      { type: 'event_msg', timestamp: completion.timestamp, payload: { type: 'item_completed', item: { type: 'DynamicToolCall' } } },
      { type: 'event_msg', payload: { type: 'token_count', info: { n: 42 } } }
    ]);
    expect(reader.read(file, consume, reset)).toBe(false);
  });

  const compacted = (text: string) => JSON.stringify({
    timestamp: '2026-10-04T00:00:00.000Z', ordinal: 8093, type: 'compacted',
    payload: { message: text, replacement_history: [{ type: 'event_msg', payload: { type: 'token_count', n: 999 } }],
      latest_token_usage_record: { type: 'token_count', n: 999 } }
  });

  it('projects large compaction context without replaying its historical token reports or rereading unchanged data', () => {
    reader = new IncrementalSessionLog(1024);
    const before = '{"type":"event_msg","payload":{"type":"token_count","n":1}}';
    const after = '{"type":"event_msg","payload":{"type":"token_count","n":2}}';
    fs.writeFileSync(file, `${before}\n${compacted('x'.repeat(600 * 1024) + '🙂')}\r\n${after}\n`);
    reader.read(file, consume, reset);
    expect(lines).toEqual([before, JSON.stringify({ type: 'compacted', timestamp: '2026-10-04T00:00:00.000Z' }), after]);
    vi.mocked(fs.readSync).mockClear();
    expect(reader.read(file, consume, reset)).toBe(false);
    expect(fs.readSync).not.toHaveBeenCalled();
    fs.appendFileSync(file, '{"n":3}\n');
    reader.read(file, consume, reset);
    expect(lines.at(-1)).toBe('{"n":3}');
    expect(resets).toBe(1);
  });

  it('continues a partial compaction record using only newly appended bytes', () => {
    reader = new IncrementalSessionLog(1024);
    const record = compacted('x'.repeat(600 * 1024));
    fs.writeFileSync(file, record.slice(0, -5));
    reader.read(file, consume, reset);
    expect(lines).toEqual([]);
    vi.mocked(fs.readSync).mockClear();
    fs.appendFileSync(file, record.slice(-5) + '\n{"n":2}\n');
    reader.read(file, consume, reset);
    expect(lines).toEqual([JSON.stringify({ type: 'compacted', timestamp: '2026-10-04T00:00:00.000Z' }), '{"n":2}']);
    const bytes = vi.mocked(fs.readSync).mock.results.reduce((sum, result) => sum + (result.type === 'return' ? Number(result.value) : 0), 0);
    expect(bytes).toBeLessThan(1024);
  });

  it.each([
    '{"type":"event_msg","payload":{"type":"token_count","text":"BODY"}}',
    '{"type":"event_msg","payload":{"type":"item_completed","item":{"type":"TokenCount","text":"BODY"}}}',
    '{"type":"event_msg","payload":{"type":"item_completed","item":{"type":"DynamicToolCall","text":"BODY","type":"TokenCount"}}}',
    '{"type":"event_msg","payload":{"type":"item_completed","item":{"type":"DynamicToolCall","text":"BODY"},"item":{"type":"TokenCount"}}}',
    '{"type":"session_meta","payload":{"type":"custom_tool_call_output","text":"BODY"}}',
    '{"type":"turn_context","payload":{"type":"custom_tool_call_output","text":"BODY"}}',
    '{"type":"event_msg","payload":{"type":"task_started","text":"BODY"}}',
    '{"type":"event_msg","payload":{"type":"task_complete","text":"BODY"}}',
    '{"type":"event_msg","payload":{"type":"turn_aborted","text":"BODY"}}',
    '{"nested":{"type":"response_item"},"type":"event_msg","payload":{"type":"custom_tool_call_output","text":"BODY"}}',
    '{"type":"response_item","payload":{"type":"message","role":"user","text":"BODY"}}',
    '{"type":"response_item","payload":{"nested":{"type":"custom_tool_call_output"},"output":"BODY"}}',
    '{"type":"response_item","payload":{"type":"custom_tool_call_output","output":"BODY"},"type":"event_msg"}',
    '{"type":"response_item","payload":{"type":"custom_tool_call_output","output":"BODY","type":"token_count"}}',
    '{"type":"response_item","payload":{"type":"custom_tool_call_output","output":"BODY"},"payload":{"type":"token_count"}}',
    '{"type":"response_item","payload":{"type":"custom_tool_call_output","output":"BODY"},}',
    '{"type":"response_item","payload":{"type":"custom_tool_call_output","output":"BODY\\q"}}',
    '{"type":"response_item","payload":{"type":"custom_tool_call_output","output":"BODY"},"deep":' + '['.repeat(65) + '0' + ']'.repeat(65) + '}',
    '{"type":"compacted","payload":{"message":"BODY"},"type":"event_msg"}',
    '{"type":"compacted","payload":{"message":"BODY"},"payload":{"type":"token_count"}}',
    '{"type":"compacted","payload":{"message":"BODY\\q"}}',
    '{"type":"compacted","payload":{"message":"BODY"},}'
  ])('never projects a statistical, ambiguous or malformed oversized envelope: %s', template => {
    reader = new IncrementalSessionLog(1024);
    fs.writeFileSync(file, template.replace('BODY', 'x'.repeat(300 * 1024)) + '\n');
    expect(() => reader.read(file, consume, reset)).toThrow(SessionLogReadLimitError);
    expect(lines).toEqual([]);
  });

  it('recognizes escaped identity keys and rejects a duplicate identity encoded with escapes', () => {
    reader = new IncrementalSessionLog(1024);
    const output = toolOutput('x'.repeat(300 * 1024)).replace('"type":"response_item"', '"\\u0074ype":"response_item"');
    fs.writeFileSync(file, output + '\n');
    reader.read(file, consume, reset);
    expect(lines).toHaveLength(1);
    fs.writeFileSync(file, output.slice(0, -1) + ',"type":"event_msg"}\n');
    expect(() => reader.read(file, consume, reset)).toThrow(SessionLogReadLimitError);
  });

  it('recovers when a blocked unknown record is rewritten in place as a larger valid tool output', () => {
    reader = new IncrementalSessionLog(1024);
    fs.writeFileSync(file, JSON.stringify({ type: 'unknown', text: 'x'.repeat(300 * 1024) }) + '\n');
    expect(() => reader.read(file, consume, reset)).toThrow(SessionLogReadLimitError);
    const original = fs.statSync(file);
    fs.writeFileSync(file, toolOutput('y'.repeat(600 * 1024)) + '\n');
    expect(fs.statSync(file).ino).toBe(original.ino);
    reader.read(file, consume, reset);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).payload.type).toBe('custom_tool_call_output');
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
