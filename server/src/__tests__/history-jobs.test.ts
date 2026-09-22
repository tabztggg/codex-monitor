import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { HistoryJobReader, parseHistorySessionFile, readSessionLines } from "../history-jobs";
import { MonitorService } from "../service";

it("recovers desktop titles absent from thread/list and tolerates a partial index line", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "monitor-index-"));
  try {
    const sessions = path.join(root, "sessions");
    mkdirSync(sessions);
    const id = "019e1b12-3784-79c3-86e7-5469e67f114b";
    writeFileSync(path.join(sessions, `rollout-${id}.jsonl`), JSON.stringify({ type: "session_meta", payload: { id } }));
    writeFileSync(path.join(root, "session_index.jsonl"), [JSON.stringify({ id, thread_name: "Old title" }), JSON.stringify({ id, thread_name: "Actual desktop title" }), '{"id":'].join("\n"));
    expect(new HistoryJobReader(sessions).listJobs({}).data[0].name).toBe("Actual desktop title");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('reads streamed session lines across UTF-8 and newline boundaries without requiring a whole-file string', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'monitor-lines-'));
  try {
    const file = path.join(root, 'rollout.jsonl');
    writeFileSync(file, '中文🙂\r\nsecond\n最后一行');
    expect([...readSessionLines(file, 3)]).toEqual(['中文🙂', 'second', '最后一行']);
    // Early iterator termination must close the file descriptor as well.
    const lines = readSessionLines(file, 3);
    expect(lines.next().value).toBe('中文🙂');
    lines.return(undefined);
    writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: { id: 'streamed-session' } }));
    expect(parseHistorySessionFile({ sessionId: null, fileContent: readSessionLines(file, 3),
      updatedAt: '2026-09-22T00:00:00Z', nowMs: Date.parse('2026-09-22T00:00:00Z') })?.id).toBe('streamed-session');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

class FakeCodexClient extends EventEmitter {
  public constructor(private readonly threads: unknown[] | null = null) {
    super();
  }

  public async ensureStarted() {
    return;
  }

  public async request(method: string) {
    if (method === "thread/list" && this.threads) {
      return {
        data: this.threads,
        nextCursor: null
      };
    }

    throw new Error("Unexpected request");
  }

  public async respond() {
    return;
  }
}

