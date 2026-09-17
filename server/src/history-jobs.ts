import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  HISTORY_JOB_SORT_KEYS,
  SOURCE_KINDS,
  type HistoryJob,
  type HistoryJobListResponse,
  type HistoryJobSortKey,
  type HistoryUsageAllocation,
  type SourceKind,
  type SortDirection,
  type TokenUsage
} from "../../shared/monitor";
import { asRecord, asString, cloneValue, toIsoDate } from "./utils";
import { userPreview } from "../../shared/session-preview";
import { QuotaAttribution } from "./quota-attribution";

type SessionFile = {
  path: string;
  mtimeMs: number;
  size: number;
};

type CachedHistoryJob = {
  mtimeMs: number;
  size: number;
  parsedAtMs: number;
  usageWindowStartedAtMs: number | null;
  job: ParsedHistoryJob | null;
};

type ParsedHistoryJob = HistoryJob & {
  parentThreadId: string | null;
  isSubagent: boolean;
};

export type HistoryJobMetadata = Partial<
  Pick<
    HistoryJob,
    | "name"
    | "preview"
    | "sourceKind"
    | "createdAt"
    | "updatedAt"
    | "cwd"
    | "modelProvider"
  >
>;

type ParsedTurn = {
  id: string;
  startedAtMs: number | null;
  completedAtMs: number | null;
  durationMs: number | null;
};

type ModelPricing = {
  input: number;
  cachedInput: number;
  cacheWriteInput: number;
  output: number;
};

type UsageWindow = {
  usedPercent: number;
  startedAtMs: number;
  resetsAt: string;
  limitName: string;
  windowLabel: string;
};

const ROLLING_USAGE_WINDOW_MS = 24 * 60 * 60 * 1000;

// Standard API prices in USD per million tokens, verified 2026-09-06.
// This is an API-equivalent estimate: ChatGPT plan usage is not billed this way.
const MODEL_PRICING: Record<string, ModelPricing> = {
  "gpt-6-astra": { input: 10, cachedInput: 1, cacheWriteInput: 12.5, output: 50 },
  "gpt-5.6": { input: 4, cachedInput: 0.4, cacheWriteInput: 5, output: 20 },
  "gpt-5.6-sol": { input: 4, cachedInput: 0.4, cacheWriteInput: 5, output: 20 },
  "gpt-5.6-terra": { input: 2, cachedInput: 0.2, cacheWriteInput: 2.5, output: 12 },
  "gpt-5.6-luna": { input: 0.2, cachedInput: 0.02, cacheWriteInput: 0.25, output: 1.2 },
  "gpt-5.5": { input: 5, cachedInput: 0.5, cacheWriteInput: 6.25, output: 30 },
  "gpt-5.4-mini": { input: 0.75, cachedInput: 0.075, cacheWriteInput: 0.9375, output: 4.5 },
  "gpt-5.3-codex": { input: 1.75, cachedInput: 0.175, cacheWriteInput: 2.1875, output: 14 },
  "gpt-5.2-codex": { input: 1.75, cachedInput: 0.175, cacheWriteInput: 2.1875, output: 14 },
  "gpt-5-codex": { input: 1.25, cachedInput: 0.125, cacheWriteInput: 1.5625, output: 10 }
};

const ACTIVE_OPEN_TURN_WINDOW_MS = 15 * 60 * 1000;

export class HistoryJobReader {
  private readonly cache = new Map<string, CachedHistoryJob>();
  private readonly attribution: QuotaAttribution;

  public constructor(private readonly sessionsRoot = resolveCodexSessionsRoot(), ledgerFile?: string) {
    this.attribution = new QuotaAttribution(ledgerFile);
  }

