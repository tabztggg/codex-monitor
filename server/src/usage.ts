import type {
  CodexUsageCredits,
  CodexUsageLimit,
  CodexUsageSnapshot,
  CodexUsageWindow
} from "../../shared/monitor";
import { asBoolean, asRecord, asString, cloneValue, isoNow, toIsoDate } from "./utils";

// Only forward display fields, never the raw auth response or credentials.
export function usageAccount(response: unknown): NonNullable<CodexUsageSnapshot['account']> | null {
  const account = asRecord(asRecord(response)?.account);
  const type = asString(account?.type);
  return type ? { type, email: asString(account?.email), planType: asString(account?.planType) } : null;
}

export function staleCodexUsage(previous: CodexUsageSnapshot, error: string): CodexUsageSnapshot {
  return previous.limits.length ? { ...cloneValue(previous), stale: true, error }
    : emptyCodexUsage('error', error);
}

export async function readAccountUsage(client: { request(method: string, params?: unknown): Promise<unknown> }, previous?: CodexUsageSnapshot): Promise<CodexUsageSnapshot> {
  const readAccount = async () => {
    try { return { ok: true, account: usageAccount(await client.request('account/read', { refreshToken: false })) }; }
    catch { return { ok: false, account: null }; }
  };
  const before = await readAccount();
  let result: CodexUsageSnapshot;
  try { result = codexUsageFromRateLimitsRead(await client.request('account/rateLimits/read')); }
  catch (error) { result = emptyCodexUsage('error', error instanceof Error ? error.message : String(error)); }
  const after = await readAccount();
  // An identity change during the request must not relabel old quota data.
  if (before.ok && after.ok && JSON.stringify(before.account) !== JSON.stringify(after.account)) {
    return emptyCodexUsage('unavailable', 'Account changed while reading usage. Waiting for the next refresh.');
  }
  if (result.status !== 'available' && previous?.limits.length) {
    const known = [before, after].filter(read => read.ok);
    // An unreadable identity leaves the retained snapshot explicitly attached to
    // its old account. A confirmed logout/different account must never reuse it.
    if (known.every(read => read.account !== null && JSON.stringify(read.account) === JSON.stringify(previous.account))) {
      return staleCodexUsage(previous, result.error ?? 'Codex did not return rate limit data.');
    }
  }
  return { ...result, account: before.ok && after.ok ? after.account : null };
}

export function emptyCodexUsage(
  status: CodexUsageSnapshot["status"] = "loading",
  error: string | null = null
): CodexUsageSnapshot {
  return {
    status,
    updatedAt: null,
    error,
    primaryLimit: null,
    limits: []
  };
}

export function codexUsageFromRateLimitsRead(
  response: unknown,
  updatedAt = isoNow()
): CodexUsageSnapshot {
  const record = asRecord(response);
  const legacyLimit = normalizeRateLimit(record?.rateLimits);
  const limitsById = asRecord(record?.rateLimitsByLimitId);
  const limits = limitsById
    ? Object.entries(limitsById)
        .map(([id, value]) => normalizeRateLimit(value, id))
        .filter((value): value is CodexUsageLimit => Boolean(value))
    : [];

  if (legacyLimit && !limits.some((limit) => limit.id === legacyLimit.id)) {
    limits.unshift(legacyLimit);
  }
  const primaryLimit = limits.find(limit => limit.id === 'codex') ??
    limits.find(limit => limit.id === legacyLimit?.id) ?? limits[0] ?? null;

  return {
    status: primaryLimit ? "available" : "unavailable",
    updatedAt,
    error: primaryLimit ? null : "Codex did not return rate limit data.",
    primaryLimit,
    limits
  };
}

export function codexUsageFromRateLimitsUpdated(
  params: unknown,
  previous: CodexUsageSnapshot,
  updatedAt = isoNow()
): CodexUsageSnapshot {
  const limit = normalizeRateLimit(asRecord(params)?.rateLimits);
  if (!limit) {
    return {
      ...cloneValue(previous),
      status: previous.limits.length ? previous.status : 'error',
      stale: previous.limits.length > 0,
      error: "Codex sent malformed rate limit data."
    };
  }

  const limits = upsertLimit(previous.limits, limit);
  const primaryLimit =
    !previous.primaryLimit ||
    previous.primaryLimit.id === limit.id ||
    limit.id === "codex"
      ? limit
      : previous.primaryLimit;

  return {
    status: "available",
    account: previous.account ?? null,
    updatedAt,
    error: null,
    primaryLimit,
    limits
  };
}

function normalizeRateLimit(value: unknown, fallbackId = "codex"): CodexUsageLimit | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const id = asString(record.limitId) ?? fallbackId;
  return {
    id,
    name: asString(record.limitName),
    planType: asString(record.planType),
    primary: normalizeWindow(record.primary),
    secondary: normalizeWindow(record.secondary),
    credits: normalizeCredits(record.credits),
    rateLimitReachedType: asString(record.rateLimitReachedType)
  };
}

function normalizeWindow(value: unknown): CodexUsageWindow | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const rawUsedPercent = asFiniteNumber(record.usedPercent);
  const usedPercent =
    rawUsedPercent === null ? null : clampPercent(rawUsedPercent);
  const duration = asFiniteNumber(record.windowDurationMins);

  return {
    label: labelForWindowDuration(duration),
    usedPercent,
    remainingPercent:
      usedPercent === null ? null : clampPercent(100 - usedPercent),
    windowDurationMins: duration,
    resetsAt: toIsoDate(record.resetsAt)
  };
}

function normalizeCredits(value: unknown): CodexUsageCredits | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  return {
    hasCredits: asBoolean(record.hasCredits),
    unlimited: asBoolean(record.unlimited),
    balance:
      typeof record.balance === "number"
        ? String(record.balance)
        : asString(record.balance)
  };
}

function upsertLimit(
  existing: CodexUsageLimit[],
  nextLimit: CodexUsageLimit
): CodexUsageLimit[] {
  const next = existing.filter((limit) => limit.id !== nextLimit.id);
  next.push(nextLimit);
  return next;
}

function labelForWindowDuration(durationMins: number | null): string {
  if (durationMins === 300) {
    return "5-hour";
  }

  if (durationMins === 10080) {
    return "Weekly";
  }

  if (durationMins && durationMins % 1440 === 0) {
    return `${durationMins / 1440}-day`;
  }

  if (durationMins && durationMins % 60 === 0) {
    return `${durationMins / 60}-hour`;
  }

  return durationMins ? `${durationMins}-minute` : "Window";
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}
