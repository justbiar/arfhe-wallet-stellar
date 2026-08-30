/**
 * VpsAgentOrchestrator — runs the tool-calling loop for the "Kendi VPS'im" agent backend, the
 * structural counterpart of AgentOrchestrator.ts's runAgentTurn but talking to the user's own
 * VPS (VpsAgentService.ts's vpsChatCompletion, which forwards to Ollama's native tool-calling
 * chat API) instead of backend-proxy/OpenRouter.
 *
 * Tool EXECUTION always happens here, client-side, via the same AgentToolRunner.executeToolCall
 * Arfio uses — the VPS only ever decides WHICH tool to call, it can never run one itself (it has
 * no access to the user's private key, RPC connection, or AccountManager). This is why VPS mode
 * gets full parity with Arfio (balance visibility, propose_send/shield/unshield confirmation
 * cards, the lot) even though the VPS is a different LLM host entirely: everything downstream of
 * "the model decided to call tool X with args Y" is identical code either way.
 *
 * One quota unit is consumed via consumeVpsQuota() ONCE per call to runVpsAgentTurn — i.e. once
 * per user-sent message — never per internal tool-calling round trip, so a question that needs
 * three tool calls to answer doesn't silently cost three times the quota. That call is the one
 * thing here allowed to throw (VpsAgentError("agent.vpsErrorQuotaExceeded")) — the caller
 * (AgentChatPanel) is what knows how to translate a reasonKey into user-facing text, so letting
 * it propagate there instead of swallowing it into a hardcoded reply keeps that translation in
 * one place. Every other failure path (chat completion, turn limit) returns a normal
 * RunAgentTurnResult with a Turkish reply baked in, same as AgentOrchestrator.ts's own
 * never-throws contract — this module deals only in Turkish natural-language text throughout,
 * not i18n keys, matching that file's existing style.
 *
 * Uses its OWN short system prompt (buildVpsSystemPrompt below) instead of AgentOrchestrator's
 * buildSystemPrompt: measured against a small self-hosted model (qwen2.5:3b), Arfio's full
 * ~90-line policy prompt reliably caused the model to keep emitting tool_calls after already
 * getting an answer, burning through MAX_TOOL_TURNS without ever producing a final reply — small
 * local models follow a handful of short, blunt rules far more reliably than a long nuanced one.
 * The safety-critical rule (propose_* never executes anything by itself) is kept, everything else
 * is cut.
 */

import { AGENT_TOOLS, type AgentToolDefinition } from "./agentTools.js";
import type { ToolExecutionContext } from "./AgentToolRunner.js";
import { findLeakedInternalReference } from "./internalLeakGuard.js";
import {
  runOneToolCall,
  finishTurn,
  isAwaitingConfirmation,
  type ChatMessage,
  type RunAgentTurnResult,
} from "./AgentOrchestrator.js";
import { vpsChatCompletion, consumeVpsQuota } from "./VpsAgentService.js";
import { tryVpsFastPath } from "./VpsFastPath.js";
import type Account from "./Account.js";

const MAX_TOOL_TURNS = 5;

/**
 * Only the last N messages of prior conversation are resent — qwen2.5:3b (unlike a large cloud
 * model) visibly loses the thread in a long context and starts producing replies with no
 * relation to the wallet at all (see the "cüzdan oluşturmak için doğrulama talebi..." incident
 * this constant was added for). Capping history is a blunt fix (older context is gone, not
 * summarized), but for a small local model that's a better trade than an unbounded context it
 * can't reliably reason over. Kept generous enough (a handful of turns) to still resolve a
 * pending confirmation card, which lives a few messages back in the wire history.
 */
const MAX_HISTORY_MESSAGES = 8;

const GENERIC_ERROR_REPLY = "Şu anda isteğinizi işleyemedim. Lütfen birkaç dakika sonra tekrar deneyin.";
const MAX_TURNS_EXCEEDED_REPLY =
  "Üzgünüm, bu isteği tamamlayamadım — çok fazla adım gerekti. Lütfen sorunuzu daha basit " +
  "bir şekilde tekrar sorar mısınız?";

function buildVpsSystemPrompt(): string {
  return [
    "Sen ArfheWallet cüzdanının kendi VPS'inde çalışan bir yapay zeka asistanısın.",
    "Kullanıcı hangi dilde yazarsa SEN DE o dilde cevap ver.",
    "Bir tool çağırıp sonucunu (tool mesajını) aldıktan HEMEN SONRA: başka HİÇBİR tool çağırma, sadece o sonucu kısa ve doğal bir cümleyle kullanıcıya anlat ve DUR.",
    "Sen hiçbir zaman gerçek bir işlem (transaction) imzalayamaz, gönderemez veya onaylayamazsın. propose_send/propose_shield/propose_unshield/propose_confidential_transfer sadece bir ÖNİZLEME oluşturur — kullanıcı ayrı bir ekranda onaylamadan hiçbir şey gerçekleşmez. Bu araçlardan biri çalıştıktan sonra da kuralın aynı: sonucu tek cümleyle özetle ve DUR, 'işlem tamamlandı' gibi bir şey söyleme.",
    "Kullanıcı şifreli/gizli (aeETH, aeUSDC gibi) bakiyesini bir adrese göndermek isterse propose_confidential_transfer'ı kullan — propose_send SADECE açık (native/ERC-20) transferler içindir, şifreli transferi reddeder.",
    "Kullanıcı 'yeni bir cüzdan/hesap oluştur' derse create_account'ı HEMEN çağır — bu tamamen local bir işlemdir, hiçbir onay/önizleme gerekmez, fon ya da özel anahtar riske girmez. Açıklama istemeden, 'şu adımları izleyin' demeden direkt çağır ve sonucu (yeni adres) bildir.",
    "Tool/fonksiyon isimlerini (get_balance, propose_send gibi) kullanıcıya asla söyleme — gündelik, doğal bir dille anlat.",
    "Bir aracın sonucunu almadan bakiye veya miktar uydurma.",
    "Kullanıcının sorusuna uyan bir tool VARSA, önce onu ÇAĞIR — 'yapamıyorum', 'bu bilgiye erişimim yok' gibi bir şey söylemeden ÖNCE mutlaka ilgili tool'u dene. Örneğin faucet/test tokenı sorulursa get_faucet_info'yu çağır; bunu denemeden faucet bilgisi bulamadığını söylemek YANLIŞTIR.",
  ].join("\n");
}

