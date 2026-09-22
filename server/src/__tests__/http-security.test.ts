import { isAllowedBrowserOrigin } from "../http-security";

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
});
