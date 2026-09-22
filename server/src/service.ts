import { EventEmitter } from "node:events";
import path from "node:path";
import { deriveThreadRuntimeStatus, type ActiveSession, type ArmAutomationRequest, type ArmGlobalAutomationRequest, type CodexUsageSnapshot, type HistoryJobListResponse, type HistoryThreadListResponse, type MonitorSnapshot, type RunSnapshot, type ServerConnectionState } from "../../shared/monitor";
import { ActiveSessionTracker } from "./active-sessions";
import { CodexAppServerClient } from "./codex-client";
import { AutomationController } from "./automation";
import { HistoryJobReader, type HistoryJobMetadata } from "./history-jobs";
import { MonitorStore } from "./store";
import {
  codexUsageFromRateLimitsRead,
  codexUsageFromRateLimitsUpdated,
  emptyCodexUsage
} from "./usage";
import { asRecord, asString, asStringArray, cloneValue, toIsoDate } from "./utils";

export class MonitorService extends EventEmitter<{ change: [MonitorSnapshot] }> {
  private readonly store = new MonitorStore();
  private readonly client: CodexAppServerClient;
  private readonly automation: AutomationController;
  private readonly activeSessionTracker = new ActiveSessionTracker();
  private readonly historyJobReader: HistoryJobReader;
  private readonly serverState: ServerConnectionState = {
    connected: false,
    initialized: false,
    lastError: null,
    stderrTail: []
  };
  private activeSessions: ActiveSession[] = [];
  private activeSessionPollHandle: NodeJS.Timeout | null = null;
  private activeSessionRefreshPromise: Promise<void> | null = null;
  private codexUsage: CodexUsageSnapshot = emptyCodexUsage();
  private codexUsagePollHandle: NodeJS.Timeout | null = null;
  private codexUsageRefreshPromise: Promise<void> | null = null;
  private historyThreadMetadataCache: {
    refreshedAtMs: number;
    data: Map<string, HistoryJobMetadata>;
  } | null = null;
  private historyThreadMetadataRefreshPromise: Promise<Map<string, HistoryJobMetadata>> | null = null;

  public constructor(
    client = new CodexAppServerClient(),
    historyJobReader = new HistoryJobReader(undefined, path.resolve('.cache/quota-attribution.json'))
  ) {
    super();
    this.client = client;
    this.historyJobReader = historyJobReader;
    this.automation = new AutomationController(this.store, {
      onChange: () => this.emitSnapshot()
    });
    this.bindClient();
  }

  public async start(): Promise<void> {
    try {
      await this.client.ensureStarted();
      this.serverState.connected = true;
      this.serverState.initialized = true;
      this.serverState.lastError = null;
    } catch (error) {
      this.serverState.connected = false;
      this.serverState.initialized = false;
      this.serverState.lastError =
        error instanceof Error ? error.message : String(error);
    }

    await Promise.all([this.refreshActiveSessions(), this.refreshCodexUsage()]);
    this.startActiveSessionPolling();
    this.startCodexUsagePolling();
    this.emitSnapshot();
  }

  public getSnapshot(): MonitorSnapshot {
    const snapshot = this.store.getSnapshot(
      cloneValue(this.serverState),
      this.automation.getActiveShutdown(),
      this.activeSessions,
      this.automation.getGlobalAutomation()
    );

    return {
      ...snapshot,
      codexUsage: cloneValue(this.codexUsage)
    };
  }

  public getRunSnapshot(runId: string): RunSnapshot {
    return this.store.getRunSnapshot(
      runId,
      cloneValue(this.serverState),
      this.automation.getActiveShutdown()
    );
  }

  public listRuns() {
    return this.store.listRuns();
  }

  public async armRunAutomation(
    runId: string,
    request: ArmAutomationRequest
  ): Promise<RunSnapshot> {
    this.automation.armRun(runId, {
      settleDelayMs: request.settleDelayMs,
      shutdownDelaySeconds: request.shutdownDelaySeconds,
      cancelOnNewActivity: request.cancelOnNewActivity
    });
    this.emitSnapshot();
    return this.getRunSnapshot(runId);
  }

