import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import {
  HISTORY_JOB_SORT_KEYS,
  SOURCE_KINDS,
  type HistoryJob,
  type HistoryJobListResponse,
  type HistoryJobSortKey,
  type HistoryUsageAllocation,
  type HistoryArchiveMode,
  type HistoryPeriod,
  type HistoryUsageDay,
  type HistoryPeriodMetrics,
  type SourceKind,
  type SortDirection,
  type TokenUsage
} from "../../shared/monitor";
import { asRecord, asString, cloneValue, toIsoDate } from "./utils";
import { userPreview } from "../../shared/session-preview";
import { QuotaAttribution } from "./quota-attribution";
import { QuotaCalibration, equivalent20x, pro20xWeeklyLimit, type QuotaCalibrationEvent } from './quota-equivalent';
import { readArchiveMetadata, type ArchiveMetadata } from './archive-metadata';
import { readProjectResolver } from './project-metadata';
import { addUsage, localDay, mergeDays, periodStart } from '../../shared/usage-period';
import { IncrementalSessionLog } from './session-log-reader';

type SessionFile = {
  path: string;
  mtimeMs: number;
  size: number;
  ctimeMs: number;
  identity: string;
};

type CachedHistoryJob = {
  mtimeMs: number;
  size: number;
  parsedAtMs: number;
  usageWindowStartedAtMs: number | null;
  job: ParsedHistoryJob | null;
  ctimeMs?: number;
  identity?: string;
  compact?: CompactHistoryData;
};

type CompactHistoryData = {
  version: 1;
  records: string[];
  preview: string | null;
  activityMin: number | null;
  activityMax: number | null;
};

