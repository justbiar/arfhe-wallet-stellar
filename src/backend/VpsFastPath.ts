/**
 * VpsFastPath — instant, LLM-free shortcuts for a handful of common, unambiguous requests
 * (balance, faucet, shielded portfolio, send/shield/unshield). Checked BEFORE the slow
 * VPS/Ollama round trip in VpsAgentOrchestrator.ts — when the user's message matches one of
 * these patterns with enough confidence, the matching tool is called directly (same
 * executeToolCall path the model would have used) and a canned, templated reply is built from
 * its real result, skipping Ollama's CPU-bound ~30-100s inference entirely. Anything that
 * doesn't match falls through to the normal (slow) LLM path unchanged — this is purely an
 * optimization, never the only path.
 *
 * This exists because qwen2.5:3b (the model this VPS path runs) is, empirically, unreliable at
 * exactly the thing that matters most here: reading a plain-language request and calling the
 * right propose_* tool with the right arguments. Left to the model alone, "1 ETH şifrele" would
 * as often produce an off-topic reply or no tool call at all as it would a working proposal —
 * these patterns turn the common phrasings into a deterministic, always-correct path instead.
 *
 * Deliberately conservative: a false NEGATIVE (falling back to the slow-but-correct LLM) costs a
 * few seconds. A false POSITIVE risks acting on a message the user didn't mean as a command — for
 * propose_send/shield/unshield that's low-stakes (they only ever produce a ConfirmationCard
 * preview, same as the LLM path; the user still has to approve it, nothing is ever broadcast
 * here), but the balance/faucet/portfolio patterns are kept narrow anyway so a genuinely
 * ambiguous message still reaches the model instead of getting a canned non-answer.
 */

import { runOneToolCall, isAwaitingConfirmation, type ChatMessage, type RunAgentTurnResult } from "./AgentOrchestrator.js";
import type { ToolExecutionContext } from "./AgentToolRunner.js";

// NOT trailing \b on Turkish roots: Türkçe eklemeli bir dil, ekler kelimeye bitişik gelir
// (bakiye+m, bakiye+niz, gönder+ir, musluk+ta) — sondaki \b bu çekimli hallerin HİÇBİRİYLE
// eşleşmez. Baştaki \b yeterli (kelime ortasında yanlışlıkla eşleşmeyi önler).
const BALANCE_RE = /\b(bakiye|balance)/i;
const FAUCET_RE = /\b(faucet|musluk|test\s*(token|coin|para))/i;
const SHIELDED_RE = /\b(shielded|gizli|şifreli).*\b(portf|varlık|bakiye)/i;
// "kalkanla"/"kalkan...kaldır"/"kalkan...aç" mirror the wallet's own UI vocabulary
// ("🛡️ Kalkanlama (Shield)" / "🔓 Kalkan Kaldırma (Unshield)" — see TransactionSimulator.ts's
// warnings) rather than a literal English/technical "shield"/"unshield", which is how a user
// who has actually used this wallet is far more likely to phrase the request.
const SHIELD_VERB_RE = /\b(shield|kalkanla|şifrele|gizle)/i;
const UNSHIELD_VERB_RE = /\b(unshield|kalkan.{0,3}(kaldır|aç)|açığa çıkar|şifreyi çöz)/i;
const ADDRESS_RE = /0x[a-fA-F0-9]{40}/;
const SEND_VERB_RE = /\b(gönder|yolla|send)/i;
// Deliberately NOT "eth" alone here (unlike AgentToolRunner's NAMED_NETWORKS) — "eth" is also
// just the currency name on every chain this wallet supports, so "ETH bakiyem ne kadar" while on
// Arbitrum must NOT be misread as "switch to Ethereum", it means "my ETH-denominated balance on
// whatever chain I'm already on". Only an unambiguous full chain name triggers the override.
const CHAIN_NAME_RE = /\b(ethereum|arbitrum|base)\b/i;
const AMOUNT_RE = /\b(\d+(?:[.,]\d+)?)\b/;
const TOKEN_SYMBOL_RE = /\b(ETH|USDC|USDT|MATIC|AVAX|BNB|DAI)\b/i;
// create_account is IMMEDIATE_TOOLS, not a proposal — no address/amount to require first, so
// this pattern alone is enough. "yeni (bir) cüzdan/hesap/adres" covers the wallet's own
// phrasing regardless of which verb follows ("oluştur", "aç", "ekle" ...) — bare "aç"/"open" is
// deliberately NOT a trigger on its own, it means a dozen unrelated things without "yeni ... "
// right before it.
const CREATE_ACCOUNT_RE = /\b(yeni (bir )?(cüzdan|hesap|adres)|create (a |an )?(new )?(wallet|account))\b/i;

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
  const r = result as { balance?: string; network?: string } | null;
  if (!r?.balance) return "Bakiyenizi alamadım.";
  const networkSuffix = r.network ? ` (${r.network})` : "";
  return `Açık (şifrelenmemiş) bakiyeniz${networkSuffix}: ${r.balance}.`;
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

