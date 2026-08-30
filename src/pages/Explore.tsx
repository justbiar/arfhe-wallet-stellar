/**
 * Explore.tsx — In-App dApp Browser & Curated dApp Directory
 * 
 * Premium "App Store" style layout with glassmorphic design.
 * - Featured dApps carousel
 * - Category-based filtering  
 * - Search functionality
 * - WalletConnect v2 integration for safe connections
 * - FHE Security Guard for transaction approval
 */

import * as React from 'react';
import { useState, useEffect, useContext, useMemo } from 'react';
import {
    Container, Box, Typography, TextField, Paper, Chip,
    IconButton, InputAdornment, CircularProgress, Alert,
    alpha, useTheme, Tooltip, Button, Dialog, DialogTitle,
    DialogContent, DialogActions, Stack, Badge
} from '@mui/material';
import {
    Search, OpenInNew, Explore as ExploreIcon, Shield,
    Star, Close,
    Link as LinkIcon, WifiTethering, Verified, Groups,
} from '@mui/icons-material';
import { useTranslation } from 'react-i18next';
import { WalletContext } from '../AppContext';
import {
    DAPP_REGISTRY, DAPP_CATEGORIES, DApp, DAppCategory,
    getFeaturedDApps, searchDApps, getDAppsByCategory, letterAvatarIcon,
} from '../backend/DAppRegistry';
import { openDApp } from '../backend/DAppConnectionService';
import type { WCSessionInfo, ImageErrorEvent } from '../types/index';

// ─── Category Icon Map ──────────────────────────────────────────────

const CATEGORY_ICONS: Record<DAppCategory, React.ReactNode> = {
    arfdao: <Groups />,
    fhe: <Shield />,
};

// ─── Main Component ─────────────────────────────────────────────────

