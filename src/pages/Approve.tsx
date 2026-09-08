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
  Avatar, Chip, Divider, Checkbox, FormControlLabel, TextField,
  InputAdornment, IconButton, alpha, useTheme,
} from "@mui/material";
import {
  Language as LanguageIcon, GppBad, Shield as ShieldIcon,
  Visibility, VisibilityOff, Fingerprint, Lock as LockIcon,
  History as HistoryIcon, NewReleases, CheckCircleOutline,
} from "@mui/icons-material";
import { BiometricService } from "../backend/BiometricService.js";
import { JsonRpcProvider, formatEther, isAddress } from "ethers";
import { WalletContext } from "../AppContext.js";
import { toChainId, wellKnownChainName } from "../backend/NetworkTypes.js";
import { analyzeFheRisk } from "../backend/DAppConnectionService.js";
import { PhishingDetector, type PhishingCheckResult } from "../backend/PhishingDetector.js";
import { toUserMessage } from "../backend/UserFacingError.js";
import HuntSurface from "../components/HuntSurface.js";

/** A request parked by the service worker. */
interface PendingRequest {
  id: string;
  method: string;
  params: unknown[];
  origin: string;
  /** The tab's own favicon, as Chrome already had it — never fetched. */
  favIconUrl?: string | null;
  title?: string | null;
}

const RPC_ERR_REJECTED = 4001;
const RPC_ERR_UNSUPPORTED = 4200;
/** EIP-3326: the chain is unknown to the wallet, so the site may offer to add it. */
const RPC_ERR_CHAIN_NOT_ADDED = 4902;

/**
 * A refusal this screen decided on, phrased for the person reading it.
 *
 * These are not chain errors and must not be run through `toUserMessage`: that maps raw
 * RPC and FHE failures onto translated text, and anything it does not recognise becomes
 * "An unexpected error occurred." So a sentence written specifically to tell the user what
 * to do next — which chain to add, which account to switch to — was replaced by the one
 * message that says nothing at all.
 */
class ApprovalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalError";
  }
}

/** How long to keep looking before accepting that no request is coming. */
const LOOKUP_ATTEMPTS = 10;
const LOOKUP_INTERVAL_MS = 300;

/** Matches the worker's own expiry for a parked request. */
const PARKED_MAX_AGE_MS = 5 * 60 * 1000;

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

/**
 * Where the worker parks requests. Shared constant — both sides must agree on it.
 */
const PENDING_APPROVALS_KEY = "arfhe_pending_approvals";

/**
 * Read the parked request straight out of session storage.
 *
 * The worker writes it there before it opens this window, and this page is an extension
 * page with its own access to that store — so displaying the request needs no round trip
 * to the worker at all. That matters because the worker is the least reliable participant
 * here: MV3 tears it down when idle, and every hop through it is a chance for the request
 * to come back empty and for this window to claim, wrongly, that nothing is waiting.
 *
 * The worker is still what *settles* the request; only reading it is made independent.
 */
async function readParkedRequest(requestId?: string): Promise<PendingRequest | null> {
  const session = (globalThis as { chrome?: typeof chrome }).chrome?.storage?.session;
  if (!session) return null;

  try {
    const stored = await session.get(PENDING_APPROVALS_KEY);
    const all = stored?.[PENDING_APPROVALS_KEY];
    if (!Array.isArray(all) || all.length === 0) return null;

    // An entry older than this describes a request the website was already told had
    // failed — the worker that would have answered it is long gone. Showing one would
    // ask the user to approve something that cannot happen.
    const cutoff = Date.now() - PARKED_MAX_AGE_MS;
    const live = all.filter(
      (entry) => typeof entry?.createdAt !== "number" || entry.createdAt > cutoff
    );
    if (live.length === 0) return null;

    // The id in the URL is the one this window was opened for. Falling back to the newest
    // live entry covers the window being reused for a later request without its address
    // bar following — better to show the request that is actually waiting than to insist
    // on an id and report nothing.
    const exact = requestId ? live.find((entry) => entry?.id === requestId) : undefined;
    return (exact ?? live[live.length - 1]) as PendingRequest;
  } catch {
    return null;
  }
}

