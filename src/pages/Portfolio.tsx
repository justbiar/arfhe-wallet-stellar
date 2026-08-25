/**
 * Portfolio — the whole wallet at once, which is the one view Home cannot give.
 *
 * Home renders the active network. That is right for Home: it is where you act, and acting
 * happens on one chain. But it leaves an obvious question unanswered — *where is my money*
 * — and the previous version of this page did not answer it either. It repeated Home's net
 * worth and Home's token list for the same single network, added a privacy ratio, and
 * topped it with a "Performance History" chart built from `Math.random()`: a line the user
 * had never actually lived through, drawn on a balance screen.
 *
 * So this page now does the two things Home structurally cannot:
 *
 *  1. **Across networks.** Totals, allocation and assets are summed over every chain the
 *     wallet has a snapshot for.
 *  2. **Public against private.** How much of the total is shielded — the number this
 *     wallet exists to move, and the one no other view states.
 *
 * Every figure comes from the cache Home already fills, so opening this page issues no
 * requests at all. The cost of that is age, which is why each network carries its own
 * "last updated" rather than one reassuring timestamp for the page.
 *
 * A network with no snapshot is reported as *not loaded*, never as zero. Counting an
 * unvisited chain as empty would understate the user's holdings — the same mistake that
 * once made undecryptable shielded balances vanish from the wallet.
 */

