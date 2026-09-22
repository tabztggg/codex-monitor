const LOOPBACK_HOSTS = new Set(["localhost", "[::1]", "::1"]);

export function isAllowedBrowserOrigin(
  origin: string | undefined,
  serverOrigin?: string
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

  return isLoopbackHost(parsed.hostname) || origin === serverOrigin;
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
