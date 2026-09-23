import { isAllowedBrowserOrigin, parseAllowedBrowserOrigins } from "../http-security";

describe("parseAllowedBrowserOrigins", () => {
  it("keeps external access disabled when the configuration is absent or blank", () => {
    for (const value of [undefined, "", "   "]) {
      expect([...parseAllowedBrowserOrigins(value)]).toEqual([]);
    }
  });

  it("normalizes root slashes, host casing and default ports, and removes duplicates", () => {
    expect([...parseAllowedBrowserOrigins(
      " HTTP://CodexMonitor.Cpolar.Cn:80/, https://codexmonitor.cpolar.cn, http://codexmonitor.cpolar.cn "
    )]).toEqual(["http://codexmonitor.cpolar.cn", "https://codexmonitor.cpolar.cn"]);
    expect([...parseAllowedBrowserOrigins("https://[::1]:8443/")]).toEqual(["https://[::1]:8443"]);
  });

  it.each([
    "*", "https://*.cpolar.cn", "https://%2A.cpolar.cn", "null", "not a url",
    "file://codexmonitor.cpolar.cn", "ws://codexmonitor.cpolar.cn", "https:codexmonitor.cpolar.cn",
    "https://codexmonitor.cpolar.cn/path", "https://codexmonitor.cpolar.cn/.",
    "https://codexmonitor.cpolar.cn?query=1", "https://codexmonitor.cpolar.cn#fragment",
    "https://user:password@codexmonitor.cpolar.cn", "https://@codexmonitor.cpolar.cn",
    "https://codexmonitor.cpolar.cn\\", "https://codexmonitor. cpolar.cn",
    "https://codexmonitor.cpolar.cn:99999", "https://codexmonitor.cpolar.cn,", ",https://codexmonitor.cpolar.cn"
  ])("rejects invalid origin configuration %s", (value) => {
    expect(() => parseAllowedBrowserOrigins(value)).toThrow(/CODEX_MONITOR_ALLOWED_ORIGINS entry \d+ must be an HTTP\(S\) origin/);
  });

  it("identifies the invalid entry without exposing its contents", () => {
    expect(() => parseAllowedBrowserOrigins("https://example.com,https://user:secret@example.com"))
      .toThrow("CODEX_MONITOR_ALLOWED_ORIGINS entry 2 must be an HTTP(S) origin without paths, queries, fragments, credentials, or wildcards.");
  });
});

describe("isAllowedBrowserOrigin", () => {
  it("allows missing and loopback browser origins", () => {
    expect(isAllowedBrowserOrigin(undefined)).toBe(true);
    expect(isAllowedBrowserOrigin("http://127.0.0.1:5173")).toBe(true);
    expect(isAllowedBrowserOrigin("http://127.42.0.1:5173")).toBe(true);
    expect(isAllowedBrowserOrigin("http://localhost:5173")).toBe(true);
    expect(isAllowedBrowserOrigin("http://[::1]:5173")).toBe(true);
  });

  it("rejects non-loopback and non-http origins", () => {
    expect(isAllowedBrowserOrigin("https://example.com")).toBe(false);
    expect(isAllowedBrowserOrigin("http://127.0.0.1.example.com")).toBe(false);
    expect(isAllowedBrowserOrigin("file://local-dashboard")).toBe(false);
    expect(isAllowedBrowserOrigin("null")).toBe(false);
    expect(isAllowedBrowserOrigin("not a url")).toBe(false);
  });

  it("allows the configured LAN origin only when explicitly provided", () => {
    const serverOrigin = "http://192.0.2.10:4201";
    expect(isAllowedBrowserOrigin(serverOrigin)).toBe(false);
    expect(isAllowedBrowserOrigin(serverOrigin, serverOrigin)).toBe(true);
    expect(isAllowedBrowserOrigin(undefined, serverOrigin)).toBe(true);
    expect(isAllowedBrowserOrigin("http://localhost:5173", serverOrigin)).toBe(true);
  });

  it("does not extend LAN access to other origins or malformed origin values", () => {
    const serverOrigin = "http://192.0.2.10:4201";
    for (const origin of [
      "http://192.0.2.11:4201",
      "http://192.0.2.10:8090",
      "https://192.0.2.10:4201",
      "http://192.0.2.10.example.com:4201",
      "http://192.0.2.10:4201/path",
      "http://user@192.0.2.10:4201",
      "null"
    ]) {
      expect(isAllowedBrowserOrigin(origin, serverOrigin)).toBe(false);
    }
  });

  it("allows only explicitly configured external origins while preserving LAN and loopback", () => {
    const serverOrigin = "http://192.0.2.10:4201";
    const externalOrigin = "https://codexmonitor.cpolar.cn";
    const additionalOrigins = parseAllowedBrowserOrigins(`${externalOrigin}/,http://codexmonitor.cpolar.cn:8080`);
    expect(isAllowedBrowserOrigin(externalOrigin, serverOrigin)).toBe(false);
    for (const origin of [undefined, serverOrigin, "http://localhost:5173", externalOrigin, "http://codexmonitor.cpolar.cn:8080"]) {
      expect(isAllowedBrowserOrigin(origin, serverOrigin, additionalOrigins)).toBe(true);
    }
    for (const origin of [
      "http://codexmonitor.cpolar.cn", "https://codexmonitor.cpolar.cn:8080",
      "https://other.cpolar.cn", "https://sub.codexmonitor.cpolar.cn",
      "https://codexmonitor.cpolar.cn.example.com", "https://codexmonitor.cpolar.cn/path",
      "https://codexmonitor.cpolar.cn?query=1", "https://codexmonitor.cpolar.cn#fragment",
      "https://user@codexmonitor.cpolar.cn", "null"
    ]) {
      expect(isAllowedBrowserOrigin(origin, serverOrigin, additionalOrigins)).toBe(false);
    }
  });
});
