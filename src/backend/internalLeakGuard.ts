/**
 * internalLeakGuard — detects when a model's user-facing reply leaks internal
 * implementation details (tool/function names, "calling tool X" style mechanism
 * narration) instead of describing what's happening in plain language.
 *
 * Not a filter: buildSystemPrompt() (AgentOrchestrator.ts) is the actual fix — this module
 * only flags violations so they're visible in logs (see callProxy's use of it), since the
 * system prompt is a strong hint to the model, not an enforced constraint on its output.
 */

import { AGENT_TOOLS } from "./agentTools.js";

const KNOWN_TOOL_NAMES = AGENT_TOOLS.map((tool) => tool.function.name);

const MECHANICAL_PHRASE_PATTERNS: RegExp[] = [
  /arac(ı|ını|ı)\s+çağırıyorum/iu,
  /arac(ı|ını)\s+çalıştırıyorum/iu,
  /tool'?(u|unu)\s+çağırıyorum/iu,
  /tool'?(u|unu)\s+çalıştırıyorum/iu,
  /fonksiyonu(nu)?\s+çağırıyorum/iu,
  /fonksiyonu(nu)?\s+çalıştırıyorum/iu,
  /function\s+call(ing)?/iu,
  /calling\s+the\s+\w+\s+tool/iu,
];

/**
 * Returns the leaked internal reference found in `text`, or null if it reads as plain
 * human language. Tool-name matching is word-bounded so it doesn't fire on ordinary text
 * that happens to contain a substring (e.g. "balance" inside a longer word).
 */
export function findLeakedInternalReference(text: string): string | null {
  for (const name of KNOWN_TOOL_NAMES) {
    const pattern = new RegExp(`\\b${name}\\b`, "i");
    if (pattern.test(text)) return name;
  }
  for (const pattern of MECHANICAL_PHRASE_PATTERNS) {
    const match = text.match(pattern);
    if (match) return match[0];
  }
  return null;
}