  public listJobs(args: {
    cursor?: string | null;
    limit?: number | null;
    sourceKinds?: string[] | null;
    searchTerm?: string | null;
    sortKey?: string | null;
    sortDirection?: string | null;
    metadataById?: Map<string, HistoryJobMetadata> | null;
    nowMs?: number;
    usageWindow?: UsageWindow | null;
    observeUsage?: boolean;
  }): HistoryJobListResponse {
    const nowMs = args.nowMs ?? Date.now();
    const indexedNames = readSessionNames(path.join(this.sessionsRoot, "..", "session_index.jsonl"));
    const sessionFiles = listSessionFiles(this.sessionsRoot);
    const activePaths = new Set(sessionFiles.map((file) => file.path));

    for (const cachedPath of this.cache.keys()) {
      if (!activePaths.has(cachedPath)) {
        this.cache.delete(cachedPath);
      }
    }

    const sourceKindSet =
      args.sourceKinds && args.sourceKinds.length > 0
        ? new Set(args.sourceKinds)
        : null;
    const searchTerm = args.searchTerm?.trim().toLocaleLowerCase() ?? "";
    const offset = Math.max(0, Number.parseInt(args.cursor ?? "0", 10) || 0);
    const limit = clampInteger(args.limit ?? 20, 1, 100);
    const sortKey = normalizeSortKey(args.sortKey);
    const sortDirection = normalizeSortDirection(args.sortDirection);

    const parsedJobs = sessionFiles
      .map((file) =>
        this.readJob(file, nowMs, args.usageWindow?.startedAtMs ?? null)
      )
      .filter((job): job is ParsedHistoryJob => Boolean(job));
    const consolidated = consolidateSubagentUsage(mergeJobsByTask(parsedJobs));
    const window = args.usageWindow;
    const key = window ? JSON.stringify([window.limitName, window.windowLabel, window.startedAtMs, window.resetsAt]) : '';
    if (window && args.observeUsage) {
      this.attribution.observe(key, window.usedPercent, consolidated.map(job => ({
        id: job.id, cost: job.sinceResetEstimatedCostUsd ?? 0,
        tokens: job.sinceResetUsage?.totalTokens ?? 0, unpriced: job.sinceResetUnpricedTokens ?? 0
      })), nowMs);
    }
    const ledger = this.attribution.read(key);
    const allJobs = consolidated.map(job => ({ ...job,
      estimatedUsagePercentSinceReset: ledger ? ledger.attributed[job.id] ?? 0 : null
    }));
    const jobs = allJobs
      .map((job) => applyMetadata({ ...job, name: indexedNames.get(job.id) ?? job.name }, args.metadataById?.get(job.id)))
      .filter((job) => !sourceKindSet || sourceKindSet.has(job.sourceKind))
      .filter((job) => matchesSearch(job, searchTerm))
      .sort((left, right) =>
        compareHistoryJobs(left, right, sortKey, sortDirection)
      );

    return {
      data: jobs.slice(offset, offset + limit),
      total: jobs.length,
      nextCursor: offset + limit < jobs.length ? String(offset + limit) : null,
      usageAllocation: {
        ...usageAllocationSummary(args.usageWindow ?? null, allJobs),
        status: ledger ? 'available' : 'unavailable',
        observedSince: ledger?.observedAt ?? null,
        unattributedPercent: ledger?.unattributed ?? window?.usedPercent ?? null
      }
    };
  }

  private readJob(
    file: SessionFile,
    nowMs: number,
    usageWindowStartedAtMs: number | null
  ): ParsedHistoryJob | null {
    const cached = this.cache.get(file.path);
    if (
      cached &&
      cached.mtimeMs === file.mtimeMs &&
      cached.size === file.size &&
      cached.usageWindowStartedAtMs === usageWindowStartedAtMs &&
      (isRollingUsageStable(cached.job, nowMs) ||
        nowMs - cached.parsedAtMs < 60_000) &&
      !hasRecentOpenTurn(cached.job, nowMs)
    ) {
      return cloneValue(cached.job);
    }

    let fileContent = "";
    try {
      fileContent = readFileSync(file.path, "utf8");
    } catch {
      this.cache.set(file.path, {
        mtimeMs: file.mtimeMs,
        size: file.size,
        parsedAtMs: nowMs,
        usageWindowStartedAtMs,
        job: null
      });
      return null;
    }

    const job = parseHistorySessionFile({
      sessionId: extractSessionId(file.path),
      fileContent,
      updatedAt: new Date(file.mtimeMs).toISOString(),
      nowMs,
      usageWindowStartedAtMs
    });

    this.cache.set(file.path, {
      mtimeMs: file.mtimeMs,
      size: file.size,
      parsedAtMs: nowMs,
      usageWindowStartedAtMs,
      job
    });
    return cloneValue(job);
  }
}

// The desktop index also names tasks omitted by thread/list, such as archived tasks.
function readSessionNames(indexPath: string): Map<string, string> {
  const names = new Map<string, string>();
  try {
    for (const line of readFileSync(indexPath, "utf8").split(/\r?\n/)) {
      try {
        const entry = asRecord(JSON.parse(line));
        const id = asString(entry?.id);
        const name = asString(entry?.thread_name);
        if (id && name?.trim()) names.set(id, name);
      } catch { /* An appended final line may still be incomplete. */ }
    }
  } catch { /* The index is optional on older installations. */ }
  return names;
}

