import type { LiveTokenSnapshot, LiveTokenWindow } from '../../shared/live-tokens';
import { asRecord, asString } from './utils';

export const LIVE_TOKEN_WINDOW_MS = 3_600_000;
export const LIVE_TOKEN_READ_INTERVAL_MS = 5_000;
// Retaining a longer time span does not increase the hard memory bound. Reports
// from the same task/read are combined; capacity loss is explicitly unavailable.
const MAX_SAMPLES = 20_000;
const MAX_SAME_TIME_REPORTS = 256;

type Usage = Pick<LiveTokenWindow, 'inputTokens' | 'outputTokens' | 'cachedInputTokens' | 'reasoningOutputTokens' | 'totalTokens'>;
type Sample = { receivedAtMs: number; taskId: string; usage: Usage; count: number };

/** Constant-size counters plus a bounded same-timestamp replay checkpoint; no transcript. */
export type LiveTokenFileState = {
  taskId: string;
  baseline: boolean;
  replaying: boolean;
  hasMetadata: boolean;
  createdAtMs: number | null;
  latestRecordAtMs: number | null;
  previousCumulative: string | null;
  previousUsage: Usage | null;
  checkpointAtMs: number | null;
  checkpointKeys: Set<string>;
  checkpointSaturated: boolean;
};

export function createLiveTokenFileState(taskId: string, baseline: boolean): LiveTokenFileState {
  return {
    taskId, baseline, replaying: false, hasMetadata: false, createdAtMs: null,
    latestRecordAtMs: null, previousCumulative: null, previousUsage: null, checkpointAtMs: null,
    checkpointKeys: new Set(), checkpointSaturated: false
  };
}

/** Memory-only rolling reports. Event arrival time is not model generation time. */
export class LiveTokenMonitor {
  private samples: Sample[] = [];
  private lastEventAtMs: number | null = null;
  private lastUnavailableAtMs = Number.NEGATIVE_INFINITY;

  public constructor(public readonly startedAtMs = Date.now(), private readonly maxSamples = MAX_SAMPLES) {}

  public resetFile(state: LiveTokenFileState): void {
    // Cursor rebuilds also happen for complete JSON records without a newline.
    // Keep the counter/checkpoint so replaying the file cannot replay live usage.
    state.replaying = true;
    state.hasMetadata = false;
    state.createdAtMs = null;
  }

  public finishFile(state: LiveTokenFileState): void {
    state.baseline = false;
    state.replaying = false;
  }

  public consume(state: LiveTokenFileState, record: Record<string, unknown>, nowMs: number): void {
    const payload = asRecord(record.payload);
    const timestamp = parseTimestamp(record.timestamp);
    if (timestamp !== null && timestamp <= nowMs) {
      state.latestRecordAtMs = Math.max(state.latestRecordAtMs ?? timestamp, timestamp);
    }
    if (record.type === 'session_meta') {
      if (!state.hasMetadata) {
        state.hasMetadata = true;
        state.createdAtMs = parseTimestamp(payload?.timestamp) ?? timestamp;
      }
      return;
    }
    if (record.type !== 'event_msg' || payload?.type !== 'token_count') return;
    const info = asRecord(payload.info);
    // Quota-only notifications often have info:null; they must not clear counters.
    if (!info) return;
    const cumulative = parseUsage(info.total_token_usage);
    const increment = parseUsage(info.last_token_usage);
    if (!cumulative || timestamp === null || timestamp > nowMs) {
      if (!state.baseline && (timestamp === null || timestamp >= this.startedAtMs)) this.markUnavailable(nowMs);
      return;
    }
    const key = JSON.stringify([increment, cumulative]);
    if (!state.baseline && state.replaying && state.checkpointAtMs !== null &&
      (timestamp < state.checkpointAtMs || (timestamp === state.checkpointAtMs &&
        (state.checkpointSaturated || state.checkpointKeys.has(key))))) return;

    const cumulativeKey = JSON.stringify(cumulative);
    const duplicate = cumulativeKey === state.previousCumulative;
    const previousUsage = state.previousUsage;
    state.previousCumulative = cumulativeKey;
    state.previousUsage = cumulative;
    this.checkpoint(state, timestamp, key, nowMs);

    // The first directory scan is a baseline, including reports with very recent
    // timestamps. A newly discovered fork can also contain its parent's history.
    const earliest = Math.max(this.startedAtMs, state.createdAtMs ?? this.startedAtMs);
    if (state.baseline || duplicate || timestamp < earliest) return;
    // Compaction/quota refreshes can repeat cumulative counters while last usage
    // is a context-size snapshot (zero input/output with a nonzero total). The
    // unchanged cumulative proves no consumption without interpreting that last
    // value. Changed counters still require a valid measured increment.
    if (!increment) { this.markUnavailable(nowMs); return; }
    // Monotonic cumulative counters must advance by the measured last report.
    // A mismatch proves a missing/inconsistent report, but does not establish
    // when the missing tokens arrived. Never fill the current window with it.
    if (previousUsage && cumulative.inputTokens >= previousUsage.inputTokens &&
      cumulative.outputTokens >= previousUsage.outputTokens &&
      (cumulative.inputTokens - previousUsage.inputTokens !== increment.inputTokens ||
        cumulative.outputTokens - previousUsage.outputTokens !== increment.outputTokens)) this.markUnavailable(nowMs);
    this.addSample(state.taskId, increment, timestamp, nowMs);
  }