/** Cuts a description down to its first sentence (or MAX_CHARS, whichever is shorter), at a word boundary. */
function truncateDescription(text: string, maxChars: number): string {
  const firstSentence = text.split(/(?<=[.!?])\s/)[0] ?? text;
  const candidate = firstSentence.length <= maxChars ? firstSentence : text;
  if (candidate.length <= maxChars) return candidate;
  const cut = candidate.slice(0, maxChars);
  return cut.slice(0, cut.lastIndexOf(" ")) + "…";
}

/**
 * AGENT_TOOLS' descriptions are written for a large cloud model (Arfio/OpenRouter) that pays no
 * meaningful latency cost for a verbose, nuanced explanation. On this VPS's CPU-only small model,
 * every one of those tokens is re-processed on EVERY turn (prompt_eval scales with input size —
 * see the perf discussion that led here), so the exact same 9-tool list that's "free" for Arfio
 * measurably adds tens of seconds here. This trims each description/parameter-description down to
 * a single short sentence — same tool names/parameters/required fields (correctness unaffected),
 * far fewer tokens to re-read every turn. Computed once at module load, not per call.
 */
function buildLiteTools(tools: readonly AgentToolDefinition[]): AgentToolDefinition[] {
  return tools.map((tool) => ({
    ...tool,
    function: {
      ...tool.function,
      description: truncateDescription(tool.function.description, 100),
      parameters: {
        ...tool.function.parameters,
        properties: Object.fromEntries(
          Object.entries(tool.function.parameters.properties).map(([key, schema]) => [
            key,
            { ...schema, description: truncateDescription(schema.description, 60) },
          ])
        ),
      },
    },
  }));
}

const LITE_AGENT_TOOLS = buildLiteTools(AGENT_TOOLS);

function logIfInternalLeak(content: string): void {
  const leak = findLeakedInternalReference(content);
  if (!leak) return;
  console.warn(`[VpsAgentOrchestrator] reply leaked an internal reference ("${leak}"):`, content);
}

export async function runVpsAgentTurn(
  userMessage: string,
  conversationHistory: ChatMessage[],
  context: ToolExecutionContext,
  account: Account
): Promise<RunAgentTurnResult> {
  // Deliberately NOT wrapped in try/catch — a quota rejection should surface to the caller as
  // VpsAgentError, not get swallowed into a generic reply (see file header).
  await consumeVpsQuota(account);

  // Skip the ~30-100s Ollama round trip entirely for a handful of common, unambiguous requests
  // (balance, faucet, shielded portfolio, a plain send) — see VpsFastPath.ts. Still costs the one
  // quota unit already consumed above; only the slow inference step is skipped, not accounting.
  const fastResult = await tryVpsFastPath(userMessage, conversationHistory, context);
  if (fastResult) return fastResult;

  const systemPrompt = buildVpsSystemPrompt();
  const newMessages: ChatMessage[] = [{ role: "user", content: userMessage }];
  const recentHistory = conversationHistory.slice(-MAX_HISTORY_MESSAGES);
  const workingMessages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    ...recentHistory,
    ...newMessages,
  ];

  for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
    let assistantMessage: ChatMessage;
    try {
      assistantMessage = await vpsChatCompletion(workingMessages, LITE_AGENT_TOOLS, account);
    } catch (err) {
      console.error("[VpsAgentOrchestrator] chat completion failed:", err);
      return finishTurn(GENERIC_ERROR_REPLY, newMessages, conversationHistory);
    }

    workingMessages.push(assistantMessage);
    newMessages.push(assistantMessage);

    const toolCalls = assistantMessage.tool_calls ?? [];
    if (toolCalls.length === 0) {
      if (assistantMessage.content) logIfInternalLeak(assistantMessage.content);
      return finishTurn(assistantMessage.content, newMessages, conversationHistory);
    }

    for (const call of toolCalls) {
      const toolMessage = await runOneToolCall(call, context);
      workingMessages.push(toolMessage);
      newMessages.push(toolMessage);

      // Same stop-dead-on-pending-confirmation rule as AgentOrchestrator.ts's own loop — see
      // isAwaitingConfirmation's docs there for why continuing the loop here would risk the
      // model hallucinating a completed transfer.
      if (isAwaitingConfirmation(call.function.name, toolMessage)) {
        return { reply: assistantMessage.content, updatedHistory: [...conversationHistory, ...newMessages] };
      }
    }
  }

  return finishTurn(MAX_TURNS_EXCEEDED_REPLY, newMessages, conversationHistory);
}
