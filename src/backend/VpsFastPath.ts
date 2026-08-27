/**
 * VpsFastPath — instant, LLM-free shortcuts for a handful of common, unambiguous requests
 * (balance, faucet, shielded portfolio, a plain token send). Checked BEFORE the slow VPS/Ollama
 * round trip in VpsAgentOrchestrator.ts — when the user's message matches one of these patterns
 * with enough confidence, the matching tool is called directly (same executeToolCall path the
 * model would have used) and a canned, templated reply is built from its real result, skipping
 * Ollama's CPU-bound ~30-100s inference entirely. Anything that doesn't match falls through to
 * the normal (slow) LLM path unchanged — this is purely an optimization, never the only path.
 *
 * Deliberately conservative: a false NEGATIVE (falling back to the slow-but-correct LLM) costs a
 * few seconds. A false POSITIVE risks acting on a message the user didn't mean as a command — for
 * propose_send that's low-stakes (it only ever produces a ConfirmationCard preview, same as the
 * LLM path; the user still has to approve it, nothing is ever broadcast here), but the balance/
 * faucet/portfolio patterns are kept narrow anyway so a genuinely ambiguous message still reaches
 * the model instead of getting a canned non-answer.
 */

import { runOneToolCall, isAwaitingConfirmation, type ChatMessage, type RunAgentTurnResult } from "./AgentOrchestrator.js";
import type { ToolExecutionContext } from "./AgentToolRunner.js";

// NOT trailing \b on Turkish roots: Türkçe eklemeli bir dil, ekler kelimeye bitişik gelir
// (bakiye+m, bakiye+niz, gönder+ir, musluk+ta) — sondaki \b bu çekimli hallerin HİÇBİRİYLE
// eşleşmez. Baştaki \b yeterli (kelime ortasında yanlışlıkla eşleşmeyi önler).
const BALANCE_RE = /\b(bakiye|balance)/i;
const FAUCET_RE = /\b(faucet|musluk|test\s*(token|coin|para))/i;
const SHIELDED_RE = /\b(shielded|gizli|şifreli).*\b(portf|varlık|bakiye)/i;
const ADDRESS_RE = /0x[a-fA-F0-9]{40}/;
const SEND_VERB_RE = /\b(gönder|yolla|send)/i;
const AMOUNT_RE = /\b(\d+(?:[.,]\d+)?)\b/;
const TOKEN_SYMBOL_RE = /\b(ETH|USDC|USDT|MATIC|AVAX|BNB|DAI)\b/i;

/**
 * Runs one tool directly (bypassing the model entirely) and builds the same
 * user/assistant(tool_calls)/tool wire shape a real LLM turn would have produced, so
 * buildChatItems in AgentChatPanel.tsx renders it identically either way — a ConfirmationCard
 * for a proposal tool awaiting confirmation, or a plain assistant bubble otherwise.
 */
