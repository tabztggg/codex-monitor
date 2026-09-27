/** One in-flight read at most. Hidden pages keep data but schedule no new reads. */
export function startVisiblePolling(options: {
  intervalMs: number;
  task: (signal: AbortSignal) => Promise<number | null | void>;
  onSchedule?: (nextAt: number | null) => void;
}): () => void {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let nextAt: number | null = Date.now();

  const schedule = () => {
    clearTimeout(timer);
    if (controller.signal.aborted) return;
    options.onSchedule?.(document.hidden || running ? null : nextAt);
    if (document.hidden || running || nextAt === null) return;
    timer = setTimeout(() => void run(), Math.max(0, nextAt - Date.now()));
  };
  const run = async () => {
    if (controller.signal.aborted || running || document.hidden) return;
    running = true;
    options.onSchedule?.(null);
    let delay: number | null | void;
    try { delay = await options.task(controller.signal); }
    catch { delay = options.intervalMs; }
    finally { running = false; }
    if (controller.signal.aborted) return;
    nextAt = delay === null ? null : Date.now() + (delay ?? options.intervalMs);
    schedule();
  };

  // A current read can finish atomically while hidden; visibility never starts a
  // duplicate read, and returning before the due time preserves the deadline.
  document.addEventListener('visibilitychange', schedule);
  schedule();
  return () => {
    controller.abort();
    clearTimeout(timer);
    document.removeEventListener('visibilitychange', schedule);
  };
}
