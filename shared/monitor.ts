export const SOURCE_KINDS = [
  "cli",
  "vscode",
  "exec",
  "appServer",
  "subAgent",
  "subAgentReview",
  "subAgentCompact",
  "subAgentThreadSpawn",
  "subAgentOther",
  "unknown"
] as const;

export const HUMAN_WAIT_FLAGS = [
  "waitingOnApproval",
  "waitingOnUserInput"
] as const;

export const HISTORY_JOB_SORT_KEYS = [
  "updatedAt",
  "createdAt",
  "estimatedTotalCostUsd",
  "last24HoursCostUsd",
  "last24HoursTokens",
  "estimatedUsagePercentSinceReset",
  "lastRunDurationMs",
  "totalDurationMs",
  "lastRunTokens",
  "totalTokens",
  "runCount"
] as const;

export type SourceKind = (typeof SOURCE_KINDS)[number];
export type HistoryJobSortKey = (typeof HISTORY_JOB_SORT_KEYS)[number];
export type SortDirection = "asc" | "desc";
export type ThreadBucket =
  | "running"
  | "waiting_on_human"
  | "idle"
  | "error"
  | "not_loaded";
export type RunStatus = "running" | "settled" | "error";
export type AutomationUiStatus =
  | "disabled"
  | "armed"
  | "debouncing"
  | "scheduled";
export type ShutdownAutomationScope = "run" | "global";
export type PendingRequestKind =
  | "commandApproval"
  | "fileChangeApproval"
  | "permissionsApproval"
  | "toolUserInput"
  | "mcpElicitation"
  | "dynamicToolCall"
  | "authRefresh"
  | "unknown";

export interface RawThreadStatus {
  type?: string;
  activeFlags?: string[] | null;
}

export interface ThreadRuntimeStatus {
  bucket: ThreadBucket;
  rawType: string;
  activeFlags: string[];
  waitingReason: string | null;
}

export interface ThreadNode {
  id: string;
  runId: string | null;
  parentId: string | null;
  childIds: string[];
  turnIds: string[];
  name: string | null;
  preview: string | null;
  sourceKind: SourceKind | "unknown";
  rawStatus: RawThreadStatus | null;
  runtimeStatus: ThreadRuntimeStatus;
  latestTurnId: string | null;
  latestTurnStatus: string | null;
  latestTurnError: string | null;
  lastActivityAt: string;
  createdAt: string | null;
  updatedAt: string | null;
  cwd: string | null;
  modelProvider: string | null;
  ephemeral: boolean;
  lastCommandSummary: string | null;
  latestMessagePreview: string | null;
  pendingRequestIds: string[];
  isClosed: boolean;
}

export interface TurnPlanStep {
  step: string;
  status: "pending" | "inProgress" | "completed";
}

export interface MonitorItem {
  id: string;
  threadId: string;
  turnId: string;
  type: string;
  status: string | null;
  title: string;
  text: string | null;
  output: string | null;
  command: string | null;
  cwd: string | null;
  toolName: string | null;
  startedAt: string;
  completedAt: string | null;
  raw: unknown;
}

export interface TurnSummary {
  id: string;
  threadId: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  diff: string | null;
  plan: TurnPlanStep[];
  planExplanation: string | null;
  itemIds: string[];
  errorMessage: string | null;
}

export interface RunSettings {
  prompt: string;
  cwd: string;
  model?: string | null;
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  approvalPolicy?: "untrusted" | "on-failure" | "on-request" | "never";
  personality?: "none" | "friendly" | "pragmatic";
}

export interface RunAutomationPolicy {
  enabled: boolean;
  action: "shutdown";
  settleDelayMs: number;
  shutdownDelaySeconds: number;
  cancelOnNewActivity: boolean;
}

export interface RunAutomationState {
  status: AutomationUiStatus;
  armedAt: string | null;
  settlesAt: string | null;
  shutdownAt: string | null;
  lastAction: string | null;
}

export interface GlobalAutomation {
  policy: RunAutomationPolicy;
  state: RunAutomationState;
}

export interface Run {
  id: string;
  prompt: string;
  rootThreadId: string;
  trackedThreadIds: string[];
  createdAt: string;
  updatedAt: string;
  status: RunStatus;
  settled: boolean;
  waitingOnHuman: boolean;
  settings: RunSettings;
  automationPolicy: RunAutomationPolicy;
  automationState: RunAutomationState;
}

