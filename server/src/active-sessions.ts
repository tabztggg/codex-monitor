import { existsSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { type ActiveSession } from "../../shared/monitor";
import { asRecord, asString } from "./utils";
import { userPreview } from "../../shared/session-preview";
import { IncrementalSessionLog } from "./session-log-reader";
import type { LiveTokenSnapshot } from "../../shared/live-tokens";
import { createLiveTokenFileState, LIVE_TOKEN_READ_INTERVAL_MS, LiveTokenMonitor, type LiveTokenFileState } from "./live-tokens";

const DEFAULT_ACTIVE_WINDOW_MS = 15 * 60 * 1000;

type CachedSessionState = {
  reader: IncrementalSessionLog;
  state: ActiveSessionState;
  sessionId: string;
  live: LiveTokenFileState;
  mtimeMs: number;
};

type ActiveSessionState = {
  hasSessionMeta: boolean;
  subagent: boolean;
  latestTurnId: string | null;
  latestTurnStartedAt: string | null;
  terminalTurnIds: Set<string>;
  name: string | null;
  cwd: string | null;
  latestUserInput: string | null;
  latestTimestamp: string | null;
};

export class ActiveSessionTracker {
  private readonly cache = new Map<string, CachedSessionState>();
  private readonly liveTokens = new LiveTokenMonitor();
  private readonly livePaths = new Set<string>();
  private initialScan = true;
  private liveSourceAvailable = true;
  private activitySourceAvailable = false;
  private lastConfirmedSessions: ActiveSession[] = [];
  private lastLiveReadAtMs = Number.NEGATIVE_INFINITY;

  public constructor(
    private readonly sessionsRoot = resolveCodexSessionsRoot(),
    private readonly activeWindowMs = DEFAULT_ACTIVE_WINDOW_MS
  ) {}

  public listActiveSessions(nowMs = Date.now()): ActiveSession[] {
    this.liveSourceAvailable = existsSync(this.sessionsRoot);
    const sessionFiles = listSessionFiles(this.sessionsRoot, () => { this.liveSourceAvailable = false; });
    const listingComplete = this.liveSourceAvailable;
    if (!listingComplete) this.liveTokens.markUnavailable(nowMs);
    this.activitySourceAvailable = listingComplete;
    const activePaths = new Set(sessionFiles.map((file) => file.path));

    for (const cachedPath of this.cache.keys()) {
      if (listingComplete && !activePaths.has(cachedPath)) {
        this.cache.delete(cachedPath);
        this.livePaths.delete(cachedPath);
      }
    }

    const sessions = sessionFiles
      .map((file) => this.readActiveSession(file.path, file.mtimeMs, nowMs))
      .filter((session): session is ActiveSession => Boolean(session))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    if (listingComplete) this.initialScan = false;
    // Expire memory even when no page is requesting live statistics.
    this.liveTokens.snapshot(nowMs, this.liveSourceAvailable);
    if (this.activitySourceAvailable) this.lastConfirmedSessions = sessions;
    return this.lastConfirmedSessions;
  }

  /** Unknown activity is not an empty, successfully observed session list. */
  public isActivitySourceAvailable(): boolean {
    return this.activitySourceAvailable;
  }

  /** Light shared 5s tail: no directory walk, history read, or app-server request. */
  public getLiveTokens(nowMs = Date.now()): LiveTokenSnapshot {
    if (nowMs < this.lastLiveReadAtMs || nowMs - this.lastLiveReadAtMs >= LIVE_TOKEN_READ_INTERVAL_MS) {
      this.lastLiveReadAtMs = nowMs;
      for (const filePath of this.livePaths) {
        const cached = this.cache.get(filePath);
        if (!cached) { this.livePaths.delete(filePath); continue; }
        const lastActivity = cached.live.latestRecordAtMs ?? cached.mtimeMs;
        // Keep recently completed chats and subagents long enough to collect final reports.
        if (lastActivity < nowMs - Math.max(this.activeWindowMs, 300_000)) {
          this.livePaths.delete(filePath);
          continue;
        }
        this.readActiveSession(filePath, cached.mtimeMs, nowMs);
      }
    }
    return this.liveTokens.snapshot(Math.max(nowMs, Date.now()), this.liveSourceAvailable);
  }

  private readActiveSession(
    filePath: string,
    mtimeMs: number,
    nowMs: number
  ): ActiveSession | null {
    let cached = this.cache.get(filePath);
    if (!cached) {
      const sessionId = extractSessionId(filePath);
      if (!sessionId) return null;
      cached = { reader: new IncrementalSessionLog(), state: createActiveSessionState(), sessionId,
        live: createLiveTokenFileState(sessionId, this.initialScan), mtimeMs };
      this.cache.set(filePath, cached);
    }
    cached.mtimeMs = mtimeMs;

    const entry = cached;
    const previousState = entry.state;
    let nextState = previousState;
    try {
      entry.reader.read(
        filePath,
        (line) => {
          // Usage includes subagents, even though top-level activity excludes them.
          let record: Record<string, unknown> | null = null;
          try { record = asRecord(JSON.parse(line)); } catch { /* Incomplete/malformed record. */ }
          // A directory scan/large first read can outlast the timestamp captured
          // by its caller. Never discard a report appended during that read.
          if (record) this.liveTokens.consume(entry.live, record, Math.max(nowMs, Date.now()));
          if (nextState === previousState) nextState = { ...previousState, terminalTurnIds: new Set(previousState.terminalTurnIds) };
          consumeActiveSessionLine(nextState, line, record);
        },
        () => { nextState = createActiveSessionState(); this.liveTokens.resetFile(entry.live); }
      );
      entry.state = nextState;
      this.liveTokens.finishFile(entry.live);
      if ((entry.live.latestRecordAtMs ?? mtimeMs) >= nowMs - Math.max(this.activeWindowMs, 300_000)) {
        this.livePaths.add(filePath);
      }
    } catch {
      // The reader invalidates its offset on failure, so a transient read error
      // is retried from a clean state on the next poll.
      const lastActivity = entry.live.latestRecordAtMs ?? mtimeMs;
      this.activitySourceAvailable = false;
      if (this.livePaths.has(filePath) || lastActivity >= nowMs - Math.max(this.activeWindowMs, 300_000)) {
        this.liveTokens.markUnavailable(nowMs);
      }
      return null;
    }

    return activeSessionFromState(entry.state, {
      sessionId: entry.sessionId,
      updatedAt: new Date(mtimeMs).toISOString(),
      nowMs,
      activeWindowMs: this.activeWindowMs
    });
  }
}

export function parseActiveSessionFile(args: {
  sessionId: string;
  fileContent: string;
  updatedAt: string;
  nowMs: number;
  activeWindowMs: number;
}): ActiveSession | null {
  const state = createActiveSessionState();
  for (const rawLine of args.fileContent.split(/\r?\n/)) {
    consumeActiveSessionLine(state, rawLine);
  }
  return activeSessionFromState(state, args);
}

function createActiveSessionState(): ActiveSessionState {
  return {
    hasSessionMeta: false,
    subagent: false,
    latestTurnId: null,
    latestTurnStartedAt: null,
    terminalTurnIds: new Set(),
    name: null,
    cwd: null,
    latestUserInput: null,
    latestTimestamp: null
  };
}

function consumeActiveSessionLine(state: ActiveSessionState, rawLine: string, knownRecord?: Record<string, unknown> | null): void {
  if (!rawLine.trim() || state.subagent) return;
  let parsed: unknown;
  try {
    parsed = knownRecord === undefined ? JSON.parse(rawLine) : knownRecord;
  } catch {
    return;
  }

  const record = asRecord(parsed);
  if (!record) return;
  const recordType = asString(record.type);
  const payload = asRecord(record.payload);
  const timestamp = asString(record.timestamp);
  if (timestamp && Number.isFinite(Date.parse(timestamp)) &&
      (!state.latestTimestamp || Date.parse(timestamp) > Date.parse(state.latestTimestamp))) state.latestTimestamp = timestamp;

  if (recordType === "session_meta") {
    // Later metadata can be inherited from an ancestor. The first header owns
    // this file's identity, including whether it is an internal subagent.
    if (!state.hasSessionMeta) {
      state.hasSessionMeta = true;
      state.subagent = Boolean(asRecord(payload?.source)?.subagent || asRecord(payload?.source)?.subAgent ||
        asString(payload?.source)?.startsWith("subAgent"));
      state.name = asString(payload?.name);
      state.cwd = asString(payload?.cwd);
    }
    return;
  }

  if (recordType === "turn_context") {
    state.cwd = asString(payload?.cwd) ?? state.cwd;
    return;
  }

  if (recordType === "response_item") {
    if (asString(payload?.type) === "message" && asString(payload?.role) === "user") {
      state.latestUserInput = (payload ? extractUserPreview(payload) : null) ?? state.latestUserInput;
    }
    return;
  }

  if (recordType !== "event_msg") return;

  const payloadType = asString(payload?.type);
  if (payloadType === "user_message") state.latestUserInput = userPreview(asString(payload?.message)) ?? state.latestUserInput;
  const turnId = asString(payload?.turn_id) ?? asString(payload?.turnId);
  if (payloadType === "task_started" && turnId) {
    state.latestTurnId = turnId;
    state.latestTurnStartedAt = timestamp ?? state.latestTurnStartedAt;
    return;
  }

  if ((payloadType === "task_complete" || payloadType === "turn_aborted") && turnId) {
    state.terminalTurnIds.add(turnId);
  }
}

function activeSessionFromState(state: ActiveSessionState, args: {
  sessionId: string;
  updatedAt: string;
  nowMs: number;
  activeWindowMs: number;
}): ActiveSession | null {
  if (state.subagent || !state.latestTurnId || state.terminalTurnIds.has(state.latestTurnId)) {
    return null;
  }

  const updatedAt = state.latestTimestamp ?? args.updatedAt;
  const updatedAtMs = Date.parse(updatedAt);
  if (
    Number.isFinite(updatedAtMs) &&
    args.nowMs - updatedAtMs > args.activeWindowMs
  ) {
    return null;
  }

  return {
    id: args.sessionId,
    name: state.name,
    preview: state.latestUserInput,
    cwd: state.cwd,
    createdAt: null,
    updatedAt,
    lastTurnStartedAt: state.latestTurnStartedAt
  };
}

function extractUserPreview(payload: Record<string, unknown>): string | null {
  const content = payload.content;
  if (!Array.isArray(content)) {
    return null;
  }

  const pieces = content
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => Boolean(entry))
    .filter((entry) => asString(entry.type) === "input_text")
    .map((entry) => asString(entry.text))
    .filter((entry): entry is string => Boolean(entry));

  return userPreview(pieces.join("\n\n"));
}

