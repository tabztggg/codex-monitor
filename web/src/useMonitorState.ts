import { useEffect, useState } from "react";
import type { MonitorSnapshot } from "../../shared/monitor";
import { startMonitorConnection } from "./monitor-connection";

export function useMonitorState() {
  const [snapshot, setSnapshot] = useState<MonitorSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connectionLabel, setConnectionLabel] = useState("connecting");

  useEffect(() => startMonitorConnection({
    snapshot: setSnapshot,
    error: setError,
    connectionLabel: setConnectionLabel
  }), []);

  return {
    snapshot,
    error,
    connectionLabel
  };
}
