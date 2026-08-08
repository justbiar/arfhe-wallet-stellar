/**
 * AgentService.ts — Configuration, persistence, and API calling for the
 * ArfheWallet in-app AI Agent (Agent.tsx).
 *
 * Two agent modes:
 *  - "arfhe": a small built-in assistant that answers basic wallet
 *    questions (balance, address, network) from local wallet state.
 *    No API key required.
 *  - "openai" / "anthropic" / "custom": the user's own agent, called
 *    directly from the browser with their own API key.
 */

import i18n from "../i18n.js";

export type AgentProvider = "arfhe" | "openai" | "anthropic" | "custom";

export interface MCPServerConfig {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
}

export interface AgentConfig {
  configured: boolean;
  provider: AgentProvider;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  systemPrompt?: string;
  mcpServers: MCPServerConfig[];
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "error";
  text: string;
  ts: number;
}

// ─── Defaults ───────────────────────────────────────────────────────

export const DEFAULT_MODELS: Record<AgentProvider, string> = {
  arfhe: "arfhe-assistant",
  openai: "gpt-4o-mini",
  anthropic: "claude-sonnet-5",
  custom: "",
};

function defaultConfig(): AgentConfig {
  return {
    configured: false,
    provider: "arfhe",
    model: DEFAULT_MODELS.arfhe,
    mcpServers: [],
  };
}

// ─── Persistence ────────────────────────────────────────────────────

const CONFIG_KEY = "arfhe_agent_config";

export function loadAgentConfig(): AgentConfig {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (!raw) return defaultConfig();
    const parsed = JSON.parse(raw) as Partial<AgentConfig>;
    return { ...defaultConfig(), ...parsed, mcpServers: parsed.mcpServers ?? [] };
  } catch {
    return defaultConfig();
  }
}

export function saveAgentConfig(config: AgentConfig): void {
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
  } catch {
    // storage unavailable — config just won't persist across reloads
  }
}

export function resetAgentConfig(): AgentConfig {
  const fresh = defaultConfig();
  saveAgentConfig(fresh);
  return fresh;
}

// ─── Local "Arfhe Agent" assistant (no API key) ────────────────────

export interface WalletSnapshot {
  accountName: string;
  address: string;
  networkName: string;
  totalBalanceUsd: number;
}

function localAssistantReply(userText: string, snapshot: WalletSnapshot | null): string {
  const q = userText.toLowerCase();

  if (!snapshot) {
    return i18n.t("agent.localNoSnapshot");
  }

  if (/(bakiye|balance)/.test(q)) {
    return i18n.t("agent.localBalance", {
      balance: snapshot.totalBalanceUsd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
      network: snapshot.networkName,
    });
  }
  if (/(adres|address)/.test(q)) {
    return i18n.t("agent.localAddress", { name: snapshot.accountName, address: snapshot.address });
  }
  if (/(ağ|network|chain)/.test(q)) {
    return i18n.t("agent.localNetwork", { network: snapshot.networkName });
  }
  if (/(shield|gizli|fhe|encrypt)/.test(q)) {
    return i18n.t("agent.localShield");
  }
  if (/(yardım|help|ne yapabilir)/.test(q)) {
    return i18n.t("agent.localHelp");
  }

  return i18n.t("agent.localFallback");
}

// ─── Remote agent calling (OpenAI-compatible / Anthropic) ──────────

interface WireMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

async function callOpenAICompatible(config: AgentConfig, messages: WireMessage[]): Promise<string> {
  const base = (config.baseUrl?.trim() || "https://api.openai.com/v1").replace(/\/+$/, "");
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model || DEFAULT_MODELS[config.provider] || "gpt-4o-mini",
      messages,
      max_tokens: 700,
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`API error (${res.status}): ${errText.slice(0, 200) || res.statusText}`);
  }

  const json = await res.json() as { choices?: { message?: { content?: string } }[] };
  const content = json.choices?.[0]?.message?.content;
  if (!content) throw new Error(i18n.t("agent.apiEmptyResponse"));
  return content;
}

async function callAnthropic(config: AgentConfig, messages: WireMessage[]): Promise<string> {
  const systemMsg = messages.find(m => m.role === "system")?.content;
  const chatMessages = messages
    .filter(m => m.role !== "system")
    .map(m => ({ role: m.role, content: m.content }));

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": config.apiKey || "",
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: config.model || DEFAULT_MODELS.anthropic,
      max_tokens: 700,
      ...(systemMsg ? { system: systemMsg } : {}),
      messages: chatMessages,
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`API error (${res.status}): ${errText.slice(0, 200) || res.statusText}`);
  }

  const json = await res.json() as { content?: { type: string; text?: string }[] };
  const text = json.content?.find(c => c.type === "text")?.text;
  if (!text) throw new Error(i18n.t("agent.apiEmptyResponse"));
  return text;
}

/**
 * Send the conversation to the configured agent and return the reply text.
 * Throws on failure (caller should surface the error to the user).
 */
export async function sendToAgent(
  config: AgentConfig,
  history: ChatMessage[],
  userText: string,
  snapshot: WalletSnapshot | null,
): Promise<string> {
  if (config.provider === "arfhe") {
    return localAssistantReply(userText, snapshot);
  }

  if (!config.apiKey?.trim()) {
    throw new Error(i18n.t("agent.apiKeyMissing"));
  }

  const wireHistory: WireMessage[] = history
    .filter((m): m is ChatMessage & { role: "user" | "assistant" } => m.role !== "error")
    .map(m => ({ role: m.role, content: m.text }));

  const messages: WireMessage[] = [
    ...(config.systemPrompt?.trim() ? [{ role: "system" as const, content: config.systemPrompt.trim() }] : []),
    ...wireHistory,
    { role: "user", content: userText },
  ];

  if (config.provider === "anthropic") {
    return callAnthropic(config, messages);
  }
  return callOpenAICompatible(config, messages);
}
