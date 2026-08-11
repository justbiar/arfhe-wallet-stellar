/**
 * index.ts — ArfheWallet agent proxy.
 *
 * A single endpoint, POST /agent/chat, that forwards the extension's in-wallet agent
 * requests to OpenRouter. Exists so the OpenRouter API key never ships inside the
 * extension bundle (anyone could unpack a Chrome extension and read it); the key lives
 * only as a Cloudflare Worker secret (`wrangler secret put OPENROUTER_API_KEY`), never in
 * this repo or in a `.env` file read at runtime.
 *
 * Request:  { messages: ChatMessage[], tools?: ToolDefinition[] }
 * Response: the raw OpenRouter chat-completion JSON, status forwarded as-is once a model
 *           in MODEL_CHAIN answers with something other than 429/5xx.
 */

import { MODEL_CHAIN } from "./modelConfig";
import { checkRateLimit } from "./rateLimiter";

export interface Env {
  /** Cloudflare Worker secret — set via `wrangler secret put OPENROUTER_API_KEY`, never a var. */
  OPENROUTER_API_KEY: string;
  /** Exact `chrome-extension://<id>` origin allowed to call this proxy. Set in wrangler.toml [vars]. */
  ALLOWED_ORIGIN: string;
  /** Requests allowed per IP per 60s. Optional; defaults to 20 if unset/unparseable. */
  RATE_LIMIT_PER_MINUTE?: string;
  RATE_LIMIT_KV: KVNamespace;
}

const OPENROUTER_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const UPSTREAM_TIMEOUT_MS = 30_000;
const DEFAULT_RATE_LIMIT_PER_MINUTE = 20;

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  [key: string]: unknown;
}

interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

interface AgentChatRequestBody {
  messages: ChatMessage[];
  tools?: ToolDefinition[];
}

// ─── Small helpers ──────────────────────────────────────────────────

function jsonResponse(body: unknown, status: number, extraHeaders?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}

/** Only a request whose Origin exactly matches the configured extension origin gets CORS headers. */
function buildCorsHeaders(origin: string | null, env: Env): HeadersInit | null {
  if (!origin || !env.ALLOWED_ORIGIN || origin !== env.ALLOWED_ORIGIN) return null;
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  };
}

function isChatMessage(value: unknown): value is ChatMessage {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    (v.role === "system" || v.role === "user" || v.role === "assistant" || v.role === "tool") &&
    typeof v.content === "string"
  );
}

function parseRequestBody(raw: unknown): AgentChatRequestBody {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Request body must be a JSON object.");
  }
  const body = raw as Record<string, unknown>;

  if (!Array.isArray(body.messages) || body.messages.length === 0 || !body.messages.every(isChatMessage)) {
    throw new Error('"messages" must be a non-empty array of { role, content } items.');
  }

  if (body.tools !== undefined && !Array.isArray(body.tools)) {
    throw new Error('"tools", when present, must be an array.');
  }

  return {
    messages: body.messages,
    tools: body.tools as ToolDefinition[] | undefined,
  };
}

// ─── Model chain ────────────────────────────────────────────────────

type ChainResult =
  | { kind: "response"; status: number; data: unknown }
  | { kind: "all_rate_limited"; attemptedModels: string[] }
  | { kind: "unreachable"; attemptedModels: string[] };

/**
 * Try each model in MODEL_CHAIN until one answers with something other than 429 (rate
 * limited), 5xx (upstream outage), or 404 (model no longer exists in OpenRouter's catalog —
 * free-tier models get retired without notice, which is exactly what happened to
 * qwen/qwen3-coder:free). Those are the only cases worth falling back for — anything else
 * (auth failure, malformed request, a genuine completion) is returned as-is, since retrying
 * a different model wouldn't change a client-side error and would just mask a real answer.
 */
