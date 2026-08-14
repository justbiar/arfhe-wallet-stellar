/**
 * AgentOrchestrator — runs the in-wallet AI Agent's tool-calling loop.
 *
 * Takes a user message, sends it (with history + tool definitions) to the backend proxy
 * (backend-proxy/src/index.ts's POST /agent/chat, OpenAI-compatible chat-completion
 * format), executes any tool_calls the model asks for via AgentToolRunner, feeds the
 * results back, and repeats until the model returns plain text or a turn limit is hit.
 *
 * This module runs only inside the extension. The proxy — not this module — holds the
 * OpenRouter API key; requests here never touch OpenRouter directly.
 */

import { AGENT_TOOLS } from "./agentTools.js";
import { executeToolCall, type ToolExecutionContext } from "./AgentToolRunner.js";
import { findLeakedInternalReference } from "./internalLeakGuard.js";

// ─── Wire types (OpenAI-compatible chat-completion shape) ──────────

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface AgentToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    /** JSON-encoded arguments, per the OpenAI tool-calling protocol. */
    arguments: string;
  };
}

export interface ChatMessage {
  role: ChatRole;
  /** Always a string — an assistant message with only tool_calls carries "" here. */
  content: string;
  tool_calls?: AgentToolCall[];
  /** Set on role:"tool" messages — must match the tool_calls[].id it answers. */
  tool_call_id?: string;
  /** Set on role:"tool" messages — the tool name, for providers that expect it. */
  name?: string;
}

export interface RunAgentTurnResult {
  reply: string;
  updatedHistory: ChatMessage[];
}

// ─── Config ──────────────────────────────────────────────────────────

export interface AgentOrchestratorConfig {
  /** Base URL of the backend proxy, e.g. "https://arfhewallet-agent-proxy.example.workers.dev". */
  proxyBaseUrl: string;
}

let config: AgentOrchestratorConfig = {
  proxyBaseUrl: (import.meta.env.VITE_AGENT_PROXY_URL as string | undefined) ?? "",
};

/** Overrides orchestrator config — used by tests, and by the app if the proxy URL changes at runtime. */
export function configureAgentOrchestrator(overrides: Partial<AgentOrchestratorConfig>): void {
  config = { ...config, ...overrides };
}

const MAX_TOOL_TURNS = 5;

const GENERIC_ERROR_REPLY =
  "Şu anda isteğinizi işleyemedim. Lütfen birkaç dakika sonra tekrar deneyin.";
const RATE_LIMIT_REPLY =
  "Çok fazla istek gönderildi. Lütfen biraz bekleyip tekrar deneyin.";
const UPSTREAM_UNAVAILABLE_REPLY =
  "Şu anda yapay zeka servisine ulaşılamıyor. Lütfen birkaç dakika sonra tekrar deneyin.";
const NOT_CONFIGURED_REPLY =
  "Agent şu anda kullanılamıyor (yapılandırma eksik). Lütfen daha sonra tekrar deneyin.";
const MAX_TURNS_EXCEEDED_REPLY =
  "Üzgünüm, bu isteği tamamlayamadım — çok fazla adım gerekti. Lütfen sorunuzu daha basit " +
  "bir şekilde tekrar sorar mısınız?";

// ─── System prompt ───────────────────────────────────────────────────

/**
 * Builds the system prompt establishing what the agent is, what it can't do, and the FHE
 * terminology it must use consistently with FHE_COMPLETE_GUIDE.md / README so it doesn't
 * contradict the UI's own wording (shield/unshield/confidential transfer, not ad-hoc terms).
 */