function resolveCodexSessionsRoot(): string {
  const codexHome =
    process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  return path.join(codexHome, "sessions");
}

function listSessionFiles(root: string, onReadError?: () => void): Array<{ path: string; mtimeMs: number; size: number }> {
  if (!existsSync(root)) {
    onReadError?.();
    return [];
  }

  const results: Array<{ path: string; mtimeMs: number; size: number }> = [];
  walkDirectory(root, results, onReadError);
  return results.sort((left, right) => right.mtimeMs - left.mtimeMs);
}

function walkDirectory(
  directory: string,
  results: Array<{ path: string; mtimeMs: number; size: number }>,
  onReadError?: () => void
): void {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true, encoding: "utf8" });
  } catch {
    onReadError?.();
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      // Files live below date directories; a partial listing cannot establish
      // deletion or the absence of active tasks.
      walkDirectory(fullPath, results, onReadError);
      continue;
    }

    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
      continue;
    }

    try {
      const stat = statSync(fullPath);
      results.push({
        path: fullPath,
        mtimeMs: stat.mtimeMs,
        size: stat.size
      });
    } catch {
      onReadError?.();
      continue;
    }
  }
}

function extractSessionId(filePath: string): string | null {
  const match = path.basename(filePath).match(
    /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i
  );
  return match?.[1] ?? null;
}
