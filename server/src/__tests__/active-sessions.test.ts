import { ActiveSessionTracker, parseActiveSessionFile } from "../active-sessions";
import { mkdtempSync, writeFileSync, appendFileSync, statSync, utimesSync, rmSync, readSync } from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return { ...original, readSync: vi.fn(original.readSync) };
});

describe("parseActiveSessionFile", () => {
  it("returns an active session when the latest turn started and has not finished", () => {
    const session = parseActiveSessionFile({
      sessionId: "019d773d-49eb-7ae0-9327-ff3b0b39c7a7",
      updatedAt: "2026-04-10T11:54:20.000Z",
      nowMs: Date.parse("2026-04-10T11:55:00.000Z"),
      activeWindowMs: 15 * 60 * 1000,
      fileContent: [
        JSON.stringify({
          timestamp: "2026-04-10T11:53:18.500Z",
          type: "session_meta",
          payload: {
            name: "Codex monitor title",
            cwd: "C:\\work\\from-meta"
          }
        }),
        JSON.stringify({
          timestamp: "2026-04-10T11:53:18.572Z",
          type: "event_msg",
          payload: {
            type: "task_started",
            turn_id: "turn_active"
          }
        }),
        JSON.stringify({
          timestamp: "2026-04-10T11:53:18.579Z",
          type: "turn_context",
          payload: {
            cwd: "C:\\work\\codex-monitor"
          }
        }),
        JSON.stringify({
          timestamp: "2026-04-10T11:53:18.580Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "monitor only the live work" }]
          }
        })
      ].join("\n")
    });

    expect(session).toEqual({
      id: "019d773d-49eb-7ae0-9327-ff3b0b39c7a7",
      name: "Codex monitor title",
      preview: "monitor only the live work",
      cwd: "C:\\work\\codex-monitor",
      createdAt: null,
      updatedAt: "2026-04-10T11:53:18.580Z",
      lastTurnStartedAt: "2026-04-10T11:53:18.572Z"
    });
  });

  it("ignores sessions whose latest turn has already completed", () => {
    const session = parseActiveSessionFile({
      sessionId: "019d773d-49eb-7ae0-9327-ff3b0b39c7a7",
      updatedAt: "2026-04-10T11:54:20.000Z",
      nowMs: Date.parse("2026-04-10T11:55:00.000Z"),
      activeWindowMs: 15 * 60 * 1000,
      fileContent: [
        JSON.stringify({
          timestamp: "2026-04-10T11:53:18.572Z",
          type: "event_msg",
          payload: {
            type: "task_started",
            turn_id: "turn_done"
          }
        }),
        JSON.stringify({
          timestamp: "2026-04-10T11:53:58.572Z",
          type: "event_msg",
          payload: {
            type: "task_complete",
            turn_id: "turn_done"
          }
        })
      ].join("\n")
    });

    expect(session).toBeNull();
  });

  it("ignores stale sessions even if the latest turn never wrote a terminal event", () => {
    const session = parseActiveSessionFile({
      sessionId: "019d773d-49eb-7ae0-9327-ff3b0b39c7a7",
      updatedAt: "2026-04-10T08:00:00.000Z",
      nowMs: Date.parse("2026-04-10T11:55:00.000Z"),
      activeWindowMs: 15 * 60 * 1000,
      fileContent: [
        JSON.stringify({
          timestamp: "2026-04-10T07:59:00.000Z",
          type: "event_msg",
          payload: {
            type: "task_started",
            turn_id: "turn_stale"
          }
        })
      ].join("\n")
    });

    expect(session).toBeNull();
  });
});