function formatCreateAccount(result: unknown): string {
  const r = result as { address?: string; name?: string } | null;
  if (!r?.address) return "Yeni hesap oluşturulamadı.";
  return `Yeni hesap oluşturuldu: ${r.name ?? "isimsiz"} (${r.address}). Artık aktif hesabınız bu.`;
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

  // create_account first: it shares no vocabulary with anything else here ("hesap"/"cüzdan"
  // alone, without "yeni", never reaches this branch — see CREATE_ACCOUNT_RE), and unlike every
  // other branch below it isn't a proposal tool at all, so there's no confirmation card to wait
  // for — the result is final the moment the tool call returns.
  if (CREATE_ACCOUNT_RE.test(userMessage)) {
    return fastToolReply(userMessage, "create_account", {}, context, conversationHistory, formatCreateAccount);
  }

  // Send: needs an explicit verb + a real address + a numeric amount, all three — narrow on
  // purpose so a hypothetical ("0.5 ETH gönderirsem ne olur?") is still ambiguous enough to
  // fall through to the model instead of popping an unwanted confirmation card.
  if (SEND_VERB_RE.test(userMessage) && address && amount) {
    const tokenSymbol = TOKEN_SYMBOL_RE.exec(userMessage)?.[1]?.toUpperCase();
    const args: Record<string, unknown> = { to: address, amount: amount.replace(",", ".") };
    if (tokenSymbol) args.tokenSymbol = tokenSymbol;
    return fastToolReply(userMessage, "propose_send", args, context, conversationHistory, () => "");
  }

  // Unshield must be checked before shield because "unshield" contains "shield".
  //
  // tokenSymbol is REQUIRED by both propose_shield and propose_unshield's schema
  // (requireTokenSymbol(args, true) throws otherwise) — omitting it when the message doesn't
  // name a token used to send that validation error itself back as the "reply", with no
  // confirmation card at all (a real bug this fixed: "1 ETH şifrele" worked because "ETH" is
  // in TOKEN_SYMBOL_RE, but "biraz şifreleyebilir misin" or "0.5 unshield et" did not, and
  // silently failed). Defaulting the network's native currency ("ETH" on every network this
  // wallet currently supports) is safe for both: AgentToolRunner.prepareProposeUnshield now
  // resolves a plain "ETH" against the native shielded holding too, not just its confidential
  // wrapper symbol (e.g. "aeETH") — see that function's docs.
  if (UNSHIELD_VERB_RE.test(userMessage) && amount) {
    const tokenSymbol = TOKEN_SYMBOL_RE.exec(userMessage)?.[1]?.toUpperCase() ?? "ETH";
    const args: Record<string, unknown> = { amount: amount.replace(",", "."), tokenSymbol };
    return fastToolReply(userMessage, "propose_unshield", args, context, conversationHistory, () => "");
  }

  if (SHIELD_VERB_RE.test(userMessage) && amount) {
    const tokenSymbol = TOKEN_SYMBOL_RE.exec(userMessage)?.[1]?.toUpperCase() ?? "ETH";
    const args: Record<string, unknown> = { amount: amount.replace(",", "."), tokenSymbol };
    return fastToolReply(userMessage, "propose_shield", args, context, conversationHistory, () => "");
  }

  if (FAUCET_RE.test(userMessage)) {
    return fastToolReply(userMessage, "get_faucet_info", {}, context, conversationHistory, formatFaucet);
  }

  if (SHIELDED_RE.test(userMessage)) {
    return fastToolReply(userMessage, "get_shielded_portfolio", {}, context, conversationHistory, formatShieldedPortfolio);
  }

  // Balance is checked last and requires no address to already be present — "0.01 ETH gönder
  // 0x...'e, bakiyem yeter mi?" should still hit the send branch above, not this one. A network
  // name mentioned alongside ("Base'de bakiyem ne kadar") is forwarded as get_balance's
  // `network` arg (see AgentToolRunner.ts's resolveBalanceCheckNetwork) — without this, the fast
  // path would silently answer for the active network and ignore what was actually asked.
  if (BALANCE_RE.test(userMessage) && !address) {
    const network = CHAIN_NAME_RE.exec(userMessage)?.[1]?.toLowerCase();
    return fastToolReply(
      userMessage,
      "get_balance",
      network ? { network } : {},
      context,
      conversationHistory,
      formatBalance
    );
  }

  return null;
}
