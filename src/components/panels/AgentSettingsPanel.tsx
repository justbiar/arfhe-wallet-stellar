/**
 * AgentSettingsPanel.tsx — Settings for the in-app AI Agent.
 *
 * Lets the user switch between the built-in "Arfhe Agent" and their own
 * API key / model, edit connection details, set a system prompt, and
 * manage MCP servers the agent can use.
 */

import * as React from "react";
import {
  Box,
  Typography,
  TextField,
  MenuItem,
  Button,
  IconButton,
  Divider,
  Stack,
  Switch,
  Tooltip,
} from "@mui/material";
import { Visibility, VisibilityOff, Delete, Add, RestartAlt } from "@mui/icons-material";
import { useTranslation } from "react-i18next";
import type { AgentConfig, AgentProvider, MCPServerConfig } from "../../backend/AgentService";
import { DEFAULT_MODELS } from "../../backend/AgentService";

interface AgentSettingsPanelProps {
  config: AgentConfig;
  onSave: (config: AgentConfig) => void;
  onChangeAgent: () => void;
}

export default function AgentSettingsPanel({ config, onSave, onChangeAgent }: AgentSettingsPanelProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = React.useState<AgentConfig>(config);
  const [showKey, setShowKey] = React.useState(false);
  const [newMcpName, setNewMcpName] = React.useState("");
  const [newMcpUrl, setNewMcpUrl] = React.useState("");

  React.useEffect(() => { setDraft(config); }, [config]);

  const isCustom = draft.provider !== "arfhe";

  const handleProviderChange = (provider: AgentProvider) => {
    setDraft(d => ({ ...d, provider, model: DEFAULT_MODELS[provider] }));
  };

  const handleAddMcp = () => {
    if (!newMcpName.trim() || !newMcpUrl.trim()) return;
    const server: MCPServerConfig = {
      id: `${Date.now()}`,
      name: newMcpName.trim(),
      url: newMcpUrl.trim(),
      enabled: true,
    };
    setDraft(d => ({ ...d, mcpServers: [...d.mcpServers, server] }));
    setNewMcpName("");
    setNewMcpUrl("");
  };

  const handleRemoveMcp = (id: string) => {
    setDraft(d => ({ ...d, mcpServers: d.mcpServers.filter(s => s.id !== id) }));
  };

  const handleToggleMcp = (id: string) => {
    setDraft(d => ({
      ...d,
      mcpServers: d.mcpServers.map(s => s.id === id ? { ...s, enabled: !s.enabled } : s),
    }));
  };

  const providerLabels: Record<AgentProvider, string> = {
    arfhe: t('agent.providerArfhe'),
    openai: t('agent.providerOpenAI'),
    anthropic: t('agent.providerAnthropic'),
    custom: t('agent.providerCustom'),
  };

  return (
    <Box sx={{ px: 2.5, pt: 1, pb: 3 }}>
      <Typography variant="subtitle2" sx={{ fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: 1, color: 'text.secondary', mb: 1.5 }}>
        {t('agent.settingsTitle')}
      </Typography>

      <Stack spacing={2}>
        {/* Provider */}
        <TextField
          select
          fullWidth
          label={t('agent.providerLabel')}
          value={draft.provider}
          onChange={(e) => handleProviderChange(e.target.value as AgentProvider)}
        >
          {(Object.keys(providerLabels) as AgentProvider[]).map((p) => (
            <MenuItem key={p} value={p}>{providerLabels[p]}</MenuItem>
          ))}
        </TextField>

        {isCustom && (
          <>
            <TextField
              fullWidth
              label={t('agent.apiKeyLabel')}
              type={showKey ? "text" : "password"}
              value={draft.apiKey ?? ""}
              onChange={(e) => setDraft(d => ({ ...d, apiKey: e.target.value }))}
              autoComplete="off"
              InputProps={{
                endAdornment: (
                  <IconButton size="small" onClick={() => setShowKey(s => !s)} aria-label={showKey ? t('agent.hideKeyAria') : t('agent.showKeyAria')}>
                    {showKey ? <VisibilityOff fontSize="small" /> : <Visibility fontSize="small" />}
                  </IconButton>
                ),
              }}
            />

            {draft.provider === "custom" && (
              <TextField
                fullWidth
                label={t('agent.baseUrlLabel')}
                placeholder="https://api.example.com/v1"
                value={draft.baseUrl ?? ""}
                onChange={(e) => setDraft(d => ({ ...d, baseUrl: e.target.value }))}
              />
            )}

            <TextField
              fullWidth
              label={t('agent.modelLabel')}
              placeholder={DEFAULT_MODELS[draft.provider] || "model"}
              value={draft.model ?? ""}
              onChange={(e) => setDraft(d => ({ ...d, model: e.target.value }))}
            />

            <TextField
              fullWidth
              multiline
              minRows={2}
              maxRows={5}
              label={t('agent.systemPromptLabel')}
              placeholder={t('agent.systemPromptPlaceholder')}
              value={draft.systemPrompt ?? ""}
              onChange={(e) => setDraft(d => ({ ...d, systemPrompt: e.target.value }))}
            />
          </>
        )}

        <Divider />

        {/* MCP Servers */}
        <Box>
          <Typography variant="caption" sx={{ fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: 1, color: 'text.secondary', display: 'block', mb: 1 }}>
            {t('agent.mcpTitle')}
          </Typography>

          {draft.mcpServers.length === 0 && (
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
              {t('agent.mcpEmpty')}
            </Typography>
          )}

          <Stack spacing={1} sx={{ mb: 1.5 }}>
            {draft.mcpServers.map((s) => (
              <Box
                key={s.id}
                sx={{
                  display: 'flex', alignItems: 'center', gap: 1,
                  border: '1px solid', borderColor: 'divider', px: 1.25, py: 0.75,
                }}
              >
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography variant="body2" fontWeight={600} noWrap>{s.name}</Typography>
                  <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block' }}>{s.url}</Typography>
                </Box>
                <Switch size="small" checked={s.enabled} onChange={() => handleToggleMcp(s.id)} />
                <Tooltip title={t('agent.mcpRemoveTooltip')}>
                  <IconButton size="small" onClick={() => handleRemoveMcp(s.id)} aria-label={`${t('agent.mcpRemoveTooltip')} ${s.name}`}>
                    <Delete fontSize="small" />
                  </IconButton>
                </Tooltip>
              </Box>
            ))}
          </Stack>

          <Stack direction="row" spacing={1}>
            <TextField
              size="small"
              label={t('agent.mcpNameLabel')}
              value={newMcpName}
              onChange={(e) => setNewMcpName(e.target.value)}
              sx={{ flex: 1 }}
            />
            <TextField
              size="small"
              label={t('agent.mcpUrlLabel')}
              value={newMcpUrl}
              onChange={(e) => setNewMcpUrl(e.target.value)}
              sx={{ flex: 2 }}
            />
            <IconButton
              onClick={handleAddMcp}
              disabled={!newMcpName.trim() || !newMcpUrl.trim()}
              aria-label={t('agent.mcpAddAria')}
              sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 0 }}
            >
              <Add fontSize="small" />
            </IconButton>
          </Stack>
        </Box>

        <Divider />

        <Button
          variant="contained"
          fullWidth
          onClick={() => onSave(draft)}
          sx={{ height: 44 }}
        >
          {t('agent.save')}
        </Button>

        <Button
          variant="outlined"
          fullWidth
          color="warning"
          startIcon={<RestartAlt />}
          onClick={onChangeAgent}
          sx={{ height: 40 }}
        >
          {t('agent.changeAgent')}
        </Button>
      </Stack>
    </Box>
  );
}
