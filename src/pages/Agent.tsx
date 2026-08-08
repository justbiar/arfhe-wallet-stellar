/**
 * Agent.tsx — In-wallet AI Agent
 *
 * First run: choose between the built-in "Arfhe Agent" (no setup needed)
 * or bringing your own agent (API key + connection details). Once
 * configured, shows a chat UI with a settings drawer to change the
 * provider, API key, model, system prompt, and MCP servers at any time.
 */

import * as React from "react";
import {
  Box,
  Typography,
  Button,
  TextField,
  IconButton,
  Drawer,
  Stack,
  CircularProgress,
  Paper,
} from "@mui/material";
import { Settings, Send, SmartToy, Person, ErrorOutline } from "@mui/icons-material";
import { useTranslation } from "react-i18next";
import { WalletContext } from "../AppContext.js";
import { useActiveAccount } from "../ActiveAccountProvider.js";
import {
  loadAgentConfig,
  saveAgentConfig,
  resetAgentConfig,
  sendToAgent,
  type AgentConfig,
  type ChatMessage,
  type WalletSnapshot,
} from "../backend/AgentService.js";
import AgentSettingsPanel from "../components/panels/AgentSettingsPanel.js";

// ─── Setup Screen ───────────────────────────────────────────────────

function AgentSetup({ onConfigured }: { onConfigured: (config: AgentConfig) => void }) {
  const { t } = useTranslation();
  const [mode, setMode] = React.useState<"choice" | "own">("choice");
  const [apiKey, setApiKey] = React.useState("");
  const [model, setModel] = React.useState("gpt-4o-mini");
  const [baseUrl, setBaseUrl] = React.useState("");

  const handleUseArfhe = () => {
    const config = loadAgentConfig();
    onConfigured({ ...config, provider: "arfhe", configured: true });
  };

  const handleSaveOwn = () => {
    if (!apiKey.trim()) return;
    const config = loadAgentConfig();
    onConfigured({
      ...config,
      provider: "custom",
      apiKey: apiKey.trim(),
      model: model.trim() || "gpt-4o-mini",
      baseUrl: baseUrl.trim() || undefined,
      configured: true,
    });
  };

  if (mode === "own") {
    return (
      <Box sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 2, maxWidth: 360, mx: 'auto' }}>
        <Typography variant="h6" sx={{ fontFamily: 'var(--font-mono)', textTransform: 'uppercase', color: 'text.primary' }}>
          {t('agent.ownFormTitle')}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {t('agent.ownFormDesc')}
        </Typography>
        <TextField
          label={t('agent.apiKeyLabel')}
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          autoComplete="off"
          fullWidth
        />
        <TextField
          label={t('agent.modelLabel')}
          placeholder="gpt-4o-mini"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          fullWidth
        />
        <TextField
          label={t('agent.baseUrlLabel')}
          placeholder="https://api.openai.com/v1"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          fullWidth
        />
        <Button variant="contained" fullWidth disabled={!apiKey.trim()} onClick={handleSaveOwn} sx={{ height: 44 }}>
          {t('agent.saveContinue')}
        </Button>
        <Button variant="text" onClick={() => setMode("choice")} sx={{ color: 'text.secondary' }}>
          {t('agent.back')}
        </Button>
      </Box>
    );
  }

  return (
    <Box sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 2, maxWidth: 360, mx: 'auto' }}>
      <Typography variant="h6" sx={{ fontFamily: 'var(--font-mono)', textTransform: 'uppercase', color: 'text.primary', textAlign: 'center', mb: 1 }}>
        {t('agent.setupTitle')}
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ textAlign: 'center', mb: 1 }}>
        {t('agent.setupSubtitle')}
      </Typography>

      <Paper
        elevation={0}
        onClick={handleUseArfhe}
        sx={{ p: 2.5, border: '1px solid', borderColor: 'divider', cursor: 'pointer', '&:hover': { borderColor: 'text.primary' } }}
      >
        <Typography variant="subtitle1" fontWeight={700}>{t('agent.arfheTitle')}</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
          {t('agent.arfheDesc')}
        </Typography>
      </Paper>

      <Paper
        elevation={0}
        onClick={() => setMode("own")}
        sx={{ p: 2.5, border: '1px solid', borderColor: 'divider', cursor: 'pointer', '&:hover': { borderColor: 'text.primary' } }}
      >
        <Typography variant="subtitle1" fontWeight={700}>{t('agent.ownTitle')}</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
          {t('agent.ownDesc')}
        </Typography>
      </Paper>
    </Box>
  );
}

// ─── Chat Screen ────────────────────────────────────────────────────

