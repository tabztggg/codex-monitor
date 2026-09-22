import type {
  CodexUsageCredits,
  CodexUsageLimit,
  CodexUsageSnapshot,
  CodexUsageWindow
} from "../../shared/monitor";
import { asBoolean, asRecord, asString, cloneValue, isoNow, toIsoDate } from "./utils";

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
      status: "error",
      updatedAt,
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
