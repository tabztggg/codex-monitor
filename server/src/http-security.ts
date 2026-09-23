const LOOPBACK_HOSTS = new Set(["localhost", "[::1]", "::1"]);
const NO_ADDITIONAL_ORIGINS: ReadonlySet<string> = new Set();

export function parseAllowedBrowserOrigins(value: string | undefined): ReadonlySet<string> {
  if (!value?.trim()) return NO_ADDITIONAL_ORIGINS;

  const origins = new Set<string>();
  for (const [index, raw] of value.split(",").entries()) {
    const entry = raw.trim();
    const invalidEntry = () => new Error(
      `CODEX_MONITOR_ALLOWED_ORIGINS entry ${index + 1} must be an HTTP(S) origin without paths, queries, fragments, credentials, or wildcards.`
    );
    // Accept an optional root slash, but do not let URL parsing silently fix
    // paths, backslashes, whitespace or credential syntax in configuration.
    if (!/^https?:\/\/[^/?#\\\s@*]+\/?$/i.test(entry)) throw invalidEntry();

    let parsed: URL;
    try {
      parsed = new URL(entry);
    } catch {
      throw invalidEntry();
    }
    if (parsed.hostname.includes("*")) throw invalidEntry();
    origins.add(parsed.origin);
  }
  return origins;
}

export function isAllowedBrowserOrigin(
  origin: string | undefined,
  serverOrigin?: string,
  additionalOrigins: ReadonlySet<string> = NO_ADDITIONAL_ORIGINS
): boolean {
  if (!origin) {
    return true;
  }

  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return false;
  }

  return isLoopbackHost(parsed.hostname) || origin === serverOrigin || additionalOrigins.has(origin);
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return LOOPBACK_HOSTS.has(normalized) || isIpv4Loopback(normalized);
}

function isIpv4Loopback(hostname: string): boolean {
  const parts = hostname.split(".");
  if (parts.length !== 4 || parts[0] !== "127") {
    return false;
  }

  return parts.every((part) => {
    if (!/^\d+$/.test(part)) {
      return false;
    }

    const value = Number(part);
    return value >= 0 && value <= 255;
  });
}
