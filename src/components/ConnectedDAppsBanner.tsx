/**
 * ConnectedDAppsBanner — what currently has standing access to this wallet, on the home screen.
 *
 * The full management surface lives on the Revoke page, which lists these alongside token
 * approvals and offers bulk actions. This is not a replacement for it: it exists because
 * cutting off a site is sometimes urgent, and "urgent" and "two navigations away, behind a
 * button labelled Revoke" do not go together. Someone who has just realised a site should not
 * be connected should be able to act from the screen they are already on.
 *
 * Renders nothing at all when there is nothing connected — the common case, and a banner that
 * is always present stops being read.
 *
 * Both kinds of access are shown together. A WalletConnect session and an injected-provider
 * grant reach the wallet by different mechanisms, but a user asking "what can see my wallet"
 * is not making that distinction, and showing only half the answer is worse than showing none.
 */

import React from "react";
import { Box, Paper, Stack, Typography, IconButton, Button, Tooltip, alpha, useTheme } from "@mui/material";
import LinkOffIcon from "@mui/icons-material/LinkOff";
import PublicIcon from "@mui/icons-material/Public";
import { useTranslation } from "react-i18next";
import { WalletContext } from "../AppContext.js";
import type { WCSessionInfo } from "../types/components.js";
import type { SitePermission } from "../backend/SitePermissionService.js";

type Row = {
    /** Stable identity for React and for the disconnect call. */
    key: string;
    label: string;
    detail: string;
    icon: string | null;
    disconnect: () => Promise<void>;
};

export default function ConnectedDAppsBanner() {
    const theme = useTheme();
    const { t } = useTranslation();
    const wallet = React.useContext(WalletContext);
    const wcService = wallet?.walletConnectService;
    const sitePermissions = wallet?.sitePermissions;

    const [sessions, setSessions] = React.useState<WCSessionInfo[]>([]);
    const [sites, setSites] = React.useState<SitePermission[]>([]);
    const [busy, setBusy] = React.useState<string | null>(null);

    const refresh = React.useCallback(async () => {
        try {
            setSessions(wcService?.getActiveSessions?.() ?? []);
        } catch {
            setSessions([]);
        }
        try {
            setSites((await sitePermissions?.getAll()) ?? []);
        } catch {
            setSites([]);
        }
    }, [wcService, sitePermissions]);

    React.useEffect(() => {
        void refresh();
        if (!wcService?.setOnSessionUpdate) return;
        // The Revoke page installs its own handler on this same single-slot setter, so this one
        // is cleared on unmount rather than left to overwrite whatever mounts next.
        wcService.setOnSessionUpdate(() => { void refresh(); });
        return () => wcService.setOnSessionUpdate(() => { });
    }, [wcService, refresh]);

    const rows: Row[] = React.useMemo(() => {
        const wcRows: Row[] = sessions.map((s) => ({
            key: `wc:${s.topic}`,
            label: s.peer?.metadata?.name || t("home.connectedUnknownDapp"),
            detail: s.peer?.metadata?.url || "",
            icon: s.peer?.metadata?.icons?.[0] || null,
            disconnect: async () => { await wcService?.disconnect(s.topic); },
        }));
        const siteRows: Row[] = sites.map((p) => ({
            key: `site:${p.origin}`,
            label: p.origin.replace(/^https?:\/\//, ""),
            detail: t("home.connectedViaBrowser"),
            icon: null,
            disconnect: async () => { await sitePermissions?.revoke(p.origin); },
        }));
        return [...wcRows, ...siteRows];
    }, [sessions, sites, wcService, sitePermissions, t]);

    if (rows.length === 0) return null;

    const handleDisconnect = async (row: Row) => {
        setBusy(row.key);
        try {
            await row.disconnect();
            await refresh();
        } catch {
            // Refresh anyway: a disconnect that threw may still have landed, and showing a
            // stale row invites the user to press it again on something already gone.
            await refresh();
        } finally {
            setBusy(null);
        }
    };

    return (
        <Box sx={{ px: 2, mb: 1 }}>
            <Paper
                elevation={0}
                sx={{
                    p: 1.5,
                    borderRadius: 3,
                    bgcolor: alpha(theme.palette.info.main, 0.06),
                    border: `1px solid ${alpha(theme.palette.info.main, 0.18)}`,
                }}
            >
                <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 1 }}>
                    <Typography variant="caption" fontWeight={800} sx={{ fontSize: "0.72rem", letterSpacing: "0.04em", textTransform: "uppercase" }}>
                        {t("home.connectedTitle")} ({rows.length})
                    </Typography>
                    {rows.length > 1 && (
                        <Button
                            size="small"
                            color="error"
                            disabled={busy !== null}
                            onClick={async () => {
                                setBusy("all");
                                try {
                                    await wcService?.disconnectAll?.();
                                    await sitePermissions?.revokeAll();
                                } finally {
                                    await refresh();
                                    setBusy(null);
                                }
                            }}
                            sx={{ fontSize: "0.68rem", textTransform: "none", fontWeight: 700, minWidth: "auto", px: 1 }}
                        >
                            {t("home.connectedDisconnectAll")}
                        </Button>
                    )}
                </Stack>

                <Stack spacing={0.5}>
                    {rows.map((row) => (
                        <Stack key={row.key} direction="row" alignItems="center" gap={1}>
                            {row.icon ? (
                                <Box
                                    component="img"
                                    src={row.icon}
                                    alt=""
                                    onError={(e: React.SyntheticEvent<HTMLImageElement>) => { e.currentTarget.style.display = "none"; }}
                                    sx={{ width: 20, height: 20, borderRadius: 0.5, flexShrink: 0 }}
                                />
                            ) : (
                                <PublicIcon sx={{ fontSize: 18, color: "text.disabled", flexShrink: 0 }} />
                            )}
                            <Box sx={{ flex: 1, minWidth: 0 }}>
                                <Typography sx={{ fontSize: "0.78rem", fontWeight: 600 }} noWrap>
                                    {row.label}
                                </Typography>
                                {row.detail && (
                                    <Typography variant="caption" color="text.secondary" sx={{ fontSize: "0.68rem" }} noWrap component="div">
                                        {row.detail}
                                    </Typography>
                                )}
                            </Box>
                            <Tooltip title={t("home.connectedDisconnect")}>
                                <span>
                                    <IconButton
                                        size="small"
                                        color="error"
                                        disabled={busy !== null}
                                        onClick={() => handleDisconnect(row)}
                                        aria-label={`${t("home.connectedDisconnect")}: ${row.label}`}
                                    >
                                        <LinkOffIcon sx={{ fontSize: 16 }} />
                                    </IconButton>
                                </span>
                            </Tooltip>
                        </Stack>
                    ))}
                </Stack>
            </Paper>
        </Box>
    );
}