function mergeJobsByTask(jobs: ParsedHistoryJob[]): ParsedHistoryJob[] {
  const merged = new Map<string, ParsedHistoryJob>();

  for (const job of jobs) {
    const existing = merged.get(job.id);
    if (!existing) {
      merged.set(job.id, job);
      continue;
    }

    const newer = job.updatedAt > existing.updatedAt ? job : existing;
    const older = newer === job ? existing : job;
    const newerLastRun =
      (dateValue(job.lastRunStartedAt) ?? Number.NEGATIVE_INFINITY) >
      (dateValue(existing.lastRunStartedAt) ?? Number.NEGATIVE_INFINITY)
        ? job
        : existing;
    const hasUnpricedRecentUsage =
      (Boolean(existing.last24HoursUsage) &&
        existing.last24HoursEstimatedCostUsd === null) ||
      (Boolean(job.last24HoursUsage) &&
        job.last24HoursEstimatedCostUsd === null);
    merged.set(job.id, {
      ...newer,
      parentThreadId: newer.parentThreadId ?? older.parentThreadId,
      isSubagent: newer.isSubagent || older.isSubagent,
      name: newer.name ?? older.name,
      preview: newer.preview ?? older.preview,
      createdAt: earliestIso(existing.createdAt, job.createdAt),
      runCount: existing.runCount + job.runCount,
      lastRunStartedAt: newerLastRun.lastRunStartedAt,
      lastRunCompletedAt: newerLastRun.lastRunCompletedAt,
      lastRunDurationMs: newerLastRun.lastRunDurationMs,
      lastRunUsage: newerLastRun.lastRunUsage,
      totalDurationMs: existing.totalDurationMs + job.totalDurationMs,
      totalUsage: addNullableTokenUsage(existing.totalUsage, job.totalUsage),
      totalEstimatedCostUsd: addNullableNumbers(
        existing.totalEstimatedCostUsd,
        job.totalEstimatedCostUsd
      ),
      totalEstimatedCostIsComplete:
        (!existing.totalUsage || existing.totalEstimatedCostIsComplete) &&
        (!job.totalUsage || job.totalEstimatedCostIsComplete),
      last24HoursUsage: addNullableTokenUsage(
        existing.last24HoursUsage,
        job.last24HoursUsage
      ),
      last24HoursEstimatedCostUsd: hasUnpricedRecentUsage
        ? null
        : addNullableNumbers(
            existing.last24HoursEstimatedCostUsd,
            job.last24HoursEstimatedCostUsd
          ),
      sinceResetUsage: addNullableTokenUsage(
        existing.sinceResetUsage,
        job.sinceResetUsage
      ),
      sinceResetEstimatedCostUsd: addNullableNumbers(
        existing.sinceResetEstimatedCostUsd,
        job.sinceResetEstimatedCostUsd
      ),
      estimatedUsagePercentSinceReset: null,
      sinceResetUnpricedTokens: (existing.sinceResetUnpricedTokens ?? 0) + (job.sinceResetUnpricedTokens ?? 0)
    });
  }

  return [...merged.values()];
}

function consolidateSubagentUsage(jobs: ParsedHistoryJob[]): ParsedHistoryJob[] {
  const jobsById = new Map<string, ParsedHistoryJob>(
    jobs.map((job): [string, ParsedHistoryJob] => [job.id, { ...job }])
  );
  const consolidatedIds = new Set<string>();

  for (const job of jobs) {
    if (!job.isSubagent || !job.parentThreadId) {
      continue;
    }

    const principal = findPrincipalAncestor(job, jobsById);
    if (!principal) {
      continue;
    }

    const target = jobsById.get(principal.id);
    if (!target) {
      continue;
    }

    target.updatedAt = latestIso(target.updatedAt, job.updatedAt);
    target.totalEstimatedCostUsd = addNullableNumbers(
      target.totalEstimatedCostUsd,
      job.totalEstimatedCostUsd
    );
    target.totalEstimatedCostIsComplete =
      (!target.totalUsage || target.totalEstimatedCostIsComplete) &&
      (!job.totalUsage || job.totalEstimatedCostIsComplete);
    target.totalUsage = addNullableTokenUsage(target.totalUsage, job.totalUsage);
    target.last24HoursEstimatedCostUsd = addEstimatedCosts(
      target.last24HoursUsage,
      target.last24HoursEstimatedCostUsd,
      job.last24HoursUsage,
      job.last24HoursEstimatedCostUsd
    );
    target.last24HoursUsage = addNullableTokenUsage(
      target.last24HoursUsage,
      job.last24HoursUsage
    );
    target.sinceResetEstimatedCostUsd = addNullableNumbers(
      target.sinceResetEstimatedCostUsd,
      job.sinceResetEstimatedCostUsd
    );
    target.sinceResetUsage = addNullableTokenUsage(
      target.sinceResetUsage,
      job.sinceResetUsage
    );
    target.sinceResetUnpricedTokens = (target.sinceResetUnpricedTokens ?? 0) + (job.sinceResetUnpricedTokens ?? 0);
    consolidatedIds.add(job.id);
  }

  return [...jobsById.values()].filter(
    (job) => !job.isSubagent && !consolidatedIds.has(job.id)
  );
}