describe("parseHistorySessionFile", () => {
  it("does not count repeated cumulative usage or its cost twice", () => {
    const event = tokenCountEvent("2026-05-12T09:00:00Z", 110, 100, 20, 10);
    const job = parseHistorySessionFile({
      sessionId: "duplicate-usage",
      updatedAt: "2026-05-12T10:00:00Z",
      nowMs: Date.parse("2026-05-12T12:00:00Z"),
      usageWindowStartedAtMs: Date.parse("2026-05-12T00:00:00Z"),
      fileContent: lines([
        { type: "turn_context", payload: { model: "gpt-6-astra" } },
        event,
        { timestamp: "2026-05-12T09:01:00Z", type: "event_msg", payload: { type: "token_count", info: null } },
        { ...event, timestamp: "2026-05-12T10:00:00Z" }
      ])
    });
    expect(job?.totalUsage?.totalTokens).toBe(110);
    expect(job?.last24HoursUsage?.totalTokens).toBe(110);
    expect(job?.sinceResetUsage?.totalTokens).toBe(110);
    expect(job?.totalEstimatedCostUsd).toBeCloseTo(0.00132, 8);
    expect(job?.last24HoursEstimatedCostUsd).toBeCloseTo(0.00132, 8);
    expect(job?.sinceResetEstimatedCostUsd).toBeCloseTo(0.00132, 8);
  });

  it("does not move old usage into a new quota window when counters repeat", () => {
    const event = tokenCountEvent("2026-05-10T09:00:00Z", 110, 100, 20, 10);
    const job = parseHistorySessionFile({
      sessionId: "duplicate-outside-window",
      updatedAt: "2026-05-12T10:00:00Z",
      nowMs: Date.parse("2026-05-12T12:00:00Z"),
      usageWindowStartedAtMs: Date.parse("2026-05-12T00:00:00Z"),
      fileContent: lines([
        { type: "turn_context", payload: { model: "gpt-6-astra" } },
        event,
        { ...event, timestamp: "2026-05-12T10:00:00Z" }
      ])
    });
    expect(job?.totalUsage?.totalTokens).toBe(110);
    expect(job?.last24HoursUsage).toBeNull();
    expect(job?.sinceResetUsage).toBeNull();
  });

  it("keeps equal response sizes when cumulative usage advances or resets", () => {
    const event = tokenCountEvent("2026-05-12T09:00:00Z", 110, 100, 20, 10);
    const next = structuredClone(event);
    next.payload.info.total_token_usage = {
      input_tokens: 200, cached_input_tokens: 40, output_tokens: 20,
      reasoning_output_tokens: 0, total_tokens: 220
    };
    const job = parseHistorySessionFile({
      sessionId: "equal-size-responses",
      updatedAt: event.timestamp,
      nowMs: Date.parse(event.timestamp),
      fileContent: lines([event, next, event])
    });
    expect(job?.totalUsage?.totalTokens).toBe(330);
  });

  it("keeps response usage when cumulative counters are absent", () => {
    const event = {
      type: "event_msg", payload: { type: "token_count", info: {
        last_token_usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 }
      } }
    };
    const job = parseHistorySessionFile({
      sessionId: "no-cumulative-counters",
      updatedAt: "2026-05-12T09:00:00Z",
      nowMs: Date.parse("2026-05-12T09:00:00Z"),
      fileContent: lines([event, event])
    });
    expect(job?.totalUsage?.totalTokens).toBe(220);
  });

  it("uses task_complete duration_ms and token_count usage", () => {
    const job = parseHistorySessionFile({
      sessionId: "019e1b12-3784-79c3-86e7-5469e67f114b",
      updatedAt: "2026-05-12T09:00:00.000Z",
      nowMs: Date.parse("2026-05-12T09:03:00.000Z"),
      fileContent: lines([
        {
          timestamp: "2026-05-12T09:00:00.000Z",
          type: "session_meta",
          payload: {
            id: "019e1b12-3784-79c3-86e7-5469e67f114b",
            timestamp: "2026-05-12T09:00:00.000Z",
            cwd: "C:/repo",
            source: { cli: {} },
            model_provider: "openai"
          }
        },
        {
          timestamp: "2026-05-12T09:01:00.000Z",
          type: "event_msg",
          payload: { type: "task_started", turn_id: "turn_a" }
        },
        {
          timestamp: "2026-05-12T09:01:05.000Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: {
                input_tokens: 100,
                cached_input_tokens: 20,
                output_tokens: 10,
                reasoning_output_tokens: 4,
                total_tokens: 110
              },
              last_token_usage: {
                input_tokens: 100,
                cached_input_tokens: 20,
                output_tokens: 10,
                reasoning_output_tokens: 4,
                total_tokens: 110
              }
            }
          }
        },
        {
          timestamp: "2026-05-12T09:01:07.000Z",
          type: "event_msg",
          payload: {
            type: "task_complete",
            turn_id: "turn_a",
            completed_at: 1778576467,
            duration_ms: 4200
          }
        }
      ])
    });

    expect(job).toMatchObject({
      id: "019e1b12-3784-79c3-86e7-5469e67f114b",
      sourceKind: "cli",
      cwd: "C:/repo",
      modelProvider: "openai",
      runCount: 1,
      lastRunDurationMs: 4200,
      totalDurationMs: 4200,
      totalUsage: {
        inputTokens: 100,
        cachedInputTokens: 20,
        outputTokens: 10,
        reasoningOutputTokens: 4,
        totalTokens: 110
      }
    });
  });

  it("falls back to timestamps and totals multiple turns", () => {
    const job = parseHistorySessionFile({
      sessionId: "019e1b12-7d46-7390-9a7a-f650b0b582f8",
      updatedAt: "2026-05-12T09:10:00.000Z",
      nowMs: Date.parse("2026-05-12T09:20:00.000Z"),
      fileContent: lines([
        {
          timestamp: "2026-05-12T09:10:00.000Z",
          type: "event_msg",
          payload: { type: "task_started", turn_id: "turn_a" }
        },
        {
          timestamp: "2026-05-12T09:10:05.000Z",
          type: "event_msg",
          payload: { type: "task_complete", turn_id: "turn_a" }
        },
        {
          timestamp: "2026-05-12T09:11:00.000Z",
          type: "event_msg",
          payload: { type: "task_started", turn_id: "turn_b" }
        },
        {
          timestamp: "2026-05-12T09:11:10.000Z",
          type: "event_msg",
          payload: { type: "task_complete", turn_id: "turn_b" }
        }
      ])
    });

    expect(job?.runCount).toBe(2);
    expect(job?.lastRunDurationMs).toBe(10000);
    expect(job?.totalDurationMs).toBe(15000);
  });

  it("ignores malformed lines and measures active turns against now", () => {
    const job = parseHistorySessionFile({
      sessionId: "019e1b12-ffff-7390-9a7a-f650b0b582f8",
      updatedAt: "2026-05-12T09:10:00.000Z",
      nowMs: Date.parse("2026-05-12T09:12:00.000Z"),
      fileContent: [
        "{malformed json",
        JSON.stringify({
          timestamp: "2026-05-12T09:10:00.000Z",
          type: "event_msg",
          payload: { type: "task_started", turn_id: "turn_active" }
        })
      ].join("\n")
    });

    expect(job?.runCount).toBe(1);
    expect(job?.lastRunCompletedAt).toBeNull();
    expect(job?.lastRunDurationMs).toBe(120000);
    expect(job?.totalDurationMs).toBe(120000);
  });

  it("caps stale open turns at the last recorded activity", () => {
    const job = parseHistorySessionFile({
      sessionId: "019e1b12-stale-7390-9a7a-f650b0b582f8",
      updatedAt: "2026-05-12T09:10:00.000Z",
      nowMs: Date.parse("2026-05-13T09:10:00.000Z"),
      fileContent: lines([
        {
          timestamp: "2026-05-12T09:00:00.000Z",
          type: "event_msg",
          payload: { type: "task_started", turn_id: "turn_stale_open" }
        },
        {
          timestamp: "2026-05-12T09:03:30.000Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: {
                input_tokens: 10,
                cached_input_tokens: 0,
                output_tokens: 1,
                reasoning_output_tokens: 1,
                total_tokens: 11
              },
              last_token_usage: {
                input_tokens: 10,
                cached_input_tokens: 0,
                output_tokens: 1,
                reasoning_output_tokens: 1,
                total_tokens: 11
              }
            }
          }
        }
      ])
    });

    expect(job?.lastRunCompletedAt).toBeNull();
    expect(job?.lastRunDurationMs).toBe(210000);
    expect(job?.totalDurationMs).toBe(210000);
  });

  it("sums token events from the rolling 24-hour window and estimates API cost", () => {
    const nowMs = Date.parse("2026-05-12T12:00:00.000Z");
    const job = parseHistorySessionFile({
      sessionId: "019e1b12-24h0-7390-9a7a-f650b0b582f8",
      updatedAt: "2026-05-12T11:00:00.000Z",
      nowMs,
      fileContent: lines([
        {
          timestamp: "2026-05-11T10:00:00.000Z",
          type: "turn_context",
          payload: { model: "gpt-6-astra" }
        },
        tokenCountEvent("2026-05-11T10:01:00.000Z", 999, 100, 20, 10),
        {
          timestamp: "2026-05-11T13:00:00.000Z",
          type: "turn_context",
          payload: { model: "gpt-6-astra" }
        },
        tokenCountEvent("2026-05-11T13:01:00.000Z", 110, 100, 20, 10),
        {
          timestamp: "2026-05-12T10:00:00.000Z",
          type: "turn_context",
          payload: { model: "gpt-5.6-sol" }
        },
        tokenCountEvent("2026-05-12T10:01:00.000Z", 55, 50, 10, 5)
      ])
    });

    expect(job?.last24HoursUsage).toMatchObject({
      inputTokens: 150,
      cachedInputTokens: 30,
      outputTokens: 15,
      totalTokens: 165
    });
    expect(job?.last24HoursEstimatedCostUsd).toBeCloseTo(0.001584, 8);
    expect(job?.totalUsage).toMatchObject({ totalTokens: 1164 });
    expect(job?.totalEstimatedCostUsd).toBeCloseTo(0.002904, 8);
    expect(job?.totalEstimatedCostIsComplete).toBe(true);
  });

  it("keeps a marked lower-bound cost when some recorded models are unpriced", () => {
    const job = parseHistorySessionFile({
      sessionId: "019e1b12-cost-7390-9a7a-f650b0b582f8",
      updatedAt: "2026-05-12T11:00:00.000Z",
      nowMs: Date.parse("2026-05-12T12:00:00.000Z"),
      fileContent: lines([
        {
          timestamp: "2026-05-12T09:00:00.000Z",
          type: "turn_context",
          payload: { model: "gpt-5.6" }
        },
        tokenCountEvent("2026-05-12T09:01:00.000Z", 110, 100, 20, 10),
        {
          timestamp: "2026-05-12T10:00:00.000Z",
          type: "turn_context",
          payload: { model: "codex-auto-review" }
        },
        tokenCountEvent("2026-05-12T10:01:00.000Z", 55, 50, 10, 5)
      ])
    });

    expect(job?.totalUsage).toMatchObject({ totalTokens: 165 });
    expect(job?.totalEstimatedCostUsd).toBeCloseTo(0.000528, 8);
    expect(job?.totalEstimatedCostIsComplete).toBe(false);
  });
});