async function fastToolReply(
  userMessage: string,
  toolName: string,
  args: Record<string, unknown>,
  context: ToolExecutionContext,
  conversationHistory: ChatMessage[],
  formatReply: (result: unknown) => string
): Promise<RunAgentTurnResult> {
  const toolCallId = `fastpath_${Date.now()}`;
  const toolCall = { id: toolCallId, type: "function" as const, function: { name: toolName, arguments: JSON.stringify(args) } };
  const assistantToolCallMessage: ChatMessage = { role: "assistant", content: "", tool_calls: [toolCall] };
  const toolMessage = await runOneToolCall(toolCall, context);

  const userChatMessage: ChatMessage = { role: "user", content: userMessage };

  // Proposal tools (propose_send) can come back needing confirmation — stop there and let the
  // ConfirmationCard render, exactly like the LLM path does for the same shape (see
  // AgentOrchestrator.ts's isAwaitingConfirmation docs for why the loop must stop dead here).
  if (isAwaitingConfirmation(toolName, toolMessage)) {
    return {
      reply: "Öneriyi hazırladım, onayınızı bekliyor.",
      updatedHistory: [...conversationHistory, userChatMessage, assistantToolCallMessage, toolMessage],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(toolMessage.content);
  } catch {
    parsed = null;
  }
  const payload = (parsed as { result?: unknown; error?: string } | null) ?? {};
  const reply = payload.error ? payload.error : formatReply(payload.result);
  const finalAssistantMessage: ChatMessage = { role: "assistant", content: reply };

  return {
    reply,
    updatedHistory: [...conversationHistory, userChatMessage, assistantToolCallMessage, toolMessage, finalAssistantMessage],
  };
}

function formatBalance(result: unknown): string {
  const r = result as { balance?: string } | null;
  if (!r?.balance) return "Bakiyenizi alamadım.";
  return `Aktif cüzdanınızdaki açık (şifrelenmemiş) bakiyeniz: ${r.balance}.`;
}

function formatFaucet(result: unknown): string {
  const r = result as { supported?: boolean; network?: string; faucetUrl?: string; address?: string } | null;
  if (!r?.supported) {
    return `Şu an bağlı olduğunuz ağ (${r?.network ?? "bilinmiyor"}) için bilinen bir faucet yok.`;
  }
  return (
    `${r.network} ağı için faucet:\n` +
    `Adres: ${r.address}\n` +
    `Link: ${r.faucetUrl}\n\n` +
    "Faucet'i otomatik kullanamıyorum (CAPTCHA gerektiriyor) — formu kendiniz tamamlamanız gerekiyor."
  );
}

function formatShieldedPortfolio(result: unknown): string {
  const holdings = (result as { symbol: string; balance: string }[] | null) ?? [];
  if (holdings.length === 0) return "Şu an şifreli (shielded) bir varlığınız görünmüyor.";
  return "Şifreli varlıklarınız:\n" + holdings.map((h) => `- ${h.symbol}: ${h.balance}`).join("\n");
}

/**
 * Tries to answer `userMessage` instantly without the LLM. Returns null (defer to the slow path)
 * whenever the message doesn't clearly match one of the patterns above.
 */
export async function tryVpsFastPath(
  userMessage: string,
  conversationHistory: ChatMessage[],
  context: ToolExecutionContext
): Promise<RunAgentTurnResult | null> {
  const address = ADDRESS_RE.exec(userMessage)?.[0];
  const amount = AMOUNT_RE.exec(userMessage)?.[1];

  // Send: needs an explicit verb + a real address + a numeric amount, all three — narrow on
  // purpose so a hypothetical ("0.5 ETH gönderirsem ne olur?") is still ambiguous enough to
  // fall through to the model instead of popping an unwanted confirmation card.
  if (SEND_VERB_RE.test(userMessage) && address && amount) {
    const tokenSymbol = TOKEN_SYMBOL_RE.exec(userMessage)?.[1]?.toUpperCase();
    const args: Record<string, unknown> = { to: address, amount: amount.replace(",", ".") };
    if (tokenSymbol) args.tokenSymbol = tokenSymbol;
    return fastToolReply(userMessage, "propose_send", args, context, conversationHistory, () => "");
  }

  if (FAUCET_RE.test(userMessage)) {
    return fastToolReply(userMessage, "get_faucet_info", {}, context, conversationHistory, formatFaucet);
  }

  if (SHIELDED_RE.test(userMessage)) {
    return fastToolReply(userMessage, "get_shielded_portfolio", {}, context, conversationHistory, formatShieldedPortfolio);
  }

  // Balance is checked last and requires no address to already be present — "0.01 ETH gönder
  // 0x...'e, bakiyem yeter mi?" should still hit the send branch above, not this one.
  if (BALANCE_RE.test(userMessage) && !address) {
    return fastToolReply(userMessage, "get_balance", {}, context, conversationHistory, formatBalance);
  }

  return null;
}
