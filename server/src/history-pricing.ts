import type { HistoryPricingCatalog, TokenUsage } from '../../shared/monitor';

type ModelPricing = { input: number; cachedInput: number; cacheWriteInput: number; output: number };
// Standard API prices in USD per million tokens. GPT-6.1 Sol verified 2026-09-30:
// https://developers.openai.com/api/docs/models/gpt-6.1-sol
// Earlier GPT-6 rates verified 2026-09-26: https://developers.openai.com/api/docs/pricing
// This is an API-equivalent estimate: ChatGPT plan usage is not billed this way.
const MODEL_PRICING: Record<string, ModelPricing> = {
  "gpt-6.1-sol": { input: 2, cachedInput: 0.1, cacheWriteInput: 2.5, output: 10 },
  "gpt-6-sol": { input: 2, cachedInput: 0.2, cacheWriteInput: 2.5, output: 10 },
  "gpt-6-luna": { input: 0.1, cachedInput: 0.01, cacheWriteInput: 0.125, output: 0.5 },
  "gpt-6-astra": { input: 10, cachedInput: 1, cacheWriteInput: 12.5, output: 50 },
  "gpt-5.6": { input: 4, cachedInput: 0.4, cacheWriteInput: 5, output: 20 },
  "gpt-5.6-sol": { input: 4, cachedInput: 0.4, cacheWriteInput: 5, output: 20 },
  "gpt-5.6-terra": { input: 2, cachedInput: 0.2, cacheWriteInput: 2.5, output: 12 },
  "gpt-5.6-luna": { input: 0.2, cachedInput: 0.02, cacheWriteInput: 0.25, output: 1.2 },
  "gpt-5.5": { input: 5, cachedInput: 0.5, cacheWriteInput: 6.25, output: 30 },
  "gpt-5.4-mini": { input: 0.75, cachedInput: 0.075, cacheWriteInput: 0.9375, output: 4.5 },
  "gpt-5.3-codex": { input: 1.75, cachedInput: 0.175, cacheWriteInput: 2.1875, output: 14 },
  "gpt-5.2-codex": { input: 1.75, cachedInput: 0.175, cacheWriteInput: 2.1875, output: 14 },
  "gpt-5-codex": { input: 1.25, cachedInput: 0.125, cacheWriteInput: 1.5625, output: 10 }
};

export const HISTORY_PRICING: HistoryPricingCatalog = {
  currency: 'USD', unit: 'perMillionTokens', verifiedAt: '2026-09-30',
  sourceUrl: 'https://developers.openai.com/api/docs/pricing',
  models: Object.entries(MODEL_PRICING).map(([model, prices]) => ({ model, ...prices,
    verifiedAt: model === 'gpt-6.1-sol' ? '2026-09-30' : model.startsWith('gpt-6-') ? '2026-09-26' : null })),
  highContext: { inputTokensThreshold: 272000, inputMultiplier: 2, outputMultiplier: 1.5 },
  note: 'API-equivalent estimates, not ChatGPT plan charges. GPT-6.1 Sol standard token rates, cache-write rates and high-context multipliers verified 2026-09-30. Earlier GPT-6 input, cached-input and output rates were verified 2026-09-26; other model rates are carried over without a recorded check date. Cache-write rates (1.25x input) and high-context multipliers for earlier models remain inherited assumptions, not verified universal official rates. Unknown models remain unpriced. High-context multipliers apply when an event input exceeds the threshold; cache-write tokens are charged separately and reasoning tokens are included in output.'
};
export function estimateApiEquivalentCost(
  usage: TokenUsage,
  model: string | null
): number | null {
  const pricing = model && Object.hasOwn(MODEL_PRICING, model) ? MODEL_PRICING[model] : null;
  if (!pricing) {
    return null;
  }

  const highContext = usage.inputTokens > 272000;
  const inputMultiplier = highContext ? 2 : 1;
  const outputMultiplier = highContext ? 1.5 : 1;
  const cachedInput = Math.min(usage.cachedInputTokens, usage.inputTokens);
  const uncachedInput = Math.max(0, usage.inputTokens - cachedInput);

  return (
    (uncachedInput * pricing.input * inputMultiplier +
      cachedInput * pricing.cachedInput * inputMultiplier +
      (usage.cacheWriteInputTokens ?? 0) *
        pricing.cacheWriteInput *
        inputMultiplier +
      usage.outputTokens * pricing.output * outputMultiplier) /
    1_000_000
  );
}