export function buildSystemPrompt(): string {
  return [
    "Senin adın Arfio. ArfheWallet'ın cüzdan içi AI asistanısın. Kendini tanıtırken veya " +
      "birinci ağızdan konuşurken Arfio ismini kullan. ArfheWallet, FHE (Fully Homomorphic " +
      "Encryption) tabanlı, gizli (confidential) bakiye ve transfer destekleyen bir kripto cüzdanıdır.",
    "",
    "YETKİ SINIRLARIN:",
    "- Hiçbir işlemi (transaction) imzalama, gönderme veya onaylama yetkin YOKTUR.",
    "- Yalnızca salt-okunur (read-only) araçları çağırabilirsin: get_balance, get_shielded_balance, " +
      "get_shielded_portfolio, get_pending_claims. Kullanıcı adına fon hareket ettiren hiçbir işlem yapamazsın.",
    "- Kullanıcı bir transfer/shield/unshield/onay işlemi yapmak isterse, bunu senin " +
      "gerçekleştiremeyeceğini belirt ve ilgili panel/ekranı kullanmasını öner.",
    "- Bir aracın sonucunu almadan bakiye, adres veya miktar UYDURMA. Emin değilsen ilgili " +
      "aracı çağır ya da bilmediğini söyle.",
    "",
    "FHE TERMİNOLOJİSİ (FHE_COMPLETE_GUIDE.md ile tutarlı kullan):",
    "- \"shield\": açık (şifrelenmemiş) bir bakiyeyi FHE ile şifreli hale getirmek.",
    "- \"unshield\": şifreli bakiyeyi tekrar açığa çıkarmak.",
    "- \"confidential transfer\" (gizli transfer): miktarın zincir üzerinde hiç görünmediği transfer.",
    "- Şifreli veri zincirde tutulmaz; zincirde yalnızca bir \"tutamaç\" (handle/ctHash) bulunur, " +
      "gerçek şifreli hesaplama zincir dışındaki koprosesörde (CoFHE) yapılır.",
    "",
    "UNSHIELD İKİ AŞAMALIDIR — bunu asla tek adımmış gibi anlatma:",
    "  1) unshield: şifreli bakiye yakılır (burn) ve bir talep (claim) kaydı açılır — " +
      "tokenlar bu anda HENÜZ kullanıcının eline geçmemiştir.",
    "  2) claim: çözülen miktar doğrulanır ve tokenlar serbest bırakılır.",
    "Kullanıcı yalnızca ilk adımı atıp ikincisini atlarsa, bakiyesi yanmış olur ama tokenlar " +
      "kilitli kalır. get_pending_claims aracı boş olmayan bir sonuç döndürürse, kullanıcıya " +
      "bekleyen talebini tamamlamak için claim adımını atması gerektiğini mutlaka hatırlat.",
    "",
    "Kısa, net ve doğru cevaplar ver. Kullanıcı hangi dilde yazarsa o dilde yanıtla.",
    "",
    "HER ZAMAN GÜNDELİK, İNSAN DİLİYLE KONUŞ — KOD DİLİYLE DEĞİL:",
    "- Kullanıcıya asla fonksiyon/araç (tool) ismi, değişken ismi, dosya/sınıf ismi ya da " +
      "başka bir iç kod/mimari referansı söyleme (get_balance, propose_send, " +
      "get_shielded_portfolio, get_pending_claims, propose_shield, propose_unshield vb. " +
      "hiçbir zaman kullanıcıya görünen metinde geçmemeli).",
    "- \"X aracını/fonksiyonunu çağırıyorum\", \"X tool'unu çalıştırıyorum\" gibi mekanizma " +
      "anlatan mekanik ifadeler kullanma. Ne yaptığını bir insana anlatır gibi anlat.",
    "- Bu, bilgi saklamak anlamına gelmez — tam tersine kullanıcı ne olup bittiğini net " +
      "anlamalı (bakiyeni kontrol ediyorum, göndermek için hedef adres lazım, vb.). Sadece " +
      "bunu her zaman doğal cümlelerle anlat, iç isimlerle değil.",
    "- Bu kural yalnızca araç çağırdığın anlar için değil, TÜM cevapların için geçerlidir: " +
      "hata mesajları, onay öncesi açıklamalar, geçmiş/durum sorularına verdiğin cevaplar " +
      "dahil hiçbirinde iç kod terimi geçmemeli.",
    "  Kötü: \"propose_send aracını çağırıyorum, hedef adres gerekiyor.\"",
    "  İyi: \"ETH göndermek için önce hedef adresi öğrenmem gerekiyor, nereye göndermek " +
      "istiyorsun?\"",
    "  Kötü: \"get_pending_claims sonucu boş döndü, bekleyen talebiniz yok.\"",
    "  İyi: \"Bekleyen bir talebiniz görünmüyor.\"",
    "  Kötü: \"propose_shield fonksiyonu çalıştırıldı, onayınızı bekliyorum.\"",
    "  İyi: \"Shield işlemini hazırladım, onayınızı bekliyorum.\"",
  ].join("\n");
}

// ─── RAG context retrieval ────────────────────────────────────────────

interface RetrievedChunk {
  title: string;
  text: string;
}

