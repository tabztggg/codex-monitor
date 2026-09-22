import { AutomationController } from "../automation";
import { MonitorStore } from "../store";

describe("AutomationController", () => {
  afterEach(() => vi.useRealTimers());

  it.each(["manual", "new activity"])("cancels an in-flight global shutdown after %s", async (reason) => {
    vi.useFakeTimers();
    let finishSchedule!: () => void;
    const calls: string[] = [];
    const controller = new AutomationController(new MonitorStore(), {
      dryRun: false,
      runCommand: async (file, args) => {
        calls.push([file, ...args].join(" "));
        if (args[0] === "/s") await new Promise<void>((resolve) => { finishSchedule = resolve; });
      }
    });
    controller.armGlobalNoActiveSessions({ settleDelayMs: 10, shutdownDelaySeconds: 60 });
    await vi.advanceTimersByTimeAsync(10);
    const canceled = reason === "manual"
      ? controller.cancelGlobalAutomation("manual", { disarm: true })
      : (controller.evaluateActiveSessions(1), Promise.resolve());
    expect(calls).toEqual(["shutdown.exe /s /t 60"]);
    finishSchedule();
    await canceled;
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(["shutdown.exe /s /t 60", "shutdown.exe /a"]);
    expect(controller.getActiveShutdown().scheduled).toBe(false);
    expect(controller.getGlobalAutomation().policy.enabled).toBe(reason !== "manual");
  });

  it("cancels an in-flight run shutdown when the run resumes", async () => {
    vi.useFakeTimers();
    let finishSchedule!: () => void;
    const calls: string[] = [];
    const store = new MonitorStore();
    const run = store.createRun("root", { prompt: "Work", cwd: "C:/repo" });
    store.upsertThreadFromRaw({ id: "root", status: { type: "idle" } }, run.id);
    const controller = new AutomationController(store, {
      dryRun: false,
      runCommand: async (file, args) => {
        calls.push([file, ...args].join(" "));
        if (args[0] === "/s") await new Promise<void>((resolve) => { finishSchedule = resolve; });
      }
    });
    controller.armRun(run.id, { settleDelayMs: 10, shutdownDelaySeconds: 60 });
    await vi.advanceTimersByTimeAsync(10);
    store.applyRpcNotification({ method: "thread/status/changed", params: { threadId: "root", status: { type: "active", activeFlags: [] } } });
    controller.evaluateAll();
    finishSchedule();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(["shutdown.exe /s /t 60", "shutdown.exe /a"]);
    expect(controller.getActiveShutdown().scheduled).toBe(false);
  });

  it("keeps a shutdown visible and rejects cancellation when Windows denies the abort", async () => {
    vi.useFakeTimers();
    const controller = new AutomationController(new MonitorStore(), {
      dryRun: false,
      runCommand: async (_file, args) => {
        if (args[0] === "/a") throw Object.assign(new Error("Access denied"), { code: 5 });
      }
    });
    controller.armGlobalNoActiveSessions({ settleDelayMs: 10, shutdownDelaySeconds: 60 });
    await vi.advanceTimersByTimeAsync(10);
    await expect(controller.cancelGlobalAutomation("manual", { disarm: true })).rejects.toThrow("Access denied");
    expect(controller.getActiveShutdown().scheduled).toBe(true);
    expect(controller.getGlobalAutomation().state.lastAction).toContain("Shutdown cancellation failed");
  });

  it("accepts the specific Windows no-shutdown-pending result", async () => {
    vi.useFakeTimers();
    const controller = new AutomationController(new MonitorStore(), {
      dryRun: false,
      runCommand: async (_file, args) => {
        if (args[0] === "/a") throw Object.assign(new Error("No shutdown in progress"), { code: 1116 });
      }
    });
    controller.armGlobalNoActiveSessions({ settleDelayMs: 10, shutdownDelaySeconds: 60 });
    await vi.advanceTimersByTimeAsync(10);
    await controller.cancelGlobalAutomation("manual", { disarm: true });
    expect(controller.getActiveShutdown().scheduled).toBe(false);
    expect(controller.getGlobalAutomation().policy.enabled).toBe(false);
  });

  it("debounces and schedules shutdown once a run settles", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-08T20:00:00Z"));

    const calls: string[] = [];
    const store = new MonitorStore();
    const run = store.createRun("thr_root", {
      prompt: "Finish the work",
      cwd: "C:/repo"
    });
    store.upsertThreadFromRaw(
      {
        id: "thr_root",
        status: { type: "idle" }
      },
      run.id
    );

    const controller = new AutomationController(store, {
      dryRun: false,
      now: () => Date.now(),
      runCommand: async (file, args) => {
        calls.push([file, ...args].join(" "));
      }
    });

    controller.armRun(run.id, {
      settleDelayMs: 1000,
      shutdownDelaySeconds: 60
    });

    expect(store.getRun(run.id)?.automationState.status).toBe("debouncing");

    await vi.advanceTimersByTimeAsync(1000);

    expect(calls).toContain("shutdown.exe /s /t 60");
    expect(store.getRun(run.id)?.automationState.status).toBe("scheduled");

    vi.useRealTimers();
  });

  it("cancels a scheduled shutdown when new activity arrives", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-08T21:00:00Z"));

    const calls: string[] = [];
    const store = new MonitorStore();
    const run = store.createRun("thr_root", {
      prompt: "Keep watching",
      cwd: "C:/repo"
    });
    store.upsertThreadFromRaw(
      {
        id: "thr_root",
        status: { type: "idle" }
      },
      run.id
    );

    const controller = new AutomationController(store, {
      dryRun: false,
      now: () => Date.now(),
      runCommand: async (file, args) => {
        calls.push([file, ...args].join(" "));
      }
    });

    controller.armRun(run.id, {
      settleDelayMs: 10,
      shutdownDelaySeconds: 60
    });
    await vi.advanceTimersByTimeAsync(10);

    store.applyRpcNotification({
      method: "thread/status/changed",
      params: {
        threadId: "thr_root",
        status: { type: "active", activeFlags: [] }
      }
    });
    controller.evaluateAll();
    await Promise.resolve();

    expect(calls).toContain("shutdown.exe /a");

    vi.useRealTimers();
  });

  it("schedules shutdown when the global no-active-sessions rule settles", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-08T22:00:00Z"));

    const calls: string[] = [];
    const store = new MonitorStore();
    const controller = new AutomationController(store, {
      dryRun: false,
      now: () => Date.now(),
      runCommand: async (file, args) => {
        calls.push([file, ...args].join(" "));
      }
    });

    controller.armGlobalNoActiveSessions({
      settleDelayMs: 1000,
      shutdownDelaySeconds: 60
    });

    expect(controller.getGlobalAutomation().state.status).toBe("debouncing");

    await vi.advanceTimersByTimeAsync(1000);

    expect(calls).toContain("shutdown.exe /s /t 60");
    expect(controller.getActiveShutdown()).toMatchObject({
      scope: "global",
      scheduled: true
    });
    expect(controller.getGlobalAutomation().state.status).toBe("scheduled");

    vi.useRealTimers();
  });

  it("keeps default global delays when arming with an empty request", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-08T22:30:00Z"));

    const calls: string[] = [];
    const store = new MonitorStore();
    const controller = new AutomationController(store, {
      dryRun: false,
      now: () => Date.now(),
      runCommand: async (file, args) => {
        calls.push([file, ...args].join(" "));
      }
    });

    controller.armGlobalNoActiveSessions({});

    expect(controller.getGlobalAutomation().state.status).toBe("debouncing");

    await vi.advanceTimersByTimeAsync(30000);

    expect(calls).toContain("shutdown.exe /s /t 60");

    vi.useRealTimers();
  });

  it("allows CODEX_MONITOR_DRY_RUN=0 to force real shutdown mode", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-08T22:35:00Z"));

    const originalDryRun = process.env.CODEX_MONITOR_DRY_RUN;
    const originalNodeEnv = process.env.NODE_ENV;
    try {
      process.env.CODEX_MONITOR_DRY_RUN = "0";
      delete process.env.NODE_ENV;

      const calls: string[] = [];
      const store = new MonitorStore();
      const controller = new AutomationController(store, {
        now: () => Date.now(),
        runCommand: async (file, args) => {
          calls.push([file, ...args].join(" "));
        }
      });

      controller.armGlobalNoActiveSessions({
        settleDelayMs: 10,
        shutdownDelaySeconds: 60
      });
      await vi.advanceTimersByTimeAsync(10);

      expect(calls).toContain("shutdown.exe /s /t 60");
      expect(controller.getActiveShutdown().dryRun).toBe(false);
    } finally {
      if (originalDryRun === undefined) {
        delete process.env.CODEX_MONITOR_DRY_RUN;
      } else {
        process.env.CODEX_MONITOR_DRY_RUN = originalDryRun;
      }
      if (originalNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = originalNodeEnv;
      }
      vi.useRealTimers();
    }
  });

  it("keeps shutdown automation in dry-run mode by default off Windows", () => {
    const originalDryRun = process.env.CODEX_MONITOR_DRY_RUN;
    const originalNodeEnv = process.env.NODE_ENV;
    try {
      delete process.env.CODEX_MONITOR_DRY_RUN;
      process.env.NODE_ENV = "production";

      const store = new MonitorStore();
      const controller = new AutomationController(store, {
        platform: "linux"
      });

      expect(controller.getActiveShutdown().dryRun).toBe(true);
    } finally {
      if (originalDryRun === undefined) {
        delete process.env.CODEX_MONITOR_DRY_RUN;
      } else {
        process.env.CODEX_MONITOR_DRY_RUN = originalDryRun;
      }
      if (originalNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = originalNodeEnv;
      }
    }
  });

  it("keeps default run delays when arming with an empty request", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-08T22:45:00Z"));

    const calls: string[] = [];
    const store = new MonitorStore();
    const run = store.createRun("thr_root", {
      prompt: "Finish the work",
      cwd: "C:/repo"
    });
    store.upsertThreadFromRaw(
      {
        id: "thr_root",
        status: { type: "idle" }
      },
      run.id
    );

    const controller = new AutomationController(store, {
      dryRun: false,
      now: () => Date.now(),
      runCommand: async (file, args) => {
        calls.push([file, ...args].join(" "));
      }
    });

    controller.armRun(run.id, {});

    expect(store.getRun(run.id)?.automationState.status).toBe("debouncing");

    await vi.advanceTimersByTimeAsync(30000);

    expect(calls).toContain("shutdown.exe /s /t 60");

    vi.useRealTimers();
  });

  it("cancels a global scheduled shutdown when a Codex session appears", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-08T23:00:00Z"));

    const calls: string[] = [];
    const store = new MonitorStore();
    const controller = new AutomationController(store, {
      dryRun: false,
      now: () => Date.now(),
      runCommand: async (file, args) => {
        calls.push([file, ...args].join(" "));
      }
    });

    controller.armGlobalNoActiveSessions({
      settleDelayMs: 10,
      shutdownDelaySeconds: 60
    });
    await vi.advanceTimersByTimeAsync(10);

    controller.evaluateActiveSessions([
      {
        id: "019d773d-49eb-7ae0-9327-ff3b0b39c7a7",
        name: "VS Code task",
        preview: "Keep working",
        cwd: "C:/repo",
        createdAt: null,
        updatedAt: "2026-04-08T23:00:01.000Z",
        lastTurnStartedAt: "2026-04-08T23:00:00.000Z"
      }
    ]);

    await vi.waitFor(() =>
      expect(controller.getActiveShutdown().scheduled).toBe(false)
    );
    expect(calls).toContain("shutdown.exe /a");
    expect(controller.getGlobalAutomation().state.status).toBe("armed");

    vi.useRealTimers();
  });
});
