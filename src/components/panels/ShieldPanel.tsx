import React, { useContext, useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import {
  Box,
  Select,
  MenuItem,
  Stack,
  Button,
  Typography,
  Paper,
  TextField,
  CircularProgress,
  Link,
  Chip,
  Fade,
  IconButton,
} from "@mui/material";
import {
  Shield,
  LockOutlined,
  LockOpen,
  ArrowForward,
  OpenInNew,
  ArrowBack,
} from "@mui/icons-material";
import { Alert } from "@mui/material";
import { WalletContext } from "../../AppContext.js";
import FheEncryptingOverlay from "../FheEncryptingOverlay.js";
import { getContractsForNetwork, getExplorerBaseForNetwork, inputCardSx, ctaButtonSx } from "./shared.js";
import { toUserMessage } from "../../backend/UserFacingError.js";
import { isFheNetwork } from "../../backend/NetworkTypes.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** A token the panel can shield, with its confidential wrapper resolved (or missing). */
interface ShieldableToken {
  /** "ETH" for native, otherwise the underlying ERC-20 address. */
  key: string;
  symbol: string;
  /** Underlying ERC-20 address; empty for native. */
  underlying: string;
  /** Confidential wrapper, or null when the token has not been enabled yet. */
  wrapper: string | null;
  isNative: boolean;
  /** Decrypted confidential balance, as a decimal string. "" when not yet known. */
  shieldedBalance: string;
  /** Superseded wrapper: withdrawable, but never a shield target. */
  isLegacy: boolean;
}

// --- Shield Panel (Privacy) ---
export default function ShieldPanel() {
  const { t } = useTranslation();
  const context = useContext(WalletContext);
  const network = context?.networkProvider?.getActiveNetwork();
  const activeAccount = context?.accountManager?.GetActive();

  const [mode, setMode] = useState<"shield" | "unshield">("shield");
  /** Selected token: "ETH" for native, otherwise the underlying ERC-20 address. */
  const [token, setToken] = useState<string>("ETH");
  const [amount, setAmount] = useState("");
  const [creatingWrapper, setCreatingWrapper] = useState(false);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("");
  const [txHash, setTxHash] = useState("");
  /** Drives the overlay copy. Localized status text must never be pattern-matched. */
  const [phase, setPhase] = useState<"idle" | "signing" | "confirming" | "decrypting" | "claiming">("idle");
  /** Overlay dismissed by the user; the operation itself keeps running. */
  const [overlayHidden, setOverlayHidden] = useState(false);
  const [outcome, setOutcome] = useState<"none" | "success" | "error">("none");

  /** Shieldable tokens: native ETH plus every held ERC-20, annotated with its wrapper. */
  const [options, setOptions] = useState<ShieldableToken[]>([]);
  const [optionsLoading, setOptionsLoading] = useState(true);
  /** Confidential holdings, keyed by wrapper address — the source for unshield. */
  const [shielded, setShielded] = useState<ShieldableToken[]>([]);

  // Shield offers anything held (a wrapper can be created on demand). Unshield offers what
  // is actually shielded, which is a different list entirely: shielding a whole balance
  // leaves nothing public, so deriving it from held tokens would hide the very funds the
  // user is trying to withdraw.
  const visibleOptions = mode === "unshield" ? shielded : options;
  const selected = visibleOptions.find((o) => o.key === token);
  const isDeployed = !!selected?.wrapper;

  /**
   * Build the token list.
   *
   * Native ETH uses the dedicated wrapper from .env; every other token is resolved
   * through the factory registry, so any ERC-20 someone has already enabled shows up
   * automatically and the rest can be enabled on demand.
   */
  const loadOptions = useCallback(async () => {
    if (!network || !activeAccount || !isFheNetwork(network.network_id)) {
      setOptions([]);
      setShielded([]);
      setOptionsLoading(false);
      return;
    }
    const address = activeAccount.GetAddress();
    if (!address) return;

    setOptionsLoading(true);

    // Native ETH first, and independently of everything else. It has a dedicated wrapper
    // and must stay shieldable even if the lookups below fail — previously any error
    // there emptied the whole list and left the panel permanently disabled.
    const list: ShieldableToken[] = [];
    const contracts = getContractsForNetwork(network.network_id);
    const nativeWrapper = contracts["ETH"]?.shielded;
    if (nativeWrapper && nativeWrapper !== ZERO_ADDRESS) {
      list.push({
        key: "ETH", symbol: "ETH", underlying: "",
        wrapper: nativeWrapper, isNative: true, shieldedBalance: "", isLegacy: false,
      });
    }
    setOptions([...list]);
    setOptionsLoading(false);

    // The two sides are independent, so a failure in one must not blank the other.
    // Unshield is driven by the confidential registry; shield by the public token list.
    void (async () => {
      try {
        const holdings = await network.getShieldedPortfolio(activeAccount);
        setShielded(
          holdings
            .filter((h) => parseFloat(h.balance) > 0)
            .map((h) => ({
              key: h.wrapper,
              symbol: h.symbol,
              underlying: h.underlying,
              wrapper: h.wrapper,
              isNative: h.isNative,
              shieldedBalance: h.balance,
              isLegacy: h.isLegacy,
            }))
        );
      } catch {
        setShielded([]);
      }
    })();

    // ERC-20s are a best-effort addition on top.
    try {
      const balances = await network.getTokenBalances(context?.tokenCache, address);
      const held = balances.filter((b) => !b.isNative && parseFloat(b.tokenBalance) > 0);

      // A wrapper is not itself shieldable — offering "shield your aeUSDC" is nonsense,
      // and its ERC-20 balance is an activity counter rather than a holding. Ask the
      // registry instead of matching addresses, so wrappers from older deployments are
      // excluded too.
      const confidential = await network.filterConfidentialTokens(held.map((b) => b.contractAddress));
      const erc20s = held.filter((b) => !confidential.has(b.contractAddress.toLowerCase()));

      const wrappers = await network.getWrappersFor(erc20s.map((b) => b.contractAddress));

      for (const b of erc20s) {
        const meta = context?.tokenCache?.getToken(network.network_id, b.contractAddress.toLowerCase());
        list.push({
          key: b.contractAddress,
          symbol: meta?.symbol || "TOKEN",
          underlying: b.contractAddress,
          wrapper: wrappers.get(b.contractAddress.toLowerCase()) ?? null,
          isNative: false,
          shieldedBalance: "",
          isLegacy: false,
        });
      }
      setOptions([...list]);
    } catch {
      // Keep whatever we already have; shielding ETH still works.
    }
    // `token` is deliberately not a dependency: this rebuilds the list, and reacting to
    // the user's selection would refetch every balance on each dropdown change.
  }, [network, activeAccount, context]);

  useEffect(() => { void loadOptions(); }, [loadOptions]);

  // Fall back to the first available token if the current selection disappears
  // (network switch, or a token whose balance dropped to zero).
  useEffect(() => {
    if (visibleOptions.length > 0 && !visibleOptions.some((o) => o.key === token)) {
      setToken(visibleOptions[0].key);
    }
  }, [visibleOptions, token]);

  /** Deploy the wrapper for a token that has none yet — a one-time cost per token. */
  const handleEnableShielding = async () => {
    if (!network || !activeAccount || !selected || selected.isNative) return;

    setCreatingWrapper(true);
    setOutcome("none");
    setStatus(t("privacy.enablingToken", { symbol: selected.symbol }));
    try {
      await network.createWrapperFor(activeAccount, selected.underlying);
      await loadOptions();
      setOutcome("success");
      setStatus(t("privacy.tokenEnabled", { symbol: selected.symbol }));
    } catch (e) {
      setOutcome("error");
      setStatus(`${t("privacy.failed")}: ${toUserMessage(e, t)}`);
    } finally {
      setCreatingWrapper(false);
    }
  };

  const handleAction = async () => {
    if (!network || !activeAccount || !context) return;

    setLoading(true);
    setOverlayHidden(false);
    setOutcome("none");
    setPhase("signing");
    setStatus(t("privacy.processing"));
    setTxHash("");

    try {
      if (!selected?.wrapper) throw new Error(t("privacy.notDeployed"));
      const symbol = selected.symbol;

      if (mode === "shield") {
        setStatus(selected.isNative
          ? t("privacy.shieldingNative", { token: symbol })
          : t("privacy.shieldingToken", { token: symbol }));

        const hash = selected.isNative
          ? await network.shieldNative(activeAccount, selected.wrapper, amount)
          : await network.shieldERC20(activeAccount, selected.underlying, selected.wrapper, amount);

        setTxHash(hash);
        setPhase("confirming");
        setStatus(t("privacy.confirming"));
        await network.waitForTransaction(hash);

        setOutcome("success");
        setStatus(t("privacy.shieldSuccessful"));
      } else {
        // Burn and settle in one call. The claim is queued the moment the burn confirms,
        // so dismissing this panel mid-flight cannot strand the balance — WalletProvider
        // retries whatever is still owed as soon as the wallet is open and unlocked.
        const hash = await network.unshieldAndClaim(
          activeAccount,
          selected.wrapper,
          amount,
          context.pendingClaimQueue,
          // Unshield entries already carry the confidential symbol ("aeUSDC"); only the
          // shield-side list uses the underlying's symbol.
          symbol.startsWith("ae") ? symbol : `ae${symbol}`,
          (p) => {
            if (p === "burning") setStatus(t("privacy.burningBalance"));
            if (p === "confirming") { setPhase("confirming"); setStatus(t("privacy.confirming")); }
            if (p === "decrypting") { setPhase("decrypting"); setStatus(t("privacy.decryptingBurned")); }
            if (p === "claiming") { setPhase("claiming"); setStatus(t("privacy.confirmingClaim")); }
          }
        );
        setTxHash(hash);

        const stillOwed = context.pendingClaimQueue
          .getFor(activeAccount.GetAddress() ?? "", network.network_id).length;

        setOutcome("success");
        setStatus(stillOwed > 0 ? t("privacy.unshieldRequested") : t("privacy.unshieldComplete"));
      }

      setPhase("idle");
      setLoading(false);
      setTimeout(() => {
        setAmount("");
        setStatus("");
        setTxHash("");
      }, 4000);
    } catch (e) {
      setOutcome("error");
      setStatus(`${t("privacy.failed")}: ${toUserMessage(e, t)}`);
      setPhase("idle");
      setLoading(false);
    }
  };

  const isError = outcome === "error";
  const isDone = outcome === "success";

  return (
    <Box sx={{ position: 'relative' }}>
      {/* FHE Overlay — fullscreen during shield / unshield */}
      <FheEncryptingOverlay
        visible={loading && !overlayHidden}
        onDismiss={() => setOverlayHidden(true)}
        message={
          phase === "decrypting"
            ? t("privacy.decryptingBurned")
            : phase === "claiming"
              ? t("privacy.confirmingClaim")
              : phase === "confirming"
                ? t("privacy.confirming")
                : mode === "shield"
                  ? t("privacy.encryptingAmount")
                  : t("privacy.burningBalance")
        }
      />

      {/* Header */}
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1 }}>
        <IconButton
          size="small"
          onClick={() => window.dispatchEvent(new CustomEvent('return-to-send-menu'))}
          sx={{ mr: -0.5, color: 'text.secondary', p: 0.5 }}
        >
          <ArrowBack sx={{ fontSize: 20 }} />
        </IconButton>
        <Shield sx={{ fontSize: 20, color: 'secondary.main' }} />
        <Typography variant="subtitle1" fontWeight={700}>
          {t("privacy.title")}
        </Typography>
        <Chip label="FHE" size="small" color="secondary" variant="outlined"
          sx={{ height: 20, fontSize: '0.65rem', fontWeight: 700 }} />
      </Stack>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.5 }}>
        {mode === "shield"
          ? t("privacy.shieldTokens")
          : t("privacy.unshieldTokens")
        }
      </Typography>

      {/* Mode Toggle */}
      <Paper elevation={0} sx={{
        display: 'flex',
        borderRadius: 2.5,
        p: 0.5,
        bgcolor: 'action.hover',
        mb: 1.5
      }}>
        <Button
          fullWidth
          size="small"
          variant={mode === "shield" ? "contained" : "text"}
          color={mode === "shield" ? "secondary" : "inherit"}
          onClick={() => setMode("shield")}
          startIcon={<LockOutlined sx={{ fontSize: 16 }} />}
          sx={{
            borderRadius: 2,
            py: 1,
            fontWeight: 600,
            fontSize: '0.8rem',
            boxShadow: mode === "shield" ? '0 2px 8px rgba(16, 185, 129, 0.3)' : 'none',
          }}
        >
          {t("privacy.shield")}
        </Button>
        <Button
          fullWidth
          size="small"
          variant={mode === "unshield" ? "contained" : "text"}
          color={mode === "unshield" ? "warning" : "inherit"}
          onClick={() => setMode("unshield")}
          startIcon={<LockOpen sx={{ fontSize: 16 }} />}
          sx={{
            borderRadius: 2,
            py: 1,
            fontWeight: 600,
            fontSize: '0.8rem',
            boxShadow: mode === "unshield" ? '0 2px 8px rgba(245, 158, 11, 0.3)' : 'none',
          }}
        >
          {t("privacy.unshield")}
        </Button>
      </Paper>

      {/* Amount Input Card */}
      <Paper elevation={0} sx={inputCardSx}>
        <Typography variant="caption" color="text.secondary" fontWeight={600}>
          {mode === "shield" ? t("privacy.amountToShield") : t("privacy.amountToUnshield")}
        </Typography>
        <Stack direction="row" alignItems="center" spacing={2} sx={{ mt: 0.5 }}>
          <TextField
            variant="standard"
            placeholder="0.00"
            fullWidth
            value={amount}
            onChange={e => setAmount(e.target.value)}
            InputProps={{
              disableUnderline: true,
              style: { fontSize: '1.4rem', fontWeight: 700, letterSpacing: '-0.02em' }
            }}
            disabled={loading}
          />
          <Select
            value={visibleOptions.some(o => o.key === token) ? token : ""}
            onChange={e => setToken(e.target.value)}
            variant="standard"
            disableUnderline
            disabled={loading}
            sx={{
              fontWeight: 700,
              fontSize: '0.9rem',
              bgcolor: 'background.paper',
              borderRadius: 2,
              px: 1.5,
              py: 0.5,
              minWidth: 80,
              border: '1px solid',
              borderColor: 'divider',
            }}
          >
            {/* Two wrappers around one token both render as e.g. "aeUSDC". Without the
                suffix the superseded one is indistinguishable from the live one. */}
            {visibleOptions.map(o => (
              <MenuItem key={o.key} value={o.key}>
                {o.symbol}{o.isLegacy ? ` (${t("privacy.legacyShort")})` : ""}{!o.wrapper ? " ·" : ""}
              </MenuItem>
            ))}
          </Select>
        </Stack>

        {/* Unshielding more than the balance cannot revert on-chain — the protocol moves
            an encrypted zero instead — so the amount is shown rather than left to guess. */}
        {mode === "unshield" && selected?.shieldedBalance && (
          <Stack direction="row" alignItems="center" spacing={1} sx={{ mt: 0.5 }}>
            <Typography variant="caption" color="text.secondary">
              {t("privacy.available")}: {selected.shieldedBalance} {selected.symbol}
            </Typography>
            <Button
              size="small"
              disabled={loading}
              onClick={() => setAmount(selected.shieldedBalance)}
              sx={{ minWidth: 0, px: 1, py: 0, fontSize: '0.68rem', fontWeight: 700 }}
            >
              {t("common.max")}
            </Button>
          </Stack>
        )}
      </Paper>

      {/* Status Feedback */}
      {status && (
        <Fade in>
          <Paper elevation={0} sx={{
            mt: 1.5,
            p: 1.5,
            borderRadius: 2.5,
            bgcolor: isError ? 'error.main' : isDone ? 'success.main' : 'primary.main',
            color: '#fff',
          }}>
            <Typography variant="body2" fontWeight={600} sx={{ fontSize: '0.8rem' }}>
              {status}
            </Typography>
            {txHash && (
              <Stack direction="row" alignItems="center" spacing={1} sx={{ mt: 0.5 }}>
                <Typography variant="caption" sx={{ fontFamily: 'monospace', opacity: 0.9 }}>
                  {txHash.slice(0, 10)}...{txHash.slice(-6)}
                </Typography>
                <Link
                  href={`${getExplorerBaseForNetwork(network)}/tx/${txHash}`}
                  target="_blank"
                  rel="noopener"
                  sx={{ color: '#fff', display: 'flex', alignItems: 'center' }}
                >
                  <OpenInNew sx={{ fontSize: 14 }} />
                </Link>
              </Stack>
            )}
          </Paper>
        </Fade>
      )}


      {/* A superseded wrapper holds its own backing pool, so the balance is real and
          withdrawable — but shielding more into it would keep growing a pool the rest of
          the wallet has moved off. Say what to do rather than just flagging it. */}
      {mode === "unshield" && selected?.isLegacy && (
        <Alert severity="warning" sx={{ mt: 1.5, borderRadius: 2.5, fontSize: '0.78rem' }}>
          {t("privacy.legacyWrapperHint", { symbol: selected.symbol })}
        </Alert>
      )}

      {/* Nothing shielded yet — say so instead of leaving an empty dropdown. */}
      {mode === "unshield" && !optionsLoading && shielded.length === 0 && (
        <Alert severity="info" sx={{ mt: 1.5, borderRadius: 2.5, fontSize: '0.78rem' }}>
          {t("privacy.nothingShielded")}
        </Alert>
      )}

      {/* A token with no wrapper can still be enabled — one deployment, then anyone can
          shield it. Rebasing / fee-on-transfer tokens must not be wrapped. */}
      {mode === "shield" && selected && !selected.wrapper && !optionsLoading && (
        <Alert
          severity="info"
          sx={{ mt: 1.5, borderRadius: 2.5, fontSize: '0.78rem' }}
          action={
            <Button
              size="small"
              disabled={creatingWrapper || loading}
              onClick={handleEnableShielding}
              sx={{ fontWeight: 700, fontSize: '0.7rem' }}
            >
              {creatingWrapper ? t("privacy.enabling") : t("privacy.enable")}
            </Button>
          }
        >
          {t("privacy.tokenNotEnabled", { symbol: selected.symbol })}
        </Alert>
      )}

      {/* CTA Button */}
      <Button
        variant="contained"
        size="large"
        fullWidth
        onClick={handleAction}
        disabled={loading || optionsLoading || !amount || !isDeployed}
        color={mode === "shield" ? "secondary" : "warning"}
        sx={{
          ...ctaButtonSx,
          mt: 2,
          boxShadow: mode === "shield"
            ? '0 4px 14px rgba(16, 185, 129, 0.3)'
            : '0 4px 14px rgba(245, 158, 11, 0.3)',
        }}
        endIcon={loading ? <CircularProgress size={18} color="inherit" /> : <ArrowForward />}
      >
        {loading
          ? (phase === "decrypting" || phase === "claiming"
            ? t("privacy.claiming")
            : phase === "confirming"
              ? t("privacy.confirming")
              : t("common.loading"))
          : (mode === "shield" ? t("privacy.shieldAssets") : t("privacy.unshieldAssets"))
        }
      </Button>
    </Box>
  );
}
