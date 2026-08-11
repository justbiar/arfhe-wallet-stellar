/**
 * ConnectedSites — lists the websites that may see an account, and lets the user cut them off.
 *
 * A permission the user cannot find and cannot withdraw is not really a permission. This is
 * the other half of the approval screen: whatever is granted there has to be visible and
 * revocable here, per site, without touching any other grant.
 *
 * Revoking notifies the service worker so connected pages receive `accountsChanged` with an
 * empty list — the EIP-1193 way of saying "you are no longer authorised". Without that a
 * site keeps showing the address until the user reloads it.
 */

import React, { useCallback, useContext, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
    Box, Paper, Typography, List, ListItem, ListItemText, IconButton,
    Button, Stack, Tooltip,
} from "@mui/material";
import { LinkOff, Language as LanguageIcon } from "@mui/icons-material";
import { WalletContext } from "../AppContext.js";
import type { SitePermission } from "../backend/SitePermissionService.js";

/** Tell the worker that grants changed, so pages get the event without a reload. */
function notifyWorker() {
    try {
        const runtime = (window as unknown as { chrome?: { runtime?: { id?: string; sendMessage?: typeof chrome.runtime.sendMessage } } }).chrome?.runtime;
        runtime?.sendMessage?.({ type: "PERMISSIONS_CHANGED" });
    } catch {
        // Worker restarting; pages pick the change up on their next request.
    }
}

export default function ConnectedSites() {
    const { t } = useTranslation();
    const context = useContext(WalletContext);
    const permissions = context?.sitePermissions;

    const [sites, setSites] = useState<SitePermission[]>([]);

    const reload = useCallback(async () => {
        if (!permissions) return;
        setSites(await permissions.getAll());
    }, [permissions]);

    useEffect(() => { void reload(); }, [reload]);

    const disconnect = async (origin: string) => {
        if (!permissions) return;
        await permissions.revoke(origin);
        notifyWorker();
        await reload();
    };

    const disconnectAll = async () => {
        if (!permissions) return;
        await permissions.revokeAll();
        notifyWorker();
        await reload();
    };

    return (
        <>
            <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ px: 1, mb: 1 }}>
                <Typography variant="h6" fontWeight={700}>
                    {t("approve.connectedSites")}
                </Typography>
                {sites.length > 0 && (
                    <Button size="small" color="error" onClick={disconnectAll} sx={{ fontWeight: 700, fontSize: "0.72rem" }}>
                        {t("approve.disconnectAll")}
                    </Button>
                )}
            </Stack>

            <Paper
                elevation={0}
                sx={{ borderRadius: 4, overflow: "hidden", mb: 3, bgcolor: "background.paper", border: "1px solid", borderColor: "divider" }}
            >
                {sites.length === 0 ? (
                    <Box sx={{ p: 3, textAlign: "center" }}>
                        <LanguageIcon sx={{ fontSize: 32, color: "text.disabled", mb: 1 }} />
                        <Typography variant="body2" color="text.secondary">
                            {t("approve.connectedSitesEmpty")}
                        </Typography>
                    </Box>
                ) : (
                    <List disablePadding>
                        {sites.map((site) => (
                            <ListItem
                                key={site.origin}
                                divider
                                secondaryAction={
                                    <Tooltip title={t("approve.disconnect")}>
                                        <IconButton edge="end" color="error" onClick={() => disconnect(site.origin)}>
                                            <LinkOff />
                                        </IconButton>
                                    </Tooltip>
                                }
                            >
                                <ListItemText
                                    primary={
                                        <Typography variant="body2" fontWeight={700} sx={{ wordBreak: "break-all" }}>
                                            {site.origin}
                                        </Typography>
                                    }
                                    secondary={
                                        <Typography variant="caption" color="text.secondary">
                                            {site.accounts.map(shorten).join(", ")}
                                            {site.lastUsedAt ? ` · ${t("approve.lastUsed")}: ${formatWhen(site.lastUsedAt)}` : ""}
                                        </Typography>
                                    }
                                />
                            </ListItem>
                        ))}
                    </List>
                )}
            </Paper>
        </>
    );
}

function shorten(address: string): string {
    return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

function formatWhen(timestamp: number): string {
    const days = Math.floor((Date.now() - timestamp) / 86_400_000);
    if (days <= 0) return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    return new Date(timestamp).toLocaleDateString();
}