function findPrincipalAncestor(
  job: ParsedHistoryJob,
  jobsById: Map<string, ParsedHistoryJob>
): ParsedHistoryJob | null {
  const visited = new Set([job.id]);
  let current = job;

  while (current.parentThreadId) {
    if (visited.has(current.parentThreadId)) {
      return null;
    }
    visited.add(current.parentThreadId);

    const parent = jobsById.get(current.parentThreadId);
    if (!parent) {
      return null;
    }
    if (!parent.isSubagent) {
      return parent;
    }
    current = parent;
  }

  return null;
}

function isSubagentSource(sourceKind: SourceKind | "unknown"): boolean {
  return sourceKind.startsWith("subAgent");
}

function usageAllocationSummary(
  window: UsageWindow | null,
  jobs: HistoryJob[]
): HistoryUsageAllocation {
  if (!window) {
    return {
      status: "unavailable",
      usedPercent: null,
      windowStartedAt: null,
      resetsAt: null,
      limitName: null,
      windowLabel: null,
      basis: null
    };
  }

  const hasUsage = jobs.some((job) => (job.sinceResetUsage?.totalTokens ?? 0) > 0);
  return {
    status: "available",
    usedPercent: window.usedPercent,
    windowStartedAt: new Date(window.startedAtMs).toISOString(),
    resetsAt: window.resetsAt,
    limitName: window.limitName,
    windowLabel: window.windowLabel,
    basis: hasUsage ? usageAllocationBasis(jobs) : null
  };
}

function usageAllocationBasis(
  jobs: HistoryJob[]
): "apiEquivalentCost" | null {
  const jobsWithUsage = jobs.filter(
    (job) => (job.sinceResetUsage?.totalTokens ?? 0) > 0
  );
  return jobsWithUsage.length > 0 &&
    jobsWithUsage.every((job) => job.sinceResetEstimatedCostUsd !== null) &&
    jobsWithUsage.some((job) => (job.sinceResetEstimatedCostUsd ?? 0) > 0)
    ? "apiEquivalentCost"
    : null;
}

function applyMetadata(
  job: HistoryJob,
  metadata: HistoryJobMetadata | undefined
): HistoryJob {
  if (!metadata) {
    return job;
  }

  return {
    ...job,
    name: metadata.name ?? job.name,
    preview: userPreview(metadata.preview) ?? job.preview,
    sourceKind: metadata.sourceKind ?? job.sourceKind,
    createdAt: metadata.createdAt ?? job.createdAt,
    updatedAt: metadata.updatedAt ? latestIso(metadata.updatedAt, job.updatedAt) : job.updatedAt,
    cwd: metadata.cwd ?? job.cwd,
    modelProvider: metadata.modelProvider ?? job.modelProvider
  };
}

