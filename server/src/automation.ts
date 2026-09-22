import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  ActiveSession,
  ActiveShutdownState,
  GlobalAutomation,
  RunAutomationPolicy
} from "../../shared/monitor";
import {
  DEFAULT_AUTOMATION_POLICY,
  DEFAULT_AUTOMATION_STATE,
  isoNow
} from "../../shared/monitor";
import { MonitorStore } from "./store";

const execFileAsync = promisify(execFile);

export class AutomationController {
  private readonly debounceTimers = new Map<string, NodeJS.Timeout>();
  private globalDebounceTimer: NodeJS.Timeout | null = null;
  private activeShutdown: ActiveShutdownState;
  private globalPolicy: RunAutomationPolicy;
  private globalState = structuredClone(DEFAULT_AUTOMATION_STATE);
  private activeSessionCount = 0;
  private shutdownOperation: Promise<void> = Promise.resolve();
  private schedulingShutdown: { scope: "run" | "global"; runId: string | null } | null = null;

  public constructor(
    private readonly store: MonitorStore,
    private readonly options: {
      dryRun?: boolean;
      platform?: NodeJS.Platform;
      runCommand?: (file: string, args: string[]) => Promise<void>;
      now?: () => number;
      onChange?: () => void;
    } = {}
  ) {
    this.globalPolicy = structuredClone(DEFAULT_AUTOMATION_POLICY);
    this.activeShutdown = {
      scope: null,
      runId: null,
      scheduled: false,
      command: null,
      executeAt: null,
      dryRun: this.isDryRun()
    };
  }

  public getActiveShutdown(): ActiveShutdownState {
    return structuredClone(this.activeShutdown);
  }

  public getGlobalAutomation(): GlobalAutomation {
    return {
      policy: structuredClone(this.globalPolicy),
      state: structuredClone(this.globalState)
    };
  }

  public armRun(
    runId: string,
    policyPatch: {
      settleDelayMs?: number;
      shutdownDelaySeconds?: number;
      cancelOnNewActivity?: boolean;
    } = {}
  ): void {
    this.store.setRunAutomationPolicy(runId, {
      enabled: true,
      ...definedPolicyPatch(policyPatch)
    });
    this.store.setRunAutomationState(runId, {
      status: "armed",
      armedAt: isoNow(),
      lastAction: "Automation armed",
      settlesAt: null,
      shutdownAt: null
    });
    this.evaluateAll();
  }

  public armGlobalNoActiveSessions(
    policyPatch: {
      settleDelayMs?: number;
      shutdownDelaySeconds?: number;
      cancelOnNewActivity?: boolean;
    } = {}
  ): void {
    this.globalPolicy = {
      ...this.globalPolicy,
      enabled: true,
      ...definedPolicyPatch(policyPatch)
    };
    this.globalState = {
      ...this.globalState,
      status: "armed",
      armedAt: isoNow(),
      lastAction: "No-active-sessions automation armed",
      settlesAt: null,
      shutdownAt: null
    };
    this.evaluateActiveSessions(this.activeSessionCount);
  }

  public async cancelGlobalAutomation(
    reason = "manual",
    options: { disarm?: boolean } = {}
  ): Promise<void> {
    this.clearGlobalDebounce();

    if (this.isShutdownFor("global")) {
      await this.cancelShutdown(reason, options);
      return;
    }

    if (options.disarm) {
      this.globalPolicy = {
        ...this.globalPolicy,
        enabled: false
      };
    }

    this.globalState = {
      ...this.globalState,
      status: options.disarm
        ? "disabled"
        : this.globalPolicy.enabled
          ? "armed"
          : "disabled",
      shutdownAt: null,
      settlesAt: null,
      lastAction: `Global shutdown canceled (${reason})`
    };
    this.notifyChange();
  }

  public async cancelShutdown(
    reason = "manual",
    options: { disarm?: boolean } = {}
  ): Promise<void> {
    this.clearAllDebounces();
    await this.queueShutdownOperation(() => this.cancelShutdownInternal(reason, options));
  }