  public async armGlobalNoActiveSessionsAutomation(
    request: ArmGlobalAutomationRequest
  ): Promise<MonitorSnapshot> {
    this.automation.armGlobalNoActiveSessions({
      settleDelayMs: request.settleDelayMs,
      shutdownDelaySeconds: request.shutdownDelaySeconds,
      cancelOnNewActivity: request.cancelOnNewActivity
    });
    this.emitSnapshot();
    return this.getSnapshot();
  }

  public async cancelGlobalNoActiveSessionsAutomation(): Promise<MonitorSnapshot> {
    await this.automation.cancelGlobalAutomation("manual", { disarm: true });
    this.emitSnapshot();
    return this.getSnapshot();
  }

  public async cancelShutdown(): Promise<MonitorSnapshot> {
    await this.automation.cancelShutdown("manual", { disarm: true });
    this.emitSnapshot();
    return this.getSnapshot();
  }

  public async listHistoryThreads(args: {
    cursor?: string | null;
    limit?: number | null;
    sourceKinds?: string[] | null;
    searchTerm?: string | null;
  }): Promise<HistoryThreadListResponse> {
    await this.client.ensureStarted();
    const response = (await this.client.request("thread/list", {
      cursor: args.cursor ?? null,
      limit: args.limit ?? 20,
      archived: false,
      sourceKinds:
        args.sourceKinds && args.sourceKinds.length > 0 ? args.sourceKinds : null,
      searchTerm: args.searchTerm ?? null,
      sortKey: "updated_at"
    })) as {
      data?: unknown[];
      nextCursor?: string | null;
    };

    return {
      data: Array.isArray(response.data)
        ? response.data
            .map((entry) => asRecord(entry))
            .filter((entry): entry is Record<string, unknown> => Boolean(entry))
            .map((entry) => ({
              id: asString(entry.id) ?? "unknown",
              name: asString(entry.name),
              preview: asString(entry.preview),
              sourceKind:
                ((asString(entry.sourceKind) ?? asString(entry.source)) as
                  | HistoryThreadListResponse["data"][number]["sourceKind"]
                  | null) ?? "unknown",
              runtimeStatus: deriveThreadRuntimeStatus(asRecord(entry.status) as never),
              createdAt: toIsoDate(entry.createdAt),
              updatedAt: toIsoDate(entry.updatedAt),
              cwd: asString(entry.cwd),
              modelProvider: asString(entry.modelProvider),
              ephemeral: entry.ephemeral === true
            }))
        : [],
      nextCursor: response.nextCursor ?? null
    };
  }

  public async listHistoryJobs(args: {
    cursor?: string | null;
    limit?: number | null;
    sourceKinds?: string[] | null;
    searchTerm?: string | null;
    sortKey?: string | null;
    sortDirection?: string | null;
    archiveMode?: 'recent' | 'all';
    period?: 'quota' | 'today' | '7d' | 'lifetime';
    forceRefresh?: boolean;
  }): Promise<HistoryJobListResponse> {
    let metadataById: Map<string, HistoryJobMetadata> | null = null;
    try {
      metadataById = await this.getHistoryThreadMetadata();
    } catch {
      metadataById = null;
    }

    return this.historyJobReader.listJobs({
      ...args,
      forceRefresh: args.forceRefresh === true && !args.cursor,
      metadataById,
      usageWindow: this.getPrimaryUsageWindow()
    });
  }

  private getPrimaryUsageWindow(): {
    usedPercent: number;
    startedAtMs: number;
    resetsAt: string;
    limitName: string;
    windowLabel: string;
  } | null {
    const limit = this.codexUsage.limits.find(entry => entry.id === 'codex') ??
      (this.codexUsage.primaryLimit?.id === 'codex' ? this.codexUsage.primaryLimit : null);
    const window = [limit?.primary, limit?.secondary].find(entry => entry?.windowDurationMins === 10080) ??
      limit?.primary ?? limit?.secondary;
    if (
      window?.usedPercent === null ||
      window?.usedPercent === undefined ||
      window.windowDurationMins === null ||
      !window.resetsAt
    ) {
      return null;
    }

    const resetsAtMs = Date.parse(window.resetsAt);
    if (!Number.isFinite(resetsAtMs)) {
      return null;
    }

    return {
      usedPercent: window.usedPercent,
      startedAtMs: resetsAtMs - window.windowDurationMins * 60_000,
      resetsAt: window.resetsAt,
      limitName: limit?.name ?? "Overall Codex",
      windowLabel: window.label
    };
  }