export default function Approve() {
  const { t } = useTranslation();
  const theme = useTheme();
  const context = useContext(WalletContext);
  const account = context?.accountManager?.GetActive();
  const network = context?.networkProvider?.getActiveNetwork();

  const [request, setRequest] = useState<PendingRequest | null>(null);
  const [loadingRequest, setLoadingRequest] = useState(true);
  /** False until the stored session has been tried, so a locked wallet is not claimed early. */
  const [sessionReady, setSessionReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [answered, setAnswered] = useState(false);
  const [phishing, setPhishing] = useState<PhishingCheckResult | null>(null);
  const [riskAccepted, setRiskAccepted] = useState(false);
  /** Bumped on unlock so the account is read again from the now-decrypted manager. */
  const [, setUnlockedAt] = useState(0);
  /** Whether this origin has been connected before, and when it was last used. */
  const [siteHistory, setSiteHistory] = useState<{ known: boolean; when: string } | null>(null);
  /** Which account the connection will be granted to. Defaults to the active one. */
  const [selectedAccountIndex, setSelectedAccountIndex] = useState(0);

  const requestId = new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("requestId") ?? undefined;

  // ── Unlock this window ────────────────────────────────────────────
  //
  // The session key lives in `chrome.storage.session`, shared across the extension's
  // pages — but *restoring* from it, and decrypting the accounts with it, happened only
  // in Auth. This window never renders Auth, so it started with an empty account list no
  // matter how recently the wallet had been unlocked, and answered every request with
  // "unlock first".
  //
  // What made it look intermittent rather than broken: opening the wallet popup runs Auth,
  // which restores the session into the shared context — so the approval window worked
  // right after the user had gone and poked at the wallet, and not otherwise.
  useEffect(() => {
    const storage = context?.storageManager;
    if (!storage) return;

    let cancelled = false;
    (async () => {
      try {
        if (!storage.isUnlocked()) {
          const timeoutMs = storage.getLocal<number>("autoLockTimeout") ?? 5 * 60 * 1000;
          if (await storage.restoreSession(timeoutMs)) {
            await context?.accountManager?.loadFromEncryptedStorage();
          }
        }
      } catch {
        // A session that will not restore leaves the wallet locked, which the render
        // below already handles — and is the correct outcome, not an error to show.
      } finally {
        if (!cancelled) setSessionReady(true);
      }
    })();
    return () => { cancelled = true; };
  }, [context]);

  // ── Load the parked request ───────────────────────────────────────
  //
  // Three sources, in order of how much has to be working for them to answer:
  //
  //   1. session storage, read directly — needs nothing but this page,
  //   2. the worker, asked once — covers a build where the store is unreachable,
  //   3. a storage subscription plus a short retry — covers the window having opened
  //      before the entry was visible to it.
  //
  // The last one is why this is not a single fetch. Declaring "nothing is waiting" is a
  // statement this window is in no position to make quickly: it was opened *because*
  // something was waiting, so an empty first read is far more likely to be a race than a
  // fact, and the previous version turned that race into a dead end with a Close button.
  useEffect(() => {
    let cancelled = false;
    let settled = false;

    const adopt = (found: PendingRequest | null) => {
      if (cancelled || settled || !found) return;
      settled = true;
      setRequest(found);
      setLoadingRequest(false);
      void PhishingDetector.checkDomain(found.origin)
        .then((r) => { if (!cancelled) setPhishing(r); })
        .catch(() => { /* detection unavailable; the origin is still shown */ });
    };

    // A late write lands here rather than being missed between polls.
    const storage = (globalThis as { chrome?: typeof chrome }).chrome?.storage;
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== "session" || !changes[PENDING_APPROVALS_KEY]) return;
      void readParkedRequest(requestId).then(adopt);
    };
    try { storage?.onChanged?.addListener(onChanged); } catch { /* not an extension context */ }

    (async () => {
      adopt(await readParkedRequest(requestId));
      if (settled || cancelled) return;

      const res = await askWorker<{ success: boolean; request: PendingRequest | null }>({
        type: "GET_PENDING_APPROVAL",
        requestId,
      });
      adopt(res?.request ?? null);
      if (settled || cancelled) return;

      // Give the write a moment to arrive before saying it never will.
      for (let attempt = 0; attempt < LOOKUP_ATTEMPTS && !settled && !cancelled; attempt++) {
        await new Promise((r) => setTimeout(r, LOOKUP_INTERVAL_MS));
        adopt(await readParkedRequest(requestId));
      }

      if (!settled && !cancelled) setLoadingRequest(false);
    })();

    return () => {
      cancelled = true;
      try { storage?.onChanged?.removeListener(onChanged); } catch { /* never added */ }
    };
  }, [requestId]);

  // ── Has this site been here before? ───────────────────────────────
  //
  // Read from the wallet's own permission store, so it costs nothing and tells nobody.
  // "First time" is the cheapest safety signal available: a first connection to a site
  // the user believes they use every day is the shape a lookalike domain takes.
  useEffect(() => {
    if (!request?.origin || !context?.sitePermissions) return;
    let cancelled = false;
    void (async () => {
      try {
        const existing = await context.sitePermissions.get(request.origin);
        if (cancelled) return;
        setSiteHistory(
          existing
            ? { known: true, when: new Date(existing.lastUsedAt).toLocaleDateString() }
            : { known: false, when: "" }
        );
      } catch {
        // Unreadable store: say nothing rather than claim the site is new.
      }
    })();
    return () => { cancelled = true; };
  }, [request?.origin, context]);

  // The account list only exists once the wallet is unlocked, so the selector's starting
  // value has to follow that rather than being fixed at mount.
  useEffect(() => {
    const manager = context?.accountManager;
    if (!manager) return;
    const active = manager.GetActive();
    const index = manager.accounts.findIndex((a) => a.GetAddress() === active?.GetAddress());
    if (index >= 0) setSelectedAccountIndex(index);
  }, [context, account]);

  /**
   * Whether this screen is a guest inside an already-open wallet rather than a window of
   * its own.
   *
   * Set by the surface that took the request from the worker. It decides what "done" means
   * here: a window closes, but calling `window.close()` inside the side panel either does
   * nothing or takes the whole wallet down — neither of which is what the user asked for
   * by answering a prompt.
   */
  const inline = new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("inline") === "1";

  /** Report the outcome, then leave. Leaving without this would strand the site. */
  const respond = useCallback(async (payload: { result?: unknown; error?: { code: number; message: string } }) => {
    if (!request) return;
    setAnswered(true);
    await askWorker({
      type: "APPROVAL_RESULT",
      requestId: request.id,
      origin: request.origin,
      ...payload,
    });
    if (inline) {
      // Back to the wallet the user was already in, not a closed window.
      window.location.hash = "#/home";
      return;
    }
    window.close();
  }, [request, inline]);

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
        if (!address) throw new ApprovalError("No active account.");

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

      if (!network?.rpc_url) throw new ApprovalError("The wallet has no active network.");
      const wallet = account.ethers_wallet;
      if (!wallet) throw new ApprovalError("Wallet is locked.");

      // The site may only act as an account it was actually granted.
      const activeAddress = account.GetAddress() ?? "";
      if (!(await context.sitePermissions.canUseAccount(request.origin, activeAddress))) {
        throw new ApprovalError(
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
          throw new ApprovalError(
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
        if (tx.to && !isAddress(tx.to)) throw new ApprovalError("The transaction has an invalid recipient.");

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
      //
      // The user pressing Confirm on this screen *is* the consent EIP-3326 asks for, so
      // the switch happens here. Refusing it and telling the user to go and change the
      // network themselves made the button a lie — it offered to confirm something the
      // handler then threw on — and left every dApp that switches chains unusable.
      if (method === "wallet_switchEthereumChain") {
        const target = Number((params[0] as { chainId?: string })?.chainId ?? NaN);
        if (!Number.isFinite(target)) throw new ApprovalError("The site did not say which chain to switch to.");
        if (target === toChainId(network.network_id)) {
          await respond({ result: null });
          return;
        }

        const match = context.networkProvider
          .listAllNetworks()
          .find((n) => n.chainId === target);
        // Nothing can be added any more, so "not in this wallet" now means "this build
        // does not support that chain" — a permanent answer rather than a missing step.

        // 4902 is the code a dApp watches for to offer adding the chain. Answering with a
        // generic failure instead leaves it with no way to recover, and the user staring
        // at a site that simply does not work.
        if (!match) {
          const name = wellKnownChainName(target);
          await respond({
            error: {
              code: RPC_ERR_CHAIN_NOT_ADDED,
              message:
                `${name ? `${name} (chain ${target})` : `Chain ${target}`} is not supported by Arfhe Wallet. ` +
                `This build works on Sepolia, Base Sepolia and Arbitrum Sepolia.`,
            },
          });
          return;
        }

        context.networkProvider.switchNetwork(match.id);
        await respond({ result: null });
        return;
      }

      if (method === "wallet_addEthereumChain") {
        // Not "add it in Settings instead" any more — there is no longer anywhere to add
        // one. Pointing the user at a door that no longer exists is worse than a refusal.
        throw new ApprovalError(
          "Arfhe Wallet runs on Sepolia, Base Sepolia and Arbitrum Sepolia only. Networks cannot be added."
        );
      }

      await respond({ error: { code: RPC_ERR_UNSUPPORTED, message: `Unsupported method: ${method}` } });
    } catch (e) {
      setError(e instanceof ApprovalError ? e.message : toUserMessage(e, t));
      setBusy(false);
    }
  }, [request, context, account, network, respond, t]);

  // ── Render ────────────────────────────────────────────────────────

  if (loadingRequest || !sessionReady) {
    return <Centered><CircularProgress size={28} /></Centered>;
  }

  if (!request) {
    // Reached only after the direct read, the worker, and the retry window have all come
    // up empty. Saying what to do next matters here: this window opened on its own, so
    // "nothing is waiting" reads as a malfunction unless it also says how to get back.
    return (
      <Centered>
        <Typography variant="body2" color="text.secondary" textAlign="center">
          {t("approve.noPending")}
        </Typography>
        <Typography variant="caption" color="text.disabled" textAlign="center" sx={{ mt: 1, maxWidth: 280 }}>
          {t("approve.noPendingHint")}
        </Typography>
        <Button
          sx={{ mt: 2 }}
          onClick={() => {
            if (inline) { window.location.hash = "#/home"; return; }
            window.close();
          }}
        >
          {t("common.close")}
        </Button>
      </Centered>
    );
  }

  // A locked wallet is a step in this flow, not a reason to send the user elsewhere.
  // Telling them to go and unlock in the extension abandoned the request they were in the
  // middle of: by the time they came back the window was gone, and the site was still
  // waiting on a promise nobody was going to answer.
  if (!account) {
    return (
      <UnlockStep
        origin={request.origin}
        onUnlocked={() => setUnlockedAt(Date.now())}
        onCancel={reject}
      />
    );
  }

  const isConnect = request.method === "eth_requestAccounts" || request.method === "wallet_requestPermissions";
  const isTx = request.method === "eth_sendTransaction";
  const txParams = isTx ? (request.params[0] ?? {}) as { to?: string; value?: string; data?: string } : null;
  const fheRisk = isTx ? analyzeFheRisk(txParams?.data, txParams?.to) : null;

  // Named where the wallet knows the chain, and numbered where it does not — a bare id
  // is still more use than the raw method name, and it is what the user must add.
  const switchTarget = request.method === "wallet_switchEthereumChain"
    ? Number((request.params[0] as { chainId?: string } | undefined)?.chainId ?? NaN)
    : NaN;
  const switchTargetNetwork = Number.isFinite(switchTarget)
    ? context?.networkProvider?.listAllNetworks().find((n) => n.chainId === switchTarget)
    : undefined;
  // The wallet's own name first, then the common name of the chain, and only then the
  // number — which on its own tells the user nothing about what they are agreeing to.
  const switchTargetName = Number.isFinite(switchTarget)
    ? (switchTargetNetwork?.name ?? wellKnownChainName(switchTarget))
    : undefined;
  const switchTargetLabel = Number.isFinite(switchTarget)
    ? (switchTargetName ? `${switchTargetName} (${switchTarget})` : `Chain ${switchTarget}`)
    : "—";
  /** A chain the wallet does not have cannot be switched to, and the user has to add it. */
  const switchTargetMissing = Number.isFinite(switchTarget) && !switchTargetNetwork;

  const dangerous = phishing?.riskLevel === "DANGEROUS";
  const suspicious = phishing?.riskLevel === "SUSPICIOUS";
  const blocked = dangerous && !riskAccepted;

  return (
    // `height` with `overflowY`, not `minHeight`: the extension root is a fixed-height box
    // with `overflow: hidden`, so a long request — a transaction with calldata under two
    // risk banners — pushed Approve and Reject past the bottom edge, where they could not
    // be scrolled to. On the one screen whose entire purpose is a decision, the buttons
    // have to be reachable.
    <Box sx={{ p: 2.5, height: "100vh", overflowY: "auto", display: "flex", flexDirection: "column", bgcolor: "background.default" }}>
      {/* Mounted here as well as in AppLayout.
          This screen is deliberately outside AppLayout — no nav chrome belongs on a
          decision — and the surface that draws hunt marks lives inside it, so this route
          was the one reachable screen where a mark could never appear.
          No state provider is needed: the states context defaults to empty, and nothing
          placed here depends on one. */}
      <HuntSurface />

      {/* Origin — the single most important thing on this screen */}
      <Stack alignItems="center" spacing={1} sx={{ mb: 2 }}>
        {/* The site's own icon, taken from the tab Chrome already had. Not fetched: asking
            a server for the icon of the site the user is on would publish exactly the
            thing this screen exists to let them decide about privately. A dangerous
            origin never gets its icon — a familiar logo is what a convincing imitation
            has, and showing it beside a warning argues against the warning. */}
        {request.favIconUrl && !dangerous ? (
          <Avatar
            src={request.favIconUrl}
            alt=""
            sx={{ width: 56, height: 56, bgcolor: "action.hover" }}
            imgProps={{ referrerPolicy: "no-referrer" }}
          >
            <LanguageIcon />
          </Avatar>
        ) : (
          <Avatar sx={{ width: 56, height: 56, bgcolor: dangerous ? "error.main" : "primary.main" }}>
            {dangerous ? <GppBad /> : <LanguageIcon />}
          </Avatar>
        )}
        <Typography
          variant="subtitle1"
          fontWeight={800}
          sx={{ wordBreak: "break-all", textAlign: "center", color: dangerous ? "error.main" : "text.primary" }}
        >
          {request.origin}
        </Typography>

        <Stack direction="row" spacing={0.75} alignItems="center" flexWrap="wrap" justifyContent="center" useFlexGap>
          <Chip size="small" label={network?.network_name ?? "—"} sx={{ fontWeight: 600, fontSize: "0.7rem" }} />
          {/* Whether this site is new is the cheapest useful safety signal there is, and
              the wallet already knows it. A first connection to a site the user believes
              they use daily is worth a second look. */}
          {siteHistory !== null && (
            <Chip
              size="small"
              variant="outlined"
              icon={siteHistory.known ? <HistoryIcon sx={{ fontSize: 13 }} /> : <NewReleases sx={{ fontSize: 13 }} />}
              color={siteHistory.known ? "default" : "warning"}
              label={siteHistory.known ? t("approve.seenBefore", { when: siteHistory.when }) : t("approve.firstTime")}
              sx={{ fontSize: "0.65rem", height: 22, "& .MuiChip-label": { textTransform: "none" } }}
            />
          )}
        </Stack>
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
          <>
            <Divider sx={{ my: 1.5 }} />

            {/* Which account gets connected was never a choice — the screen used whichever
                account happened to be active, and a user with several had to close this,
                switch, and start the connection again. */}
            <Typography variant="caption" color="text.secondary">
              {t("approve.connectAddress")}
            </Typography>
            <TextField
              select
              fullWidth
              size="small"
              value={String(selectedAccountIndex)}
              onChange={(e) => {
                const index = Number(e.target.value);
                context?.accountManager?.SetActive(index);
                setSelectedAccountIndex(index);
              }}
              SelectProps={{ native: true }}
              sx={{ mt: 0.5, "& .MuiOutlinedInput-root": { borderRadius: 0 } }}
            >
              {(context?.accountManager?.accounts ?? []).map((acc, index) => {
                const address = acc.GetAddress() ?? "";
                return (
                  <option key={address || index} value={index}>
                    {`${acc.name || `Account ${index + 1}`} · ${address.slice(0, 6)}…${address.slice(-4)}`}
                  </option>
                );
              })}
            </TextField>

            <Divider sx={{ my: 1.5 }} />

            {/* What a connection actually grants. Sites ask for "connection" as if it were
                one thing; saying what it is, and what it still is not, is the difference
                between informed consent and a habit of pressing the blue button. */}
            <Typography variant="caption" color="text.secondary">
              {t("approve.canDo")}
            </Typography>
            <Stack spacing={0.5} sx={{ mt: 0.75 }}>
              <Stack direction="row" spacing={0.75} alignItems="flex-start">
                <CheckCircleOutline sx={{ fontSize: 14, mt: "2px", color: "text.disabled" }} />
                <Typography variant="caption" sx={{ textTransform: "none" }}>
                  {t("approve.canSeeAddress")}
                </Typography>
              </Stack>
              <Stack direction="row" spacing={0.75} alignItems="flex-start">
                <CheckCircleOutline sx={{ fontSize: 14, mt: "2px", color: "text.disabled" }} />
                <Typography variant="caption" sx={{ textTransform: "none" }}>
                  {t("approve.canAsk")}
                </Typography>
              </Stack>
            </Stack>
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ display: "block", mt: 1, textTransform: "none", lineHeight: 1.4 }}
            >
              {t("approve.cannotDo")}
            </Typography>
          </>
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

        {/* A chain switch is one line of information — which chain — and it was the one
            line the screen did not show. "wallet_switchEthereumChain" tells the user
            nothing about what they are agreeing to. */}
        {request.method === "wallet_switchEthereumChain" && (
          <>
            <Divider sx={{ my: 1.5 }} />
            <Row label={t("approve.switchTo")} value={switchTargetLabel} />
            <Row label={t("approve.switchFrom")} value={network?.network_name ?? "—"} />
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

      {/* Said before the button rather than after it: confirming a switch to a chain the
          wallet does not have cannot succeed, and the site is answered with 4902 so it can
          offer to add it. Leaving that to be discovered by pressing Confirm is how a
          correct protocol answer reads as a broken wallet. */}
      {switchTargetMissing && (
        <Alert severity="warning" sx={{ mb: 1.5, borderRadius: 2 }}>
          {t("approve.chainUnsupported", { chain: switchTargetLabel })}
        </Alert>
      )}

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

/**
 * Unlock, without leaving the request behind.
 *
 * This is the same unlock as the wallet's own login screen, rendered in place. What it
 * deliberately does not do is navigate: the request lives in this window, and sending the
 * user to `/home` to unlock — which is what "unlock in the extension, then reopen this
 * request" amounted to — discarded it. The site went on waiting for an answer that could
 * no longer be given.
 *
 * The origin is shown above the password field. Someone is being asked to type their
 * wallet password because a website asked for something, and which website that is belongs
 * on screen before the field, not after it.
 */
function UnlockStep({
  origin,
  onUnlocked,
  onCancel,
}: {
  origin: string;
  onUnlocked: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const context = useContext(WalletContext);

  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [biometricAvailable, setBiometricAvailable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const available = await BiometricService.isBiometricAvailable();
        if (!cancelled) setBiometricAvailable(available && BiometricService.isEnabled());
      } catch { /* no platform authenticator; the password field is always there */ }
    })();
    return () => { cancelled = true; };
  }, []);

  /** Shared tail of both unlock paths: decrypt the accounts and hydrate what the UI reads. */
  const finishUnlock = async (secret: string): Promise<boolean> => {
    const ok = await context?.storageManager?.initEncryption(secret);
    if (!ok) return false;

    await context?.accountManager?.loadFromEncryptedStorage();
    // The approval screen prices a transaction and names the network, both of which read
    // from these — so they are hydrated here rather than on the next navigation.
    await context?.dataCacheService?.hydrate();
    await context?.portfolioHistory?.hydrate();
    return true;
  };

  const submit = async () => {
    if (password.length < 1) {
      setError(t("auth.enterPasswordPrompt"));
      return;
    }
    setBusy(true);
    setError("");
    try {
      if (await finishUnlock(password)) {
        setPassword("");
        onUnlocked();
        return;
      }
      setError(t("auth.incorrectPassword"));
    } catch (e) {
      setError(toUserMessage(e, t));
    } finally {
      setBusy(false);
    }
  };

  const submitBiometric = async () => {
    setBusy(true);
    setError("");
    try {
      const masterPassword = await BiometricService.authenticateBiometric();
      if (masterPassword && (await finishUnlock(masterPassword))) {
        onUnlocked();
        return;
      }
      setError(t("auth.biometricFailed"));
    } catch (e) {
      setError(toUserMessage(e, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Centered>
      <Avatar sx={{ width: 48, height: 48, bgcolor: "primary.main", mb: 1.5 }}>
        <LockIcon />
      </Avatar>

      <Typography variant="subtitle1" fontWeight={800} textAlign="center">
        {t("approve.unlockToContinue")}
      </Typography>

      {/* `textTransform: none` because the theme's caption variant upper-cases, and a
          domain is not free text: upper-casing it misrepresents the name and hides the
          case-based lookalikes this screen exists to let the user notice. */}
      <Typography
        variant="caption"
        fontWeight={700}
        sx={{ mt: 0.5, wordBreak: "break-all", textAlign: "center", textTransform: "none" }}
      >
        {origin}
      </Typography>

      <Typography
        variant="caption"
        color="text.secondary"
        textAlign="center"
        sx={{ mt: 1, maxWidth: 280, textTransform: "none", lineHeight: 1.4 }}
      >
        {t("approve.unlockRequestKept")}
      </Typography>

      {error && <Alert severity="error" sx={{ mt: 2, width: "100%", borderRadius: 0 }}>{error}</Alert>}

      <TextField
        fullWidth
        size="small"
        type={showPassword ? "text" : "password"}
        label={t("auth.password")}
        value={password}
        onChange={(e) => { setPassword(e.target.value); setError(""); }}
        onKeyDown={(e) => { if (e.key === "Enter" && !busy) void submit(); }}
        autoFocus
        autoComplete="current-password"
        disabled={busy}
        sx={{ mt: 2, "& .MuiOutlinedInput-root": { borderRadius: 0 } }}
        InputProps={{
          endAdornment: (
            <InputAdornment position="end">
              <IconButton
                onClick={() => setShowPassword((v) => !v)}
                edge="end"
                aria-label={showPassword ? t("common.hide") : t("common.show")}
              >
                {showPassword ? <VisibilityOff fontSize="small" /> : <Visibility fontSize="small" />}
              </IconButton>
            </InputAdornment>
          ),
        }}
      />

      <Button
        fullWidth
        variant="contained"
        onClick={() => void submit()}
        disabled={busy || password.length === 0}
        sx={{ mt: 1.5, borderRadius: 0, height: 42, fontWeight: 700 }}
      >
        {busy ? <CircularProgress size={18} color="inherit" /> : t("auth.unlock")}
      </Button>

      {biometricAvailable && (
        <Button
          fullWidth
          variant="outlined"
          startIcon={<Fingerprint />}
          onClick={() => void submitBiometric()}
          disabled={busy}
          sx={{ mt: 1, borderRadius: 0, height: 42 }}
        >
          {t("auth.biometricUnlock")}
        </Button>
      )}

      {/* Cancelling answers the site with a rejection rather than leaving it hanging. */}
      <Button onClick={onCancel} disabled={busy} sx={{ mt: 1, color: "text.secondary" }}>
        {t("common.cancel")}
      </Button>
    </Centered>
  );
}

/**
 * The window's own surface.
 *
 * `background.default` is not decoration here. This page is the whole document of a
 * standalone popup window, and the stylesheet paints the area behind the wallet near
 * black — so a transparent state screen is not "unstyled", it is a black window with a
 * spinner somewhere in it, which is what the user sees while anything is loading.
 */
function Centered({ children }: { children: React.ReactNode }) {
  return (
    <Box sx={{
      minHeight: "100vh",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      p: 3,
      bgcolor: "background.default",
    }}>
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
    throw new ApprovalError(`The site asked ${claimed} to sign, but the active account is ${activeAddress}.`);
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
