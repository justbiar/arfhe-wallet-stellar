/**
 * Approve.tsx — the approval window for the injected provider (`window.ethereum`).
 *
 * Opened by the service worker in its own popup window when a website asks for something
 * that needs a decision. This page, not the worker, is where the decision and the signing
 * happen: the decrypted key exists only in an unlocked extension page, and the worker is
 * deliberately kept unable to sign anything.
 *
 * Contract with the worker:
 *   GET_PENDING_APPROVAL  → the parked request
 *   APPROVAL_RESULT       → the user's answer, which releases the site's pending promise
 *
 * Every exit path must report back. A window closed without an answer is handled by the
 * worker's `windows.onRemoved` as a rejection, but anything this page decides itself has
 * to be sent, or the site is left waiting on a promise that never settles.
 */

import React, { useContext, useEffect, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import {
  Box, Button, Stack, Typography, Paper, Alert, CircularProgress,
  Avatar, Chip, Divider, Checkbox, FormControlLabel, alpha, useTheme,
} from "@mui/material";
import { Language as LanguageIcon, GppBad, Shield as ShieldIcon } from "@mui/icons-material";
import { JsonRpcProvider, formatEther, isAddress } from "ethers";
import { WalletContext } from "../AppContext.js";
import { toChainId } from "../backend/NetworkTypes.js";
import { analyzeFheRisk } from "../backend/DAppConnectionService.js";
import { PhishingDetector, type PhishingCheckResult } from "../backend/PhishingDetector.js";
import { toUserMessage } from "../backend/UserFacingError.js";

/** A request parked by the service worker. */
interface PendingRequest {
  id: string;
  method: string;
  params: unknown[];
  origin: string;
}

const RPC_ERR_REJECTED = 4001;
const RPC_ERR_UNSUPPORTED = 4200;

/** Ask the service worker something. Extension pages reach the privileged handler. */
function askWorker<T = unknown>(message: Record<string, unknown>): Promise<T> {
  return new Promise((resolve) => {
    const runtime = (window as unknown as { chrome?: { runtime?: { sendMessage?: typeof chrome.runtime.sendMessage } } }).chrome?.runtime;
    if (!runtime?.sendMessage) {
      resolve(undefined as T);
      return;
    }
    runtime.sendMessage(message, (response: T) => resolve(response));
  });
}

export default function Approve() {
  const { t } = useTranslation();
  const theme = useTheme();
  const context = useContext(WalletContext);
  const account = context?.accountManager?.GetActive();
  const network = context?.networkProvider?.getActiveNetwork();

  const [request, setRequest] = useState<PendingRequest | null>(null);
  const [loadingRequest, setLoadingRequest] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [answered, setAnswered] = useState(false);
  const [phishing, setPhishing] = useState<PhishingCheckResult | null>(null);
  const [riskAccepted, setRiskAccepted] = useState(false);

  const requestId = new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("requestId") ?? undefined;

  // ── Load the parked request ───────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await askWorker<{ success: boolean; request: PendingRequest | null }>({
        type: "GET_PENDING_APPROVAL",
        requestId,
      });
      if (cancelled) return;
      setRequest(res?.request ?? null);
      setLoadingRequest(false);

      if (res?.request?.origin) {
        try {
          setPhishing(await PhishingDetector.checkDomain(res.request.origin));
        } catch { /* detection unavailable; the origin is still shown */ }
      }
    })();
    return () => { cancelled = true; };
  }, [requestId]);

  /** Report the outcome and close. Closing without this would strand the site. */
  const respond = useCallback(async (payload: { result?: unknown; error?: { code: number; message: string } }) => {
    if (!request) return;
    setAnswered(true);
    await askWorker({
      type: "APPROVAL_RESULT",
      requestId: request.id,
      origin: request.origin,
      ...payload,
    });
    window.close();
  }, [request]);

  const reject = useCallback(() => {
    void respond({ error: { code: RPC_ERR_REJECTED, message: "User rejected the request." } });
  }, [respond]);

  // A window dismissed with the OS close button reaches the worker's onRemoved handler,
  // which rejects anything outstanding. Nothing to do here beyond not double-answering.

  const approve = useCallback(async () => {
    if (!request || !context || !account) return;
    setBusy(true);
    setError("");

    try {
      const method = request.method;

      // ── Connection ────────────────────────────────────────────────
      if (method === "eth_requestAccounts" || method === "wallet_requestPermissions") {
        const address = account.GetAddress();
        if (!address) throw new Error("No active account.");

        // The grant is written before answering, so the site cannot receive an address it
        // has no stored permission for.
        await context.sitePermissions.grant(request.origin, [address]);
        await respond({
          result: method === "eth_requestAccounts"
            ? [address.toLowerCase()]
            : [{ parentCapability: "eth_accounts" }],
        });
        return;
      }

      if (!network?.rpc_url) throw new Error("The wallet has no active network.");
      const wallet = account.ethers_wallet;
      if (!wallet) throw new Error("Wallet is locked.");

      // The site may only act as an account it was actually granted.
      const activeAddress = account.GetAddress() ?? "";
      if (!(await context.sitePermissions.canUseAccount(request.origin, activeAddress))) {
        throw new Error(
          `This site is connected to a different account. Switch to the connected account, or reconnect.`
        );
      }

      const provider = new JsonRpcProvider(network.rpc_url);
      const signer = wallet.connect(provider);
      const params = request.params ?? [];

      // ── Signing ───────────────────────────────────────────────────
      if (method === "personal_sign") {
        const hexMsg = String(params[0] ?? "");
        assertSigner(params[1], activeAddress);
        const bytes = hexToBytes(hexMsg);
        await respond({ result: await signer.signMessage(bytes) });
        return;
      }

      if (method === "eth_signTypedData" || method === "eth_signTypedData_v4") {
        assertSigner(params[0], activeAddress);
        const raw = params[1];
        const data = typeof raw === "string" ? JSON.parse(raw) : (raw as Record<string, never>);

        // The domain's chain is what a verifying contract will check. Signing a mainnet
        // domain while the wallet is on a testnet produces a signature valid somewhere the
        // user was never shown.
        const domainChain = (data as { domain?: { chainId?: unknown } })?.domain?.chainId;
        if (domainChain !== undefined && Number(domainChain) !== toChainId(network.network_id)) {
          throw new Error(
            `This signature is for chain ${Number(domainChain)}, but the wallet is on chain ${toChainId(network.network_id)}.`
          );
        }

        const types = { ...(data as { types: Record<string, unknown> }).types } as Record<string, never>;
        delete (types as Record<string, unknown>).EIP712Domain;
        const value = (data as { message?: unknown; value?: unknown }).message
          ?? (data as { value?: unknown }).value;
        await respond({
          result: await signer.signTypedData(
            (data as { domain: Record<string, never> }).domain,
            types,
            value as Record<string, never>
          ),
        });
        return;
      }

      if (method === "eth_sendTransaction") {
        const tx = (params[0] ?? {}) as { to?: string; from?: string; value?: string; data?: string; gas?: string; gasLimit?: string };
        assertSigner(tx.from, activeAddress);
        if (tx.to && !isAddress(tx.to)) throw new Error("The transaction has an invalid recipient.");

        const sent = await signer.sendTransaction({
          to: tx.to,
          value: tx.value ?? "0x0",
          data: tx.data ?? "0x",
          gasLimit: tx.gasLimit ?? tx.gas,
          // Pin the chain rather than letting it be inferred.
          // Pin the real chain id; the internal NetworkId would sign for the wrong chain.
          chainId: toChainId(network.network_id),
        });
        await respond({ result: sent.hash });
        return;
      }

      // ── Chain switching ───────────────────────────────────────────
      if (method === "wallet_switchEthereumChain") {
        const target = Number((params[0] as { chainId?: string })?.chainId ?? NaN);
        if (!Number.isFinite(target)) throw new Error("The site did not say which chain to switch to.");
        if (target === toChainId(network.network_id)) {
          await respond({ result: null });
          return;
        }
        // Switching is the user's action in the wallet UI, not something this window can
        // do on their behalf — pretending otherwise would leave the site believing a
        // switch happened.
        throw new Error(
          `Switch to chain ${target} in the wallet, then retry. Arfhe does not change networks on a site's request.`
        );
      }

      if (method === "wallet_addEthereumChain") {
        throw new Error("Adding a network from a website is not supported. Add it in Settings instead.");
      }

      await respond({ error: { code: RPC_ERR_UNSUPPORTED, message: `Unsupported method: ${method}` } });
    } catch (e) {
      setError(toUserMessage(e, t));
      setBusy(false);
    }
  }, [request, context, account, network, respond, t]);

  // ── Render ────────────────────────────────────────────────────────

  if (loadingRequest) {
    return <Centered><CircularProgress size={28} /></Centered>;
  }

  if (!request) {
    return (
      <Centered>
        <Typography variant="body2" color="text.secondary" textAlign="center">
          {t("approve.noPending")}
        </Typography>
        <Button sx={{ mt: 2 }} onClick={() => window.close()}>{t("common.close")}</Button>
      </Centered>
    );
  }

  if (!account) {
    return (
      <Centered>
        <Alert severity="warning" sx={{ mb: 2 }}>{t("approve.unlockFirst")}</Alert>
        <Button variant="outlined" onClick={reject}>{t("common.cancel")}</Button>
      </Centered>
    );
  }

  const isConnect = request.method === "eth_requestAccounts" || request.method === "wallet_requestPermissions";
  const isTx = request.method === "eth_sendTransaction";
  const txParams = isTx ? (request.params[0] ?? {}) as { to?: string; value?: string; data?: string } : null;
  const fheRisk = isTx ? analyzeFheRisk(txParams?.data, txParams?.to) : null;

  const dangerous = phishing?.riskLevel === "DANGEROUS";
  const suspicious = phishing?.riskLevel === "SUSPICIOUS";
  const blocked = dangerous && !riskAccepted;

  return (
    <Box sx={{ p: 2.5, minHeight: "100vh", display: "flex", flexDirection: "column", bgcolor: "background.default" }}>
      {/* Origin — the single most important thing on this screen */}
      <Stack alignItems="center" spacing={1} sx={{ mb: 2 }}>
        <Avatar sx={{ width: 56, height: 56, bgcolor: dangerous ? "error.main" : "primary.main" }}>
          {dangerous ? <GppBad /> : <LanguageIcon />}
        </Avatar>
        <Typography
          variant="subtitle1"
          fontWeight={800}
          sx={{ wordBreak: "break-all", textAlign: "center", color: dangerous ? "error.main" : "text.primary" }}
        >
          {request.origin}
        </Typography>
        <Chip size="small" label={network?.network_name ?? "—"} sx={{ fontWeight: 600, fontSize: "0.7rem" }} />
      </Stack>

      {dangerous && (
        <Alert severity="error" sx={{ mb: 2, borderRadius: 2 }}>
          {t("approve.phishingDangerous")}
        </Alert>
      )}
      {suspicious && !dangerous && (
        <Alert severity="warning" sx={{ mb: 2, borderRadius: 2 }}>
          {t("approve.phishingSuspicious")}
        </Alert>
      )}

      {fheRisk?.isFheSensitive && (
        <Alert
          severity={fheRisk.riskLevel === "critical" ? "error" : "warning"}
          icon={<ShieldIcon fontSize="inherit" />}
          sx={{ mb: 2, borderRadius: 2 }}
        >
          {fheRisk.reason}
        </Alert>
      )}

      {/* What is being asked */}
      <Paper elevation={0} sx={{ p: 2, borderRadius: 3, bgcolor: alpha(theme.palette.primary.main, 0.05), mb: 2 }}>
        <Typography variant="caption" color="text.secondary" fontWeight={700}>
          {t("approve.requestLabel")}
        </Typography>
        <Typography variant="body2" fontWeight={700} sx={{ mt: 0.5 }}>
          {isConnect ? t("approve.connectTitle") : request.method}
        </Typography>

        {isConnect && (
          <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 1 }}>
            {t("approve.connectExplain", { address: account.GetAddress() })}
          </Typography>
        )}

        {isTx && (
          <>
            <Divider sx={{ my: 1.5 }} />
            <Row label={t("approve.to")} value={txParams?.to ?? "—"} mono />
            <Row
              label={t("approve.amount")}
              value={`${formatEther(txParams?.value ?? "0x0")} ${network?.currency_symbol ?? "ETH"}`}
            />
            {txParams?.data && txParams.data !== "0x" && (
              <Row label={t("approve.data")} value={`${txParams.data.slice(0, 20)}… (${(txParams.data.length - 2) / 2} bytes)`} mono />
            )}
          </>
        )}

        {(request.method === "personal_sign") && (
          <>
            <Divider sx={{ my: 1.5 }} />
            <Typography variant="caption" color="text.secondary">{t("approve.message")}</Typography>
            <Paper elevation={0} sx={{ p: 1, mt: 0.5, bgcolor: "action.hover", borderRadius: 2, maxHeight: 140, overflow: "auto" }}>
              <Typography variant="caption" sx={{ fontFamily: "monospace", wordBreak: "break-all" }}>
                {decodeMessage(String(request.params[0] ?? ""))}
              </Typography>
            </Paper>
          </>
        )}
      </Paper>

      {dangerous && (
        <FormControlLabel
          sx={{ mb: 1 }}
          control={<Checkbox checked={riskAccepted} onChange={(e) => setRiskAccepted(e.target.checked)} color="error" />}
          label={<Typography variant="caption">{t("approve.acceptRisk")}</Typography>}
        />
      )}

      {error && <Alert severity="error" sx={{ mb: 1.5, borderRadius: 2 }}>{error}</Alert>}

      <Box sx={{ flex: 1 }} />

      <Stack direction="row" spacing={1.5}>
        <Button fullWidth variant="outlined" onClick={reject} disabled={busy || answered} sx={{ borderRadius: 2.5, py: 1.2, fontWeight: 700 }}>
          {t("common.cancel")}
        </Button>
        <Button
          fullWidth
          variant="contained"
          color={dangerous ? "error" : "primary"}
          onClick={approve}
          disabled={busy || answered || blocked}
          sx={{ borderRadius: 2.5, py: 1.2, fontWeight: 700 }}
        >
          {busy ? <CircularProgress size={20} color="inherit" /> : t("approve.confirm")}
        </Button>
      </Stack>
    </Box>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <Box sx={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", p: 3 }}>
      {children}
    </Box>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <Stack direction="row" justifyContent="space-between" alignItems="flex-start" sx={{ mt: 0.75, gap: 2 }}>
      <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0 }}>{label}</Typography>
      <Typography
        variant="caption"
        fontWeight={600}
        sx={{ fontFamily: mono ? "monospace" : undefined, wordBreak: "break-all", textAlign: "right" }}
      >
        {value}
      </Typography>
    </Stack>
  );
}

/** The address a site names must be the one that signs. */
function assertSigner(claimed: unknown, activeAddress: string) {
  if (typeof claimed !== "string" || !claimed.startsWith("0x")) return;
  if (claimed.toLowerCase() !== activeAddress.toLowerCase()) {
    throw new Error(`The site asked ${claimed} to sign, but the active account is ${activeAddress}.`);
  }
}

function hexToBytes(hex: string): Uint8Array | string {
  if (!hex.startsWith("0x")) return hex;
  const pairs = hex.slice(2).match(/.{1,2}/g);
  return pairs ? new Uint8Array(pairs.map((b) => parseInt(b, 16))) : new Uint8Array();
}

/** Render a personal_sign payload as text when it is text, hex otherwise. */
function decodeMessage(hex: string): string {
  try {
    if (!hex.startsWith("0x")) return hex;
    const bytes = hexToBytes(hex);
    if (typeof bytes === "string") return bytes;
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return text;
  } catch {
    // Not valid UTF-8 — showing the raw hex is more honest than mojibake.
    return hex;
  }
}