export interface ArmAutomationRequest {
  enabled?: boolean;
  settleDelayMs?: number;
  shutdownDelaySeconds?: number;
  cancelOnNewActivity?: boolean;
}

export interface ArmGlobalAutomationRequest extends ArmAutomationRequest {}

export interface PendingRequest {
  id: string;
  threadId: string;
  turnId: string;
  itemId: string | null;
  method: string;
  kind: PendingRequestKind;
  summary: string;
  createdAt: string;
  raw: unknown;
  status: "pending" | "resolved";
}

export interface ServerConnectionState {
  connected: boolean;
  initialized: boolean;
  lastError: string | null;
  stderrTail: string[];
}

export interface ActiveShutdownState {
  scope: ShutdownAutomationScope | null;
  runId: string | null;
  scheduled: boolean;
  command: string | null;
  executeAt: string | null;
  dryRun: boolean;
}

export interface ActiveSession {
  id: string;
  name: string | null;
  preview: string | null;
  cwd: string | null;
  createdAt: string | null;
  updatedAt: string;
  lastTurnStartedAt: string | null;
}

export interface CodexUsageWindow {
  label: string;
  usedPercent: number | null;
  remainingPercent: number | null;
  windowDurationMins: number | null;
  resetsAt: string | null;
}

export interface CodexUsageCredits {
  hasCredits: boolean | null;
  unlimited: boolean | null;
  balance: string | null;
}

export interface CodexUsageLimit {
  id: string;
  name: string | null;
  planType: string | null;
  primary: CodexUsageWindow | null;
  secondary: CodexUsageWindow | null;
  credits: CodexUsageCredits | null;
  rateLimitReachedType: string | null;
}

export interface CodexUsageSnapshot {
  status: "loading" | "available" | "unavailable" | "error";
  updatedAt: string | null;
  error: string | null;
  primaryLimit: CodexUsageLimit | null;
  limits: CodexUsageLimit[];
}

export interface TokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens?: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

export interface HistoryJob {
  id: string;
  name: string | null;
  preview: string | null;
  sourceKind: SourceKind | "unknown";
  createdAt: string | null;
  updatedAt: string;
  cwd: string | null;
  modelProvider: string | null;
  runCount: number;
  lastRunStartedAt: string | null;
  lastRunCompletedAt: string | null;
  lastRunDurationMs: number | null;
  totalDurationMs: number;
  lastRunUsage: TokenUsage | null;
  totalUsage: TokenUsage | null;
  totalEstimatedCostUsd: number | null;
  totalEstimatedCostIsComplete: boolean;
  last24HoursUsage: TokenUsage | null;
  last24HoursEstimatedCostUsd: number | null;
  sinceResetUsage: TokenUsage | null;
  sinceResetEstimatedCostUsd: number | null;
  sinceResetUnpricedTokens?: number;
  estimatedUsagePercentSinceReset: number | null;
}

export interface HistoryUsageAllocation {
  observedSince?: string | null;
  unattributedPercent?: number | null;
  status: "available" | "unavailable";
  usedPercent: number | null;
  windowStartedAt: string | null;
  resetsAt: string | null;
  limitName: string | null;
  windowLabel: string | null;
  basis: "apiEquivalentCost" | null;
}

export interface HistoryJobListResponse {
  data: HistoryJob[];
  total: number;
  nextCursor: string | null;
  usageAllocation: HistoryUsageAllocation;
}

export interface MonitorSnapshot {
  generatedAt: string;
  runs: Run[];
  activeSessions: ActiveSession[];
  threads: Record<string, ThreadNode>;
  turns: Record<string, TurnSummary>;
  items: Record<string, MonitorItem>;
  pendingRequests: Record<string, PendingRequest>;
  server: ServerConnectionState;
  activeShutdown: ActiveShutdownState;
  globalAutomation: GlobalAutomation;
  codexUsage: CodexUsageSnapshot;
}

export interface RunSnapshot {
  generatedAt: string;
  run: Run | null;
  threads: Record<string, ThreadNode>;
  turns: Record<string, TurnSummary>;
  items: Record<string, MonitorItem>;
  pendingRequests: Record<string, PendingRequest>;
  server: ServerConnectionState;
  activeShutdown: ActiveShutdownState;
}