export function parseHistorySessionFile(args: {
  sessionId: string | null;
  fileContent: string;
  updatedAt: string;
  nowMs: number;
  usageWindowStartedAtMs?: number | null;
}): ParsedHistoryJob | null {
  let sessionId = args.sessionId;
  let parentThreadId: string | null = null;
  let isSubagent = false;
  let name: string | null = null;
  let preview: string | null = null;
  let sourceKind: SourceKind | "unknown" = "unknown";
  let createdAtMs: number | null = null;
  let fallbackUpdatedAtMs = Date.parse(args.updatedAt);
  if (!Number.isFinite(fallbackUpdatedAtMs)) {
    fallbackUpdatedAtMs = args.nowMs;
  }
  let latestRecordTimestampMs: number | null = null;
  let cwd: string | null = null;
  let modelProvider: string | null = null;
  let lastRunUsage: TokenUsage | null = null;
  let totalUsage: TokenUsage | null = null;
  let totalEstimatedCostUsd = 0;
  let totalCostIsComplete = true;
  let hasPricedTotalUsage = false;
  let activeModel: string | null = null;
  let last24HoursUsage: TokenUsage | null = null;
  let last24HoursEstimatedCostUsd = 0;
  let last24HoursCostIsComplete = true;
  let sinceResetUsage: TokenUsage | null = null;
  let sinceResetEstimatedCostUsd = 0;
  let sinceResetUnpricedTokens = 0;
  let hasPricedSinceResetUsage = false;
  let latestTurnId: string | null = null;
  const turns = new Map<string, ParsedTurn>();

  for (const rawLine of args.fileContent.split(/\r?\n/)) {
    if (!rawLine.trim()) {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawLine);
    } catch {
      continue;
    }

    const record = asRecord(parsed);
    if (!record) {
      continue;
    }

    const recordTimestampMs = parseDateMs(record.timestamp);
    if (recordTimestampMs !== null) {
      latestRecordTimestampMs =
        latestRecordTimestampMs === null
          ? recordTimestampMs
          : Math.max(latestRecordTimestampMs, recordTimestampMs);
      createdAtMs =
        createdAtMs === null
          ? recordTimestampMs
          : Math.min(createdAtMs, recordTimestampMs);
    }

    const recordType = asString(record.type);
    const payload = asRecord(record.payload);

    if (recordType === "session_meta") {
      sessionId = asString(payload?.id) ?? sessionId;
      parentThreadId =
        asString(payload?.parent_thread_id) ??
        asString(payload?.parentThreadId) ??
        parentThreadId;
      name = asString(payload?.name) ?? name;
      cwd = asString(payload?.cwd) ?? cwd;
      modelProvider =
        asString(payload?.model_provider) ??
        asString(payload?.modelProvider) ??
        modelProvider;
      const sessionSourceKind =
        normalizeSourceKind(payload?.source) ??
        normalizeOriginator(payload?.originator);
      sourceKind = sessionSourceKind ?? sourceKind;
      isSubagent =
        isSubagent ||
        (sessionSourceKind !== null && isSubagentSource(sessionSourceKind));
      createdAtMs =
        parseDateMs(payload?.timestamp) ?? parseDateMs(record.timestamp) ?? createdAtMs;
      continue;
    }

    if (recordType === "turn_context") {
      cwd = asString(payload?.cwd) ?? cwd;
      modelProvider =
        asString(payload?.model_provider) ??
        asString(payload?.modelProvider) ??
        modelProvider;
      activeModel = asString(payload?.model) ?? activeModel;
      continue;
    }

    if (recordType === "response_item") {
      if (isUserMessage(payload)) {
        preview = extractUserPreview(payload) ?? preview;
      }
      continue;
    }

    if (recordType !== "event_msg") {
      continue;
    }

    const payloadType = asString(payload?.type);
    if (payloadType === "user_message") preview = userPreview(asString(payload?.message)) ?? preview;

    if (payloadType === "task_started") {
      const turnId = asString(payload?.turn_id) ?? asString(payload?.turnId);
      if (!turnId) {
        continue;
      }

      const turn = ensureTurn(turns, turnId);
      turn.startedAtMs = recordTimestampMs ?? turn.startedAtMs;
      latestTurnId = turnId;
      continue;
    }

    if (payloadType === "task_complete" || payloadType === "turn_aborted") {
      const turnId = asString(payload?.turn_id) ?? asString(payload?.turnId);
      if (!turnId) {
        continue;
      }

      const turn = ensureTurn(turns, turnId);
      turn.completedAtMs =
        parseDateMs(payload?.completed_at) ??
        parseDateMs(payload?.completedAt) ??
        recordTimestampMs ??
        turn.completedAtMs;
      turn.durationMs = asFiniteNumber(payload?.duration_ms) ?? turn.durationMs;
      latestTurnId = turnId;
      continue;
    }

    if (payloadType === "token_count") {
      const info = asRecord(payload?.info);
      const increment = normalizeTokenUsage(info?.last_token_usage);
      lastRunUsage = increment ?? lastRunUsage;

      if (increment) {
        totalUsage = addTokenUsage(totalUsage, increment);
        const estimatedCost = estimateApiEquivalentCost(increment, activeModel);
        if (estimatedCost === null) {
          totalCostIsComplete = false;
        } else {
          totalEstimatedCostUsd += estimatedCost;
          hasPricedTotalUsage = true;
        }
      }

      if (
        increment &&
        recordTimestampMs !== null &&
        recordTimestampMs >= args.nowMs - ROLLING_USAGE_WINDOW_MS
      ) {
        last24HoursUsage = addTokenUsage(last24HoursUsage, increment);
        const estimatedCost = estimateApiEquivalentCost(increment, activeModel);
        if (estimatedCost === null) {
          last24HoursCostIsComplete = false;
        } else {
          last24HoursEstimatedCostUsd += estimatedCost;
        }
      }

      if (
        increment &&
        args.usageWindowStartedAtMs !== null &&
        args.usageWindowStartedAtMs !== undefined &&
        recordTimestampMs !== null &&
        recordTimestampMs >= args.usageWindowStartedAtMs
      ) {
        sinceResetUsage = addTokenUsage(sinceResetUsage, increment);
        const estimatedCost = estimateApiEquivalentCost(increment, activeModel);
        if (estimatedCost !== null) {
          sinceResetEstimatedCostUsd += estimatedCost;
          hasPricedSinceResetUsage = true;
        } else sinceResetUnpricedTokens += increment.totalTokens;
      }
    }
  }

  if (!sessionId) {
    return null;
  }

  const sortedTurns = [...turns.values()].sort((left, right) => {
    return turnSortMs(left) - turnSortMs(right);
  });
  const latestTurn =
    (latestTurnId ? turns.get(latestTurnId) : null) ??
    sortedTurns[sortedTurns.length - 1] ??
    null;
  const activityUpdatedAtMs = latestRecordTimestampMs ?? fallbackUpdatedAtMs;
  const totalDurationMs = sortedTurns.reduce(
    (total, turn) =>
      total + (durationForTurn(turn, args.nowMs, activityUpdatedAtMs) ?? 0),
    0
  );

  return {
    id: sessionId,
    parentThreadId,
    isSubagent,
    name,
    preview,
    sourceKind,
    createdAt: createdAtMs === null ? null : new Date(createdAtMs).toISOString(),
    updatedAt: new Date(activityUpdatedAtMs).toISOString(),
    cwd,
    modelProvider,
    runCount: sortedTurns.length,
    lastRunStartedAt:
      latestTurn?.startedAtMs === null || latestTurn?.startedAtMs === undefined
        ? null
        : new Date(latestTurn.startedAtMs).toISOString(),
    lastRunCompletedAt:
      latestTurn?.completedAtMs === null || latestTurn?.completedAtMs === undefined
        ? null
        : new Date(latestTurn.completedAtMs).toISOString(),
    lastRunDurationMs: latestTurn
      ? durationForTurn(latestTurn, args.nowMs, activityUpdatedAtMs)
      : null,
    totalDurationMs,
    lastRunUsage,
    totalUsage,
    totalEstimatedCostUsd:
      totalUsage && hasPricedTotalUsage ? totalEstimatedCostUsd : null,
    totalEstimatedCostIsComplete: Boolean(totalUsage) && totalCostIsComplete,
    last24HoursUsage,
    last24HoursEstimatedCostUsd:
      last24HoursUsage && last24HoursCostIsComplete
        ? last24HoursEstimatedCostUsd
        : null,
    sinceResetUsage,
    sinceResetUnpricedTokens,
    sinceResetEstimatedCostUsd:
      sinceResetUsage && hasPricedSinceResetUsage
        ? sinceResetEstimatedCostUsd
        : null,
    estimatedUsagePercentSinceReset: null
  };
}