/**
 * Asks the proxy's /agent/retrieve-context to embed the user's message and return the
 * FHE_COMPLETE_GUIDE.md excerpts most relevant to it (empty when nothing clears the
 * relevance threshold, e.g. small talk unrelated to the wallet). Never throws — mirrors
 * callProxy's degrade-safely contract, except here "safely" means "send the turn with no
 * extra context" rather than a user-facing error, since this step is a pure enrichment
 * with no bearing on whether the turn can proceed.
 */
async function fetchRetrievedContext(userMessage: string): Promise<RetrievedChunk[]> {
  if (!config.proxyBaseUrl || !userMessage.trim()) return [];

  const url = `${config.proxyBaseUrl.replace(/\/+$/, "")}/agent/retrieve-context`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: userMessage }),
    });
    if (!response.ok) return [];

    const body = (await response.json()) as { chunks?: unknown };
    if (!Array.isArray(body.chunks)) return [];

    return body.chunks.filter(
      (c): c is RetrievedChunk =>
        typeof c === "object" && c !== null && typeof (c as RetrievedChunk).title === "string" &&
        typeof (c as RetrievedChunk).text === "string"
    );
  } catch (err) {
    console.error("[AgentOrchestrator] context retrieval failed:", err);
    return [];
  }
}

function buildContextMessage(chunks: RetrievedChunk[]): ChatMessage | null {
  if (chunks.length === 0) return null;
  const body = chunks.map((c) => `### ${c.title}\n${c.text}`).join("\n\n");
  return {
    role: "system",
    content:
      "İLGİLİ BAĞLAM (kullanıcının sorusuyla ilgili olabilecek rehber alıntıları — yalnızca " +
      "doğruysa ve soruyla alakalıysa kullan, alakasızsa yok say):\n\n" + body,
  };
}

// ─── Proxy call ──────────────────────────────────────────────────────

type ProxyOutcome = { ok: true; message: ChatMessage } | { ok: false; friendlyMessage: string };

function friendlyMessageForStatus(status: number): string {
  if (status === 429) return RATE_LIMIT_REPLY;
  if (status === 503 || status === 502 || status === 504) return UPSTREAM_UNAVAILABLE_REPLY;
  return GENERIC_ERROR_REPLY;
}

function isValidToolCall(value: unknown): value is AgentToolCall {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== "string" || v.type !== "function") return false;
  const fn = v.function;
  if (typeof fn !== "object" || fn === null) return false;
  const f = fn as Record<string, unknown>;
  return typeof f.name === "string" && typeof f.arguments === "string";
}

/** Extracts and defensively re-validates the assistant message from an OpenAI-shaped response body. */
function extractAssistantMessage(body: unknown): ChatMessage | null {
  if (typeof body !== "object" || body === null) return null;
  const choices = (body as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;

  const first = choices[0];
  if (typeof first !== "object" || first === null) return null;
  const message = (first as Record<string, unknown>).message;
  if (typeof message !== "object" || message === null) return null;

  const m = message as Record<string, unknown>;
  if (m.role !== "assistant") return null;

  const content = typeof m.content === "string" ? m.content : "";
  const rawToolCalls = Array.isArray(m.tool_calls) ? m.tool_calls.filter(isValidToolCall) : [];

  return {
    role: "assistant",
    content,
    ...(rawToolCalls.length > 0 ? { tool_calls: rawToolCalls } : {}),
  };
}

/** OpenRouter echoes back which model in MODEL_CHAIN actually served the request. */
function extractModelName(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const model = (body as Record<string, unknown>).model;
  return typeof model === "string" ? model : null;
}

/**
 * Logs (never blocks or alters the reply) when a model's user-facing text leaks internal
 * implementation details — see internalLeakGuard.ts. The model name is included so the
 * fallback chain in backend-proxy/src/modelConfig.ts can be reordered later if one model
 * turns out to leak far more often than the others.
 */
function logIfInternalLeak(content: string, body: unknown): void {
  const leak = findLeakedInternalReference(content);
  if (!leak) return;
  console.warn(
    `[AgentOrchestrator] reply leaked an internal reference ("${leak}") from model ` +
      `"${extractModelName(body) ?? "unknown"}":`,
    content
  );
}

async function callProxy(messages: ChatMessage[]): Promise<ProxyOutcome> {
  if (!config.proxyBaseUrl) {
    console.error("[AgentOrchestrator] proxyBaseUrl is not configured (VITE_AGENT_PROXY_URL).");
    return { ok: false, friendlyMessage: NOT_CONFIGURED_REPLY };
  }

  const url = `${config.proxyBaseUrl.replace(/\/+$/, "")}/agent/chat`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages, tools: AGENT_TOOLS }),
    });
  } catch (err) {
    console.error("[AgentOrchestrator] proxy request failed:", err);
    return { ok: false, friendlyMessage: UPSTREAM_UNAVAILABLE_REPLY };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    console.error("[AgentOrchestrator] proxy returned non-JSON response:", err);
    return { ok: false, friendlyMessage: GENERIC_ERROR_REPLY };
  }

  if (!response.ok) {
    console.error("[AgentOrchestrator] proxy error:", response.status, body);
    return { ok: false, friendlyMessage: friendlyMessageForStatus(response.status) };
  }

  const message = extractAssistantMessage(body);
  if (!message) {
    console.error("[AgentOrchestrator] proxy response missing a valid assistant message:", body);
    return { ok: false, friendlyMessage: GENERIC_ERROR_REPLY };
  }

  if (message.content) logIfInternalLeak(message.content, body);

  return { ok: true, message };
}

