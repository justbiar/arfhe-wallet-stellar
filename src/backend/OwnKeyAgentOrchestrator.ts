/**
 * OwnKeyAgentOrchestrator — runs the tool-calling loop for the "Kendi API Anahtarım" agent
 * backend, talking to OpenRouter directly with the user's own key (OwnKeyAgentService.ts)
 * instead of Arfio's backend-proxy (AgentOrchestrator.ts) or the retired team-VPS/Ollama flow
 * (VpsAgentOrchestrator.ts).
 *
 * Deliberately the least customized of the three orchestrators: a user who pastes their own
 * OpenRouter key is choosing their own (real, cloud-class) model, so this reuses Arfio's own
 * buildSystemPrompt() and the full, untrimmed AGENT_TOOLS list rather than VpsAgentOrchestrator's
 * cut-down prompt/lite-tools pair — those exist specifically to work around a small CPU-bound
 * local model (qwen2.5:3b) losing the thread on a long prompt, which does not apply here. No
 * VpsFastPath either, for the same reason: that path exists to skip a slow (~30-100s) Ollama
 * round trip for common requests, and a cloud model over OpenRouter does not have that latency
 * problem to begin with.
 *
 * No quota/credit accounting (VpsAgentOrchestrator's consumeVpsQuota) — the user is billed
 * directly by OpenRouter for their own usage, so there is nothing for this wallet to meter.
 *
 * Tool EXECUTION still always happens here, client-side, via the exact same
 * AgentToolRunner.executeToolCall every other backend uses — the model only ever decides WHICH
 * tool to call, never runs one itself.
 */

import { AGENT_TOOLS } from "./agentTools.js";
import type { ToolExecutionContext } from "./AgentToolRunner.js";
import { findLeakedInternalReference } from "./internalLeakGuard.js";
import {
  buildSystemPrompt,
  runOneToolCall,
  finishTurn,
  isAwaitingConfirmation,
  type ChatMessage,
  type RunAgentTurnResult,
} from "./AgentOrchestrator.js";
import { ownKeyChatCompletion } from "./OwnKeyAgentService.js";

const MAX_TOOL_TURNS = 5;

const MAX_TURNS_EXCEEDED_REPLY =
  "Üzgünüm, bu isteği tamamlayamadım — çok fazla adım gerekti. Lütfen sorunuzu daha basit " +
  "bir şekilde tekrar sorar mısınız?";

function logIfInternalLeak(content: string): void {
  const leak = findLeakedInternalReference(content);
  if (!leak) return;
  console.warn(`[OwnKeyAgentOrchestrator] reply leaked an internal reference ("${leak}"):`, content);
}

export async function runOwnKeyAgentTurn(
  userMessage: string,
  conversationHistory: ChatMessage[],
  context: ToolExecutionContext
): Promise<RunAgentTurnResult> {
  const systemPrompt = buildSystemPrompt();
  const newMessages: ChatMessage[] = [{ role: "user", content: userMessage }];
  const workingMessages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    ...conversationHistory,
    ...newMessages,
  ];

  for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
    let assistantMessage: ChatMessage;
    try {
      assistantMessage = await ownKeyChatCompletion(workingMessages, AGENT_TOOLS);
    } catch (err) {
      console.error("[OwnKeyAgentOrchestrator] chat completion failed:", err);
      // Re-thrown (not swallowed into a hardcoded reply) — an invalid/missing key or a rate
      // limit is something the user can actually fix, so AgentChatPanel needs the reasonKey to
      // show them the right message, same as VpsAgentError's contract.
      throw err;
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

      // Same stop-dead-on-pending-confirmation rule as every other orchestrator's loop — see
      // isAwaitingConfirmation's docs for why continuing here would risk the model hallucinating
      // a completed transfer.
      if (isAwaitingConfirmation(call.function.name, toolMessage)) {
        return { reply: assistantMessage.content, updatedHistory: [...conversationHistory, ...newMessages] };
      }
    }
  }

  return finishTurn(MAX_TURNS_EXCEEDED_REPLY, newMessages, conversationHistory);
}
