import { previewText } from "./monitor";

/** Ignore injected setup while preserving the actual request in wrapped messages. */
export function userPreview(text: string | null | undefined): string | null {
  if (!text) return null;
  const input = text.match(/<realtime_delegation>\s*<input>([\s\S]*?)<\/input>/);
  const cleaned = (input?.[1] ?? text)
    .replace(/<(recommended_plugins|environment_context|permissions instructions)>[\s\S]*?<\/\1>/g, "")
    .replace(/<in-app-browser-context\b[^>]*>[\s\S]*?<\/in-app-browser-context>/g, "")
    .replace(/^\s*## My request:\s*/, "")
    .trim();
  if (/^(?:<|#?\s*AGENTS\.md instructions|You are |The following is the Codex agent history)/i.test(cleaned)) return null;
  return previewText(cleaned, 240);
}