function AgentChat({ config, onSaveConfig, onChangeAgent }: {
  config: AgentConfig;
  onSaveConfig: (config: AgentConfig) => void;
  onChangeAgent: () => void;
}) {
  const { t } = useTranslation();
  const wallet = React.useContext(WalletContext);
  const { activeAccount } = useActiveAccount();
  const [messages, setMessages] = React.useState<ChatMessage[]>([]);
  const [input, setInput] = React.useState("");
  const [sending, setSending] = React.useState(false);
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const scrollRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, sending]);

  const getSnapshot = (): WalletSnapshot | null => {
    if (!wallet || !activeAccount) return null;
    const address = activeAccount.GetAddress() ?? "";
    const networkId = wallet.networkProvider.getActiveNetworkId();
    const cached = wallet.dataCacheService?.get(address, networkId);
    return {
      accountName: activeAccount.GetName(),
      address,
      networkName: wallet.networkProvider.getActiveNetwork()?.network_name ?? "Unknown",
      totalBalanceUsd: cached?.totalUsd ?? 0,
    };
  };

  const handleSend = async () => {
    const text = input.trim();
    if (!text || sending) return;

    const userMsg: ChatMessage = { id: `${Date.now()}-u`, role: "user", text, ts: Date.now() };
    setMessages(prev => [...prev, userMsg]);
    setInput("");
    setSending(true);

    try {
      const reply = await sendToAgent(config, messages, text, getSnapshot());
      setMessages(prev => [...prev, { id: `${Date.now()}-a`, role: "assistant", text: reply, ts: Date.now() }]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setMessages(prev => [...prev, { id: `${Date.now()}-e`, role: "error", text: msg, ts: Date.now() }]);
    } finally {
      setSending(false);
    }
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header */}
      <Box sx={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        px: 2, py: 1.25, borderBottom: '1px solid', borderColor: 'divider', flexShrink: 0,
      }}>
        <Box>
          <Typography variant="subtitle1" sx={{ fontFamily: 'var(--font-mono)', textTransform: 'uppercase', color: 'text.primary', lineHeight: 1.2 }}>
            {t('agent.chatTitle')}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {config.provider === "arfhe" ? t('agent.arfheTitle') : (config.model || config.provider)}
          </Typography>
        </Box>
        <IconButton onClick={() => setSettingsOpen(true)} aria-label={t('agent.chatSettingsAria')}>
          <Settings />
        </IconButton>
      </Box>

      {/* Messages */}
      <Box sx={{ flex: 1, overflowY: 'auto', px: 2, py: 2 }}>
        {messages.length === 0 && (
          <Box sx={{ textAlign: 'center', mt: 6 }}>
            <SmartToy sx={{ fontSize: 40, color: 'text.disabled', mb: 1 }} />
            <Typography variant="body2" color="text.secondary">
              {t('agent.chatEmptyState')}
            </Typography>
          </Box>
        )}

        <Stack spacing={1.5}>
          {messages.map((m) => (
            <Box
              key={m.id}
              sx={{
                display: 'flex',
                gap: 1,
                alignSelf: m.role === "user" ? 'flex-end' : 'flex-start',
                flexDirection: m.role === "user" ? 'row-reverse' : 'row',
                maxWidth: '85%',
                ml: m.role === "user" ? 'auto' : 0,
              }}
            >
              <Box sx={{
                width: 26, height: 26, flexShrink: 0,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                border: '1px solid', borderColor: 'divider',
                color: m.role === 'error' ? 'error.main' : 'text.primary',
              }}>
                {m.role === "user" ? <Person sx={{ fontSize: 16 }} /> : m.role === "error" ? <ErrorOutline sx={{ fontSize: 16 }} /> : <SmartToy sx={{ fontSize: 16 }} />}
              </Box>
              <Box sx={{
                px: 1.5, py: 1,
                border: '1px solid',
                borderColor: m.role === 'error' ? 'error.main' : 'divider',
                bgcolor: m.role === 'user' ? 'action.hover' : 'transparent',
              }}>
                <Typography variant="body2" sx={{ color: m.role === 'error' ? 'error.main' : 'text.primary', whiteSpace: 'pre-wrap' }}>
                  {m.text}
                </Typography>
              </Box>
            </Box>
          ))}
          {sending && (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <CircularProgress size={16} />
              <Typography variant="caption" color="text.secondary">{t('agent.chatTyping')}</Typography>
            </Box>
          )}
        </Stack>
        <div ref={scrollRef} />
      </Box>

      {/* Input */}
      <Box sx={{ display: 'flex', gap: 1, p: 1.5, borderTop: '1px solid', borderColor: 'divider', flexShrink: 0 }}>
        <TextField
          fullWidth
          size="small"
          placeholder={t('agent.chatPlaceholder')}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
          disabled={sending}
        />
        <IconButton
          onClick={handleSend}
          disabled={sending || !input.trim()}
          aria-label={t('agent.chatSendAria')}
          sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 0 }}
        >
          <Send fontSize="small" />
        </IconButton>
      </Box>

      {/* Settings Drawer */}
      <Drawer
        anchor="bottom"
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        PaperProps={{ sx: { maxWidth: '600px', mx: 'auto', maxHeight: '85vh', overflowY: 'auto' } }}
      >
        <AgentSettingsPanel
          config={config}
          onSave={(next) => { onSaveConfig(next); setSettingsOpen(false); }}
          onChangeAgent={() => { setSettingsOpen(false); onChangeAgent(); }}
        />
      </Drawer>
    </Box>
  );
}

// ─── Page ───────────────────────────────────────────────────────────

function Agent() {
  const [config, setConfig] = React.useState<AgentConfig>(() => loadAgentConfig());

  const handleConfigured = (next: AgentConfig) => {
    setConfig(next);
    saveAgentConfig(next);
  };

  const handleChangeAgent = () => {
    setConfig(resetAgentConfig());
  };

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {config.configured ? (
        <AgentChat config={config} onSaveConfig={handleConfigured} onChangeAgent={handleChangeAgent} />
      ) : (
        <AgentSetup onConfigured={handleConfigured} />
      )}
    </Box>
  );
}

export default Agent;