export interface HistoryThread {
  id: string;
  name: string | null;
  preview: string | null;
  sourceKind: SourceKind | "unknown";
  runtimeStatus: ThreadRuntimeStatus;
  createdAt: string | null;
  updatedAt: string | null;
  cwd: string | null;
  modelProvider: string | null;
  ephemeral: boolean;
}

export interface HistoryThreadListResponse {
  data: HistoryThread[];
  nextCursor: string | null;
}

export const DEFAULT_AUTOMATION_POLICY: RunAutomationPolicy = {
  enabled: false,
  action: "shutdown",
  settleDelayMs: 30000,
  shutdownDelaySeconds: 60,
  cancelOnNewActivity: true
};

export const DEFAULT_AUTOMATION_STATE: RunAutomationState = {
  status: "disabled",
  armedAt: null,
  settlesAt: null,
  shutdownAt: null,
  lastAction: null
};

export function isoNow(): string {
  return new Date().toISOString();
}

export function toIsoDate(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = value < 1000000000000 ? value * 1000 : value;
    return new Date(milliseconds).toISOString();
  }

  if (typeof value === "string") {
    const numeric = Number(value);
    if (!Number.isNaN(numeric) && value.trim() !== "") {
      return toIsoDate(numeric);
    }

    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) {
      return new Date(parsed).toISOString();
    }
  }

  return null;
}

export function previewText(
  value: string | null | undefined,
  maxLength = 120
): string | null {
  if (!value) {
    return null;
  }

  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return null;
  }

  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, maxLength - 1)}…`;
}

export function derivePendingRequestKind(method: string): PendingRequestKind {
  switch (method) {
    case "item/commandExecution/requestApproval":
      return "commandApproval";
    case "item/fileChange/requestApproval":
      return "fileChangeApproval";
    case "item/permissions/requestApproval":
      return "permissionsApproval";
    case "item/tool/requestUserInput":
      return "toolUserInput";
    case "mcpServer/elicitation/request":
      return "mcpElicitation";
    case "item/tool/call":
      return "dynamicToolCall";
    case "account/chatgptAuthTokens/refresh":
      return "authRefresh";
    default:
      return "unknown";
  }
}

export function describePendingRequest(method: string): string {
  switch (method) {
    case "item/commandExecution/requestApproval":
      return "Waiting on command approval";
    case "item/fileChange/requestApproval":
      return "Waiting on file-change approval";
    case "item/permissions/requestApproval":
      return "Waiting on extra permissions";
    case "item/tool/requestUserInput":
      return "Waiting on user input";
    case "mcpServer/elicitation/request":
      return "Waiting on MCP elicitation";
    default:
      return "Waiting on external request";
  }
}

export function deriveThreadRuntimeStatus(
  rawStatus: RawThreadStatus | null | undefined,
  latestTurnStatus?: string | null,
  latestTurnError?: string | null
): ThreadRuntimeStatus {
  if (latestTurnStatus === "failed" || latestTurnError) {
    return {
      bucket: "error",
      rawType: latestTurnStatus ?? "failed",
      activeFlags: [],
      waitingReason: latestTurnError ?? "Latest turn failed"
    };
  }

  const rawType = rawStatus?.type ?? "notLoaded";
  const activeFlags = [...(rawStatus?.activeFlags ?? [])];
  const firstHumanWait = activeFlags.find((flag) =>
    (HUMAN_WAIT_FLAGS as readonly string[]).includes(flag)
  );

  switch (rawType) {
    case "idle":
      return { bucket: "idle", rawType, activeFlags, waitingReason: null };
    case "systemError":
      return {
        bucket: "error",
        rawType,
        activeFlags,
        waitingReason: "Thread entered systemError"
      };
    case "active":
      return {
        bucket: firstHumanWait ? "waiting_on_human" : "running",
        rawType,
        activeFlags,
        waitingReason: firstHumanWait ?? null
      };
    default:
      return {
        bucket: "not_loaded",
        rawType,
        activeFlags,
        waitingReason: null
      };
  }
}

export function emptyThreadRuntimeStatus(): ThreadRuntimeStatus {
  return deriveThreadRuntimeStatus({ type: "notLoaded", activeFlags: [] });
}
