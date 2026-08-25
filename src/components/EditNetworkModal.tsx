/**
 * EditNetworkModal — change how the wallet reaches a chain it already knows.
 *
 * The chain id is the network's identity, so it is shown but never editable: changing it
 * would not point this network somewhere else, it would silently make it a different
 * network while every stored balance, permission and pending claim still referred to the
 * old one. Everything else — endpoint, explorer, display name, symbol — is presentation or
 * transport and is safe to change.
 *
 * The RPC endpoint is the reason this screen exists. A default provider that rate-limits,
 * goes down, or is blocked in the user's country takes the whole chain with it, and until
 * now there was no way to do anything about it except add the same chain again as a
 * "custom" network — which loses its FHE support and its Alchemy wiring.
 */

import React, { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogContent,
  IconButton,
  InputAdornment,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { ArrowBack, Close, CheckCircle, ErrorOutline } from "@mui/icons-material";
import type { NetworkOverride } from "../backend/NetworkTypes.js";

export interface EditableNetwork {
  /** Internal NetworkId — how an override is keyed. */
  id: number;
  /** Real EVM chain id — what is displayed and what an endpoint is checked against. */
  chainId: number;
  name: string;
  rpcUrl: string;
  explorerUrl: string;
  currencySymbol: string;
  isCustom: boolean;
  isOverridden: boolean;
}

interface Props {
  open: boolean;
  network: EditableNetwork | null;
  onClose: () => void;
  onSave: (networkId: number, override: NetworkOverride) => void;
  /** Restores the shipped defaults. Absent for custom networks, which have none. */
  onReset?: (networkId: number) => void;
}

/** Result of asking an endpoint what chain it serves. */
type ProbeState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "ok"; chainId: number }
  | { status: "mismatch"; chainId: number }
  | { status: "unreachable"; reason: string };

const labelSx = { fontWeight: 700, fontSize: "0.8rem", mb: 0.75, display: "block" } as const;

const fieldSx = {
  "& .MuiOutlinedInput-root": { borderRadius: "0px" },
  "& .MuiOutlinedInput-input": { fontSize: "0.9rem", py: 1.5 },
} as const;

