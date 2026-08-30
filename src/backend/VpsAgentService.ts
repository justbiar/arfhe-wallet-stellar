/**
 * VpsAgentService — client for a user's own self-hosted agent backend (e.g. Express + Ollama
 * on a personal VPS), used as the "Kendi VPS'im" alternative to the built-in Arfio/OpenRouter
 * agent (AgentOrchestrator.ts).
 *
 * Auth model: instead of asking the user to paste an API key, the active account SIGNS a fixed
 * login message with its own private key (EIP-191 personal_sign, same mechanism WalletConnect/
 * dApp signing already uses — see Approve.tsx). The VPS verifies the signature against the
 * claimed address (ethers.verifyMessage) and returns a short-lived JWT; that JWT — never the
 * private key or anything derived from it — is what's cached and sent as a Bearer token on
 * subsequent requests. A leaked cached token only grants temporary VPS access and expires on
 * its own; it can't be used to reconstruct the wallet.
 */

import type Account from "./Account.js";
import { isValidToolCall, type ChatMessage } from "./AgentOrchestrator.js";

const VPS_URL_STORAGE_KEY = "arfhe_vps_agent_url";
const VPS_TOKEN_STORAGE_PREFIX = "arfhe_vps_agent_token_";
const AGENT_SOURCE_STORAGE_KEY = "arfhe_agent_source";

/**
 * The team's own always-on VPS (Express + Ollama, see server.js) — pre-filled so the "Kendi
 * VPS'im" settings field already works out of the box instead of requiring everyone testing it
 * to go find and type this address themselves. Still fully overridable (and clearable, which
 * falls straight back to this same default rather than to a blank field) via setVpsAgentUrl —
 * this is a default, not a hardcoded destination.
 */
const DEFAULT_VPS_AGENT_URL = "http://83.229.86.69:3000";

// "vps" ("Kendi VPS'im") is retired from the settings dialog — it pointed at a VPS the team
// itself runs, not the user's own infrastructure, so "your own VPS" was a misleading label for a
// choice that was really just another Arfio-adjacent option. "ownkey" (OwnKeyAgentService.ts)
// replaced it as the actual bring-your-own-credentials alternative. The value is kept in the
// type (and still handled below) purely so a tester who already had "vps" persisted in
// localStorage from before this change falls back to "arfio" instead of AgentChatPanel hitting
// an unhandled source at runtime — it is simply never offered as a choice going forward.
export type AgentSource = "arfio" | "vps" | "ownkey";

/** Which agent backend the chat panel should talk to — durable across restarts (localStorage), like the language preference in i18n.ts. */
export function getAgentSource(): AgentSource {
  // Anything other than "ownkey" — including a stale "vps" from before that mode was retired,
  // or nothing saved at all — falls back to "arfio".
  return localStorage.getItem(AGENT_SOURCE_STORAGE_KEY) === "ownkey" ? "ownkey" : "arfio";
}

export function setAgentSource(source: AgentSource): void {
  localStorage.setItem(AGENT_SOURCE_STORAGE_KEY, source);
}

/** Must match the VPS server's own login message exactly, or signature verification fails. */
const LOGIN_MESSAGE = "Arfhe Wallet Agent'a giris yapmak istiyorum.";

/** Mirrors the server's own JWT expiry (see server.js: jwt.sign(..., { expiresIn: '24h' })). Kept
 *  slightly shorter so the client re-logs in a bit before the server would reject the token. */
const TOKEN_TTL_MS = 23 * 60 * 60 * 1000;

interface CachedToken {
  token: string;
  issuedAt: number;
}

export function getVpsAgentUrl(): string {
  return localStorage.getItem(VPS_URL_STORAGE_KEY) ?? DEFAULT_VPS_AGENT_URL;
}

export function setVpsAgentUrl(url: string): void {
  const trimmed = url.trim().replace(/\/+$/, "");
  if (trimmed) localStorage.setItem(VPS_URL_STORAGE_KEY, trimmed);
  else localStorage.removeItem(VPS_URL_STORAGE_KEY);
}

export function isVpsAgentConfigured(): boolean {
  return getVpsAgentUrl().length > 0;
}

function tokenStorageKey(address: string): string {
  return VPS_TOKEN_STORAGE_PREFIX + address.toLowerCase();
}

function readCachedToken(address: string): string | null {
  try {
    const raw = localStorage.getItem(tokenStorageKey(address));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedToken;
    if (typeof parsed.token !== "string" || Date.now() - parsed.issuedAt >= TOKEN_TTL_MS) return null;
    return parsed.token;
  } catch {
    return null;
  }
}