// ─── Tool-call execution ─────────────────────────────────────────────

function parseToolArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    // Malformed tool_call arguments from the model — AgentToolRunner rejects missing
    // required fields gracefully, so empty args just becomes a normal tool-level error.
    return {};
  }
}

/**
 * Builds the final turn result, guaranteeing `reply` is visible in `updatedHistory` as a
 * trailing assistant message. Needed because early-return paths (proxy failure, turn-limit)
 * produce a `reply` that was never pushed onto `newMessages` — without this, AgentChatPanel
 * (which renders `updatedHistory`, not `reply`) shows nothing for those turns.
 */
function finishTurn(
  reply: string,
  newMessages: ChatMessage[],
  conversationHistory: ChatMessage[]
): RunAgentTurnResult {
  const last = newMessages[newMessages.length - 1];
  const alreadyVisible = last?.role === "assistant" && last.content === reply;
  const messages = alreadyVisible ? newMessages : [...newMessages, { role: "assistant" as const, content: reply }];
  return { reply, updatedHistory: [...conversationHistory, ...messages] };
}

async function runOneToolCall(call: AgentToolCall, context: ToolExecutionContext): Promise<ChatMessage> {
  const args = parseToolArguments(call.function.arguments);
  const outcome = await executeToolCall(call.function.name, args, context);

  return {
    role: "tool",
    tool_call_id: call.id,
    name: call.function.name,
    content: JSON.stringify(outcome.error !== undefined ? { error: outcome.error } : { result: outcome.result }),
  };
}

// ─── Entry point ─────────────────────────────────────────────────────

/**
 * Runs one user turn through the tool-calling loop: sends the message to the proxy,
 * executes any tool_calls the model requests, feeds results back, and repeats (up to
 * MAX_TOOL_TURNS proxy round trips) until the model answers with plain text.
 *
 * Never throws — proxy failures and turn-limit overruns both come back as a safe,
 * user-facing reply rather than a raw error.
 */
export async function runAgentTurn(
  userMessage: string,
  conversationHistory: ChatMessage[],
  context: ToolExecutionContext
): Promise<RunAgentTurnResult> {
  const systemPrompt = buildSystemPrompt();
  const retrievedChunks = await fetchRetrievedContext(userMessage);
  const contextMessage = buildContextMessage(retrievedChunks);
  const newMessages: ChatMessage[] = [{ role: "user", content: userMessage }];
  const workingMessages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    ...(contextMessage ? [contextMessage] : []),
    ...conversationHistory,
    ...newMessages,
  ];

  for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
    const outcome = await callProxy(workingMessages);

    if (!outcome.ok) {
      return finishTurn(outcome.friendlyMessage, newMessages, conversationHistory);
    }

    const assistantMessage = outcome.message;
    workingMessages.push(assistantMessage);
    newMessages.push(assistantMessage);

    const toolCalls = assistantMessage.tool_calls ?? [];
    if (toolCalls.length === 0) {
      return finishTurn(assistantMessage.content, newMessages, conversationHistory);
    }

    for (const call of toolCalls) {
      const toolMessage = await runOneToolCall(call, context);
      workingMessages.push(toolMessage);
      newMessages.push(toolMessage);
    }
  }

  return finishTurn(MAX_TURNS_EXCEEDED_REPLY, newMessages, conversationHistory);
}