  public markUnavailable(nowMs: number): void {
    this.lastUnavailableAtMs = Math.max(this.lastUnavailableAtMs, nowMs);
  }

  public snapshot(nowMs = Date.now(), sourceAvailable = true): LiveTokenSnapshot {
    this.prune(nowMs);
    const windows = {
      oneMinute: this.window(60, nowMs, sourceAvailable),
      fiveMinutes: this.window(300, nowMs, sourceAvailable),
      twentyMinutes: this.window(1200, nowMs, sourceAvailable),
      oneHour: this.window(3600, nowMs, sourceAvailable)
    };
    const states = Object.values(windows).map(window => window.status);
    return {
      startedAt: new Date(this.startedAtMs).toISOString(),
      updatedAt: new Date(nowMs).toISOString(),
      lastEventAt: this.lastEventAtMs === null ? null : new Date(this.lastEventAtMs).toISOString(),
      status: states.includes('ready') ? 'ready' : states.includes('collecting') ? 'collecting' : 'unavailable',
      scope: 'local', windows
    };
  }

  private checkpoint(state: LiveTokenFileState, timestamp: number, key: string, nowMs: number): void {
    if (state.checkpointAtMs === null || timestamp > state.checkpointAtMs) {
      state.checkpointAtMs = timestamp;
      state.checkpointKeys.clear();
      state.checkpointSaturated = false;
    }
    if (timestamp !== state.checkpointAtMs || state.checkpointKeys.has(key)) return;
    if (state.checkpointKeys.size >= MAX_SAME_TIME_REPORTS) {
      state.checkpointSaturated = true;
      if (!state.baseline) this.markUnavailable(nowMs);
      return;
    }
    state.checkpointKeys.add(key);
  }

  private addSample(taskId: string, usage: Usage, eventAtMs: number, nowMs: number): void {
    this.prune(nowMs);
    this.lastEventAtMs = Math.max(this.lastEventAtMs ?? eventAtMs, eventAtMs);
    const last = this.samples.at(-1);
    if (last?.receivedAtMs === nowMs && last.taskId === taskId) {
      addUsage(last.usage, usage);
      last.count++;
      return;
    }
    if (this.samples.length >= this.maxSamples) {
      // Never silently label a capacity-limited window as a complete count.
      this.markUnavailable(nowMs);
      return;
    }
    this.samples.push({ receivedAtMs: nowMs, taskId, usage: { ...usage }, count: 1 });
  }

  private prune(nowMs: number): void {
    this.samples = this.samples.filter(sample => sample.receivedAtMs >= nowMs - LIVE_TOKEN_WINDOW_MS);
  }

  private window(seconds: LiveTokenWindow['seconds'], nowMs: number, sourceAvailable: boolean): LiveTokenWindow {
    const result: LiveTokenWindow = { seconds, status: 'collecting', inputTokens: 0, outputTokens: 0, cachedInputTokens: 0,
      reasoningOutputTokens: 0, totalTokens: 0, sampleCount: 0, taskCount: 0 };
    const tasks = new Set<string>();
    for (const sample of this.samples) {
      if (sample.receivedAtMs < nowMs - seconds * 1000 || sample.receivedAtMs > nowMs) continue;
      addUsage(result, sample.usage);
      result.sampleCount += sample.count;
      tasks.add(sample.taskId);
    }
    result.taskCount = tasks.size;
    const validSums = Object.entries(result).every(([key, value]) =>
      key === 'status' || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0));
    result.status = !sourceAvailable || this.lastUnavailableAtMs >= nowMs - seconds * 1000 || !validSums ? 'unavailable' :
      result.sampleCount > 0 || nowMs - this.startedAtMs >= seconds * 1000 ? 'ready' : 'collecting';
    return result;
  }
}

function parseTimestamp(value: unknown): number | null {
  const text = asString(value);
  if (!text) return null;
  const valueMs = Date.parse(text);
  return Number.isFinite(valueMs) ? valueMs : null;
}

function parseUsage(value: unknown): Usage | null {
  const record = asRecord(value);
  if (!record) return null;
  const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  if (!integer(record.input_tokens) || !integer(record.output_tokens)) return null;
  const inputTokens = record.input_tokens;
  const outputTokens = record.output_tokens;
  const cachedInputTokens = record.cached_input_tokens === undefined ? 0 : record.cached_input_tokens;
  const reasoningOutputTokens = record.reasoning_output_tokens === undefined ? 0 : record.reasoning_output_tokens;
  const totalTokens = record.total_tokens === undefined ? inputTokens + outputTokens : record.total_tokens;
  if (!integer(cachedInputTokens) || !integer(reasoningOutputTokens) || !integer(totalTokens) ||
    cachedInputTokens > inputTokens || reasoningOutputTokens > outputTokens || totalTokens !== inputTokens + outputTokens) return null;
  return { inputTokens, outputTokens, cachedInputTokens, reasoningOutputTokens, totalTokens };
}

function addUsage(target: Usage, value: Usage): void {
  target.inputTokens += value.inputTokens;
  target.outputTokens += value.outputTokens;
  target.cachedInputTokens += value.cachedInputTokens;
  target.reasoningOutputTokens += value.reasoningOutputTokens;
  target.totalTokens += value.totalTokens;
}