describe("ActiveSessionTracker cache", () => {
  afterEach(() => vi.mocked(readSync).mockClear());

  it("does not reread unchanged logs and only reads the appended tail of a large log", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "monitor-active-"));
    try {
      const file = path.join(root, "rollout-019d773d-49eb-7ae0-9327-ff3b0b39c7a7.jsonl");
      const now = Date.now();
      const timestamp = new Date(now).toISOString();
      writeFileSync(file, [
        JSON.stringify({ type: "session_meta", payload: { name: "Current task", source: "cli" } }),
        JSON.stringify({ timestamp, type: "event_msg", payload: { type: "task_started", turn_id: "first" } }),
        JSON.stringify({ timestamp, type: "response_item", payload: { type: "function_call_output", output: "x".repeat(1024 * 1024) } })
      ].join("\n") + "\n");
      const tracker = new ActiveSessionTracker(root, 1000);
      expect(tracker.listActiveSessions(now)).toHaveLength(1);
      vi.mocked(readSync).mockClear();
      expect(tracker.listActiveSessions(now + 500)).toHaveLength(1);
      expect(readSync).not.toHaveBeenCalled();

      const completion = JSON.stringify({ timestamp, type: "event_msg", payload: { type: "task_complete", turn_id: "first" } }) + "\n";
      appendFileSync(file, completion);
      expect(tracker.listActiveSessions(now + 500)).toHaveLength(0);
      const bytesRead = vi.mocked(readSync).mock.results.reduce((sum, result) => sum + (result.type === "return" ? Number(result.value) : 0), 0);
      expect(bytesRead).toBeLessThanOrEqual(Buffer.byteLength(completion) + 512);

      appendFileSync(file, JSON.stringify({ timestamp: new Date(now + 1500).toISOString(), type: "event_msg", payload: { type: "task_started", turn_id: "second" } }) + "\n");
      expect(tracker.listActiveSessions(now + 1500)[0]?.lastTurnStartedAt).toBe(new Date(now + 1500).toISOString());
      expect(tracker.listActiveSessions(now + 2501)).toHaveLength(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("retains UTF-8 user previews when an appended record is split across polls", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "monitor-active-"));
    try {
      const file = path.join(root, "rollout-019d773d-49eb-7ae0-9327-ff3b0b39c7a7.jsonl");
      const now = Date.now();
      const timestamp = new Date(now).toISOString();
      writeFileSync(file, JSON.stringify({ timestamp, type: "event_msg", payload: { type: "task_started", turn_id: "turn" } }) + "\n");
      const tracker = new ActiveSessionTracker(root);
      expect(tracker.listActiveSessions(now)).toHaveLength(1);
      const line = Buffer.from(JSON.stringify({ timestamp, type: "event_msg", payload: { type: "user_message", message: "中文任务 🚀" } }) + "\n");
      const split = line.indexOf(Buffer.from("中")) + 1;
      appendFileSync(file, line.subarray(0, split));
      expect(tracker.listActiveSessions(now)[0]?.preview).toBeNull();
      appendFileSync(file, line.subarray(split));
      expect(tracker.listActiveSessions(now)[0]?.preview).toBe("中文任务 🚀");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("retries a failed read instead of caching an inactive session", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "monitor-active-"));
    try {
      const file = path.join(root, "rollout-019d773d-49eb-7ae0-9327-ff3b0b39c7a7.jsonl");
      const now = Date.now();
      writeFileSync(file, JSON.stringify({ timestamp: new Date(now).toISOString(), type: "event_msg", payload: { type: "task_started", turn_id: "turn" } }) + "\n");
      const tracker = new ActiveSessionTracker(root);
      vi.mocked(readSync).mockImplementationOnce(() => { throw new Error("Temporary read failure"); });
      expect(tracker.listActiveSessions(now)).toHaveLength(0);
      expect(tracker.listActiveSessions(now)).toHaveLength(1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("rebuilds session identity after a same-size rewrite", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "monitor-active-"));
    try {
      const file = path.join(root, "rollout-019d773d-49eb-7ae0-9327-ff3b0b39c7a7.jsonl");
      const now = Date.now();
      const log = (name: string) => [
        JSON.stringify({ type: "session_meta", payload: { source: "cli", name } }),
        JSON.stringify({ timestamp: new Date(now).toISOString(), type: "event_msg", payload: { type: "task_started", turn_id: "turn" } })
      ].join("\n") + "\n";
      writeFileSync(file, log("First"));
      const tracker = new ActiveSessionTracker(root);
      expect(tracker.listActiveSessions(now)[0]?.name).toBe("First");
      const stat = statSync(file);
      writeFileSync(file, log("Other"));
      utimesSync(file, stat.atime, new Date(stat.mtimeMs + 2000));
      expect(tracker.listActiveSessions(now)[0]?.name).toBe("Other");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("uses the first metadata header instead of inherited ancestor identity", () => {
    const now = Date.now();
    const session = parseActiveSessionFile({ sessionId: "current", updatedAt: new Date(now).toISOString(), nowMs: now, activeWindowMs: 900000,
      fileContent: [
        JSON.stringify({ type: "session_meta", payload: { source: "cli", name: "Current", cwd: "C:/current" } }),
        JSON.stringify({ type: "session_meta", payload: { source: { subagent: { other: "ancestor" } }, name: "Ancestor", cwd: "C:/ancestor" } }),
        JSON.stringify({ timestamp: new Date(now).toISOString(), type: "event_msg", payload: { type: "task_started", turn_id: "turn" } })
      ].join("\n")
    });
    expect(session).toMatchObject({ id: "current", name: "Current", cwd: "C:/current" });
  });

  it("expires unchanged sessions and detects completion even when mtime does not change", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "monitor-active-"));
    try {
      const file = path.join(root, "rollout-019d773d-49eb-7ae0-9327-ff3b0b39c7a7.jsonl");
      const now = Date.now();
      writeFileSync(file, JSON.stringify({ timestamp: new Date(now).toISOString(), type: "event_msg", payload: { type: "task_started", turn_id: "t" } }) + "\n");
      const tracker = new ActiveSessionTracker(root, 1000);
      expect(tracker.listActiveSessions(now)).toHaveLength(1);
      expect(tracker.listActiveSessions(now + 1001)).toHaveLength(0);
      const stat = statSync(file);
      appendFileSync(file, JSON.stringify({ timestamp: new Date(now + 500).toISOString(), type: "event_msg", payload: { type: "task_complete", turn_id: "t" } }) + "\n");
      utimesSync(file, stat.atime, stat.mtime);
      expect(tracker.listActiveSessions(now + 500)).toHaveLength(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("excludes internal subagents from top-level activity", () => {
    expect(parseActiveSessionFile({ sessionId: "review", updatedAt: new Date().toISOString(), nowMs: Date.now(), activeWindowMs: 900000,
      fileContent: [JSON.stringify({ type: "session_meta", payload: { source: { subagent: { other: "guardian" } } } }), JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "t" } })].join("\n")
    })).toBeNull();
  });
});