import React, { useContext, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import {
  Alert,
  Box,
  Chip,
  IconButton,
  LinearProgress,
  Paper,
  Stack,
  Tooltip,
  Typography,
  alpha,
  useTheme,
} from "@mui/material";
import { ArrowBack, Shield, Visibility, VisibilityOff, Public } from "@mui/icons-material";

import { WalletContext } from "../AppContext";
import { ActiveAccountContext } from "../ActiveAccountProvider";
import PortfolioHistoryChart, { DailyChangeBadge } from "../components/PortfolioHistoryChart";
import type { HistoryRange } from "../backend/PortfolioHistoryService";
import { isFheNetwork } from "../backend/NetworkTypes";

/** One chain's contribution to the total. */
interface NetworkSlice {
  networkId: number;
  name: string;
  totalUsd: number;
  shieldedUsd: number;
  ageMs: number;
  supportsFhe: boolean;
}

/** One asset, summed over every network that holds it. */
interface AggregatedAsset {
  symbol: string;
  valueUsd: number;
  amount: number;
  isShielded: boolean;
  networks: string[];
}

export default function Portfolio() {
  const navigate = useNavigate();
  const theme = useTheme();
  const { t } = useTranslation();
  const wallet = useContext(WalletContext);
  const activeContext = useContext(ActiveAccountContext);

  const [hidden, setHidden] = useState(false);
  const [range, setRange] = useState<HistoryRange>("1W");

  const address = activeContext?.activeAccount?.GetAddress() ?? "";

  /** Networks the wallet ships with, so we can name the ones with no snapshot yet. */
  const knownNetworks = useMemo(
    () => wallet?.networkProvider?.listAllNetworks() ?? [],
    [wallet?.networkProvider]
  );

  const { slices, assets, totalUsd, shieldedUsd, missing } = useMemo(() => {
    const cache = wallet?.dataCacheService;
    if (!cache || !address) return aggregatePortfolio([], knownNetworks);

    // Snapshots for networks the wallet has since dropped can only render as a nameless
    // "Chain 143" row nobody can open or refresh. Clearing them also stops them occupying
    // the persisted entry cap ahead of networks the user actually uses.
    const knownIds = knownNetworks.map((n) => n.id);
    cache.pruneUnknownNetworks(knownIds);

    return aggregatePortfolio(cache.getCachedNetworks(address, knownIds), knownNetworks);
  }, [wallet?.dataCacheService, address, knownNetworks]);

  const points = useMemo(
    () => (address ? wallet?.portfolioHistory?.getSeries(address, range) ?? [] : []),
    [wallet?.portfolioHistory, address, range]
  );

  const dailyChange = useMemo(
    () => wallet?.portfolioHistory?.getDailyChange(address ?? "")
      ?? { absolute: 0, percent: 0, since: Date.now(), hasBaseline: false },
    [wallet?.portfolioHistory, address]
  );

  const money = (v: number) =>
    hidden ? "•••" : `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const privacyPct = totalUsd > 0 ? (shieldedUsd / totalUsd) * 100 : 0;

  const cardSx = {
    p: 2,
    border: "1px solid",
    borderColor: "divider",
    bgcolor: "background.paper",
    borderRadius: "0px",
  } as const;

  return (
    <Box sx={{ pb: 12, px: 2, pt: 2 }}>
      <Stack direction="row" alignItems="center" spacing={0.5} sx={{ mb: 2 }}>
        <IconButton onClick={() => navigate(-1)} aria-label={t("common.back")} sx={{ ml: -1 }}>
          <ArrowBack />
        </IconButton>
        <Typography variant="h6" fontWeight={800} sx={{ flex: 1, letterSpacing: "-0.02em" }}>
          {t("portfolio.title")}
        </Typography>
        <Tooltip title={hidden ? t("home.showBalance") : t("home.hideBalance")}>
          <IconButton size="small" onClick={() => setHidden(!hidden)} aria-label={hidden ? t("home.showBalance") : t("home.hideBalance")}>
            {hidden ? <VisibilityOff fontSize="small" /> : <Visibility fontSize="small" />}
          </IconButton>
        </Tooltip>
      </Stack>

      {/* ── Total across every chain with a snapshot ──────────── */}
      <Paper elevation={0} sx={{ ...cardSx, mb: 2 }}>
        <Typography
          variant="caption"
          color="text.secondary"
          fontWeight={700}
          sx={{ textTransform: "uppercase", letterSpacing: "0.08em", fontSize: "0.65rem" }}
        >
          {t("portfolio.acrossNetworks")}
        </Typography>
        <Typography variant="h4" fontWeight={800} sx={{ mt: 0.5 }}>
          {money(totalUsd)}
        </Typography>
        <Stack direction="row" alignItems="center" spacing={1} sx={{ mt: 0.5, flexWrap: "wrap" }} useFlexGap>
          <DailyChangeBadge {...dailyChange} hidden={hidden} />
          <Typography variant="caption" color="text.secondary">
            {t("portfolio.networkCount", { count: slices.length })}
          </Typography>
        </Stack>

        <Box sx={{ mt: 1.5 }}>
          <PortfolioHistoryChart points={points} range={range} onRangeChange={setRange} hidden={hidden} />
        </Box>
      </Paper>

      {/* A chain never opened has no snapshot. Saying so is the difference between a
          total the user can trust and one that quietly leaves money out. */}
      {missing.length > 0 && (
        <Alert severity="info" sx={{ mb: 2, borderRadius: "0px", fontSize: "0.75rem" }}>
          {t("portfolio.notLoaded", { networks: missing.join(", ") })}
        </Alert>
      )}

      {/* ── Public against private ────────────────────────────── */}
      <Paper elevation={0} sx={{ ...cardSx, mb: 2 }}>
        <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1 }}>
          <Shield sx={{ fontSize: 18, color: "secondary.main" }} />
          <Typography variant="subtitle2" fontWeight={700} sx={{ flex: 1 }}>
            {t("portfolio.privacySplit")}
          </Typography>
          <Typography variant="h6" fontWeight={800}>
            {hidden ? "•••" : `${privacyPct.toFixed(1)}%`}
          </Typography>
        </Stack>

        <LinearProgress
          variant="determinate"
          value={Math.min(100, privacyPct)}
          sx={{
            height: 8,
            borderRadius: 0,
            bgcolor: alpha(theme.palette.text.primary, 0.08),
            "& .MuiLinearProgress-bar": { bgcolor: "secondary.main", borderRadius: 0 },
          }}
        />

        <Stack direction="row" justifyContent="space-between" sx={{ mt: 1 }}>
          <Stack direction="row" spacing={0.5} alignItems="center">
            <Shield sx={{ fontSize: 13, color: "secondary.main" }} />
            <Typography variant="caption" color="text.secondary">
              {t("portfolio.shielded")} {money(shieldedUsd)}
            </Typography>
          </Stack>
          <Stack direction="row" spacing={0.5} alignItems="center">
            <Public sx={{ fontSize: 13, color: "text.disabled" }} />
            <Typography variant="caption" color="text.secondary">
              {t("portfolio.public")} {money(Math.max(0, totalUsd - shieldedUsd))}
            </Typography>
          </Stack>
        </Stack>
      </Paper>

      {/* ── Where it sits ─────────────────────────────────────── */}
      <Typography variant="subtitle2" fontWeight={800} sx={{ mb: 1, pl: 0.5 }}>
        {t("portfolio.byNetwork")}
      </Typography>

      {slices.length === 0 ? (
        <Alert severity="info" sx={{ mb: 2, borderRadius: "0px", fontSize: "0.78rem" }}>
          {t("portfolio.nothingCached")}
        </Alert>
      ) : (
        <Stack spacing={1} sx={{ mb: 2 }}>
          {slices.map((slice) => {
            const share = totalUsd > 0 ? (slice.totalUsd / totalUsd) * 100 : 0;
            return (
              <Paper key={slice.networkId} elevation={0} sx={cardSx}>
                <Stack direction="row" alignItems="center" spacing={1}>
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Stack direction="row" alignItems="center" spacing={0.5}>
                      <Typography variant="subtitle2" fontWeight={700} noWrap>
                        {slice.name}
                      </Typography>
                      {slice.supportsFhe && <Shield sx={{ fontSize: 12, color: "secondary.main" }} />}
                    </Stack>
                    <Typography variant="caption" color="text.disabled">
                      {t("portfolio.updated", { ago: formatAge(slice.ageMs, t) })}
                    </Typography>
                  </Box>
                  <Box sx={{ textAlign: "right" }}>
                    <Typography variant="subtitle2" fontWeight={700}>
                      {money(slice.totalUsd)}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      {hidden ? "•••" : `${share.toFixed(0)}%`}
                    </Typography>
                  </Box>
                </Stack>

                {slice.shieldedUsd > 0 && (
                  <Chip
                    icon={<Shield sx={{ fontSize: 11 }} />}
                    label={`${t("portfolio.shielded")} ${money(slice.shieldedUsd)}`}
                    size="small"
                    color="secondary"
                    variant="outlined"
                    sx={{ height: 18, fontSize: "0.6rem", fontWeight: 700, mt: 0.75 }}
                  />
                )}
              </Paper>
            );
          })}
        </Stack>
      )}


      {/* ── Assets, one row per holding regardless of chain ───── */}
      {assets.length > 0 && (
        <>
          <Typography variant="subtitle2" fontWeight={800} sx={{ mb: 1, pl: 0.5 }}>
            {t("portfolio.assets")}
          </Typography>
          <Stack spacing={1}>
            {assets.map((asset) => (
              <Paper key={`${asset.symbol}-${asset.isShielded}`} elevation={0} sx={cardSx}>
                <Stack direction="row" alignItems="center" spacing={1}>
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Stack direction="row" alignItems="center" spacing={0.5}>
                      <Typography variant="subtitle2" fontWeight={700} noWrap>
                        {asset.symbol}
                      </Typography>
                      {asset.isShielded && <Shield sx={{ fontSize: 12, color: "secondary.main" }} />}
                    </Stack>
                    {/* Which chains this holding is spread over — the detail that makes a
                        combined row honest rather than merely tidy. */}
                    <Typography variant="caption" color="text.disabled" noWrap>
                      {asset.networks.join(" · ")}
                    </Typography>
                  </Box>
                  <Box sx={{ textAlign: "right" }}>
                    <Typography variant="subtitle2" fontWeight={700}>
                      {money(asset.valueUsd)}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      {hidden ? "•••" : asset.amount.toLocaleString(undefined, { maximumFractionDigits: 4 })}
                    </Typography>
                  </Box>
                </Stack>
              </Paper>
            ))}
          </Stack>
        </>
      )}
    </Box>
  );
}

/** Human-readable age of a snapshot. */
function formatAge(ms: number, t: (k: string, o?: Record<string, unknown>) => string): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return t("portfolio.justNow");
  if (minutes < 60) return t("portfolio.minutesAgo", { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("portfolio.hoursAgo", { count: hours });
  return t("portfolio.daysAgo", { count: Math.floor(hours / 24) });
}


/** A cached snapshot as {@link DataCacheService.getCachedNetworks} returns it. */
export interface CachedNetworkEntry {
  networkId: number;
  ageMs: number;
  data: {
    balances: Record<string, { contractAddress?: string; tokenBalance?: string; totalValueUsd?: number; isShielded?: boolean; symbol?: string }>;
    tokens: { contractAddress?: string; symbol?: string }[];
    totalUsd: number;
  };
}

export interface PortfolioSummary {
  slices: NetworkSlice[];
  assets: AggregatedAsset[];
  totalUsd: number;
  shieldedUsd: number;
  /** Networks the wallet knows about but has no snapshot for. Unknown, not empty. */
  missing: string[];
}

/**
 * Fold every cached network into one picture.
 *
 * Extracted from the component because the interesting behaviour is arithmetic, not
 * rendering: whether two chains holding the same symbol combine, whether shielded value is
 * counted once, and — most importantly — whether a network with no snapshot is reported as
 * unknown instead of being silently added as zero.
 */
export function aggregatePortfolio(
  cached: CachedNetworkEntry[],
  knownNetworks: { id: number; name: string }[]
): PortfolioSummary {
  const seen = new Set(cached.map((c) => c.networkId));

  const slices: NetworkSlice[] = [];
  const bySymbol = new Map<string, AggregatedAsset>();
  let totalUsd = 0;
  let shieldedUsd = 0;

  for (const { networkId, data, ageMs } of cached) {
    const meta = knownNetworks.find((n) => n.id === networkId);
    const networkName = meta?.name ?? `Chain ${networkId}`;
    let netShielded = 0;

    for (const balance of Object.values(data.balances)) {
      const valueUsd = Number(balance.totalValueUsd ?? 0);
      if (!Number.isFinite(valueUsd) || valueUsd <= 0) continue;

      const isShielded = !!balance.isShielded;
      if (isShielded) netShielded += valueUsd;

      // Grouped by symbol, not address: the same asset on two chains is one holding to
      // the user, and two rows would only invite mental arithmetic. Shielded and public
      // stay apart, because that distinction is the point of the wallet.
      const tokenInfo = data.tokens.find(
        (tk) => tk.contractAddress?.toLowerCase() === balance.contractAddress?.toLowerCase()
      );
      const symbol = (tokenInfo?.symbol ?? balance.symbol ?? "???").toUpperCase();
      const key = `${symbol}:${isShielded}`;
      const amount = parseFloat(balance.tokenBalance ?? "0") || 0;

      const existing = bySymbol.get(key);
      if (existing) {
        existing.valueUsd += valueUsd;
        existing.amount += amount;
        if (!existing.networks.includes(networkName)) existing.networks.push(networkName);
      } else {
        bySymbol.set(key, { symbol, valueUsd, amount, isShielded, networks: [networkName] });
      }
    }

    totalUsd += data.totalUsd;
    shieldedUsd += netShielded;

    slices.push({
      networkId,
      name: networkName,
      totalUsd: data.totalUsd,
      shieldedUsd: netShielded,
      ageMs,
      supportsFhe: isFheNetwork(networkId),
    });
  }

  return {
    slices,
    assets: [...bySymbol.values()].sort((a, b) => b.valueUsd - a.valueUsd),
    totalUsd,
    shieldedUsd,
    missing: knownNetworks.filter((n) => !seen.has(n.id)).map((n) => n.name),
  };
}