type ParsedHistoryJob = HistoryJob & {
  dailyUsage?: HistoryUsageDay[];
  quotaDailyUsage?: HistoryUsageDay[];
  untimedTokens?: number;
  totalUnpricedTokens?: number;
  quotaCalibrationEvents?: QuotaCalibrationEvent[];
  quotaCalibrationVersion?: 2;
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
const ARCHIVE_CACHE_VERSION = 2;

export class HistoryJobReader {
  private readonly cache = new Map<string, CachedHistoryJob>();
  private readonly attribution: QuotaAttribution;
  private readonly calibration: QuotaCalibration;
  private readonly archiveCacheFile: string | undefined;
  private archiveCacheDirty = false;
  private readonly identities = new Map<string, ArchiveMetadata>();
  private readonly incremental = new Map<string, { reader: IncrementalSessionLog; stats: CompactHistoryRecords }>();

  public constructor(
    private readonly sessionsRoot = resolveCodexSessionsRoot(),
    ledgerFile?: string,
    private readonly archivedRoot = path.join(sessionsRoot, '..', 'archived_sessions')
  ) {
    this.attribution = new QuotaAttribution(ledgerFile);
    this.calibration = new QuotaCalibration(ledgerFile ? path.join(path.dirname(ledgerFile), 'quota-calibration.json') : undefined);
    this.archiveCacheFile = ledgerFile ? path.join(path.dirname(ledgerFile), 'archived-history.json') : undefined;
    this.loadArchiveCache();
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
    archiveMode?: HistoryArchiveMode;
    period?: HistoryPeriod;
    forceRefresh?: boolean;
  }): HistoryJobListResponse {
    if (args.forceRefresh) {
      this.cache.clear();
      this.incremental.clear();
      this.identities.clear();
      this.archiveCacheDirty = true;
    }
    const nowMs = args.nowMs ?? Date.now();
    const period = args.period ?? 'quota';
    const indexedNames = readSessionNames(path.join(this.sessionsRoot, "..", "session_index.jsonl"));
    const archiveMetadata = readArchiveMetadata(path.join(this.sessionsRoot, '..'));
    const archiveMode = args.archiveMode === 'all' ? 'all' : 'recent';
    const projectFor = readProjectResolver(path.join(this.sessionsRoot, '..'));
    const activeFiles = listSessionFiles(this.sessionsRoot);
    // During an archive move both copies may briefly exist. Count that rollout once.
    const activeNames = new Set(activeFiles.map(file => path.basename(file.path)));
    const archiveFiles = listSessionFiles(this.archivedRoot)
      .filter(file => !activeNames.has(path.basename(file.path)));
    const archivedPaths = new Set(archiveFiles.map(file => file.path));
    const selection = this.selectArchives(activeFiles, archiveFiles, archiveMetadata, archiveMode);
    const sessionFiles = [...activeFiles, ...selection.files];
    // A narrower request must not evict cached summaries for the full-history view.
    const activePaths = new Set([...activeFiles, ...archiveFiles].map((file) => file.path));

    for (const cachedPath of this.cache.keys()) {
      if (!activePaths.has(cachedPath)) {
        this.cache.delete(cachedPath);
        this.incremental.delete(cachedPath);
        this.identities.delete(cachedPath);
        this.archiveCacheDirty = true;
      }
    }

    for (const file of this.incremental.keys()) if (!activePaths.has(file)) this.incremental.delete(file);
    for (const file of this.identities.keys()) if (!activePaths.has(file)) this.identities.delete(file);

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
      .map((file) => {
        const previous = this.cache.get(file.path);
        const job = this.readJob(file, nowMs, args.usageWindow?.startedAtMs ?? null);
        const archived = archivedPaths.has(file.path);
        const next = this.cache.get(file.path);
        if (archived && (previous?.compact !== next?.compact || previous?.mtimeMs !== next?.mtimeMs || previous?.size !== next?.size)) this.archiveCacheDirty = true;
        return job ? { ...job, archived } : null;
      })
      .filter((job): job is ParsedHistoryJob => Boolean(job));
    this.saveArchiveCache(archivedPaths);
    const consolidated = consolidateSubagentUsage(mergeJobsByTask(parsedJobs));
    const window = args.usageWindow;
    const weekEnd = Date.parse(window?.resetsAt ?? '');
    const weekly = window && weekEnd > nowMs && weekEnd - window.startedAtMs === 604800000;
    const calibration = this.calibration.resolve(parsedJobs.flatMap(job => job.quotaCalibrationEvents ?? []), weekly ? window.startedAtMs : null, nowMs);
    const key = window ? JSON.stringify([window.limitName, window.windowLabel, window.startedAtMs, window.resetsAt]) : '';
    if (window && args.observeUsage) {
      this.attribution.observe(key, window.usedPercent, consolidated.map(job => ({
        id: job.id, cost: job.sinceResetEstimatedCostUsd ?? 0,
        tokens: job.sinceResetUsage?.totalTokens ?? 0, unpriced: job.sinceResetUnpricedTokens ?? 0,
        historical: job.archived
      })), nowMs);
    }
    const ledger = this.attribution.read(key);
    const selectedDays = new Map<string, HistoryUsageDay[]>();
    const selectedStart = periodStart(period, nowMs, window?.startedAtMs ?? null);
    const allJobs = consolidated.map(({ quotaCalibrationEvents: _events, quotaCalibrationVersion: _calibrationVersion, dailyUsage, quotaDailyUsage, untimedTokens = 0, totalUnpricedTokens = 0, ...job }) => {
      const days = (period === 'quota' ? quotaDailyUsage ?? [] : dailyUsage ?? [])
        .filter(day => (!selectedStart || day.date >= localDay(selectedStart)) && day.date <= localDay(nowMs));
      selectedDays.set(job.id, days);
      const usage = period === 'lifetime' ? job.totalUsage : period === 'quota' ? job.sinceResetUsage
        : days.reduce<TokenUsage | null>((sum, day) => addUsage(sum, day.usage), null);
      const priced = days.filter(day => day.costUsd !== null);
      const cost = period === 'lifetime' ? job.totalEstimatedCostUsd : period === 'quota' ? job.sinceResetEstimatedCostUsd
        : priced.length ? priced.reduce((sum, day) => sum + day.costUsd!, 0) : null;
      const unpriced = period === 'lifetime' ? totalUnpricedTokens : period === 'quota' ? job.sinceResetUnpricedTokens ?? 0 : days.reduce((sum, day) => sum + day.unpricedTokens, 0);
      const available = period !== 'quota' || Boolean(window && weekEnd > nowMs);
      const emptyKnown = available && Boolean(job.totalUsage) && !usage && untimedTokens === 0;
      const periodMetrics: HistoryPeriodMetrics = {
        tokensComplete: available && Boolean(usage || emptyKnown) && (period === 'lifetime' || untimedTokens === 0),
        usage: available ? usage ?? (emptyKnown ? { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 } : null) : null,
        costUsd: available ? cost ?? (emptyKnown ? 0 : null) : null,
        costComplete: period === 'lifetime' ? job.totalEstimatedCostIsComplete : available && unpriced === 0 && untimedTokens === 0,
        unpricedTokens: unpriced, untimedTokens
      };
      const attributed = ledger?.attributed[job.id] ?? 0;
      return { ...job,
        periodMetrics,
        estimated20xPercent: available && periodMetrics.usage ? equivalent20x({ ...job, sinceResetUsage: periodMetrics.usage, sinceResetEstimatedCostUsd: periodMetrics.costUsd }, calibration.costPerPercent) : null,
        estimated20xIsComplete: periodMetrics.costComplete,
        estimatedUsagePercentSinceReset: !ledger ? null : attributed > 0 ? attributed :
          job.sinceResetUsage || !job.totalUsage ? null : 0
      };
    });
    const jobs = allJobs
      .map((job) => applyMetadata({ ...job, archivedAt: job.archived ? archiveMetadata.get(job.id)?.archivedAt ?? null : null,
        name: indexedNames.get(job.id) ?? job.name }, args.metadataById?.get(job.id)))
      .map(job => ({ ...job, project: projectFor(job) }))
      .filter((job) => !sourceKindSet || sourceKindSet.has(job.sourceKind))
      .filter((job) => matchesSearch(job, searchTerm))
      .sort((left, right) =>
        compareHistoryJobs(left, right, sortKey, sortDirection)
      );

    return {
      analysis: {
        period, startedAt: selectedStart === null ? null : new Date(selectedStart).toISOString(),
        endedAt: new Date(nowMs).toISOString(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        days: mergeDays(...jobs.map(job => selectedDays.get(job.id))),
        unpricedTokens: jobs.reduce((sum, job) => sum + (job.periodMetrics?.unpricedTokens ?? 0), 0),
        untimedTokens: jobs.reduce((sum, job) => sum + (job.periodMetrics?.untimedTokens ?? 0), 0)
      },
      data: jobs.slice(offset, offset + limit),
      total: jobs.length,
      nextCursor: offset + limit < jobs.length ? String(offset + limit) : null,
      archives: { mode: archiveMode, total: selection.total, included: allJobs.filter(job => job.archived).length },
      usageAllocation: {
        equivalent20x: { costPerPercentUsd: calibration.costPerPercent, calibrationQuotaPercent: calibration.quotaPercent,
          source: calibration.source, calibratedAt: calibration.calibratedAt, referenceQuotaPercent: calibration.referenceQuotaPercent },
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
    const unchanged = Boolean(cached?.compact && cached.mtimeMs === file.mtimeMs &&
      cached.size === file.size && cached.ctimeMs === file.ctimeMs && cached.identity === file.identity);
    if (unchanged && cached?.job?.quotaCalibrationVersion === 2 && cached.usageWindowStartedAtMs === usageWindowStartedAtMs &&
        (cached.parsedAtMs === nowMs || (isRollingUsageStable(cached.job, cached.parsedAtMs) &&
          nowMs >= cached.parsedAtMs && !hasRecentOpenTurn(cached.job, cached.parsedAtMs)))) {
      return cloneValue(cached.job);
    }

    try {
      let compact = cached?.compact;
      if (!unchanged) {
        let state = this.incremental.get(file.path);
        if (!state) {
          state = { reader: new IncrementalSessionLog(), stats: new CompactHistoryRecords() };
          this.incremental.set(file.path, state);
        }
        state.reader.read(file.path, line => state!.stats.consume(line), () => { state!.stats = new CompactHistoryRecords(); });
        // Detach persisted records from the mutable reader state. A later partial
        // read failure must not corrupt the last successfully cached summary.
        compact = state.stats.serialize();
      }
      if (!compact) return null;
      const stats = new CompactHistoryRecords(compact);
      const job = parseHistorySessionFile({
        sessionId: extractSessionId(file.path),
        fileContent: stats.lines(),
        updatedAt: new Date(file.mtimeMs).toISOString(),
        nowMs,
        usageWindowStartedAtMs
      });
      if (job) job.preview = compact.preview;
      this.cache.set(file.path, {
        mtimeMs: file.mtimeMs, size: file.size, ctimeMs: file.ctimeMs, identity: file.identity,
        parsedAtMs: nowMs, usageWindowStartedAtMs, job, compact
      });
      return cloneValue(job);
    } catch (error) {
      console.error(`Could not read Codex session ${file.path}:`, error instanceof Error ? error.message : String(error));
      this.incremental.get(file.path)?.reader.invalidate();
      return cached?.job ? cloneValue(cached.job) : null;
    }
  }

  private selectArchives(activeFiles: SessionFile[], archiveFiles: SessionFile[], metadata: Map<string, ArchiveMetadata>, mode: HistoryArchiveMode) {
    const identity = (file: SessionFile): ArchiveMetadata => {
      const fileId = extractSessionId(file.path);
      const indexed = fileId ? metadata.get(fileId) : undefined;
      if (indexed) return indexed;
      const cached = this.cache.get(file.path)?.job;
      if (cached) return { id: cached.id, parentThreadId: cached.parentThreadId, isSubagent: cached.isSubagent, archivedAt: null };
      const known = this.identities.get(file.path);
      if (known) return known;
      // Fallback for older Codex versions: inspect at most 64 KiB, never scan an
      // unselected archive's transcript merely to identify its parent.
      let header: Record<string, unknown> | null = null;
      let descriptor: number | undefined;
      try {
        descriptor = openSync(file.path, 'r');
        const buffer = Buffer.alloc(64 * 1024);
        const bytes = readSync(descriptor, buffer, 0, buffer.length, 0);
        header = asRecord(asRecord(JSON.parse(buffer.subarray(0, bytes).toString('utf8').split('\n')[0]))?.payload);
      } catch { /* File-name identity remains usable when the optional header is absent. */ }
      finally { if (descriptor !== undefined) closeSync(descriptor); }
      const subagent = asRecord(header?.source)?.subagent;
      const parent = header?.parent_thread_id ?? header?.parentThreadId ?? asRecord(asRecord(subagent)?.thread_spawn)?.parent_thread_id;
      const result = { id: typeof header?.id === 'string' ? header.id : fileId ?? file.path, archivedAt: null,
        parentThreadId: typeof parent === 'string' ? parent : null,
        isSubagent: Boolean(subagent) || (typeof header?.source === 'string' && /^subagent/i.test(header.source)) };
      this.identities.set(file.path, result);
      return result;
    };
    const activeIds = new Set(activeFiles.map(file => identity(file).id));
    const roots = new Map<string, { time: number; id: string }>();
    const identities = new Map<string, ArchiveMetadata>();
    for (const file of [...activeFiles, ...archiveFiles]) {
      const info = identity(file);
      identities.set(info.id, info);
      if (activeIds.has(info.id) || info.isSubagent) continue;
      const time = info.archivedAt ? Date.parse(info.archivedAt) : file.mtimeMs;
      const previous = roots.get(info.id);
      if (!previous || time > previous.time) roots.set(info.id, { id: info.id, time });
    }
    const recentRoots = [...roots.values()].sort((a, b) => b.time - a.time || a.id.localeCompare(b.id));
    const selectedIds = new Set([...activeIds, ...(mode === 'all' ? recentRoots : recentRoots.slice(0, 30)).map(entry => entry.id)]);
    const files = archiveFiles.filter(file => {
      let info = identity(file);
      const visited = new Set<string>();
      while (info.isSubagent && info.parentThreadId && !visited.has(info.id)) {
        visited.add(info.id);
        const parent = identities.get(info.parentThreadId);
        if (!parent) return false;
        info = parent;
      }
      return !info.isSubagent && selectedIds.has(info.id);
    });
    return { files, total: roots.size };
  }

  private loadArchiveCache(): void {
    if (!this.archiveCacheFile || !existsSync(this.archiveCacheFile)) return;
    try {
      const stored = JSON.parse(readFileSync(this.archiveCacheFile, 'utf8'));
      // Bump the version whenever the parser or model pricing changes.
      if (stored.version !== ARCHIVE_CACHE_VERSION || stored.root !== path.resolve(this.archivedRoot) || !Array.isArray(stored.entries)) return;
      const entries = stored.entries as [string, CachedHistoryJob][];
      for (const [file, cached] of entries) {
        const relative = path.relative(this.archivedRoot, file);
        if (relative.startsWith('..') || path.isAbsolute(relative) ||
          !Number.isFinite(cached.mtimeMs) || !Number.isFinite(cached.size) || !Number.isFinite(cached.parsedAtMs) ||
          !(cached.usageWindowStartedAtMs === null || Number.isFinite(cached.usageWindowStartedAtMs)) ||
          !cached.job || typeof cached.job.id !== 'string' || !Number.isFinite(Date.parse(cached.job.updatedAt)) ||
          (cached.compact !== undefined && !isCompactHistoryData(cached.compact))) {
          throw new Error('Invalid archived history cache entry');
        }
      }
      for (const [file, cached] of entries) {
        // Version 2 summaries predate the compact numeric timeline. Keep their
        // optional upgrade lazy: only selected archives are read to populate it.
        this.cache.set(file, cached);
      }
    } catch (error) {
      console.warn('Could not load archived history cache; rebuilding from session logs:', error instanceof Error ? error.message : String(error));
    }
  }

  private saveArchiveCache(archivedPaths: Set<string>): void {
    if (!this.archiveCacheFile || !this.archiveCacheDirty) return;
    try {
      const entries = [...this.cache].filter(([file, cached]) => archivedPaths.has(file) && cached.job);
      mkdirSync(path.dirname(this.archiveCacheFile), { recursive: true });
      const temporary = `${this.archiveCacheFile}.${process.pid}.tmp`;
      writeFileSync(temporary, JSON.stringify({ version: ARCHIVE_CACHE_VERSION, root: path.resolve(this.archivedRoot), entries }), { mode: 0o600 });
      renameSync(temporary, this.archiveCacheFile);
      this.archiveCacheDirty = false;
    } catch (error) {
      console.warn('Could not save archived history cache:', error instanceof Error ? error.message : String(error));
    }
  }
}

/** Only statistics survive a scan; transcripts, instructions and tool output do not. */
class CompactHistoryRecords {
  private readonly data: CompactHistoryData;

  constructor(data?: CompactHistoryData) {
    this.data = data ?? { version: 1, records: [], preview: null, activityMin: null, activityMax: null };
  }

  consume(line: string): void {
    let record: Record<string, unknown> | null;
    try { record = asRecord(JSON.parse(line)); } catch { return; }
    if (!record) return;
    const type = asString(record.type);
    const payload = asRecord(record.payload);
    const timestamp = toIsoDate(record.timestamp);
    let compact: Record<string, unknown> | null = null;
    if (type === 'session_meta') {
      const source = asRecord(payload?.source);
      const subagent = asRecord(source?.subagent) ?? asRecord(source?.subAgent);
      const spawn = asRecord(subagent?.thread_spawn) ?? asRecord(subagent?.threadSpawn);
      compact = { ...statFields(payload, ['id', 'timestamp', 'name', 'cwd', 'model_provider', 'modelProvider']),
        parent_thread_id: asString(payload?.parent_thread_id) ?? asString(payload?.parentThreadId) ??
          asString(spawn?.parent_thread_id) ?? asString(spawn?.parentThreadId),
        source: normalizeSourceKind(payload?.source) ?? normalizeOriginator(payload?.originator) };
    } else if (type === 'turn_context') {
      compact = statFields(payload, ['cwd', 'model_provider', 'modelProvider', 'model']);
    } else if (type === 'event_msg') {
      const event = asString(payload?.type);
      if (event === 'token_count') {
        const info = asRecord(payload?.info);
        const rate = asRecord(payload?.rate_limits);
        compact = { type: event,
          info: { last_token_usage: compactTokenUsage(info?.last_token_usage), total_token_usage: compactTokenUsage(info?.total_token_usage) },
          rate_limits: rate ? { ...statFields(rate, ['plan_type', 'limit_id']),
            primary: statFields(asRecord(rate.primary), ['window_minutes', 'used_percent', 'resets_at']),
            secondary: statFields(asRecord(rate.secondary), ['window_minutes', 'used_percent', 'resets_at']) } : null };
      } else if (event === 'task_started' || event === 'task_complete' || event === 'turn_aborted') {
        compact = statFields(payload, ['type', 'turn_id', 'turnId', 'completed_at', 'completedAt', 'duration_ms']);
      } else if (event === 'user_message') {
        this.data.preview = userPreview(asString(payload?.message)) ?? this.data.preview;
      }
    } else if (type === 'response_item' && isUserMessage(payload)) {
      this.data.preview = extractUserPreview(payload) ?? this.data.preview;
    }
    if (compact) {
      this.flushActivity();
      this.data.records.push(JSON.stringify({ timestamp, type, payload: compact }));
    } else {
      const at = timestamp ? Date.parse(timestamp) : NaN;
      if (Number.isFinite(at)) {
        this.data.activityMin = this.data.activityMin === null ? at : Math.min(this.data.activityMin, at);
        this.data.activityMax = this.data.activityMax === null ? at : Math.max(this.data.activityMax, at);
      }
    }
  }

  *lines(): Generator<string> {
    yield* this.data.records;
    yield* this.activityLines();
  }

  serialize(): CompactHistoryData {
    return { ...this.data, records: [...this.data.records] };
  }

  private *activityLines(): Generator<string> {
    for (const at of new Set([this.data.activityMin, this.data.activityMax])) {
      if (at !== null) yield JSON.stringify({ type: 'activity', timestamp: new Date(at).toISOString() });
    }
  }

  private flushActivity(): void {
    this.data.records.push(...this.activityLines());
    this.data.activityMin = this.data.activityMax = null;
  }
}

function statFields(record: Record<string, unknown> | null, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.flatMap(key => {
    const value = record?.[key];
    return typeof value === 'string' || typeof value === 'number' ? [[key, value]] : [];
  }));
}

function compactTokenUsage(value: unknown): Record<string, unknown> | null {
  const record = asRecord(value);
  return record ? statFields(record, ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens',
    'output_tokens', 'reasoning_output_tokens', 'total_tokens']) : null;
}

function isCompactHistoryData(value: unknown): value is CompactHistoryData {
  const record = asRecord(value);
  return record?.version === 1 && Array.isArray(record.records) && record.records.every(line => typeof line === 'string') &&
    (record.preview === null || typeof record.preview === 'string') &&
    (record.activityMin === null || typeof record.activityMin === 'number' && Number.isFinite(record.activityMin)) &&
    (record.activityMax === null || typeof record.activityMax === 'number' && Number.isFinite(record.activityMax));
}

// The desktop index also names tasks omitted by thread/list, such as archived tasks.
// Avoid V8's single-string size limit on long-lived, multi-hundred-MB sessions.
export function* readSessionLines(filePath: string, chunkSize = 64 * 1024): Generator<string> {
  const descriptor = openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(chunkSize);
    const decoder = new StringDecoder('utf8');
    let pending: string[] = [];
    let bytes: number;
    while ((bytes = readSync(descriptor, buffer, 0, buffer.length, null)) > 0) {
      const text = decoder.write(buffer.subarray(0, bytes));
      let start = 0;
      let end: number;
      while ((end = text.indexOf('\n', start)) !== -1) {
        const fragment = text.slice(start, end);
        let line = fragment;
        if (pending.length) {
          pending.push(fragment);
          line = pending.join('');
          pending = [];
        }
        yield line.replace(/\r$/, '');
        start = end + 1;
      }
      if (start < text.length) pending.push(text.slice(start));
    }
    const tail = decoder.end();
    if (tail) pending.push(tail);
    if (pending.length) yield pending.join('').replace(/\r$/, '');
  } finally { closeSync(descriptor); }
}

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
      dailyUsage: mergeDays(existing.dailyUsage, job.dailyUsage),
      quotaDailyUsage: mergeDays(existing.quotaDailyUsage, job.quotaDailyUsage),
      untimedTokens: (existing.untimedTokens ?? 0) + (job.untimedTokens ?? 0),
      totalUnpricedTokens: (existing.totalUnpricedTokens ?? 0) + (job.totalUnpricedTokens ?? 0),
      archived: existing.archived && job.archived,
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
    target.dailyUsage = mergeDays(target.dailyUsage, job.dailyUsage);
    target.quotaDailyUsage = mergeDays(target.quotaDailyUsage, job.quotaDailyUsage);
    target.untimedTokens = (target.untimedTokens ?? 0) + (job.untimedTokens ?? 0);
    target.totalUnpricedTokens = (target.totalUnpricedTokens ?? 0) + (job.totalUnpricedTokens ?? 0);
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
  fileContent: string | Iterable<string>;
  updatedAt: string;
  nowMs: number;
  usageWindowStartedAtMs?: number | null;
}): ParsedHistoryJob | null {
  let sessionId = args.sessionId;
  let metadataId: string | null = null;
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
  let previousTokenUsageKey: string | null = null;
  let tokenCountIndex = 0;
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
  const quotaCalibrationEvents: QuotaCalibrationEvent[] = [];
  const dailyUsage = new Map<string, HistoryUsageDay>();
  const quotaDailyUsage = new Map<string, HistoryUsageDay>();
  let untimedTokens = 0;
  let totalUnpricedTokens = 0;
  const turns = new Map<string, ParsedTurn>();

  const lines = typeof args.fileContent === 'string' ? args.fileContent.split(/\r?\n/) : args.fileContent;
  for (const rawLine of lines) {
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

    const recordType = asString(record.type);
    const payload = asRecord(record.payload);
    const incomingId = recordType === 'session_meta' ? asString(payload?.id) : null;
    // Forked logs can include an ancestor's session_meta immediately after
    // their own header. It is inherited context, not a change of task identity.
    if (incomingId && metadataId && incomingId !== metadataId) continue;

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

    if (recordType === "session_meta") {
      if (incomingId) {
        metadataId = incomingId;
        sessionId = incomingId;
      }
      const source = asRecord(payload?.source);
      const subagent = asRecord(source?.subagent) ?? asRecord(source?.subAgent);
      const spawn = asRecord(subagent?.thread_spawn) ?? asRecord(subagent?.threadSpawn);
      parentThreadId =
        asString(payload?.parent_thread_id) ??
        asString(payload?.parentThreadId) ??
        asString(spawn?.parent_thread_id) ??
        asString(spawn?.parentThreadId) ??
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
      const sampleId = `${sessionId ?? args.sessionId}:${tokenCountIndex++}`;
      const info = asRecord(payload?.info);
      const increment = normalizeTokenUsage(info?.last_token_usage);
      const cumulative = normalizeTokenUsage(info?.total_token_usage);
      const cumulativeKey = cumulative ? JSON.stringify(cumulative) : null;
      const duplicate = Boolean(increment && cumulativeKey && cumulativeKey === previousTokenUsageKey);
      if (recordTimestampMs !== null && recordTimestampMs <= args.nowMs) {
        quotaCalibrationEvents.push({ id: sampleId, at: recordTimestampMs,
          cost: duplicate || !increment ? 0 : estimateApiEquivalentCost(increment, activeModel),
          limit: pro20xWeeklyLimit(payload?.rate_limits, recordTimestampMs) });
      }
      // Rate-limit refreshes can repeat the previous response's token usage.
      // Only deduplicate when unchanged cumulative counters prove no new usage.
      if (duplicate) {
        continue;
      }
      if (increment) previousTokenUsageKey = cumulativeKey;
      lastRunUsage = increment ?? lastRunUsage;

      if (increment) {
        totalUsage = addTokenUsage(totalUsage, increment);
        const estimatedCost = estimateApiEquivalentCost(increment, activeModel);
        if (recordTimestampMs === null) untimedTokens += increment.totalTokens;
        else if (recordTimestampMs <= args.nowMs) {
          const date = localDay(recordTimestampMs);
          const next = { date, usage: increment, costUsd: estimatedCost, unpricedTokens: estimatedCost === null ? increment.totalTokens : 0 };
          dailyUsage.set(date, mergeDays(dailyUsage.has(date) ? [dailyUsage.get(date)!] : [], [next])[0]);
          if (args.usageWindowStartedAtMs != null && recordTimestampMs >= args.usageWindowStartedAtMs) {
            quotaDailyUsage.set(date, mergeDays(quotaDailyUsage.has(date) ? [quotaDailyUsage.get(date)!] : [], [next])[0]);
          }
        }
        if (estimatedCost === null) {
          totalUnpricedTokens += increment.totalTokens;
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
    quotaCalibrationEvents,
    quotaCalibrationVersion: 2,
    dailyUsage: [...dailyUsage.values()], quotaDailyUsage: [...quotaDailyUsage.values()], untimedTokens, totalUnpricedTokens,
    archived: false,
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
        size: stats.size,
        ctimeMs: stats.ctimeMs,
        identity: `${stats.dev}:${stats.ino}:${stats.birthtimeMs}`
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
