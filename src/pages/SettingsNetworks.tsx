/**
 * SettingsNetworks — every chain the wallet talks to, on its own screen.
 *
 * This lived inline in Settings, which worked while there was nothing to show: the wallet
 * ships with three networks and the list was a footnote. It stops working the moment
 * networks become the user's own — a dozen entries, each with an endpoint that can be
 * edited, tested and removed, buried under theme and language toggles.
 *
 * The three shipped networks are the chains the CoFHE coprocessor runs on, and for this
 * release they are the only ones the wallet will talk to at all. Adding your own is gone:
 * confidential balances do not exist off these chains, so a user-added network produced a
 * wallet that looked complete and quietly could not do the one thing it is for. The RPC
 * endpoint of each remains editable, which is the part people actually need.
 */

import React, { useCallback, useContext, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import {
  Alert,
  Box,
  Chip,
  Container,
  IconButton,
  InputAdornment,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Paper,
  Stack,
  TextField,
  Typography,
  alpha,
  useTheme,
} from "@mui/material";
import {
  ArrowBack,
  Edit,
  Search,
  Shield,
} from "@mui/icons-material";

import { WalletContext } from "../AppContext";
import { useToast } from "../components/ToastProvider";
import EditNetworkModal, { type EditableNetwork } from "../components/EditNetworkModal";
import { isFheNetwork } from "../backend/NetworkTypes";
import type { NetworkOverride } from "../backend/NetworkTypes";

export default function SettingsNetworks() {
  const navigate = useNavigate();
  const theme = useTheme();
  const { t } = useTranslation();
  const { showToast } = useToast();
  const walletContext = useContext(WalletContext);

  const [editing, setEditing] = useState<EditableNetwork | null>(null);
  const [query, setQuery] = useState("");
  /** Bumped after any change so the list re-reads the provider rather than a stale copy. */
  const [revision, setRevision] = useState(0);

  const networks: EditableNetwork[] = useMemo(
    () => walletContext?.networkProvider?.listAllNetworks() ?? [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [walletContext?.networkProvider, revision]
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return networks;
    return networks.filter(
      (n) => n.name.toLowerCase().includes(q) || String(n.chainId).includes(q)
    );
  }, [networks, query]);

  const handleSave = useCallback((networkId: number, override: NetworkOverride) => {
    try {
      walletContext?.networkProvider?.setNetworkOverride(networkId, override);
      setRevision((r) => r + 1);
      showToast(t("settings.networkUpdated"), "success");
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), "error");
    }
  }, [walletContext?.networkProvider, showToast, t]);

  const handleReset = useCallback((networkId: number) => {
    walletContext?.networkProvider?.clearNetworkOverride(networkId);
    setRevision((r) => r + 1);
    showToast(t("settings.networkReset"), "info");
  }, [walletContext?.networkProvider, showToast, t]);

  return (
    <Box sx={{ pb: 12 }}>
      <Container maxWidth="md" sx={{ py: 2 }}>
        <Stack direction="row" alignItems="center" spacing={0.5} sx={{ mb: 0.5 }}>
          <IconButton onClick={() => navigate("/settings")} aria-label={t("common.back")} sx={{ ml: -1 }}>
            <ArrowBack />
          </IconButton>
          <Typography variant="h6" fontWeight={800} sx={{ letterSpacing: "-0.02em" }}>
            {t("network.allNetworks")}
          </Typography>
        </Stack>
        <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 2, pl: 0.5 }}>
          {t("network.allNetworksDesc")}
        </Typography>

        <TextField
          fullWidth
          size="small"
          placeholder={t("network.searchPlaceholder")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          sx={{ mb: 2, "& .MuiOutlinedInput-root": { borderRadius: "0px" } }}
          InputProps={{
            startAdornment: (
              <InputAdornment position="start">
                <Search sx={{ fontSize: 18, color: "text.disabled" }} />
              </InputAdornment>
            ),
          }}
        />

        <Paper
          elevation={0}
          sx={{
            borderRadius: "0px",
            overflow: "hidden",
            mb: 2,
            border: "1px solid",
            borderColor: "divider",
          }}
        >
          {filtered.map((net, index) => (
            <Box
              key={net.id}
              sx={{
                display: "flex",
                alignItems: "center",
                px: 2,
                py: 1.5,
                borderBottom: index < filtered.length - 1 ? `1px solid ${alpha(theme.palette.divider, 0.3)}` : "none",
              }}
            >
              <Box
                sx={{
                  width: 10,
                  height: 10,
                  borderRadius: "50%",
                  bgcolor: theme.palette.primary.main,
                  mr: 1.5,
                  flexShrink: 0,
                }}
              />
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Stack direction="row" alignItems="center" spacing={0.5}>
                  <Typography fontWeight={600} fontSize={14} noWrap>
                    {net.name}
                  </Typography>
                  {/* Confidential balances only exist where the coprocessor runs, so which
                      networks those are is worth stating on the row itself. */}
                  {isFheNetwork(net.id) && (
                    <Shield sx={{ fontSize: 13, color: "secondary.main" }} titleAccess="FHE" />
                  )}
                </Stack>
                <Stack direction="row" spacing={0.5} alignItems="center" mt={0.3} flexWrap="wrap" useFlexGap>
                  <Chip label={`Chain ${net.chainId}`} size="small" variant="outlined" sx={{ height: 18, fontSize: 10, fontWeight: 600 }} />
                  <Chip label={net.currencySymbol} size="small" color="primary" variant="outlined" sx={{ height: 18, fontSize: 10, fontWeight: 600 }} />
                  {net.isOverridden && (
                    <Chip label={t("network.editedBadge")} size="small" color="warning" variant="outlined" sx={{ height: 18, fontSize: 10, fontWeight: 600 }} />
                  )}
                </Stack>
                <Typography variant="caption" color="text.disabled" noWrap sx={{ display: "block", mt: 0.25 }}>
                  {hostOf(net.rpcUrl)}
                </Typography>
              </Box>

              <IconButton size="small" aria-label={`${t("network.edit")} ${net.name}`} onClick={() => setEditing(net)} sx={{ ml: 1 }}>
                <Edit sx={{ fontSize: 18 }} />
              </IconButton>
            </Box>
          ))}

          {filtered.length === 0 && (
            <Box sx={{ px: 3, py: 3, textAlign: "center" }}>
              <Typography variant="caption" color="text.disabled">
                {t("network.noMatches")}
              </Typography>
            </Box>
          )}
        </Paper>

        <Alert severity="info" sx={{ borderRadius: "0px", fontSize: "0.75rem" }}>
          {t("network.onlyThreeChains")}
        </Alert>
      </Container>

      <EditNetworkModal
        open={!!editing}
        network={editing}
        onClose={() => setEditing(null)}
        onSave={handleSave}
        onReset={handleReset}
      />
    </Box>
  );
}

/** Show which provider a network points at without the key in the path. */
function hostOf(rpcUrl: string): string {
  try {
    return new URL(rpcUrl).host;
  } catch {
    return rpcUrl;
  }
}