  private async getHistoryThreadMetadata(): Promise<Map<string, HistoryJobMetadata>> {
    const nowMs = Date.now();
    if (
      this.historyThreadMetadataCache &&
      nowMs - this.historyThreadMetadataCache.refreshedAtMs < 60_000
    ) {
      return this.historyThreadMetadataCache.data;
    }

    if (this.historyThreadMetadataRefreshPromise) return this.historyThreadMetadataRefreshPromise;
    this.historyThreadMetadataRefreshPromise = this.refreshHistoryThreadMetadata();
    try {
      return await this.historyThreadMetadataRefreshPromise;
    } finally {
      this.historyThreadMetadataRefreshPromise = null;
    }
  }

  private async refreshHistoryThreadMetadata(): Promise<Map<string, HistoryJobMetadata>> {
    await this.client.ensureStarted();
    const metadataById = new Map<string, HistoryJobMetadata>();
    let cursor: string | null = null;
    let pageCount = 0;

    do {
      const response = (await this.client.request("thread/list", {
        cursor,
        limit: 200,
        archived: false,
        sortKey: "updated_at"
      })) as {
        data?: unknown[];
        nextCursor?: string | null;
      };

      if (Array.isArray(response.data)) {
        for (const rawEntry of response.data) {
          const entry = asRecord(rawEntry);
          const id = asString(entry?.id);
          if (!id || !entry) {
            continue;
          }

          metadataById.set(id, {
            name: asString(entry.name),
            preview: asString(entry.preview),
            sourceKind:
              ((asString(entry.sourceKind) ?? asString(entry.source)) as
                | HistoryJobMetadata["sourceKind"]
                | null) ?? undefined,
            createdAt: toIsoDate(entry.createdAt),
            updatedAt: toIsoDate(entry.updatedAt) ?? undefined,
            cwd: asString(entry.cwd),
            modelProvider: asString(entry.modelProvider)
          });
        }
      }

      cursor = response.nextCursor ?? null;
      pageCount += 1;
    } while (cursor && pageCount < 25);

    this.historyThreadMetadataCache = {
      refreshedAtMs: Date.now(),
      data: metadataById
    };
    return metadataById;
  }

  private bindClient(): void {
    this.client.on("initialized", () => {
      this.serverState.connected = true;
      this.serverState.initialized = true;
      this.serverState.lastError = null;
      void this.refreshCodexUsage();
      this.emitSnapshot();
    });

    this.client.on("stderr", (line) => {
      this.serverState.stderrTail = [...this.serverState.stderrTail, line].slice(-8);
      this.emitSnapshot();
    });

    this.client.on("close", (code) => {
      this.serverState.connected = false;
      this.serverState.initialized = false;
      this.serverState.lastError =
        code === null
          ? "Codex app-server closed."
          : `Codex app-server exited with code ${code}.`;
      this.codexUsage = emptyCodexUsage("unavailable", this.serverState.lastError);
      this.emitSnapshot();
    });

    this.client.on("notification", (message) => {
      if (message.method === "account/rateLimits/updated") {
        this.codexUsage = codexUsageFromRateLimitsUpdated(
          message.params,
          this.codexUsage
        );
        this.observeQuotaUsage();
      }
      this.store.applyRpcNotification(message);
      this.automation.evaluateAll();
      this.emitSnapshot();
    });

    this.client.on("serverRequest", async (message) => {
      if (message.method === "item/tool/call") {
        await this.client.respond(message.id, {
          success: false,
          contentItems: [
            {
              type: "inputText",
              text: "codex-monitor does not support client-side dynamic tool calls in v1."
            }
          ]
        });
      }

      this.store.applyServerRequest(message);
      if (message.method === "item/tool/call") {
        this.store.resolvePendingRequest(String(message.id));
      }
      this.automation.evaluateAll();
      this.emitSnapshot();
    });
  }