  private async cancelShutdownInternal(
    reason: string,
    options: { disarm?: boolean }
  ): Promise<void> {
    this.clearAllDebounces();

    const runId = this.activeShutdown.runId;
    if (this.activeShutdown.scheduled && !this.isDryRun()) {
      try {
        await this.runCommand("shutdown.exe", ["/a"]);
      } catch (error) {
        // ERROR_NO_SHUTDOWN_IN_PROGRESS confirms there is nothing left to cancel.
        if (!(typeof error === "object" && error !== null && "code" in error && error.code === 1116)) {
          const message = error instanceof Error ? error.message : String(error);
          const lastAction = `Shutdown cancellation failed: ${message}`;
          if (runId) this.store.setRunAutomationState(runId, { lastAction });
          if (this.activeShutdown.scope === "global") this.globalState = { ...this.globalState, lastAction };
          this.notifyChange();
          throw error;
        }
      }
    }

    this.finishCancellation(runId, reason, options);
  }

  private clearAllDebounces(): void {
    for (const [, timer] of this.debounceTimers) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    this.clearGlobalDebounce();
  }

  private finishCancellation(runId: string | null, reason: string, options: { disarm?: boolean }): void {
    if (runId) {
      const run = this.store.getRun(runId);
      if (run) {
        if (options.disarm) {
          this.store.setRunAutomationPolicy(runId, { enabled: false });
        }
        this.store.setRunAutomationState(runId, {
          status: options.disarm
            ? "disabled"
            : run.automationPolicy.enabled
              ? "armed"
              : "disabled",
          shutdownAt: null,
          settlesAt: null,
          lastAction: `Shutdown canceled (${reason})`
        });
      }
    }

    if (this.activeShutdown.scope === "global") {
      if (options.disarm) {
        this.globalPolicy = {
          ...this.globalPolicy,
          enabled: false
        };
      }
      this.globalState = {
        ...this.globalState,
        status: options.disarm
          ? "disabled"
          : this.globalPolicy.enabled
            ? "armed"
            : "disabled",
        shutdownAt: null,
        settlesAt: null,
        lastAction: `Global shutdown canceled (${reason})`
      };
    }

    this.activeShutdown = {
      scope: null,
      runId: null,
      scheduled: false,
      command: null,
      executeAt: null,
      dryRun: this.isDryRun()
    };
    this.notifyChange();
  }

  public evaluateAll(): void {
    for (const run of this.store.listRuns()) {
      this.evaluateRun(run.id);
    }
  }

  public evaluateActiveSessions(activeSessions: ActiveSession[] | number): void {
    const activeCount = Array.isArray(activeSessions)
      ? activeSessions.length
      : activeSessions;
    this.activeSessionCount = activeCount;

    if (!this.globalPolicy.enabled) {
      this.clearGlobalDebounce();
      if (this.isShutdownFor("global")) {
        this.cancelOnActivity("global automation disabled");
      }
      this.globalState = {
        ...DEFAULT_AUTOMATION_STATE
      };
      return;
    }

    if (activeCount > 0) {
      this.clearGlobalDebounce();
      if (
        this.globalPolicy.cancelOnNewActivity &&
        this.isShutdownFor("global")
      ) {
        this.cancelOnActivity("new Codex activity");
        return;
      }

      this.globalState = {
        ...this.globalState,
        status: "armed",
        settlesAt: null,
        shutdownAt: null,
        lastAction: "Waiting for active Codex sessions to finish"
      };
      return;
    }

    if (
      this.activeShutdown.scope === "global" &&
      this.activeShutdown.scheduled
    ) {
      this.globalState = {
        ...this.globalState,
        status: "scheduled",
        shutdownAt: this.activeShutdown.executeAt,
        settlesAt: null,
        lastAction: this.activeShutdown.dryRun
          ? "Dry-run shutdown scheduled"
          : "Windows shutdown scheduled"
      };
      return;
    }

    if (this.schedulingShutdown?.scope === "global") return;

    if (this.activeShutdown.scheduled) {
      this.globalState = {
        ...this.globalState,
        status: "armed",
        settlesAt: null,
        shutdownAt: null,
        lastAction: "Another shutdown is already scheduled"
      };
      return;
    }

    if (this.globalDebounceTimer) {
      return;
    }

    const settlesAt = new Date(
      this.now() + this.globalPolicy.settleDelayMs
    ).toISOString();
    this.globalState = {
      ...this.globalState,
      status: "debouncing",
      settlesAt,
      shutdownAt: null,
      lastAction: "No active Codex sessions; waiting before scheduling shutdown"
    };

    this.globalDebounceTimer = setTimeout(() => {
      this.globalDebounceTimer = null;
      void this.scheduleGlobalShutdown();
    }, this.globalPolicy.settleDelayMs);
  }

