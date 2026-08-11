import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Box, IconButton, Typography, useTheme, Paper, Stack, Avatar } from "@mui/material";
import { ArrowBack, Visibility, VisibilityOff, Shield, TrendingUp } from "@mui/icons-material";
import { useNavigate } from "react-router";
import { WalletContext } from "../AppContext";
import { ActiveAccountContext } from "../ActiveAccountProvider";
import PortfolioChart from "../components/PortfolioChart";
import AssetAllocationChart from "../components/AssetAllocationChart";
import { NetworkId, TokenBalance, isFheNetwork } from "../backend/NetworkTypes";
import { PortfolioSkeleton } from "../components/SkeletonLoaders";
import { getHiddenTokenAddresses } from "../components/panels/shared.js";

interface DetailedAsset {
    contractAddress: string;
    symbol: string;
    name: string;
    balance: number;
    price: number;
    valueUsd: number;
    isShielded: boolean;
    color: string;
}

const COLORS = ['#2563eb', '#10b981', '#f59e0b', '#3b82f6', '#1e3a8a', '#93c5fd'];

export default function Portfolio() {
    const navigate = useNavigate();
    const theme = useTheme();
    const wallet_context = React.useContext(WalletContext);
    const active_context = React.useContext(ActiveAccountContext);
    const activeNetworkId = wallet_context?.networkProvider?.getActiveNetworkId() ?? NetworkId.Unknown;
    const showFhe = isFheNetwork(activeNetworkId);

    const [isPrivacyMode, setIsPrivacyMode] = useState(false);
    const [totalBalanceUsd, setTotalBalanceUsd] = useState(0.00);
    const [shieldedRatio, setShieldedRatio] = useState(0);
    const { t } = useTranslation();
    const [assets, setAssets] = useState<DetailedAsset[]>([]);
    /** True when the figures come from an expired cache Home has not refreshed yet. */
    const [isStale, setIsStale] = useState(false);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        let isMounted = true;
        const loadCacheData = () => {
            if (!wallet_context || !active_context) return;

            const net = wallet_context.networkProvider.getActiveNetwork();
            const account = active_context.activeAccount;
            if (!net || !account) return;

            const address = account.GetAddress();
            if (!address) return;

            const dataCache = wallet_context.dataCacheService;
            if (!dataCache) return;

            // Stale data is accepted here. This page reads the cache that Home fills and
            // has no loader of its own, so once the 60s TTL lapsed a strict read returned
            // nothing and the page sat on a skeleton waiting for a page the user was not
            // on — then showed an empty portfolio for an account that has funds.
            const entry = dataCache.getAllowStale(address, net.network_id);
            if (!entry) {
                // Genuinely nothing cached yet (cold open). Keep polling.
                return;
            }
            const cached = entry.data;

            // Sync rendering with the verified cached data from Home.tsx
            const IGNORED_CONTRACTS = getHiddenTokenAddresses(net.network_id);

            let shieldedUsd = 0;
            let totalUsd = 0;
            const detailedAssets: DetailedAsset[] = [];

            Object.values(cached.balances).forEach((b, index: number) => {
                const bal = parseFloat(b.tokenBalance);

                // Shielded entries carry the decrypted balance and must survive the filter —
                // they are what `shieldedUsd` below is measuring.
                if (!b.isShielded && IGNORED_CONTRACTS.has(b.contractAddress.toLowerCase())) return;

                // A portfolio is what the account holds. Airdropped and long-emptied
                // contracts arrive in the balance list at zero and used to be listed all
                // the same — over a hundred rows of nothing, none of which move the total.
                // The native token stays regardless, because a zero native balance is
                // itself worth seeing.
                if (!b.isNative && !(bal > 0)) return;

                const meta = wallet_context.tokenCache.getToken(net.network_id, b.contractAddress.toLowerCase()) ||
                    wallet_context.tokenCache.getToken(net.network_id, b.contractAddress);

                const symbol = b.symbol || meta?.symbol || (b.isNative ? "ETH" : "Unknown");
                const name = b.name || meta?.name || symbol;

                const price = b.priceUsd || 0;
                const valueUsd = b.totalValueUsd || (bal * price);

                totalUsd += valueUsd;
                if (b.isShielded) shieldedUsd += valueUsd;

                detailedAssets.push({
                    contractAddress: b.contractAddress,
                    symbol,
                    name,
                    balance: bal,
                    price,
                    valueUsd,
                    isShielded: !!b.isShielded,
                    color: COLORS[index % COLORS.length]
                });
            });

            // Sort exactly matching Home logic
            detailedAssets.sort((a, b) => b.valueUsd - a.valueUsd);
            detailedAssets.forEach((d, i) => d.color = COLORS[i % COLORS.length]);

            if (isMounted) {
                setIsStale(entry.isStale);
                setAssets(detailedAssets);
                // Force total USD display exactly equal to cache to eliminate floating point diffs
                setTotalBalanceUsd(cached.totalUsd);
                setShieldedRatio(cached.totalUsd > 0 ? (shieldedUsd / cached.totalUsd) * 100 : 0);
                setLoading(false);
            }
        };

        loadCacheData();

        // Home fills the cache asynchronously; poll briefly so the page renders as soon as
        // the data lands. Gives up after a bounded window rather than spinning forever.
        const started = Date.now();
        const poll = setInterval(() => {
            if (!isMounted) return;
            if (Date.now() - started > 15_000) {
                clearInterval(poll);
                setLoading(false);   // Render the empty state instead of an endless skeleton.
                return;
            }
            loadCacheData();
        }, 500);

        return () => {
            isMounted = false;
            clearInterval(poll);
        };
    }, [wallet_context, active_context, navigate]);

    // Derived Data
    const formatMoney = (val: number) => isPrivacyMode ? '***' : `$${val.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

    const topAsset = assets.length > 0 ? assets[0].symbol : '-';
    const topAssetDom = assets.length > 0 && totalBalanceUsd > 0 ? ((assets[0].valueUsd / totalBalanceUsd) * 100).toFixed(1) : '0.0';

    const chartData = assets.map(a => ({
        name: a.symbol,
        value: a.valueUsd,
        color: a.color
    }));

    if (loading) return <PortfolioSkeleton />;

    return (
        <Box sx={{ pb: 10, px: { xs: 2, md: 4 }, pt: 3 }}>
            {/* Header */}
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 4 }}>
                <Box sx={{ display: 'flex', alignItems: 'center' }}>
                    <IconButton onClick={() => navigate(-1)} sx={{ mr: 1, ml: -1 }} aria-label="Go back">
                        <ArrowBack />
                    </IconButton>
                    <Typography variant="h5" fontWeight="800" sx={{ letterSpacing: '-0.02em' }}>
                        Portfolio Dashboard
                    </Typography>
                </Box>
                <IconButton
                    onClick={() => setIsPrivacyMode(!isPrivacyMode)}
                    aria-label={isPrivacyMode ? 'Show portfolio values' : 'Hide portfolio values'}
                    sx={{
                        bgcolor: isPrivacyMode ? 'rgba(16, 185, 129, 0.1)' : 'action.hover',
                        color: isPrivacyMode ? 'success.main' : 'text.primary',
                        '&:hover': { bgcolor: isPrivacyMode ? 'rgba(16, 185, 129, 0.2)' : 'action.selected' }
                    }}
                >
                    {isPrivacyMode ? <VisibilityOff /> : <Visibility />}
                </IconButton>
            </Box>

            {/* Stat Cards Row */}
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 2, mb: 4 }}>
                <Box sx={{ flex: { xs: '1 1 100%', sm: '1 1 calc(33.333% - 16px)' } }}>
                    <Paper elevation={0} sx={{ p: 3, borderRadius: 4, bgcolor: 'background.paper', border: '1px solid', borderColor: 'divider', boxShadow: '0 8px 32px rgba(0,0,0,0.02)', height: '100%' }}>
                        <Typography variant="body2" color="text.secondary" fontWeight={600} gutterBottom>Net Worth</Typography>
                        <Typography variant="h4" fontWeight="800" sx={{ mt: 1 }}>{formatMoney(totalBalanceUsd)}</Typography>
                        {/* Rendering an expired cache is what keeps this page instant, but
                            a figure that claims to be current when it is not has no place
                            on a balance screen. */}
                        {isStale && (
                            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                                {t('portfolio.staleData')}
                            </Typography>
                        )}
                    </Paper>
                </Box>
                {showFhe && (
                <Box sx={{ flex: { xs: '1 1 calc(50% - 8px)', sm: '1 1 calc(33.333% - 16px)' } }}>
                    <Paper elevation={0} sx={{ p: 3, borderRadius: 4, bgcolor: 'background.paper', border: '1px solid', borderColor: 'divider', boxShadow: '0 8px 32px rgba(0,0,0,0.02)', height: '100%' }}>
                        <Typography variant="body2" color="text.secondary" fontWeight={600} gutterBottom>Privacy Ratio</Typography>
                        <Stack direction="row" alignItems="center" spacing={1} sx={{ mt: 1 }}>
                            <Shield sx={{ color: 'secondary.main', fontSize: 28 }} />
                            <Typography variant="h5" fontWeight="800">{isPrivacyMode ? '***' : `${shieldedRatio.toFixed(1)}%`}</Typography>
                        </Stack>
                        <Typography variant="caption" color="text.secondary">Held in FHE Assets</Typography>
                    </Paper>
                </Box>
                )}
                <Box sx={{ flex: { xs: '1 1 calc(50% - 8px)', sm: '1 1 calc(33.333% - 16px)' } }}>
                    <Paper elevation={0} sx={{ p: 3, borderRadius: 4, bgcolor: 'background.paper', border: '1px solid', borderColor: 'divider', boxShadow: '0 8px 32px rgba(0,0,0,0.02)', height: '100%' }}>
                        <Typography variant="body2" color="text.secondary" fontWeight={600} gutterBottom>Top Asset</Typography>
                        <Typography variant="h5" fontWeight="800" sx={{ mt: 1 }}>{isPrivacyMode ? '***' : topAsset}</Typography>
                        <Typography variant="caption" color="success.main" fontWeight={700}>{isPrivacyMode ? '***' : `${topAssetDom}% Dominance`}</Typography>
                    </Paper>
                </Box>
            </Box>

            {/* Charts Row */}
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 3, mb: 4 }}>
                <Box sx={{ flex: { xs: '1 1 100%', md: '1 1 calc(66.666% - 24px)' } }}>
                    <Paper elevation={0} sx={{ p: 3, borderRadius: 4, bgcolor: 'background.paper', border: '1px solid', borderColor: 'divider', boxShadow: '0 8px 32px rgba(0,0,0,0.02)', height: '100%' }}>
                        <Typography variant="subtitle1" fontWeight={700} sx={{ mb: 2 }}>Performance History</Typography>
                        <Box sx={{ filter: isPrivacyMode ? 'blur(8px)' : 'none', transition: 'filter 0.3s' }}>
                            <PortfolioChart currentBalanceUsd={totalBalanceUsd} />
                        </Box>
                    </Paper>
                </Box>
                <Box sx={{ flex: { xs: '1 1 100%', md: '1 1 calc(33.333% - 24px)' } }}>
                    <Paper elevation={0} sx={{ p: 3, borderRadius: 4, bgcolor: 'background.paper', border: '1px solid', borderColor: 'divider', boxShadow: '0 8px 32px rgba(0,0,0,0.02)', height: '100%', display: 'flex', flexDirection: 'column' }}>
                        <Typography variant="subtitle1" fontWeight={700} sx={{ mb: 2 }}>Asset Allocation</Typography>
                        <Box sx={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                            <AssetAllocationChart data={chartData} isPrivacyMode={isPrivacyMode} />
                        </Box>
                    </Paper>
                </Box>
            </Box>

            {/* Detailed Assets List */}
            <Typography variant="h6" fontWeight="800" sx={{ mb: 2, px: 1 }}>Your Assets</Typography>
            <Stack spacing={1.5}>
                {assets.map((asset, i) => (
                    <Paper key={i} elevation={0} sx={{
                        p: 2,
                        borderRadius: 3,
                        bgcolor: 'background.paper',
                        border: '1px solid',
                        borderColor: 'divider',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        transition: 'transform 0.2s',
                        '&:hover': { transform: 'scale(1.01)', borderColor: asset.color }
                    }}>
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                            <Box sx={{ width: 40, height: 40, borderRadius: '50%', bgcolor: asset.color, opacity: 0.15, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                {/* Optional: Real logos if available, else initial */}
                                <Typography variant="h6" sx={{ color: asset.color, fontWeight: 800 }}>{asset.symbol.substring(0, 1)}</Typography>
                            </Box>
                            <Box>
                                <Stack direction="row" alignItems="center" spacing={1}>
                                    <Typography variant="subtitle2" fontWeight={700}>{asset.symbol}</Typography>
                                    {showFhe && asset.isShielded && <Shield sx={{ fontSize: 14, color: 'secondary.main' }} />}
                                </Stack>
                                <Typography variant="caption" color="text.secondary">
                                    {isPrivacyMode ? '***' : `${asset.balance.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${asset.symbol}`}
                                </Typography>
                            </Box>
                        </Box>

                        <Box sx={{ textAlign: 'right' }}>
                            <Typography variant="subtitle2" fontWeight={700}>
                                {formatMoney(asset.valueUsd)}
                            </Typography>
                            <Typography variant="caption" color="text.secondary">
                                {isPrivacyMode ? '***' : `@ $${asset.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
                            </Typography>
                        </Box>
                    </Paper>
                ))}
                {assets.length === 0 && !loading && (
                    <Typography variant="body2" color="text.secondary" textAlign="center" sx={{ py: 4 }}>No assets found in your portfolio.</Typography>
                )}
            </Stack>
        </Box>
    );
}
