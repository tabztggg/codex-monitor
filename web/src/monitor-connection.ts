import type { MonitorSnapshot } from "../../shared/monitor";
import { api } from "./api";

const INITIAL_RETRY_MS = 1_500;
const MAX_RETRY_MS = 60_000;
const CONNECTION_TIMEOUT_MS = 30_000;
const STABLE_CONNECTION_MS = 30_000;

/** Own one snapshot request/socket at a time, including across reconnects. */
export function startMonitorConnection(callbacks: {
  snapshot(value: MonitorSnapshot): void;
  error(value: string | null): void;
  connectionLabel(value: string): void;
}): () => void {
  let disposed = false;
  let generation = 0;
  let retryDelay = INITIAL_RETRY_MS;
  let socket: WebSocket | null = null;
  let request: AbortController | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let stableTimer: ReturnType<typeof setTimeout> | undefined;
  const isCurrent = (attempt: number) => !disposed && attempt === generation;

  function clearConnection() {
    clearTimeout(deadlineTimer);
    clearTimeout(stableTimer);
    request?.abort();
    request = null;
    if (socket) {
      socket.onopen = socket.onclose = socket.onerror = socket.onmessage = null;
      socket.close();
      socket = null;
    }
  }

  function retry(attempt: number) {
    if (!isCurrent(attempt)) return;
    generation++;
    clearConnection();
    callbacks.connectionLabel("reconnecting");
    retryTimer = setTimeout(() => void connect(), retryDelay);
    retryDelay = Math.min(retryDelay * 2, MAX_RETRY_MS);
  }

  async function connect() {
    if (disposed) return;
    const attempt = ++generation;
    request = new AbortController();
    deadlineTimer = setTimeout(() => {
      if (!isCurrent(attempt)) return;
      callbacks.error("Monitor snapshot request timed out.");
      retry(attempt);
    }, CONNECTION_TIMEOUT_MS);
    try {
      const next = await api.fetchSnapshot(request.signal);
      if (!isCurrent(attempt)) return;
      callbacks.snapshot(next);
      callbacks.error(null);
    } catch (error) {
      if (isCurrent(attempt)) {
        callbacks.error(error instanceof Error ? error.message : String(error));
        retry(attempt);
      }
      return;
    }
    if (!isCurrent(attempt)) return;
    clearTimeout(deadlineTimer);
    request = null;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    let current: WebSocket;
    try {
      current = new WebSocket(`${protocol}//${window.location.host}/ws`);
      socket = current;
    } catch (error) {
      callbacks.error(error instanceof Error ? error.message : String(error));
      retry(attempt);
      return;
    }
    deadlineTimer = setTimeout(() => {
      if (!isCurrent(attempt)) return;
      callbacks.error("Monitor WebSocket connection timed out.");
      retry(attempt);
    }, CONNECTION_TIMEOUT_MS);

    current.onopen = () => {
      if (!isCurrent(attempt)) return;
      clearTimeout(deadlineTimer);
      callbacks.connectionLabel("live");
      // Brief opens during an outage must not restart aggressive polling.
      stableTimer = setTimeout(() => {
        if (isCurrent(attempt) && current.readyState === WebSocket.OPEN) {
          retryDelay = INITIAL_RETRY_MS;
        }
      }, STABLE_CONNECTION_MS);
    };
    current.onmessage = (event) => {
      if (!isCurrent(attempt)) return;
      try {
        const message = JSON.parse(event.data) as { type: string; payload?: MonitorSnapshot };
        if (message.type === "snapshot" && message.payload) {
          callbacks.snapshot(message.payload);
          callbacks.error(null);
        }
      } catch (error) {
        callbacks.error(error instanceof Error ? error.message : String(error));
      }
    };
    current.onerror = () => retry(attempt);
    current.onclose = () => retry(attempt);
  }

  void connect();
  return () => {
    disposed = true;
    generation++;
    clearTimeout(retryTimer);
    clearConnection();
  };
}