  private evaluateRun(runId: string): void {
    const run = this.store.getRun(runId);
    if (!run) {
      return;
    }

    if (!run.automationPolicy.enabled) {
      this.clearDebounce(runId);
      if (
        this.isShutdownFor("run", runId)
      ) {
        this.cancelOnActivity("automation disabled");
      }
      this.store.setRunAutomationState(runId, {
        status: "disabled",
        shutdownAt: null,
        settlesAt: null
      });
      return;
    }

    if (run.status === "error") {
      this.clearDebounce(runId);
      this.store.setRunAutomationState(runId, {
        status: "armed",
        settlesAt: null,
        shutdownAt: null,
        lastAction: "Automation paused because the run is in error"
      });
      return;
    }

    if (!run.settled) {
      this.clearDebounce(runId);
      if (
        run.automationPolicy.cancelOnNewActivity &&
        this.isShutdownFor("run", runId)
      ) {
        this.cancelOnActivity("new activity");
      } else {
        this.store.setRunAutomationState(runId, {
          status: "armed",
          settlesAt: null,
          shutdownAt: null
        });
      }
      return;
    }

    if (
      this.activeShutdown.scope === "run" &&
      this.activeShutdown.runId === runId &&
      this.activeShutdown.scheduled
    ) {
      this.store.setRunAutomationState(runId, {
        status: "scheduled",
        shutdownAt: this.activeShutdown.executeAt,
        settlesAt: null,
        lastAction: this.activeShutdown.dryRun
          ? "Dry-run shutdown scheduled"
          : "Windows shutdown scheduled"
      });
      return;
    }

    if (this.schedulingShutdown?.scope === "run" && this.schedulingShutdown.runId === runId) return;

    if (this.debounceTimers.has(runId)) {
      return;
    }

    const settlesAt = new Date(
      this.now() + run.automationPolicy.settleDelayMs
    ).toISOString();
    this.store.setRunAutomationState(runId, {
      status: "debouncing",
      settlesAt,
      shutdownAt: null,
      lastAction: "Run settled; waiting before scheduling shutdown"
    });

    const timer = setTimeout(() => {
      this.debounceTimers.delete(runId);
      void this.scheduleShutdown(runId);
    }, run.automationPolicy.settleDelayMs);
    this.debounceTimers.set(runId, timer);
  }

  private clearDebounce(runId: string): void {
    const timer = this.debounceTimers.get(runId);
    if (!timer) {
      return;
    }

    clearTimeout(timer);
    this.debounceTimers.delete(runId);
  }

  private clearGlobalDebounce(): void {
    if (!this.globalDebounceTimer) {
      return;
    }

    clearTimeout(this.globalDebounceTimer);
    this.globalDebounceTimer = null;
  }

  private async scheduleShutdown(runId: string): Promise<void> {
    await this.queueShutdownOperation(async () => {
      this.schedulingShutdown = { scope: "run", runId };
      try {
        await this.scheduleRunShutdownInternal(runId);
      } finally {
        this.schedulingShutdown = null;
      }
    });
  }

  private async scheduleRunShutdownInternal(runId: string): Promise<void> {
    const run = this.store.getRun(runId);
    if (!run || !run.settled || !run.automationPolicy.enabled) {
      return;
    }

    if (
      this.activeShutdown.scheduled &&
      (this.activeShutdown.scope !== "run" || this.activeShutdown.runId !== runId)
    ) {
      try {
        await this.cancelShutdownInternal("replaced by a newer run", {});
      } catch {
        return;
      }
    }

    const seconds = run.automationPolicy.shutdownDelaySeconds;
    const executeAt = new Date(this.now() + seconds * 1000).toISOString();
    const args = ["/s", "/t", String(seconds)];

    if (!this.isDryRun()) {
      try {
        console.log(`Scheduling Windows shutdown: shutdown.exe ${args.join(" ")}`);
        await this.runCommand("shutdown.exe", args);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Failed to schedule Windows shutdown: ${message}`);
        this.store.setRunAutomationState(runId, {
          status: "armed",
          shutdownAt: null,
          settlesAt: null,
          lastAction: `Shutdown command failed: ${message}`
        });
        this.notifyChange();
        return;
      }
    }

    this.activeShutdown = {
      scope: "run",
      runId,
      scheduled: true,
      command: `shutdown.exe ${args.join(" ")}`,
      executeAt,
      dryRun: this.isDryRun()
    };

    this.store.setRunAutomationState(runId, {
      status: "scheduled",
      shutdownAt: executeAt,
      settlesAt: null,
      lastAction: this.isDryRun()
        ? "Dry-run shutdown scheduled"
        : "Windows shutdown scheduled"
    });
    this.notifyChange();
  }

  private async scheduleGlobalShutdown(): Promise<void> {
    await this.queueShutdownOperation(async () => {
      this.schedulingShutdown = { scope: "global", runId: null };
      try {
        await this.scheduleGlobalShutdownInternal();
      } finally {
        this.schedulingShutdown = null;
      }
    });
  }

  private async scheduleGlobalShutdownInternal(): Promise<void> {
    if (
      !this.globalPolicy.enabled ||
      this.activeSessionCount > 0 ||
      this.activeShutdown.scheduled
    ) {
      return;
    }

    const seconds = this.globalPolicy.shutdownDelaySeconds;
    const executeAt = new Date(this.now() + seconds * 1000).toISOString();
    const args = ["/s", "/t", String(seconds)];

    if (!this.isDryRun()) {
      try {
        console.log(`Scheduling Windows shutdown: shutdown.exe ${args.join(" ")}`);
        await this.runCommand("shutdown.exe", args);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Failed to schedule Windows shutdown: ${message}`);
        this.globalState = {
          ...this.globalState,
          status: "armed",
          shutdownAt: null,
          settlesAt: null,
          lastAction: `Shutdown command failed: ${message}`
        };
        this.notifyChange();
        return;
      }
    }