const Explore = () => {
    const theme = useTheme();
    const { t } = useTranslation();
    const walletContext = useContext(WalletContext);

    const network = walletContext?.networkProvider?.getActiveNetwork();

    // State
    const [searchQuery, setSearchQuery] = useState('');
    const [activeCategory, setActiveCategory] = useState<DAppCategory | 'all'>('all');
    const [wcDialogOpen, setWcDialogOpen] = useState(false);
    const [wcUri, setWcUri] = useState('');
    const [wcLoading, setWcLoading] = useState(false);
    const [wcError, setWcError] = useState('');

    const [wcSessionCount, setWcSessionCount] = useState(0);

    // WalletConnect session count
    useEffect(() => {
        const wc = walletContext?.walletConnectService;
        if (!wc) return;
        const updateCount = () => {
            setWcSessionCount(wc.getActiveSessions?.()?.length || 0);
        };
        updateCount();
        wc.setOnSessionUpdate?.(updateCount);
    }, [walletContext?.walletConnectService]);

    // Note: WalletConnect request handling is done globally by WalletConnectManager.
    // Do NOT call setOnRequest here — it would override the global handler.

    // Filter dApps
    const filteredDApps = useMemo(() => {
        let list = searchQuery
            ? searchDApps(searchQuery)
            : activeCategory === 'all'
                ? [...DAPP_REGISTRY]
                : getDAppsByCategory(activeCategory);

        return list;
    }, [searchQuery, activeCategory]);

    const featuredDApps = useMemo(() => getFeaturedDApps(), []);

    // Handlers
    const handleDAppClick = (dApp: DApp) => {
        openDApp(dApp);
        // Informational project pages (e.g. ArfDAO showcase links) don't need a wallet
        // connection — only prompt WalletConnect for dApps meant to be connected to.
        if (!dApp.infoOnly) {
            setWcDialogOpen(true);
        }
    };

    const handleWcConnect = async () => {
        const wc = walletContext?.walletConnectService;
        if (!wc || !wcUri.trim()) return;

        setWcLoading(true);
        setWcError('');
        try {
            await wc.init();
            await wc.pair(wcUri.trim());
            setWcDialogOpen(false);
            setWcUri('');
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (msg === 'ALREADY_PAIRED') {
                setWcError(t('explore.alreadyPaired'));
            } else if (msg === 'URI_EXPIRED') {
                setWcError(t('explore.uriExpired'));
            } else {
                setWcError(msg || t('explore.connectionFailed'));
            }
        } finally {
            setWcLoading(false);
        }
    };



    // The extension popup is ~360px wide. Anything that overflows horizontally makes the
    // whole page pan sideways, which reads as a broken layout rather than a scrollable
    // row — so the page is clamped and only the strips meant to scroll (categories,
    // featured) are allowed to.
    return (
        <Box sx={{ pb: 6, minHeight: '100%', width: '100%', maxWidth: '100%', overflowX: 'hidden' }}>
            <Container maxWidth="lg" sx={{ py: 2, px: { xs: 1.5, sm: 3 } }}>

                {/* ── Hero Header ── */}
                <Box sx={{ mb: 4, borderBottom: '1px solid', borderColor: 'divider', pb: 2 }}>
                    <Typography
                        variant="h3"
                        sx={{
                            fontFamily: 'var(--font-mono)',
                            color: 'text.primary',
                            textTransform: 'uppercase',
                            // A wide-tracked h3 does not fit a popup; both scale down so a
                            // translated title cannot push the header past the edge.
                            fontSize: { xs: '1.6rem', sm: '3rem' },
                            letterSpacing: { xs: 1, sm: 2 },
                            wordBreak: 'break-word',
                            mb: 1
                        }}
                    >
                        {t('explore.title')}
                    </Typography>
                    <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                        {t('explore.subtitle')}
                    </Typography>
                </Box>

                {/* ── Search + WalletConnect Button ── */}
                <Box sx={{ display: 'flex', gap: 1, mb: 3 }}>
                    <TextField
                        fullWidth
                        placeholder={t('explore.searchPlaceholder')}
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        InputProps={{
                            startAdornment: (
                                <InputAdornment position="start">
                                    <Search sx={{ color: 'text.secondary' }} />
                                </InputAdornment>
                            ),
                        }}
                        sx={{
                            '& .MuiOutlinedInput-root': {
                                borderRadius: '0px',
                                bgcolor: 'transparent',
                                color: 'text.primary',
                                '& fieldset': {
                                    borderColor: 'divider',
                                },
                                '&:hover fieldset': {
                                    borderColor: 'text.primary',
                                },
                            }
                        }}
                    />
                    <Tooltip title={t('explore.walletConnect')}>
                        <Badge badgeContent={wcSessionCount} color="success" max={9}>
                            <IconButton
                                onClick={() => setWcDialogOpen(true)}
                                aria-label={t('explore.walletConnect')}
                                sx={{
                                    width: 56, height: 56,
                                    borderRadius: '0px',
                                    border: '1px solid', borderColor: 'divider',
                                    color: 'text.primary',
                                    '&:hover': {
                                        borderColor: 'text.primary',
                                    }
                                }}
                            >
                                <WifiTethering />
                            </IconButton>
                        </Badge>
                    </Tooltip>
                </Box>

                {/* ── Category Pills ── */}
                <Box sx={{
                    display: 'flex',
                    gap: 1,
                    mb: 3,
                    overflowX: 'auto',
                    pb: 1,
                    '&::-webkit-scrollbar': { display: 'none' },
                }}>
                    <Chip
                        label={t('explore.all')}
                        variant={activeCategory === 'all' ? 'filled' : 'outlined'}
                        onClick={() => { setActiveCategory('all'); setSearchQuery(''); }}
                        sx={{
                            borderRadius: '0px', px: 1,
                            fontFamily: 'var(--font-mono)', textTransform: 'uppercase',
                            bgcolor: activeCategory === 'all' ? 'text.primary' : 'transparent',
                            color: activeCategory === 'all' ? 'background.paper' : 'text.secondary',
                            borderColor: 'divider',
                        }}
                    />
                    {DAPP_CATEGORIES.map(cat => (
                        <Chip
                            key={cat.id}
                            icon={React.cloneElement(CATEGORY_ICONS[cat.id] as React.ReactElement<{ sx?: object }>, { sx: { color: 'inherit !important' } })}
                            label={t(cat.labelKey)}
                            variant={activeCategory === cat.id ? 'filled' : 'outlined'}
                            onClick={() => { setActiveCategory(cat.id); setSearchQuery(''); }}
                            sx={{
                                borderRadius: '0px', px: 0.5,
                                fontFamily: 'var(--font-mono)', textTransform: 'uppercase',
                                bgcolor: activeCategory === cat.id ? 'text.primary' : 'transparent',
                                color: activeCategory === cat.id ? 'background.paper' : 'text.secondary',
                                borderColor: 'divider',
                                '& .MuiChip-icon': { fontSize: 16 },
                            }}
                        />
                    ))}
                </Box>

                {/* ── Featured Section ── */}
                {activeCategory === 'all' && !searchQuery && (
                    <Box sx={{ mb: 3 }}>
                        <Typography variant="h6" fontWeight={800} sx={{ mb: 2, display: 'flex', alignItems: 'center', gap: 1 }}>
                            <Star sx={{ color: '#f59e0b' }} /> {t('explore.featured')}
                        </Typography>
                        <Box sx={{
                            display: 'flex',
                            gap: 2,
                            overflowX: 'auto',
                            pb: 2,
                            '&::-webkit-scrollbar': { height: 4 },
                            '&::-webkit-scrollbar-thumb': { bgcolor: 'divider', borderRadius: 2 },
                        }}>
                            {featuredDApps.map(dApp => (
                                <FeaturedCard key={dApp.id} dApp={dApp} onClick={handleDAppClick} />
                            ))}
                        </Box>
                    </Box>
                )}

                {/* ── dApp Grid ──
                    `auto-fill` against a minimum, not xs/sm/md breakpoints. Those read the
                    *window* width, while this content is capped at 400px by `#root` — so
                    opening the wallet in a tab made MUI report `md` and lay out three
                    columns inside 400px, squeezing each card's text to about 100px. The
                    name and description were clipped to a couple of letters.
                    A track minimum answers to the space the cards actually have. */}
                <Box sx={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
                    gap: 2,
                }}>
                    {filteredDApps.map(dApp => (
                        <DAppCard key={dApp.id} dApp={dApp} onClick={handleDAppClick} />
                    ))}
                </Box>

                {filteredDApps.length === 0 && (
                    <Box sx={{ textAlign: 'center', py: 4 }}>
                        <ExploreIcon sx={{ fontSize: 64, color: 'text.disabled', mb: 2 }} />
                        <Typography variant="h6" color="text.secondary" fontWeight={700}>
                            {t('explore.noResults')}
                        </Typography>
                        <Typography variant="body2" color="text.disabled">
                            {t('explore.tryDifferent')}
                        </Typography>
                    </Box>
                )}
            
            </Container>

            {/* ── WalletConnect Dialog ── */}
            <Dialog
                open={wcDialogOpen}
                onClose={() => { setWcDialogOpen(false); setWcError(''); }}
                maxWidth="sm"
                fullWidth
                aria-labelledby="wc-dialog-title"
                PaperProps={{
                    sx: {
                        borderRadius: 4,
                        bgcolor: alpha(theme.palette.background.paper, 0.95),
                        backdropFilter: 'blur(20px)',
                        backgroundImage: 'none',
                    }
                }}
            >
                <DialogTitle id="wc-dialog-title" component="div" sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid', borderColor: 'divider' }}>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
                        <WifiTethering color="primary" />
                        <Typography fontWeight={700}>{t('explore.walletConnect')}</Typography>
                    </Box>
                    <IconButton onClick={() => { setWcDialogOpen(false); setWcError(''); }} size="small" aria-label="Close WalletConnect dialog">
                        <Close />
                    </IconButton>
                </DialogTitle>
                <DialogContent sx={{ pt: 3 }}>
                    <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
                        {t('explore.wcDescription')}
                    </Typography>

                    {wcError && (
                        <Alert severity="error" sx={{ mb: 2, borderRadius: 2 }} onClose={() => setWcError('')}>
                            {wcError}
                        </Alert>
                    )}

                    <TextField
                        fullWidth
                        label={t('explore.wcUriLabel')}
                        placeholder="wc:a281567bb3e4..."
                        value={wcUri}
                        onChange={(e) => setWcUri(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && handleWcConnect()}
                        InputProps={{
                            startAdornment: (
                                <InputAdornment position="start">
                                    <LinkIcon color="action" />
                                </InputAdornment>
                            ),
                        }}
                        sx={{
                            '& .MuiOutlinedInput-root': { borderRadius: 3 },
                        }}
                    />

                    <Paper
                        elevation={0}
                        sx={{
                            mt: 2, p: 2, borderRadius: 2,
                            bgcolor: alpha(theme.palette.info.main, 0.05),
                            border: '1px solid',
                            borderColor: alpha(theme.palette.info.main, 0.15),
                        }}
                    >
                        <Typography variant="caption" color="text.secondary" sx={{ lineHeight: 1.6 }}>
                            💡 {t('explore.wcHint')}
                        </Typography>
                    </Paper>

                    {/* Active Sessions */}
                    {wcSessionCount > 0 && (
                        <Box sx={{ mt: 3 }}>
                            <Typography variant="subtitle2" fontWeight={700} sx={{ mb: 1 }}>
                                {t('explore.activeSessions')} ({wcSessionCount})
                            </Typography>
                            {walletContext?.walletConnectService?.getActiveSessions?.()?.map((session: WCSessionInfo) => (
                                <Box
                                    key={session.topic}
                                    sx={{
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: 1.5,
                                        p: 1.5,
                                        borderRadius: 2,
                                        border: '1px solid',
                                        borderColor: 'divider',
                                        mb: 1,
                                    }}
                                >
                                    <Box
                                        component="img"
                                        src={session.peer?.metadata?.icons?.[0] || ''}
                                        alt=""
                                        onError={(e: ImageErrorEvent) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                                        sx={{ width: 28, height: 28, borderRadius: 1 }}
                                    />
                                    <Box sx={{ flex: 1, minWidth: 0 }}>
                                        <Typography fontSize={13} fontWeight={600} noWrap>
                                            {session.peer?.metadata?.name || 'Unknown'}
                                        </Typography>
                                        <Typography variant="caption" color="text.secondary" noWrap>
                                            {session.peer?.metadata?.url || ''}
                                        </Typography>
                                    </Box>
                                    <Button
                                        size="small"
                                        color="error"
                                        onClick={() => walletContext?.walletConnectService?.disconnect(session.topic)}
                                        sx={{ fontSize: 11, minWidth: 'auto' }}
                                    >
                                        {t('explore.disconnect')}
                                    </Button>
                                </Box>
                            ))}
                        </Box>
                    )}
                </DialogContent>
                <DialogActions sx={{ p: 3, pt: 1 }}>
                    <Button
                        variant="contained"
                        fullWidth
                        onClick={handleWcConnect}
                        disabled={wcLoading || !wcUri.trim()}
                        sx={{ borderRadius: 3, height: 48, fontWeight: 700 }}
                    >
                        {wcLoading ? <CircularProgress size={24} color="inherit" /> : t('explore.connect')}
                    </Button>
                </DialogActions>
            </Dialog>


        </Box>
    );
};

// ─── Featured Card ──────────────────────────────────────────────────

function FeaturedCard({ dApp, onClick }: { dApp: DApp; onClick: (d: DApp) => void }) {
    const { t } = useTranslation();
    const catInfo = DAPP_CATEGORIES.find(c => c.id === dApp.category);

    return (
        <Paper
            elevation={0}
            onClick={() => onClick(dApp)}
            sx={{
                // This one really is in a horizontal scroller, so it keeps a fixed width
                // and refuses to shrink — otherwise the flex row squashes every card to
                // fit and there is nothing left to scroll.
                width: 240,
                flexShrink: 0,
                p: 2,
                borderRadius: '0px',
                cursor: 'pointer',
                bgcolor: 'transparent',
                border: '1px solid', borderColor: 'divider',
                transition: 'none',
                '&:hover': {
                    borderColor: 'text.primary',
                },
            }}
        >
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 2, minWidth: 0 }}>
                <Box
                    component="img"
                    src={dApp.icon}
                    alt={dApp.name}
                    onError={(e: ImageErrorEvent) => { (e.target as HTMLImageElement).src = letterAvatarIcon(dApp.name[0]); }}
                    sx={{
                        width: 48, height: 48,
                        flexShrink: 0,
                        borderRadius: '0px',
                        objectFit: 'cover',
                        border: '1px solid',
                        borderColor: 'divider',
                    }}
                />
                {/* The card is a fixed 240px, so the text column must be allowed to shrink
                    and truncate — otherwise a long name pushes the icon out of the card. */}
                <Box sx={{ minWidth: 0, flex: 1 }}>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, minWidth: 0 }}>
                        <Typography
                            noWrap
                            sx={{ fontFamily: 'var(--font-mono)', color: 'text.primary', textTransform: 'uppercase', minWidth: 0 }}
                        >
                            {dApp.name}
                        </Typography>
                        <Verified sx={{ fontSize: 14, color: 'text.secondary', flexShrink: 0 }} />
                    </Box>
                    <Chip
                        label={t(catInfo?.labelKey || 'explore.catTools')}
                        size="small"
                        sx={{
                            height: 20, fontSize: 10, fontFamily: 'var(--font-mono)', textTransform: 'uppercase',
                            bgcolor: 'transparent', color: 'text.secondary', border: '1px solid', borderColor: 'divider', borderRadius: '0px'
                        }}
                    />
                </Box>
            </Box>
            <Typography
                variant="body2"
                sx={{
                    color: 'text.secondary', mb: 2, minHeight: 40,
                    // Descriptions vary wildly in length; clamping keeps the row of cards
                    // a uniform height instead of one tall card dragging the strip out.
                    display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical',
                    overflow: 'hidden',
                }}
            >
                {dApp.description}
            </Typography>
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end' }}>
                <Typography variant="caption" sx={{ fontFamily: 'var(--font-mono)', color: 'text.primary', textTransform: 'uppercase' }}>
                    [ {t('explore.open')} ]
                </Typography>
            </Box>
        </Paper>
    );
}

