import type {
  ArmAutomationRequest,
  ArmGlobalAutomationRequest,
  HistoryJobListResponse,
  HistoryArchiveMode,
  HistoryPeriod,
  HistoryJobSortKey,
  HistoryThreadListResponse,
  MonitorSnapshot,
  OfficialTaskUsage,
  RunSnapshot,
  SortDirection
} from "../../shared/monitor";

async function jsonFetch<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    headers: {
      "Content-Type": "application/json"
    },
    ...init
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as
      | { error?: string }
      | null;
    throw new Error(payload?.error ?? `Request failed with ${response.status}`);
  }

  return (await response.json()) as T;
}

export const api = {
  fetchOfficialTaskUsage(id: string, signal?: AbortSignal): Promise<OfficialTaskUsage> {
    return jsonFetch(`/api/history/jobs/${encodeURIComponent(id)}/official-usage`, { signal });
  },
  fetchSnapshot(signal?: AbortSignal): Promise<MonitorSnapshot> {
    return jsonFetch<MonitorSnapshot>("/api/snapshot", { signal });
  },
  armAutomation(runId: string, body: ArmAutomationRequest): Promise<RunSnapshot> {
    return jsonFetch<RunSnapshot>(`/api/runs/${runId}/automation/arm`, {
      method: "POST",
      body: JSON.stringify(body)
    });
  },
  cancelShutdown(): Promise<MonitorSnapshot> {
    return jsonFetch<MonitorSnapshot>("/api/automation/cancel-shutdown", {
      method: "POST",
      body: JSON.stringify({})
    });
  },
  armGlobalNoActiveSessions(
    body: ArmGlobalAutomationRequest
  ): Promise<MonitorSnapshot> {
    return jsonFetch<MonitorSnapshot>("/api/automation/no-active-sessions/arm", {
      method: "POST",
      body: JSON.stringify(body)
    });
  },
  cancelGlobalNoActiveSessions(): Promise<MonitorSnapshot> {
    return jsonFetch<MonitorSnapshot>(
      "/api/automation/no-active-sessions/cancel",
      {
        method: "POST",
        body: JSON.stringify({})
      }
    );
  },
  fetchHistoryThreads(args: {
    sourceKinds: string[];
    searchTerm?: string;
    limit?: number;
  }): Promise<HistoryThreadListResponse> {
    const params = new URLSearchParams();
    params.set("sourceKinds", args.sourceKinds.join(","));
    params.set("limit", String(args.limit ?? 20));
    if (args.searchTerm) {
      params.set("searchTerm", args.searchTerm);
    }

    return jsonFetch<HistoryThreadListResponse>(
      `/api/history/threads?${params.toString()}`
    );
  },
  fetchHistoryJobs(args: {
    sourceKinds: string[];
    searchTerm?: string;
    cursor?: string | null;
    limit?: number;
    sortKey?: HistoryJobSortKey;
    sortDirection?: SortDirection;
    signal?: AbortSignal;
    archiveMode?: HistoryArchiveMode;
    period?: HistoryPeriod;
    forceRefresh?: boolean;
  }): Promise<HistoryJobListResponse> {
    const params = new URLSearchParams();
    params.set('archives', args.archiveMode ?? 'recent');
    params.set('period', args.period ?? 'quota');
    if (args.forceRefresh && !args.cursor) params.set('forceRefresh', 'true');
    params.set("sourceKinds", args.sourceKinds.join(","));
    params.set("limit", String(args.limit ?? 20));
    if (args.searchTerm) {
      params.set("searchTerm", args.searchTerm);
    }
    if (args.cursor) {
      params.set("cursor", args.cursor);
    }
    if (args.sortKey) {
      params.set("sortKey", args.sortKey);
    }
    if (args.sortDirection) {
      params.set("sortDirection", args.sortDirection);
    }

    return jsonFetch<HistoryJobListResponse>(
      `/api/history/jobs?${params.toString()}`,
      { signal: args.signal }
    );
  }
};
