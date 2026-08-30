/**
 * OwnKeyAgentService — client for the "Kendi API Anahtarım" agent backend: the user pastes
 * their own OpenRouter API key and the wallet talks to OpenRouter's OpenAI-compatible
 * `/chat/completions` endpoint directly from the extension, no team-run server in between.
 *
 * This replaces the old "Kendi VPS'im" flow (VpsAgentService.ts/VpsAgentOrchestrator.ts) as the
 * user-facing alternative to Arfio: that flow pointed at a VPS the team itself hosts and runs
 * Ollama on, which made "your own VPS" a misleading label — it was never actually the user's
 * infrastructure, and there is nothing for a user to bring except the choice to use it. An own
 * API key is the opposite: real BYO credentials, a real third-party bill in the user's name, and
 * (unlike a wallet signature) exactly the credential model OpenRouter itself expects, so no
 * custom login/JWT dance is needed the way VpsAgentService.ts's signed-message auth was.
 *
 * Kept deliberately close to VpsAgentService's shape (same OwnKeyAgentError/reasonKey pattern,
 * same OpenAI-shaped ChatMessage in and out) so OwnKeyAgentOrchestrator.ts can mirror
 * VpsAgentOrchestrator.ts's tool-calling loop almost line for line — only WHO decides which tool
 * to call differs; execution is always local, same as every other agent backend (see that file's
 * header for why that split is what makes backend parity possible at all).
 */

import { isValidToolCall, type ChatMessage } from "./AgentOrchestrator.js";
import type { AgentToolDefinition } from "./agentTools.js";

const OWN_API_KEY_STORAGE_KEY = "arfhe_own_agent_api_key";
const OWN_MODEL_STORAGE_KEY = "arfhe_own_agent_model";

const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";

/**
 * A solid, inexpensive general-purpose default so the feature works the instant a key is
 * pasted — no separate "pick a model" step. Still fully overridable via setOwnAgentModel for
 * anyone who wants a different OpenRouter model; there is just no UI for that yet (see
 * AgentChatPanel.tsx's settings dialog), matching the "standard/simple API key setting" scope
 * this was built for rather than a full model-picker.
 */
const DEFAULT_MODEL = "openai/gpt-4o-mini";

/** Whether an OpenRouter key has been saved — mirrors isVpsAgentConfigured()'s role for the old flow. */
export function isOwnKeyConfigured(): boolean {
  return getOwnApiKey().length > 0;
}

/**
 * Stored in localStorage next to every other agent-settings value this codebase already keeps
 * there (agent source, VPS URL/tokens — see VpsAgentService.ts) rather than chrome.storage, for
 * the same reason: this extension has no server-side session to protect it from, and consistency
 * with the existing settings keeps them all readable/writable through one mental model. It is
 * still never sent anywhere but directly to OpenRouter (openRouterChatCompletion below) — no
 * team-run server ever sees it, which is the whole point of "bring your own key".
 */
export function getOwnApiKey(): string {
  return localStorage.getItem(OWN_API_KEY_STORAGE_KEY) ?? "";
}

export function setOwnApiKey(key: string): void {
  const trimmed = key.trim();
  if (trimmed) localStorage.setItem(OWN_API_KEY_STORAGE_KEY, trimmed);
  else localStorage.removeItem(OWN_API_KEY_STORAGE_KEY);
}

export function getOwnAgentModel(): string {
  return localStorage.getItem(OWN_MODEL_STORAGE_KEY) || DEFAULT_MODEL;
}

export function setOwnAgentModel(model: string): void {
  const trimmed = model.trim();
  if (trimmed) localStorage.setItem(OWN_MODEL_STORAGE_KEY, trimmed);
  else localStorage.removeItem(OWN_MODEL_STORAGE_KEY);
}

/** Thrown for every failure path — `reasonKey` is an i18n key AgentChatPanel translates for the user. */
export class OwnKeyAgentError extends Error {
  reasonKey: string;
  constructor(reasonKey: string) {
    super(reasonKey);
    this.reasonKey = reasonKey;
  }
}

/** A real cloud model over the open internet; generous but bounded so a hung request still resolves the chat panel's spinner. */
const CHAT_TIMEOUT_MS = 60_000;

/**
 * Sends one turn's messages+tools straight to OpenRouter and returns the assistant's reply as a
 * ChatMessage in the same OpenAI-compatible wire shape AgentOrchestrator.ts already speaks — so
 * OwnKeyAgentOrchestrator.ts's tool-calling loop and AgentToolRunner.executeToolCall need no
 * own-key-specific branching at all.
 */
export async function ownKeyChatCompletion(
  messages: ChatMessage[],
  tools: readonly AgentToolDefinition[]
): Promise<ChatMessage> {
  const apiKey = getOwnApiKey();
  if (!apiKey) throw new OwnKeyAgentError("agent.ownKeyErrorNotConfigured");

  let response: Response;
  try {
    response = await fetch(OPENROUTER_CHAT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        // Shown on the user's own OpenRouter dashboard next to usage for this key — purely
        // cosmetic attribution, not required for the request to succeed.
        "X-Title": "Arfhe Wallet",
      },
      body: JSON.stringify({ model: getOwnAgentModel(), messages, tools }),
      signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
    });
  } catch {
    throw new OwnKeyAgentError("agent.ownKeyErrorUnreachable");
  }

  if (response.status === 401 || response.status === 403) {
    throw new OwnKeyAgentError("agent.ownKeyErrorInvalidKey");
  }
  if (response.status === 429) {
    throw new OwnKeyAgentError("agent.ownKeyErrorRateLimited");
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new OwnKeyAgentError("agent.ownKeyErrorRequestFailed");
  }

  if (!response.ok) throw new OwnKeyAgentError("agent.ownKeyErrorRequestFailed");

  const choices = (body as { choices?: unknown } | null)?.choices;
  const first = Array.isArray(choices) ? choices[0] : null;
  const message = (first as { message?: unknown } | null)?.message;
  if (typeof message !== "object" || message === null) throw new OwnKeyAgentError("agent.ownKeyErrorRequestFailed");

  const m = message as Record<string, unknown>;
  if (m.role !== "assistant") throw new OwnKeyAgentError("agent.ownKeyErrorRequestFailed");

  const content = typeof m.content === "string" ? m.content : "";
  const rawToolCalls = Array.isArray(m.tool_calls) ? m.tool_calls.filter(isValidToolCall) : [];

  return {
    role: "assistant",
    content,
    ...(rawToolCalls.length > 0 ? { tool_calls: rawToolCalls } : {}),
  };
}