// ─── Standard dApp Card ─────────────────────────────────────────────

function DAppCard({ dApp, onClick }: { dApp: DApp; onClick: (d: DApp) => void }) {
    const { t } = useTranslation();
    const catInfo = DAPP_CATEGORIES.find(c => c.id === dApp.category);

    return (
        <Paper
            elevation={0}
            onClick={() => onClick(dApp)}
            sx={{
                // This card sits in a CSS grid, so it fills its track. It previously kept
                // `minWidth: 260` and `flexShrink: 0` from when it lived in a horizontal
                // scroller — inside a grid those force the track wider than the popup and
                // push the whole page sideways.
                width: '100%',
                minWidth: 0,
                p: 2,
                borderRadius: '0px',
                cursor: 'pointer',
                bgcolor: 'transparent',
                border: '1px solid', borderColor: 'divider',
                transition: 'none',
                '&:hover': {
                    borderColor: 'text.primary',
                },
            }}
        >
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, minWidth: 0 }}>
                <Box
                    component="img"
                    src={dApp.icon}
                    alt={dApp.name}
                    onError={(e: ImageErrorEvent) => { (e.target as HTMLImageElement).src = letterAvatarIcon(dApp.name[0]); }}
                    sx={{
                        width: 44, height: 44,
                        borderRadius: '0px',
                        flexShrink: 0,
                        objectFit: 'cover',
                        border: '1px solid',
                        borderColor: 'divider',
                    }}
                />
                <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                        <Typography sx={{ fontFamily: 'var(--font-mono)', color: 'text.primary', textTransform: 'uppercase', fontSize: 14 }} noWrap>
                            {dApp.name}
                        </Typography>
                        {dApp.featured && <Star sx={{ fontSize: 13, color: 'text.primary' }} />}
                    </Box>
                    <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block' }} noWrap>
                        {dApp.description}
                    </Typography>
                    <Box sx={{ display: 'flex', gap: 0.5, mt: 0.5 }}>
                        <Chip
                            label={t(catInfo?.labelKey || dApp.category)}
                            size="small"
                            sx={{
                                height: 18, fontSize: 9, fontFamily: 'var(--font-mono)', textTransform: 'uppercase',
                                bgcolor: 'transparent', color: 'text.secondary', border: '1px solid', borderColor: 'divider', borderRadius: '0px'
                            }}
                        />
                        {dApp.chains.length > 0 && dApp.chains.length <= 3 && (
                            <Chip
                                label={dApp.chains.map(c => getChainLabel(c)).join(', ')}
                                size="small"
                                sx={{ height: 18, fontSize: 9, fontFamily: 'var(--font-mono)', textTransform: 'uppercase', bgcolor: 'transparent', color: 'text.secondary', border: '1px solid', borderColor: 'divider', borderRadius: '0px' }}
                            />
                        )}
                    </Box>
                </Box>
                <OpenInNew sx={{ fontSize: 16, color: 'text.secondary', flexShrink: 0 }} />
            </Box>
        </Paper>
    );
}

// ─── Helpers ────────────────────────────────────────────────────────

function getChainLabel(chainId: number): string {
    switch (chainId) {
        case 1: return 'ETH';
        case 11155111: return 'Sepolia';
        case 42161: return 'ARB';
        case 421614: return 'ARB Sep';
        case 8453: return 'Base';
        case 84532: return 'Base Sep';
        case 43114: return 'Avalanche';
        case 43113: return 'Avax Fuji';
        default: return `#${chainId}`;
    }
}

export default Explore;