export function resolveCodexSessionsRoot(options?: {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}): string {
  const env = options?.env ?? process.env;
  const homeDir = options?.homeDir ?? os.homedir();
  const codexHome = env.CODEX_HOME ?? path.join(homeDir, ".codex");
  return path.join(codexHome, "sessions");
}

function listSessionFiles(root: string): SessionFile[] {
  if (!existsSync(root)) {
    return [];
  }

  const results: SessionFile[] = [];
  walkDirectory(root, results);
  return results.sort((left, right) => right.mtimeMs - left.mtimeMs);
}

function walkDirectory(directory: string, results: SessionFile[]): void {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      walkDirectory(fullPath, results);
      continue;
    }

    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
      continue;
    }

    try {
      const stats = statSync(fullPath);
      results.push({
        path: fullPath,
        mtimeMs: stats.mtimeMs,
        size: stats.size
      });
    } catch {
      continue;
    }
  }
}

function ensureTurn(turns: Map<string, ParsedTurn>, turnId: string): ParsedTurn {
  const existing = turns.get(turnId);
  if (existing) {
    return existing;
  }

  const turn: ParsedTurn = {
    id: turnId,
    startedAtMs: null,
    completedAtMs: null,
    durationMs: null
  };
  turns.set(turnId, turn);
  return turn;
}

function durationForTurn(
  turn: ParsedTurn,
  nowMs: number,
  sessionUpdatedAtMs: number
): number | null {
  if (turn.durationMs !== null) {
    return Math.max(0, turn.durationMs);
  }

  if (turn.startedAtMs === null) {
    return null;
  }

  const openTurnEndMs =
    nowMs - sessionUpdatedAtMs <= ACTIVE_OPEN_TURN_WINDOW_MS
      ? nowMs
      : sessionUpdatedAtMs;
  const endMs = turn.completedAtMs ?? openTurnEndMs;
  return Math.max(0, endMs - turn.startedAtMs);
}