function writeCachedToken(address: string, token: string): void {
  const entry: CachedToken = { token, issuedAt: Date.now() };
  localStorage.setItem(tokenStorageKey(address), JSON.stringify(entry));
}

/** Clears the cached session for one account, forcing a fresh wallet-signature login next time. */
export function resetVpsAgentSession(address: string): void {
  localStorage.removeItem(tokenStorageKey(address));
}

/** Thrown for every failure path — `reasonKey` is an i18n key AgentChatPanel translates for the user. */
export class VpsAgentError extends Error {
  reasonKey: string;
  constructor(reasonKey: string) {
    super(reasonKey);
    this.reasonKey = reasonKey;
  }
}

/**
 * Default per-request timeout — most VPS endpoints (login, credits, quota) are near-instant, so
 * anything hanging this long means the VPS/network is genuinely unreachable, not just slow.
 * vpsChatCompletion overrides this with a much larger one (see CHAT_TIMEOUT_MS) since it waits on
 * actual LLM inference, which a modest CPU-only self-hosted box can take a while to produce.
 * Without a timeout at all, a `fetch` that never settles (VPS wedged, Ollama hung) leaves the
 * chat panel's "AGENT'IN DÜŞÜNÜYOR..." spinner running forever with no way out — this turns that
 * into a bounded, user-visible vpsErrorUnreachable instead.
 */
const DEFAULT_TIMEOUT_MS = 20_000;
const CHAT_TIMEOUT_MS = 120_000;

async function loginToVps(account: Account, baseUrl: string): Promise<string> {
  const wallet = account.ethers_wallet;
  const address = account.GetAddress();
  if (!wallet || !address) throw new VpsAgentError("agent.vpsErrorLocked");

  const signature = await wallet.signMessage(LOGIN_MESSAGE);

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address, message: LOGIN_MESSAGE, signature }),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
  } catch {
    throw new VpsAgentError("agent.vpsErrorUnreachable");
  }

  let body: { success?: boolean; token?: string };
  try {
    body = await response.json();
  } catch {
    throw new VpsAgentError("agent.vpsErrorUnreachable");
  }

  if (!response.ok || !body.success || !body.token) {
    throw new VpsAgentError("agent.vpsErrorLoginFailed");
  }

  writeCachedToken(address, body.token);
  return body.token;
}

/**
 * Signs the same fixed login message and returns the resulting 24h JWT, for the user to paste
 * into their OWN Claude/MCP client config (`Authorization: Bearer <token>`) — see mcp.js on the
 * VPS for what that token is checked against. Deliberately just `loginToVps` against the team's
 * VPS (the same origin /mcp is mounted on) rather than a separate token type: this wallet
 * already has exactly one signed-login flow, and the MCP server reuses the exact same
 * requireAuth middleware every other authenticated VPS route does, so there is nothing
 * MCP-specific to add here beyond reusing it under a name that reads correctly at the call site.
 * Does NOT cache the result under the normal token cache key — a token meant to be copied out of
 * the wallet and pasted somewhere else (Claude Desktop's config, on disk, outside this session)
 * is worth minting fresh each time the user asks, not silently reusing whatever the "own VPS
 * agent" flow happened to cache last.
 */
export async function getMcpAccessToken(account: Account): Promise<string> {
  return loginToVps(account, DEFAULT_VPS_AGENT_URL);
}

/**
 * Shared plumbing for every authenticated VPS call: ensures a cached (unexpired) token exists —
 * logging in via wallet signature first if not — attaches it as a Bearer header, and on a
 * 401/403 (token expired or rejected server-side despite looking fresh locally) clears the
 * cache and retries the login+request exactly once, so a stale cache never permanently wedges
 * the chat or the credit endpoints below. Network failures at either attempt become
 * vpsErrorUnreachable rather than a raw fetch rejection.
 */