describe("MonitorService history jobs", () => {
  let sessionsRoot: string;

  beforeEach(() => {
    sessionsRoot = mkdtempSync(path.join(os.tmpdir(), "codex-monitor-history-"));
  });

  afterEach(() => {
    rmSync(sessionsRoot, { recursive: true, force: true });
  });

  it("orders, filters, and paginates local history jobs", async () => {
    writeSessionFile(
      sessionsRoot,
      "019e1b12-0000-7000-8000-000000000001",
      "2026-05-12T09:00:00.000Z",
      "cli",
      "older cli work"
    );
    writeSessionFile(
      sessionsRoot,
      "019e1b12-0000-7000-8000-000000000002",
      "2026-05-12T10:00:00.000Z",
      "vscode",
      "newer vscode work"
    );

    const service = new MonitorService(
      new FakeCodexClient() as never,
      new HistoryJobReader(sessionsRoot)
    );

    const firstPage = await service.listHistoryJobs({ limit: 1 });
    expect(firstPage.data).toHaveLength(1);
    expect(firstPage.total).toBe(2);
    expect(firstPage.data[0].id).toBe("019e1b12-0000-7000-8000-000000000002");
    expect(firstPage.nextCursor).toBe("1");

    const secondPage = await service.listHistoryJobs({
      cursor: firstPage.nextCursor,
      limit: 1
    });
    expect(secondPage.data[0].id).toBe("019e1b12-0000-7000-8000-000000000001");
    expect(secondPage.total).toBe(2);
    expect(secondPage.nextCursor).toBeNull();

    const cliOnly = await service.listHistoryJobs({
      sourceKinds: ["cli"],
      searchTerm: "older"
    });
    expect(cliOnly.data).toHaveLength(1);
    expect(cliOnly.total).toBe(1);
    expect(cliOnly.data[0].sourceKind).toBe("cli");
  });

  it("sorts local history jobs by duration, tokens, and date direction", async () => {
    writeSessionFile(
      sessionsRoot,
      "019e1b12-0000-7000-8000-000000000011",
      "2026-05-12T09:00:00.000Z",
      "cli",
      "short work",
      { durationMs: 1000, totalTokens: 1000 }
    );
    writeSessionFile(
      sessionsRoot,
      "019e1b12-0000-7000-8000-000000000012",
      "2026-05-12T10:00:00.000Z",
      "cli",
      "long work",
      { durationMs: 5000, totalTokens: 500 }
    );

    const service = new MonitorService(
      new FakeCodexClient() as never,
      new HistoryJobReader(sessionsRoot)
    );

    expect(
      (
        await service.listHistoryJobs({
        sortKey: "totalDurationMs",
        sortDirection: "desc"
      })
      ).data[0].id
    ).toBe("019e1b12-0000-7000-8000-000000000012");

    expect(
      (
        await service.listHistoryJobs({
        sortKey: "totalTokens",
        sortDirection: "desc"
      })
      ).data[0].id
    ).toBe("019e1b12-0000-7000-8000-000000000011");

    expect(
      (
        await service.listHistoryJobs({
        sortKey: "updatedAt",
        sortDirection: "asc"
      })
      ).data[0].id
    ).toBe("019e1b12-0000-7000-8000-000000000011");
  });

  it("uses app-server thread metadata for history job titles and search", async () => {
    writeSessionFile(
      sessionsRoot,
      "019e1b12-0000-7000-8000-000000000021",
      "2026-05-12T09:00:00.000Z",
      "vscode",
      "raw prompt without the generated title"
    );

    const service = new MonitorService(
      new FakeCodexClient([
        {
          id: "019e1b12-0000-7000-8000-000000000021",
          name: "Readable generated title",
          preview: "Metadata preview",
          source: "vscode",
          createdAt: "2026-05-12T09:00:00.000Z",
          updatedAt: "2026-05-12T09:01:00.000Z",
          cwd: "C:/repo",
          modelProvider: "openai"
        }
      ]) as never,
      new HistoryJobReader(sessionsRoot)
    );

    const history = await service.listHistoryJobs({
      searchTerm: "generated title"
    });

    expect(history.data).toHaveLength(1);
    expect(history.data[0]).toMatchObject({
      id: "019e1b12-0000-7000-8000-000000000021",
      name: "Readable generated title",
      preview: "Metadata preview"
    });
  });

  it("merges multiple session files that belong to the same Codex task", async () => {
    const taskId = "019e1b12-0000-7000-8000-000000000099";
    writeSessionFile(
      sessionsRoot,
      "019e1b12-0000-7000-8000-000000000031",
      "2026-05-12T09:00:00.000Z",
      "cli",
      "first task fragment",
      { totalTokens: 100, taskId }
    );
    writeSessionFile(
      sessionsRoot,
      "019e1b12-0000-7000-8000-000000000032",
      "2026-05-12T10:00:00.000Z",
      "cli",
      "second task fragment",
      { totalTokens: 200, taskId }
    );

    const service = new MonitorService(
      new FakeCodexClient() as never,
      new HistoryJobReader(sessionsRoot)
    );
    const history = await service.listHistoryJobs({});

    expect(history.data).toHaveLength(1);
    expect(history.data[0]).toMatchObject({
      id: taskId,
      runCount: 2,
      totalUsage: { totalTokens: 300 }
    });
  });

  it("hides nested subagents and attributes their usage to the principal task", () => {
    const principalId = "019e1b12-0000-7000-8000-000000000061";
    const childId = "019e1b12-0000-7000-8000-000000000062";
    const nestedChildId = "019e1b12-0000-7000-8000-000000000063";
    writeSessionFile(
      sessionsRoot,
      principalId,
      "2026-05-12T09:00:00.000Z",
      "appServer",
      "principal task",
      { totalTokens: 100 }
    );
    writeSessionFile(
      sessionsRoot,
      childId,
      "2026-05-12T09:01:00.000Z",
      "subAgentOther",
      "child task",
      { totalTokens: 200, parentThreadId: principalId }
    );
    writeSessionFile(
      sessionsRoot,
      nestedChildId,
      "2026-05-12T09:02:00.000Z",
      "subAgentReview",
      "nested child task",
      { totalTokens: 300, parentThreadId: childId }
    );
    writeSessionFile(
      sessionsRoot,
      "019e1b12-0000-7000-8000-000000000064",
      "2026-05-12T09:03:00.000Z",
      "vscode",
      "newer child fragment",
      { totalTokens: 50, taskId: childId }
    );

    const history = new HistoryJobReader(sessionsRoot).listJobs({
      nowMs: Date.parse("2026-05-12T12:00:00.000Z"),
      usageWindow: {
        usedPercent: 20,
        startedAtMs: Date.parse("2026-05-12T08:00:00.000Z"),
        resetsAt: "2026-05-19T08:00:00.000Z",
        limitName: "Overall Codex",
        windowLabel: "Weekly"
      }
    });

    expect(history.data).toHaveLength(1);
    expect(history.data[0]).toMatchObject({
      id: principalId,
      sourceKind: "appServer",
      runCount: 1,
      totalUsage: { totalTokens: 650 },
      last24HoursUsage: { totalTokens: 650 },
      sinceResetUsage: { totalTokens: 650 },
      estimatedUsagePercentSinceReset: null
    });
  });

  it("allocates observed usage percent across tasks since the current reset", () => {
    const reader = new HistoryJobReader(sessionsRoot);
    reader.listJobs({ observeUsage: true, usageWindow: {
      usedPercent: 16, startedAtMs: Date.parse("2026-05-12T08:00:00.000Z"),
      resetsAt: "2026-05-19T08:00:00.000Z", limitName: "Overall Codex", windowLabel: "Weekly"
    }});
    writeSessionFile(
      sessionsRoot,
      "019e1b12-0000-7000-8000-000000000041",
      "2026-05-12T09:00:00.000Z",
      "cli",
      "smaller task",
      { totalTokens: 100 }
    );
    writeSessionFile(
      sessionsRoot,
      "019e1b12-0000-7000-8000-000000000042",
      "2026-05-12T10:00:00.000Z",
      "cli",
      "larger task",
      { totalTokens: 300 }
    );

    const history = reader.listJobs({
      observeUsage: true,
      nowMs: Date.parse("2026-05-12T12:00:00.000Z"),
      usageWindow: {
        usedPercent: 20, startedAtMs: Date.parse("2026-05-12T08:00:00.000Z"),
        resetsAt: "2026-05-19T08:00:00.000Z", limitName: "Overall Codex", windowLabel: "Weekly"
      }
    });

    expect(history.usageAllocation).toMatchObject({
      unattributedPercent: 16,
      status: "available",
      usedPercent: 20,
      limitName: "Overall Codex",
      windowLabel: "Weekly",
      basis: "apiEquivalentCost"
    });
    expect(
      history.data.find((job) => job.id.endsWith("41"))
        ?.estimatedUsagePercentSinceReset
    ).toBeCloseTo(1.1666666667, 8);
    expect(
      history.data.find((job) => job.id.endsWith("42"))
        ?.estimatedUsagePercentSinceReset
    ).toBeCloseTo(2.8333333333, 8);
  });

  it('keeps existing token activity without quota attribution unknown instead of zero', () => {
    const id = '019e1b12-0000-7000-8000-000000000089';
    writeSessionFile(sessionsRoot, id, '2026-05-12T10:00:00Z', 'cli', 'existing activity', { totalTokens: 100 });
    const reader = new HistoryJobReader(sessionsRoot);
    const window = { usedPercent: 10, startedAtMs: Date.parse('2026-05-12T08:00:00Z'),
      resetsAt: '2026-05-19T08:00:00Z', limitName: 'Overall Codex', windowLabel: 'Weekly' };
    const history = reader.listJobs({ observeUsage: true, usageWindow: window });
    expect(history.data[0].sinceResetUsage?.totalTokens).toBe(100);
    expect(history.data[0].estimatedUsagePercentSinceReset).toBeNull();
    expect(history.usageAllocation.unattributedPercent).toBe(10);
    const next = reader.listJobs({ observeUsage: true, usageWindow: { ...window,
      usedPercent: 0, startedAtMs: Date.parse('2026-05-19T08:00:00Z'), resetsAt: '2026-05-26T08:00:00Z' } });
    expect(next.data[0].estimatedUsagePercentSinceReset).toBe(0);
  });

  it('records weekly quota notifications without dashboard reads and ignores Spark and timestamp jitter', async () => {
    const client = new FakeCodexClient();
    const reader = new HistoryJobReader(sessionsRoot);
    const service = new MonitorService(client as never, reader);
    const now = Date.now();
    const reset = Math.floor(now / 1000) + 86400;
    const notify = (usedPercent: number, limitId = 'codex', offset = 0) => client.emit('notification', {
      method: 'account/rateLimits/updated', params: { rateLimits: {
        limitId,
        primary: { usedPercent: 50, windowDurationMins: 300, resetsAt: reset },
        secondary: { usedPercent, windowDurationMins: 10080, resetsAt: reset + offset }
      }}
    });
    notify(20);
    writeSessionFile(sessionsRoot, '019e1b12-0000-7000-8000-000000000090', new Date(now).toISOString(), 'cli', 'new activity', { totalTokens: 100 });
    notify(22);
    notify(22, 'codex', -1);
    notify(80, 'codex_bengalfox');
    const history = await service.listHistoryJobs({});
    expect(history.usageAllocation).toMatchObject({ usedPercent: 22, unattributedPercent: 20, windowLabel: 'Weekly' });
    expect(history.data[0].estimatedUsagePercentSinceReset).toBe(2);
    // Reading or filtering history must never reallocate quota.
    expect((await service.listHistoryJobs({})).data[0].estimatedUsagePercentSinceReset).toBe(2);
  });
});