function hasRecentOpenTurn(job: HistoryJob | null, nowMs: number): boolean {
  if (!job || job.lastRunCompletedAt || !job.lastRunStartedAt) {
    return false;
  }

  const updatedAtMs = Date.parse(job.updatedAt);
  return Number.isFinite(updatedAtMs)
    ? nowMs - updatedAtMs <= ACTIVE_OPEN_TURN_WINDOW_MS
    : false;
}

function isRollingUsageStable(job: HistoryJob | null, nowMs: number): boolean {
  if (!job) {
    return true;
  }

  const updatedAtMs = Date.parse(job.updatedAt);
  return (
    Number.isFinite(updatedAtMs) &&
    updatedAtMs < nowMs - ROLLING_USAGE_WINDOW_MS
  );
}

function turnSortMs(turn: ParsedTurn): number {
  return turn.startedAtMs ?? turn.completedAtMs ?? 0;
}

function matchesSearch(job: HistoryJob, searchTerm: string): boolean {
  if (!searchTerm) {
    return true;
  }

  return [job.name, job.preview, job.cwd, job.id, job.modelProvider]
    .filter((entry): entry is string => Boolean(entry))
    .some((entry) => entry.toLocaleLowerCase().includes(searchTerm));
}

function compareHistoryJobs(
  left: HistoryJob,
  right: HistoryJob,
  sortKey: HistoryJobSortKey,
  sortDirection: SortDirection
): number {
  const primary = compareNullableNumbers(
    sortValue(left, sortKey),
    sortValue(right, sortKey),
    sortDirection
  );

  if (primary !== 0) {
    return primary;
  }

  const byUpdatedAt = right.updatedAt.localeCompare(left.updatedAt);
  if (byUpdatedAt !== 0) {
    return byUpdatedAt;
  }

  return left.id.localeCompare(right.id);
}

function sortValue(job: HistoryJob, sortKey: HistoryJobSortKey): number | null {
  switch (sortKey) {
    case "createdAt":
      return dateValue(job.createdAt);
    case "lastRunDurationMs":
      return job.lastRunDurationMs;
    case "totalDurationMs":
      return job.totalDurationMs;
    case "lastRunTokens":
      return job.lastRunUsage?.totalTokens ?? null;
    case "totalTokens":
      return job.totalUsage?.totalTokens ?? null;
    case "estimatedTotalCostUsd":
      return job.totalEstimatedCostUsd;
    case "last24HoursTokens":
      return job.last24HoursUsage?.totalTokens ?? null;
    case "last24HoursCostUsd":
      return job.last24HoursEstimatedCostUsd;
    case "estimatedUsagePercentSinceReset":
      return job.estimatedUsagePercentSinceReset;
    case "runCount":
      return job.runCount;
    case "updatedAt":
    default:
      return dateValue(job.updatedAt);
  }
}

function compareNullableNumbers(
  left: number | null,
  right: number | null,
  sortDirection: SortDirection
): number {
  if (left === null && right === null) {
    return 0;
  }

  if (left === null) {
    return 1;
  }

  if (right === null) {
    return -1;
  }

  return sortDirection === "asc" ? left - right : right - left;
}