async function callModelChain(body: AgentChatRequestBody, apiKey: string): Promise<ChainResult> {
  let sawRateLimit = false;
  let sawUnreachable = false;
  // Recorded so a caller-visible "all failed" error can say exactly which models were tried,
  // instead of leaving it ambiguous whether the chain was exhausted or aborted after one.
  const attemptedModels: string[] = [];

  for (const model of MODEL_CHAIN) {
    attemptedModels.push(model);
    let response: Response;
    try {
      response = await fetch(OPENROUTER_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          "HTTP-Referer": "https://arfhewallet.app",
          "X-Title": "ArfheWallet Agent",
        },
        body: JSON.stringify({
          model,
          messages: body.messages,
          ...(body.tools ? { tools: body.tools } : {}),
        }),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
    } catch {
      // Network error or timeout reaching OpenRouter itself — try the next model.
      sawUnreachable = true;
      continue;
    }

    if (response.status === 429) {
      sawRateLimit = true;
      continue;
    }
    if (response.status === 404 || response.status >= 500) {
      // Covers 502/503/504 (e.g. a provider-side "ResourceExhausted") exactly like a 5xx,
      // and 404 for a model retired from OpenRouter's catalog — neither is a mistake in our
      // own request, so both fall through to the next model instead of being returned as-is.
      sawUnreachable = true;
      continue;
    }

    const data = await response.json().catch(() => ({ error: "Upstream returned a non-JSON response." }));
    return { kind: "response", status: response.status, data };
  }

  if (sawUnreachable) return { kind: "unreachable", attemptedModels };
  if (sawRateLimit) return { kind: "all_rate_limited", attemptedModels };
  // MODEL_CHAIN is a non-empty const array, so this is unreachable in practice.
  return { kind: "unreachable", attemptedModels };
}

// ─── Worker entrypoint ──────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");
    const cors = buildCorsHeaders(origin, env);

    if (request.method === "OPTIONS") {
      // Preflight from a disallowed origin gets no CORS headers, so the browser blocks the
      // actual request itself — no need to leak a distinct error body here.
      return new Response(null, { status: cors ? 204 : 403, headers: cors ?? undefined });
    }

    if (url.pathname !== "/agent/chat" || request.method !== "POST") {
      return jsonResponse({ error: "Not found." }, 404, cors ?? undefined);
    }

    if (!cors) {
      return jsonResponse({ error: "Origin not allowed." }, 403);
    }

    if (!env.OPENROUTER_API_KEY) {
      return jsonResponse({ error: "Server misconfigured: missing OPENROUTER_API_KEY." }, 500, cors);
    }

    const clientIp = request.headers.get("CF-Connecting-IP") ?? "unknown";
    const limitPerMinute = Number.parseInt(env.RATE_LIMIT_PER_MINUTE ?? "", 10) || DEFAULT_RATE_LIMIT_PER_MINUTE;
    const rate = await checkRateLimit(env.RATE_LIMIT_KV, clientIp, limitPerMinute);
    if (!rate.allowed) {
      return jsonResponse(
        { error: "Rate limit exceeded. Try again shortly." },
        429,
        { ...cors, "Retry-After": String(rate.retryAfterSeconds ?? 60) }
      );
    }

    let body: AgentChatRequestBody;
    try {
      body = parseRequestBody(await request.json());
    } catch (err) {
      return jsonResponse({ error: err instanceof Error ? err.message : "Invalid request body." }, 400, cors);
    }

    const result = await callModelChain(body, env.OPENROUTER_API_KEY);

    switch (result.kind) {
      case "response":
        return jsonResponse(result.data, result.status, cors);
      case "all_rate_limited":
        return jsonResponse(
          {
            error: "All models in the fallback chain are currently rate limited. Try again shortly.",
            attemptedModels: result.attemptedModels,
          },
          503,
          cors
        );
      case "unreachable":
        return jsonResponse(
          {
            error: "OpenRouter is unreachable, or none of the configured models are currently available.",
            attemptedModels: result.attemptedModels,
          },
          502,
          cors
        );
    }
  },
};