export default function EditNetworkModal({ open, network, onClose, onSave, onReset }: Props) {
  const { t } = useTranslation();

  const [name, setName] = useState("");
  const [rpcUrl, setRpcUrl] = useState("");
  const [fallbackRpcUrl, setFallbackRpcUrl] = useState("");
  const [explorerUrl, setExplorerUrl] = useState("");
  const [symbol, setSymbol] = useState("");
  const [probe, setProbe] = useState<ProbeState>({ status: "idle" });

  // Reload whenever a different network is opened, so the form never shows the previous
  // one's values for the split second before the user notices.
  useEffect(() => {
    if (!network) return;
    setName(network.name);
    setRpcUrl(network.rpcUrl);
    setExplorerUrl(network.explorerUrl);
    setSymbol(network.currencySymbol);
    setFallbackRpcUrl("");
    setProbe({ status: "idle" });
  }, [network]);

  const rpcChanged = !!network && rpcUrl.trim() !== network.rpcUrl;

  const urlProblem = useMemo(() => {
    const value = rpcUrl.trim();
    if (!value) return t("network.rpcRequired");
    if (!/^(https?|wss?):\/\//i.test(value)) return t("network.rpcScheme");
    // An http:// endpoint sends the user's addresses and balance queries in the clear, and
    // any network hop can read or rewrite them. Blocking it outright would break local
    // development against a node on localhost, so it warns instead.
    return "";
  }, [rpcUrl, t]);

  const insecure = /^http:\/\//i.test(rpcUrl.trim()) && !/^http:\/\/(localhost|127\.0\.0\.1)/i.test(rpcUrl.trim());

  /**
   * Ask the endpoint which chain it serves before trusting it.
   *
   * An RPC for the wrong chain is the failure that costs money: it answers every call
   * plausibly, shows balances that look real, and signs transactions for a chain the user
   * did not intend. Comparing `eth_chainId` is the one check that catches it up front.
   */
  const testEndpoint = async () => {
    const url = rpcUrl.trim();
    if (!url || !network) return;

    setProbe({ status: "checking" });
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "eth_chainId", params: [] }),
        signal: controller.signal,
      });
      clearTimeout(timer);

      const json = await response.json();
      if (json.error || !json.result) throw new Error(json.error?.message ?? "No chain id returned");

      const reported = Number(BigInt(json.result));
      setProbe(reported === network.chainId ? { status: "ok", chainId: reported } : { status: "mismatch", chainId: reported });
    } catch (e) {
      setProbe({ status: "unreachable", reason: e instanceof Error ? e.message : String(e) });
    }
  };

  const handleSave = () => {
    if (!network || urlProblem) return;
    onSave(network.id, {
      networkName: name,
      rpcUrl: rpcUrl.trim(),
      fallbackRpcUrl: fallbackRpcUrl.trim() || undefined,
      explorerUrl: explorerUrl.trim(),
      currencySymbol: symbol.trim(),
    });
    onClose();
  };

  if (!network) return null;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullWidth
      maxWidth="sm"
      aria-labelledby="edit-network-title"
      PaperProps={{ sx: { borderRadius: "0px", bgcolor: "background.paper", backgroundImage: "none" } }}
    >
      {/* Header */}
      <Stack direction="row" alignItems="center" sx={{ px: 2, py: 1.5, borderBottom: "1px solid", borderColor: "divider" }}>
        <IconButton onClick={onClose} size="small" aria-label={t("common.back")} sx={{ borderRadius: "0px" }}>
          <ArrowBack />
        </IconButton>
        <Typography id="edit-network-title" fontWeight={700} sx={{ flex: 1, textAlign: "center" }}>
          {t("network.editTitle")}
        </Typography>
        <IconButton onClick={onClose} size="small" aria-label={t("common.close")} sx={{ borderRadius: "0px" }}>
          <Close />
        </IconButton>
      </Stack>

      <DialogContent sx={{ px: 2, py: 2 }}>
        <Box sx={{ mb: 2 }}>
          <Typography component="label" htmlFor="net-name" sx={labelSx}>
            {t("network.name")}
          </Typography>
          <TextField id="net-name" fullWidth size="small" value={name} onChange={(e) => setName(e.target.value)} sx={fieldSx} />
        </Box>

        <Box sx={{ mb: 2 }}>
          <Typography component="label" htmlFor="net-rpc" sx={labelSx}>
            {t("network.rpcUrl")}
          </Typography>
          <TextField
            id="net-rpc"
            fullWidth
            size="small"
            value={rpcUrl}
            onChange={(e) => { setRpcUrl(e.target.value); setProbe({ status: "idle" }); }}
            error={!!urlProblem}
            helperText={urlProblem || undefined}
            sx={fieldSx}
            InputProps={{
              endAdornment: (
                <InputAdornment position="end">
                  <Button
                    size="small"
                    onClick={() => void testEndpoint()}
                    disabled={!!urlProblem || probe.status === "checking"}
                    sx={{ borderRadius: "0px", fontWeight: 700, fontSize: "0.7rem", whiteSpace: "nowrap" }}
                  >
                    {probe.status === "checking" ? t("network.testing") : t("network.test")}
                  </Button>
                </InputAdornment>
              ),
            }}
          />

          {probe.status === "ok" && (
            <Stack direction="row" spacing={0.5} alignItems="center" sx={{ mt: 0.75 }}>
              <CheckCircle sx={{ fontSize: 14, color: "success.main" }} />
              <Typography variant="caption" color="success.main">
                {t("network.testOk", { chainId: probe.chainId })}
              </Typography>
            </Stack>
          )}
          {probe.status === "mismatch" && (
            <Alert severity="error" sx={{ mt: 1, borderRadius: "0px", fontSize: "0.75rem" }}>
              {t("network.testMismatch", { reported: probe.chainId, expected: network.chainId })}
            </Alert>
          )}
          {probe.status === "unreachable" && (
            <Stack direction="row" spacing={0.5} alignItems="center" sx={{ mt: 0.75 }}>
              <ErrorOutline sx={{ fontSize: 14, color: "error.main" }} />
              <Typography variant="caption" color="error.main">
                {t("network.testUnreachable")}
              </Typography>
            </Stack>
          )}
        </Box>

        <Box sx={{ mb: 2 }}>
          <Typography component="label" htmlFor="net-fallback" sx={labelSx}>
            {t("network.fallbackRpcUrl")}
          </Typography>
          <TextField
            id="net-fallback"
            fullWidth
            size="small"
            placeholder={t("network.fallbackPlaceholder")}
            value={fallbackRpcUrl}
            onChange={(e) => setFallbackRpcUrl(e.target.value)}
            helperText={t("network.fallbackHint")}
            sx={fieldSx}
          />
        </Box>

        <Box sx={{ mb: 2 }}>
          <Typography component="label" htmlFor="net-chain" sx={{ ...labelSx, color: "text.disabled" }}>
            {t("network.chainId")}
          </Typography>
          {/* Read-only on purpose: the chain id is this network's identity, not a setting.
              Editing it would leave every stored balance and permission attached to a
              network that no longer exists under that id. */}
          <TextField
            id="net-chain"
            fullWidth
            size="small"
            value={network.chainId}
            disabled
            helperText={t("network.chainIdLocked")}
            sx={fieldSx}
          />
        </Box>

        <Box sx={{ mb: 2 }}>
          <Typography component="label" htmlFor="net-symbol" sx={labelSx}>
            {t("network.currencySymbol")}
          </Typography>
          <TextField id="net-symbol" fullWidth size="small" value={symbol} onChange={(e) => setSymbol(e.target.value)} sx={fieldSx} />
        </Box>

        <Box sx={{ mb: 2 }}>
          <Typography component="label" htmlFor="net-explorer" sx={labelSx}>
            {t("network.explorerUrl")}
          </Typography>
          <TextField id="net-explorer" fullWidth size="small" value={explorerUrl} onChange={(e) => setExplorerUrl(e.target.value)} sx={fieldSx} />
        </Box>

        {insecure && (
          <Alert severity="warning" sx={{ mb: 2, borderRadius: "0px", fontSize: "0.75rem" }}>
            {t("network.insecureRpc")}
          </Alert>
        )}

        {/* Pointing an Alchemy-backed network elsewhere costs the indexer, and the user
            should hear that from the wallet rather than discover it as missing NFTs. */}
        {rpcChanged && !/\.g\.alchemy\.com/i.test(rpcUrl) && (
          <Alert severity="info" sx={{ mb: 2, borderRadius: "0px", fontSize: "0.75rem" }}>
            {t("network.losesIndexer")}
          </Alert>
        )}

        <Stack direction="row" spacing={1}>
          {onReset && network.isOverridden && (
            <Button
              fullWidth
              variant="outlined"
              onClick={() => { onReset(network.id); onClose(); }}
              sx={{ borderRadius: "0px", fontWeight: 700, py: 1.25 }}
            >
              {t("network.reset")}
            </Button>
          )}
          <Button
            fullWidth
            variant="contained"
            onClick={handleSave}
            disabled={!!urlProblem}
            sx={{ borderRadius: "0px", fontWeight: 700, py: 1.25, boxShadow: "none", "&:hover": { boxShadow: "none" } }}
          >
            {t("common.save")}
          </Button>
        </Stack>
      </DialogContent>
    </Dialog>
  );
}
