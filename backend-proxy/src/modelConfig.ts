/**
 * modelConfig.ts — OpenRouter model fallback chain.
 *
 * The proxy tries these in order for every /agent/chat request. A model is skipped and the
 * next one tried when OpenRouter answers 429 (rate limited), 5xx (its own outage), or 404
 * (model no longer exists — free-tier models rotate out of OpenRouter's catalog without
 * notice, e.g. qwen/qwen3-coder:free) — see callModelChain() in index.ts. All entries are
 * free-tier models so a single extension install can't run up a bill on its own; add paid
 * models here only alongside a spend cap.
 *
 * "openrouter/free" is kept first on purpose: it's OpenRouter's own auto-router over
 * whichever free, tool-calling-capable models currently exist, so it's the most resilient
 * option against the capacity/rotation problems that hit a single named model (rate limits,
 * ResourceExhausted, retirement from the catalog). The two named models behind it are a
 * fallback for that fallback, not the primary path.
 */
export const MODEL_CHAIN = [
  "openrouter/free",
  "nvidia/nemotron-3-ultra-550b-a55b:free",
  "google/gemma-4-31b-it:free",
] as const;

export type ModelId = (typeof MODEL_CHAIN)[number];
