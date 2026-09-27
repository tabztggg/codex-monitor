/** Token reports received locally since this Monitor process started. */
export interface LiveTokenWindow {
  seconds: 60 | 300 | 1200 | 3600;
  /** Read/report gaps only invalidate windows that still contain the gap. */
  status: 'collecting' | 'ready' | 'unavailable';
  inputTokens: number;
  outputTokens: number;
  /** Subset of inputTokens, not additional input. */
  cachedInputTokens: number;
  /** Subset of outputTokens, not additional output. */
  reasoningOutputTokens: number;
  totalTokens: number;
  sampleCount: number;
  taskCount: number;
}

export interface LiveTokenSnapshot {
  startedAt: string;
  updatedAt: string;
  lastEventAt: string | null;
  status: 'collecting' | 'ready' | 'unavailable';
  /** Local chats across accounts; logs do not establish the current account. */
  scope: 'local';
  windows: {
    oneMinute: LiveTokenWindow;
    fiveMinutes: LiveTokenWindow;
    twentyMinutes: LiveTokenWindow;
    oneHour: LiveTokenWindow;
  };
}