  private emitSnapshot(): void {
    this.emit("change", this.getSnapshot());
  }

  private startActiveSessionPolling(): void {
    if (this.activeSessionPollHandle) {
      return;
    }

    this.activeSessionPollHandle = setInterval(() => {
      void this.refreshActiveSessions();
    }, 2000);
  }

  private startCodexUsagePolling(): void {
    if (this.codexUsagePollHandle) {
      return;
    }

    this.codexUsagePollHandle = setInterval(() => {
      void this.refreshCodexUsage();
    }, 60000);
  }

  private async refreshActiveSessions(): Promise<void> {
    if (this.activeSessionRefreshPromise) {
      return this.activeSessionRefreshPromise;
    }

    this.activeSessionRefreshPromise = this.refreshActiveSessionsInternal().finally(
      () => {
        this.activeSessionRefreshPromise = null;
      }
    );

    return this.activeSessionRefreshPromise;
  }

  private async refreshActiveSessionsInternal(): Promise<void> {
    const scannedSessions = this.activeSessionTracker.listActiveSessions();
    let nextSessions = scannedSessions;

    try {
      await this.client.ensureStarted();
      const response = (await this.client.request("thread/list", {
        limit: 200,
        archived: false,
        sortKey: "updated_at"
      })) as {
        data?: unknown[];
      };

      if (Array.isArray(response.data)) {
        const metadataById = new Map(
          response.data
            .map((entry) => asRecord(entry))
            .filter((entry): entry is Record<string, unknown> => Boolean(entry))
            .map((entry) => [asString(entry.id), entry] as const)
            .filter((entry): entry is [string, Record<string, unknown>] => Boolean(entry[0]))
        );

        nextSessions = scannedSessions.map((session) => {
          const metadata = metadataById.get(session.id);
          if (!metadata) {
            return session;
          }

          return {
            ...session,
            name: asString(metadata.name) ?? session.name,
            preview: asString(metadata.preview) ?? session.preview,
            cwd: asString(metadata.cwd) ?? session.cwd,
            createdAt: toIsoDate(metadata.createdAt) ?? session.createdAt,
            updatedAt: session.updatedAt
          };
        });
      }
    } catch {
      nextSessions = scannedSessions;
    }

    if (JSON.stringify(nextSessions) === JSON.stringify(this.activeSessions)) {
      this.automation.evaluateActiveSessions(nextSessions);
      return;
    }

    this.activeSessions = nextSessions;
    this.automation.evaluateActiveSessions(this.activeSessions);
    this.emitSnapshot();
  }

  private async refreshCodexUsage(): Promise<void> {
    if (this.codexUsageRefreshPromise) {
      return this.codexUsageRefreshPromise;
    }

    this.codexUsageRefreshPromise = this.refreshCodexUsageInternal().finally(() => {
      this.codexUsageRefreshPromise = null;
    });

    return this.codexUsageRefreshPromise;
  }

  private async refreshCodexUsageInternal(): Promise<void> {
    let nextUsage: CodexUsageSnapshot;
    try {
      await this.client.ensureStarted();
      const response = await this.client.request("account/rateLimits/read");
      nextUsage = codexUsageFromRateLimitsRead(response);
    } catch (error) {
      nextUsage = emptyCodexUsage(
        "error",
        error instanceof Error ? error.message : String(error)
      );
    }

    const unchanged = JSON.stringify(nextUsage) === JSON.stringify(this.codexUsage);
    this.codexUsage = nextUsage;
    this.observeQuotaUsage();
    if (unchanged) {
      return;
    }

    this.emitSnapshot();
  }

  private observeQuotaUsage(): void {
    const usageWindow = this.getPrimaryUsageWindow();
    if (!usageWindow || Date.parse(usageWindow.resetsAt) <= Date.now()) return;
    try {
      this.historyJobReader.listJobs({ usageWindow, observeUsage: true });
    } catch (error) {
      console.error('Could not record quota attribution:', error);
    }
  }
}