async function authedFetch(
  account: Account,
  path: string,
  init?: RequestInit,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<Response> {
  const baseUrl = getVpsAgentUrl();
  if (!baseUrl) throw new VpsAgentError("agent.vpsErrorNotConfigured");

  const address = account.GetAddress();
  if (!address) throw new VpsAgentError("agent.vpsErrorLocked");

  let token = readCachedToken(address) ?? (await loginToVps(account, baseUrl));

  const call = (bearer: string) =>
    fetch(`${baseUrl}${path}`, {
      ...init,
      headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${bearer}` },
      signal: AbortSignal.timeout(timeoutMs),
    });

  let response: Response;
  try {
    response = await call(token);
  } catch {
    throw new VpsAgentError("agent.vpsErrorUnreachable");
  }

  if (response.status === 401 || response.status === 403) {
    resetVpsAgentSession(address);
    token = await loginToVps(account, baseUrl);
    try {
      response = await call(token);
    } catch {
      throw new VpsAgentError("agent.vpsErrorUnreachable");
    }
  }

  return response;
}

/**
 * Sends one turn's messages+tools to the VPS's `/api/chat` (the user's own server, forwarding
 * to Ollama's native tool-calling chat API) and returns the assistant's reply as a ChatMessage
 * in the exact OpenAI-compatible wire shape AgentOrchestrator.ts already speaks — so
 * VpsAgentOrchestrator.ts's tool-calling loop and AgentToolRunner.executeToolCall need no
 * VPS-specific branching at all, they just work the same way they do for Arfio.
 */
export async function vpsChatCompletion(messages: ChatMessage[], tools: unknown, account: Account): Promise<ChatMessage> {
  const response = await authedFetch(
    account,
    "/api/chat",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages, tools }),
    },
    CHAT_TIMEOUT_MS
  );

  if (!response.ok) throw new VpsAgentError("agent.vpsErrorRequestFailed");

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new VpsAgentError("agent.vpsErrorRequestFailed");
  }

  const message = (body as { message?: unknown } | null)?.message;
  if (typeof message !== "object" || message === null) throw new VpsAgentError("agent.vpsErrorRequestFailed");
  const m = message as Record<string, unknown>;
  if (m.role !== "assistant") throw new VpsAgentError("agent.vpsErrorRequestFailed");

  const content = typeof m.content === "string" ? m.content : "";
  const rawToolCalls = Array.isArray(m.tool_calls) ? m.tool_calls.filter(isValidToolCall) : [];

  return {
    role: "assistant",
    content,
    ...(rawToolCalls.length > 0 ? { tool_calls: rawToolCalls } : {}),
  };
}

/**
 * Consumes exactly one unit of the active account's daily quota BEFORE a chat turn starts — one
 * user-initiated message costs one unit regardless of how many internal tool-calling round trips
 * it takes to answer (those all go through vpsChatCompletion above with no further quota check).
 * Throws vpsErrorQuotaExceeded on a 429 without attempting the turn at all.
 */
export async function consumeVpsQuota(account: Account): Promise<CreditInfo> {
  const response = await authedFetch(account, "/api/quota/consume", { method: "POST" });
  if (response.status === 429) throw new VpsAgentError("agent.vpsErrorQuotaExceeded");
  if (!response.ok) throw new VpsAgentError("agent.vpsErrorRequestFailed");
  try {
    return (await response.json()) as CreditInfo;
  } catch {
    throw new VpsAgentError("agent.vpsErrorRequestFailed");
  }
}

/**
 * Mirrors the VPS's credit ledger (see server.js's credit store): each `sources` entry is a
 * standing credit grant (on-chain activity, and eventually Gmail/X once those OAuth flows
 * exist), `credits` is their sum, and `dailyLimit` is derived from it server-side (currently
 * floor(credits / 10) — one request per 10 credits). `dailyUsed` resets at UTC midnight.
 */
export interface CreditInfo {
  address: string;
  credits: number;
  sources: Record<string, number>;
  dailyLimit: number;
  dailyUsed: number;
}

/** Fetches the active account's current credit balance and today's quota usage — read-only, no side effects. */
export async function getVpsCredits(account: Account): Promise<CreditInfo> {
  const response = await authedFetch(account, "/api/credits", { method: "GET" });
  if (!response.ok) throw new VpsAgentError("agent.vpsErrorRequestFailed");
  try {
    return (await response.json()) as CreditInfo;
  } catch {
    throw new VpsAgentError("agent.vpsErrorRequestFailed");
  }
}

/**
 * Asks the VPS to re-check the active account's on-chain activity (mainnet tx count + ENS
 * ownership) and update its "onchain" credit source accordingly — see server.js's
 * /api/verify/onchain. Safe to call repeatedly: the server recomputes that one source from
 * scratch each time rather than accumulating, so this can only raise it as activity grows, never
 * stack duplicate grants for the same activity.
 */
export async function verifyVpsOnchainCredits(account: Account): Promise<CreditInfo> {
  const response = await authedFetch(account, "/api/verify/onchain", { method: "POST" });
  if (!response.ok) throw new VpsAgentError("agent.vpsErrorRequestFailed");
  try {
    return (await response.json()) as CreditInfo;
  } catch {
    throw new VpsAgentError("agent.vpsErrorRequestFailed");
  }
}
