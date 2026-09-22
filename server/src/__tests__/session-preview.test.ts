import { userPreview } from "../../../shared/session-preview";
import { parseHistorySessionFile } from "../history-jobs";

it("extracts the request after setup before truncating", () => {
  expect(userPreview(`<recommended_plugins>${"setup ".repeat(100)}</recommended_plugins>\nFix the monitor`)).toBe("Fix the monitor");
  expect(userPreview('<realtime_delegation><input>Review my document</input><transcript_delta>context</transcript_delta></realtime_delegation>')).toBe("Review my document");
});

it("preserves the real request after ambient browser context", () => {
  const message = `<in-app-browser-context source="ambient-ui-state">${"browser setup ".repeat(100)}</in-app-browser-context>\n\n## My request:\n修复统计遗漏的聊天`;
  expect(userPreview(message)).toBe("修复统计遗漏的聊天");
  const fileContent = JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: message }] } });
  expect(parseHistorySessionFile({ sessionId: "task", fileContent, updatedAt: new Date().toISOString(), nowMs: Date.now() })?.preview).toBe("修复统计遗漏的聊天");
});

it("does not expose browser context or invent a request when no request is present", () => {
  expect(userPreview('<in-app-browser-context source="ambient-ui-state">Current URL: https://example.com/private</in-app-browser-context>')).toBeNull();
  expect(userPreview('<in-app-browser-context source="ambient-ui-state">Current URL: https://example.com/private</in-app-browser-context>\n## My request:\n')).toBeNull();
  expect(userPreview('<in-app-browser-context source="ambient-ui-state">incomplete context')).toBeNull();
  expect(userPreview('Inspect the <widget> element')).toBe('Inspect the <widget> element');
});

it("does not overwrite a real request with injected context", () => {
  const fileContent = ["Fix the monitor", "<environment_context>setup</environment_context>"].map(text => JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } })).join("\n");
  expect(parseHistorySessionFile({ sessionId: "task", fileContent, updatedAt: new Date().toISOString(), nowMs: Date.now() })?.preview).toBe("Fix the monitor");
});