function writeSessionFile(
  root: string,
  sessionId: string,
  timestamp: string,
  sourceKind: string,
  prompt: string,
  options: {
    durationMs?: number;
    totalTokens?: number;
    taskId?: string;
    parentThreadId?: string;
    model?: string;
  } = {}
) {
  const durationMs = options.durationMs ?? 1000;
  const totalTokens = options.totalTokens ?? 100;
  const directory = path.join(root, "2026", "05", "12");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    path.join(directory, `rollout-2026-05-12T09-00-00-${sessionId}.jsonl`),
    lines([
      {
        timestamp,
        type: "session_meta",
        payload: {
          id: options.taskId ?? sessionId,
          parent_thread_id: options.parentThreadId,
          timestamp,
          cwd: "C:/repo",
          source: sourceKind
        }
      },
      {
        timestamp,
        type: "turn_context",
        payload: { model: options.model ?? "gpt-5.6-sol" }
      },
      {
        timestamp,
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: prompt }]
        }
      },
      {
        timestamp,
        type: "event_msg",
        payload: { type: "task_started", turn_id: "turn_a" }
      },
      {
        timestamp: new Date(Date.parse(timestamp) + 500).toISOString(),
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: totalTokens - 10,
              cached_input_tokens: 0,
              output_tokens: 10,
              reasoning_output_tokens: 5,
              total_tokens: totalTokens
            },
            last_token_usage: {
              input_tokens: totalTokens - 10,
              cached_input_tokens: 0,
              output_tokens: 10,
              reasoning_output_tokens: 5,
              total_tokens: totalTokens
            }
          }
        }
      },
      {
        timestamp: new Date(Date.parse(timestamp) + durationMs).toISOString(),
        type: "event_msg",
        payload: {
          type: "task_complete",
          turn_id: "turn_a",
          duration_ms: durationMs
        }
      }
    ])
  );
}

function lines(entries: unknown[]): string {
  return entries.map((entry) => JSON.stringify(entry)).join("\n");
}

function tokenCountEvent(
  timestamp: string,
  totalTokens: number,
  inputTokens: number,
  cachedInputTokens: number,
  outputTokens: number
) {
  return {
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: inputTokens,
          cached_input_tokens: cachedInputTokens,
          output_tokens: outputTokens,
          reasoning_output_tokens: 0,
          total_tokens: totalTokens
        },
        last_token_usage: {
          input_tokens: inputTokens,
          cached_input_tokens: cachedInputTokens,
          output_tokens: outputTokens,
          reasoning_output_tokens: 0,
          total_tokens: totalTokens
        }
      }
    }
  };
}