    this.activeShutdown = {
      scope: "global",
      runId: null,
      scheduled: true,
      command: `shutdown.exe ${args.join(" ")}`,
      executeAt,
      dryRun: this.isDryRun()
    };

    this.globalState = {
      ...this.globalState,
      status: "scheduled",
      shutdownAt: executeAt,
      settlesAt: null,
      lastAction: this.isDryRun()
        ? "Dry-run shutdown scheduled"
        : "Windows shutdown scheduled"
    };
    this.notifyChange();
  }

  private async runCommand(file: string, args: string[]): Promise<void> {
    if (this.options.runCommand) {
      await this.options.runCommand(file, args);
      return;
    }

    await execFileAsync(file, args);
  }

  private queueShutdownOperation(operation: () => Promise<void>): Promise<void> {
    const result = this.shutdownOperation.then(operation);
    this.shutdownOperation = result.catch(() => {});
    return result;
  }

  private isShutdownFor(scope: "run" | "global", runId: string | null = null): boolean {
    return [this.activeShutdown, this.schedulingShutdown].some(
      (shutdown) => shutdown?.scope === scope && shutdown.runId === runId
    );
  }

  private cancelOnActivity(reason: string): void {
    // Cancellation errors remain visible in automation state; do not create an
    // unhandled rejection from polling or notification callbacks.
    void this.cancelShutdown(reason).catch(() => {});
  }

  private isDryRun(): boolean {
    if (typeof this.options.dryRun === "boolean") {
      return this.options.dryRun;
    }

    const dryRunOverride = process.env.CODEX_MONITOR_DRY_RUN?.toLowerCase();
    if (dryRunOverride === "1" || dryRunOverride === "true") {
      return true;
    }

    if (dryRunOverride === "0" || dryRunOverride === "false") {
      return false;
    }

    if ((this.options.platform ?? process.platform) !== "win32") {
      return true;
    }

    return process.env.NODE_ENV !== "production";
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private notifyChange(): void {
    this.options.onChange?.();
  }
}

function definedPolicyPatch(
  policyPatch: {
    settleDelayMs?: number;
    shutdownDelaySeconds?: number;
    cancelOnNewActivity?: boolean;
  }
): Partial<RunAutomationPolicy> {
  const result: Partial<RunAutomationPolicy> = {};

  if (
    typeof policyPatch.settleDelayMs === "number" &&
    Number.isFinite(policyPatch.settleDelayMs) &&
    policyPatch.settleDelayMs >= 0
  ) {
    result.settleDelayMs = policyPatch.settleDelayMs;
  }

  if (
    typeof policyPatch.shutdownDelaySeconds === "number" &&
    Number.isFinite(policyPatch.shutdownDelaySeconds) &&
    policyPatch.shutdownDelaySeconds >= 0
  ) {
    result.shutdownDelaySeconds = policyPatch.shutdownDelaySeconds;
  }

  if (typeof policyPatch.cancelOnNewActivity === "boolean") {
    result.cancelOnNewActivity = policyPatch.cancelOnNewActivity;
  }

  return result;
}