function dateValue(value: string | null): number | null {
  if (!value) {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function earliestIso(left: string | null, right: string | null): string | null {
  if (!left) return right;
  if (!right) return left;
  return left < right ? left : right;
}

function latestIso(left: string, right: string): string {
  return left > right ? left : right;
}

function addNullableNumbers(
  left: number | null,
  right: number | null
): number | null {
  if (left === null && right === null) return null;
  return (left ?? 0) + (right ?? 0);
}

function addEstimatedCosts(
  leftUsage: TokenUsage | null,
  leftCost: number | null,
  rightUsage: TokenUsage | null,
  rightCost: number | null
): number | null {
  if ((leftUsage && leftCost === null) || (rightUsage && rightCost === null)) {
    return null;
  }
  return addNullableNumbers(leftCost, rightCost);
}

function addNullableTokenUsage(
  left: TokenUsage | null,
  right: TokenUsage | null
): TokenUsage | null {
  if (!left) return right;
  if (!right) return left;
  return addTokenUsage(left, right);
}

function isUserMessage(payload: Record<string, unknown> | null): boolean {
  return asString(payload?.type) === "message" && asString(payload?.role) === "user";
}

function extractUserPreview(payload: Record<string, unknown> | null): string | null {
  const content = payload?.content;
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

function normalizeTokenUsage(value: unknown): TokenUsage | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const inputTokens = asFiniteNumber(record.input_tokens) ?? 0;
  const cachedInputTokens = asFiniteNumber(record.cached_input_tokens) ?? 0;
  const cacheWriteInputTokens = asFiniteNumber(record.cache_write_input_tokens) ?? 0;
  const outputTokens = asFiniteNumber(record.output_tokens) ?? 0;
  const reasoningOutputTokens = asFiniteNumber(record.reasoning_output_tokens) ?? 0;
  const totalTokens =
    asFiniteNumber(record.total_tokens) ?? inputTokens + outputTokens;

  return {
    inputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens
  };
}

function addTokenUsage(
  total: TokenUsage | null,
  increment: TokenUsage
): TokenUsage {
  return {
    inputTokens: (total?.inputTokens ?? 0) + increment.inputTokens,
    cachedInputTokens: (total?.cachedInputTokens ?? 0) + increment.cachedInputTokens,
    cacheWriteInputTokens:
      (total?.cacheWriteInputTokens ?? 0) + (increment.cacheWriteInputTokens ?? 0),
    outputTokens: (total?.outputTokens ?? 0) + increment.outputTokens,
    reasoningOutputTokens:
      (total?.reasoningOutputTokens ?? 0) + increment.reasoningOutputTokens,
    totalTokens: (total?.totalTokens ?? 0) + increment.totalTokens
  };
}

function estimateApiEquivalentCost(
  usage: TokenUsage,
  model: string | null
): number | null {
  const pricing = model ? MODEL_PRICING[model] : null;
  if (!pricing) {
    return null;
  }

  const highContext = usage.inputTokens > 272000;
  const inputMultiplier = highContext ? 2 : 1;
  const outputMultiplier = highContext ? 1.5 : 1;
  const cachedInput = Math.min(usage.cachedInputTokens, usage.inputTokens);
  const uncachedInput = Math.max(0, usage.inputTokens - cachedInput);

  return (
    (uncachedInput * pricing.input * inputMultiplier +
      cachedInput * pricing.cachedInput * inputMultiplier +
      (usage.cacheWriteInputTokens ?? 0) *
        pricing.cacheWriteInput *
        inputMultiplier +
      usage.outputTokens * pricing.output * outputMultiplier) /
    1_000_000
  );
}

function normalizeSourceKind(value: unknown): SourceKind | "unknown" | null {
  const asKind = sourceKindFromString(asString(value));
  if (asKind) {
    return asKind;
  }

  const record = asRecord(value);
  if (!record) {
    return null;
  }

  if (record.cli) {
    return "cli";
  }

  if (record.vscode) {
    return "vscode";
  }

  if (record.exec) {
    return "exec";
  }

  if (record.appServer || record.app_server || record.app) {
    return "appServer";
  }

  const subagent = asRecord(record.subagent) ?? asRecord(record.subAgent);
  if (subagent) {
    if (subagent.review) {
      return "subAgentReview";
    }
    if (subagent.compact) {
      return "subAgentCompact";
    }
    if (subagent.threadSpawn || subagent.thread_spawn) {
      return "subAgentThreadSpawn";
    }
    return "subAgentOther";
  }

  return null;
}

function normalizeOriginator(value: unknown): SourceKind | "unknown" | null {
  const originator = asString(value)?.toLocaleLowerCase();
  if (!originator) {
    return null;
  }

  if (originator.includes("cli")) {
    return "cli";
  }

  if (originator.includes("vscode") || originator.includes("vs code")) {
    return "vscode";
  }

  if (originator.includes("desktop")) {
    return "appServer";
  }

  return null;
}

function sourceKindFromString(value: string | null): SourceKind | "unknown" | null {
  if (!value) {
    return null;
  }

  return (SOURCE_KINDS as readonly string[]).includes(value)
    ? (value as SourceKind)
    : null;
}

function normalizeSortKey(value: string | null | undefined): HistoryJobSortKey {
  return value && (HISTORY_JOB_SORT_KEYS as readonly string[]).includes(value)
    ? (value as HistoryJobSortKey)
    : "updatedAt";
}

function normalizeSortDirection(
  value: string | null | undefined
): SortDirection {
  return value === "asc" ? "asc" : "desc";
}

function parseDateMs(value: unknown): number | null {
  const isoValue = toIsoDate(value);
  if (!isoValue) {
    return null;
  }

  const parsed = Date.parse(isoValue);
  return Number.isFinite(parsed) ? parsed : null;
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }

  return Math.max(min, Math.min(max, Math.floor(value)));
}

function extractSessionId(filePath: string): string | null {
  const match = path.basename(filePath).match(
    /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i
  );
  return match?.[1] ?? null;
}
