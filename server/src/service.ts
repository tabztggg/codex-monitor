import { EventEmitter } from "node:events";
import { AccountUsageHistory } from './account-usage';
import { FreshCurrentAccountSource, type CurrentAccountSource } from './current-account';
import path from "node:path";
import { deriveThreadRuntimeStatus, type ActiveSession, type ArmAutomationRequest, type ArmGlobalAutomationRequest, type CodexUsageSnapshot, type HistoryJobListResponse, type HistoryThreadListResponse, type MonitorSnapshot, type RunSnapshot, type ServerConnectionState } from "../../shared/monitor";
import { ActiveSessionTracker } from "./active-sessions";
import type { LiveTokenSnapshot } from '../../shared/live-tokens';
import { CodexAppServerClient } from "./codex-client";
import { AutomationController } from "./automation";
import { HistoryJobReader, type HistoryJobMetadata } from "./history-jobs";
import { MonitorStore } from "./store";
import {
  readAccountUsage,
  staleCodexUsage,
  codexUsageFromRateLimitsUpdated,
  emptyCodexUsage
} from "./usage";
import { asRecord, asString, asStringArray, cloneValue, toIsoDate } from "./utils";
import { ACTIVE_SESSION_INTERVAL_MS, AUTOMATION_SESSION_INTERVAL_MS, ACCOUNT_USAGE_INTERVAL_MS, HISTORY_METADATA_TTL_MS } from '../../shared/polling';

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
  private activeSessionPollIntervalMs = 0;
  private activeSessionRefreshPromise: Promise<void> | null = null;
  private codexUsage: CodexUsageSnapshot = emptyCodexUsage();
  private readonly accountUsageHistory = new AccountUsageHistory(path.resolve('.cache/account-usage.json'));
  private codexUsagePollHandle: NodeJS.Timeout | null = null;
  private codexUsageRefreshPromise: Promise<void> | null = null;
  private usageAccountRevision = 0;
  private usageIdentityPending = false;
  private readonly currentAccountSource: CurrentAccountSource | null;
  private accountIdentityCheck: Promise<void> | null = null;
  private nextAccountIdentityCheck = 0;
  private accountRefreshQueued = false;
  private lastAccountRefreshStarted = -Infinity;
  private historyThreadMetadataCache: {
    refreshedAtMs: number;
    data: Map<string, HistoryJobMetadata>;
  } | null = null;
  private historyThreadMetadataRefreshPromise: Promise<Map<string, HistoryJobMetadata>> | null = null;

  public constructor(
    client?: CodexAppServerClient,
    historyJobReader = new HistoryJobReader(undefined, path.resolve('.cache/quota-attribution.json')),
    currentAccountSource?: CurrentAccountSource,
  ) {
    super();
    this.client = client ?? new CodexAppServerClient();
    this.currentAccountSource = currentAccountSource ?? (client ? null : new FreshCurrentAccountSource());
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
      codexUsage: cloneValue(this.codexUsage),
      accountUsages: this.accountUsageHistory.list(this.codexUsage)
    };
  }

  public getRunSnapshot(runId: string): RunSnapshot {
    return this.store.getRunSnapshot(
      runId,
      cloneValue(this.serverState),
      this.automation.getActiveShutdown()
    );
  }

  /** Local rolling counters only; does not refresh accounts or full task history. */
  public getLiveTokens(): LiveTokenSnapshot {
    const snapshot = this.activeSessionTracker.getLiveTokens();
    if (!this.activeSessionTracker.isActivitySourceAvailable()) {
      this.automation.evaluateActiveSessions(this.activeSessions, false);
    }
    return snapshot;
  }

  /** Explicit page refresh is shared across tabs and bounded; account changes
   * bypass the short manual cooldown but never overlap an in-flight read. */
  public async refreshCurrentAccount(): Promise<CodexUsageSnapshot> {
    await this.checkAccountIdentity(true);
    if (this.codexUsageRefreshPromise) await this.codexUsageRefreshPromise;
    else if (Date.now() - this.lastAccountRefreshStarted >= 30_000) await this.refreshCodexUsage();
    return cloneValue(this.codexUsage);
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
    // The ordinary scan can be a minute old. Never arm an idle shutdown from
    // that stale count; reconcile activity before starting its settle timer.
    await this.refreshActiveSessions();
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
    accountId?: string;
    dateFrom?: string;
    dateTo?: string;
    cursor?: string | null;
    limit?: number | null;
    sourceKinds?: string[] | null;
    searchTerm?: string | null;
    sortKey?: string | null;
    sortDirection?: string | null;
    archiveMode?: 'recent' | 'all';
    period?: 'quota' | 'today' | '7d' | 'lifetime' | 'custom';
    forceRefresh?: boolean;
  }): Promise<HistoryJobListResponse> {
    const selected = args.accountId ? this.accountUsageHistory.list(this.codexUsage).find(a => a.id === args.accountId) : undefined;
    if (args.accountId && !selected) throw new Error("Unknown account selection.");
    const usage = selected && !selected.current ? selected.usage : this.codexUsage;
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
      account: usage.account,
      calibrateAccount: !selected || selected.current,
      observeUsage: false,
      usageWindow: this.getPrimaryUsageWindow(usage)
    });
  }

  private getPrimaryUsageWindow(usage = this.codexUsage): {
    usedPercent: number;
    startedAtMs: number;
    resetsAt: string;
    limitName: string;
    windowLabel: string;
    observedAtMs?: number;
  } | null {
    const limit = usage.limits.find(entry => entry.id === 'codex') ??
      (usage.primaryLimit?.id === 'codex' ? usage.primaryLimit : null);
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
      windowLabel: window.label,
      observedAtMs: usage.updatedAt && Number.isFinite(Date.parse(usage.updatedAt)) ? Date.parse(usage.updatedAt) : undefined
    };
  }

  private async getHistoryThreadMetadata(): Promise<Map<string, HistoryJobMetadata>> {
    const nowMs = Date.now();
    if (
      this.historyThreadMetadataCache &&
      nowMs - this.historyThreadMetadataCache.refreshedAtMs < HISTORY_METADATA_TTL_MS
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
      if (!this.currentAccountSource) void this.refreshCodexUsage();
      this.emitSnapshot();
    });

    this.client.on("stderr", (line) => {
      this.serverState.stderrTail = [...this.serverState.stderrTail, line].slice(-8);
      this.emitSnapshot();
    });

    this.client.on("close", (code) => {
      if (!this.currentAccountSource) this.usageAccountRevision++;
      this.serverState.connected = false;
      this.serverState.initialized = false;
      this.serverState.lastError =
        code === null
          ? "Codex app-server closed."
          : `Codex app-server exited with code ${code}.`;
      if (!this.currentAccountSource) {
        this.usageIdentityPending = true;
        this.codexUsage = staleCodexUsage(this.codexUsage, this.serverState.lastError);
      }
      this.emitSnapshot();
    });

    this.client.on("notification", (message) => {
      // The metadata client may still be logged in as the previous account.
      // Only the fresh usage client may publish current-account quota.
      if (this.currentAccountSource && (message.method === 'account/updated' || message.method === 'account/rateLimits/updated')) return;
      if (message.method === 'account/updated') {
        // account/read can itself emit this notification. The paired before /
        // after identity reads validate the account without invalidating themselves.
        this.usageIdentityPending = true;
        this.codexUsage = staleCodexUsage(this.codexUsage, 'Account identity is being checked.');
        void this.refreshCodexUsage();
      } else if (message.method === "account/rateLimits/updated") {
        if (this.usageIdentityPending) void this.refreshCodexUsage();
        else {
          this.codexUsage = codexUsageFromRateLimitsUpdated(message.params, this.codexUsage);
          this.accountUsageHistory.record(this.codexUsage);
          this.observeQuotaUsage();
        }
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
    if (this.activeSessionPollHandle) this.startActiveSessionPolling();
    this.emit("change", this.getSnapshot());
  }

  private startActiveSessionPolling(): void {
    const sensitive = this.automation.getGlobalAutomation().policy.enabled ||
      this.automation.getActiveShutdown().scheduled || this.store.listRuns().some(run => run.automationPolicy.enabled);
    const intervalMs = sensitive ? AUTOMATION_SESSION_INTERVAL_MS : ACTIVE_SESSION_INTERVAL_MS;
    if (this.activeSessionPollHandle && this.activeSessionPollIntervalMs === intervalMs) return;
    if (this.activeSessionPollHandle) clearInterval(this.activeSessionPollHandle);
    this.activeSessionPollIntervalMs = intervalMs;
    this.activeSessionPollHandle = setInterval(() => {
      void this.refreshActiveSessions();
    }, intervalMs);
  }

  private startCodexUsagePolling(): void {
    if (this.codexUsagePollHandle) {
      return;
    }

    this.codexUsagePollHandle = setInterval(() => {
      void this.refreshCodexUsage();
    }, ACCOUNT_USAGE_INTERVAL_MS);
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
    void this.checkAccountIdentity();
    const scannedSessions = this.activeSessionTracker.listActiveSessions();
    if (!this.activeSessionTracker.isActivitySourceAvailable()) {
      this.automation.evaluateActiveSessions(this.activeSessions, false);
      this.emitSnapshot();
      return;
    }
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
      this.automation.evaluateActiveSessions(nextSessions, this.activeSessionTracker.isActivitySourceAvailable());
      return;
    }

    this.activeSessions = nextSessions;
    this.automation.evaluateActiveSessions(this.activeSessions, this.activeSessionTracker.isActivitySourceAvailable());
    this.emitSnapshot();
  }

  private async refreshCodexUsage(): Promise<void> {
    if (this.codexUsageRefreshPromise) {
      return this.codexUsageRefreshPromise;
    }

    this.lastAccountRefreshStarted = Date.now();
    this.codexUsageRefreshPromise = this.refreshCodexUsageInternal().finally(() => {
      this.codexUsageRefreshPromise = null;
      if (this.accountRefreshQueued) {
        this.accountRefreshQueued = false;
        void this.refreshCodexUsage();
      }
    });

    return this.codexUsageRefreshPromise;
  }

  private async refreshCodexUsageInternal(): Promise<void> {
    let nextUsage: CodexUsageSnapshot;
    const revision = this.usageAccountRevision;
    try {
      if (this.currentAccountSource) nextUsage = await this.currentAccountSource.read(this.codexUsage);
      else {
        await this.client.ensureStarted();
        nextUsage = await readAccountUsage(this.client, this.codexUsage);
      }
    } catch (error) {
      nextUsage = staleCodexUsage(
        this.codexUsage,
        error instanceof Error ? error.message : String(error)
      );
    }

    if (revision !== this.usageAccountRevision) return;
    const unchanged = JSON.stringify(nextUsage) === JSON.stringify(this.codexUsage);
    this.codexUsage = nextUsage;
    this.accountUsageHistory.record(nextUsage);
    if (nextUsage.status === 'available' && !nextUsage.stale) this.usageIdentityPending = false;
    this.observeQuotaUsage();
    if (unchanged) {
      return;
    }

    this.emitSnapshot();
  }

  public shutdown(): void {
    if (this.activeSessionPollHandle) clearInterval(this.activeSessionPollHandle);
    if (this.codexUsagePollHandle) clearInterval(this.codexUsagePollHandle);
    this.currentAccountSource?.shutdown?.();
    this.client.shutdown();
  }

  private async checkAccountIdentity(manual = false): Promise<void> {
    if (!this.currentAccountSource) return;
    if (this.accountIdentityCheck) return this.accountIdentityCheck;
    if (!manual && Date.now() < this.nextAccountIdentityCheck) return;
    this.nextAccountIdentityCheck = Date.now() + 60_000;
    this.accountIdentityCheck = (async () => {
      if (!await this.currentAccountSource!.hasChanged()) return;
      this.usageAccountRevision++;
      this.usageIdentityPending = true;
      this.codexUsage = staleCodexUsage(this.codexUsage, 'Account identity is being checked.');
      this.emitSnapshot();
      if (this.codexUsageRefreshPromise) this.accountRefreshQueued = true;
      else await this.refreshCodexUsage();
    })().catch(() => { /* A failed local identity check must not relabel quota. */ })
      .finally(() => { this.accountIdentityCheck = null; });
    return this.accountIdentityCheck;
  }

  private observeQuotaUsage(): void {
    if (this.codexUsage.stale) return;
    const usageWindow = this.getPrimaryUsageWindow();
    if (!usageWindow || Date.parse(usageWindow.resetsAt) <= Date.now()) return;
    try {
      this.historyJobReader.listJobs({ usageWindow, observeUsage: true, account: this.codexUsage.account });
    } catch (error) {
      console.error('Could not record quota attribution:', error);
    }
  }
}
