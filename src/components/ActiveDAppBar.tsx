/**
 * ActiveDAppBar — the one site the user is looking at right now, if it is connected.
 *
 * This is not the list of connected sites. That list lives on the Permissions page, where it
 * belongs: it is a standing record, it grows, and reviewing it is a deliberate act. Putting
 * it on the home screen made the home screen mostly about other websites.
 *
 * What is genuinely useful is much smaller: *this tab, right now, can see this account*. It
 * appears when the user is on a connected site and disappears the moment they navigate away
 * — it tracks attention, not history — so it never accumulates and never needs managing.
 *
 * Renders nothing outside the extension, or when the active tab is not connected to the
 * account currently selected, which is the common case.
 */

import React from "react";
import { Box, Paper, Stack, Typography, IconButton, Tooltip, alpha, useTheme } from "@mui/material";
import LinkOffIcon from "@mui/icons-material/LinkOff";
import PublicIcon from "@mui/icons-material/Public";
import { useTranslation } from "react-i18next";
import { WalletContext } from "../AppContext.js";
import { useActiveAccount } from "../ActiveAccountProvider.js";

/** Sits directly above the floating bottom bar (fixed at 12, roughly 53 tall). */
const BOTTOM_OFFSET = 73;

/**
 * Read straight from storage rather than through `WalletContext.sitePermissions`.
 *
 * Two reasons, both of which this component was getting wrong. The context object is filled
 * in as the wallet initialises without a state update to go with it, so a component that
 * reads it once on mount can read it before it exists and never hear that it arrived — which
 * is why the bar only showed up after navigating away and back. And a grant written by the
 * approval window or by the worker never reaches an in-page listener at all, whereas
 * `chrome.storage.onChanged` reaches every context.
 *
 * Must stay in step with SitePermissionService's own key and record shape.
 */
const PERMISSION_STORAGE_KEY = "arfhe_site_permissions";

function originOf(url: string | undefined): string | null {
    if (!url) return null;
    try {
        const parsed = new URL(url);
        // Only pages a site can actually reach the wallet from. chrome:// and extension
        // pages have no provider, and showing the wallet's own URL here would be absurd.
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
        return parsed.origin.toLowerCase();
    } catch {
        return null;
    }
}

/** Origins granted to `address`. Empty when nothing is stored or the store cannot be read. */
async function originsGrantedTo(address: string): Promise<Set<string>> {
    try {
        const stored = await chrome.storage.local.get(PERMISSION_STORAGE_KEY);
        const raw = stored?.[PERMISSION_STORAGE_KEY];
        if (!Array.isArray(raw)) return new Set();

        const wanted = address.toLowerCase();
        return new Set(
            raw
                .filter(
                    (p): p is { origin: string; accounts: string[] } =>
                        !!p &&
                        typeof p.origin === "string" &&
                        Array.isArray(p.accounts) &&
                        p.accounts.some((a: unknown) => typeof a === "string" && a.toLowerCase() === wanted),
                )
                .map((p) => p.origin.toLowerCase()),
        );
    } catch {
        return new Set();
    }
}

export default function ActiveDAppBar() {
    const theme = useTheme();
    const { t } = useTranslation();
    const wallet = React.useContext(WalletContext);
    const { activeAccount } = useActiveAccount();
    const address = activeAccount?.GetAddress();

    const [origin, setOrigin] = React.useState<string | null>(null);
    const [connected, setConnected] = React.useState(false);
    const [busy, setBusy] = React.useState(false);

    /** Reads the active tab of the window this wallet surface is attached to. */
    const readActiveTab = React.useCallback(async () => {
        try {
            // `lastFocusedWindow` rather than `currentWindow`: a side panel is not itself a
            // browser window, and the panel's idea of "current" is not reliably the window
            // the user is looking at.
            const tabs = await chrome?.tabs?.query({ active: true, lastFocusedWindow: true });
            const found = originOf(tabs?.[0]?.url);
            if (found) { setOrigin(found); return; }

            const fallback = await chrome?.tabs?.query({ active: true, currentWindow: true });
            setOrigin(originOf(fallback?.[0]?.url));
        } catch {
            // No tabs API (dev server) — there is no active site to speak of.
            setOrigin(null);
        }
    }, []);

    const readConnection = React.useCallback(async () => {
        if (!origin || !address) { setConnected(false); return; }
        setConnected((await originsGrantedTo(address)).has(origin));
    }, [origin, address]);

    React.useEffect(() => {
        if (!chrome?.tabs) return;
        void readActiveTab();

        const refresh = () => { void readActiveTab(); };
        chrome.tabs.onActivated.addListener(refresh);
        chrome.tabs.onUpdated.addListener(refresh);
        chrome.windows?.onFocusChanged?.addListener(refresh);
        // The panel keeps running while the user works in another window, so it has to
        // re-check when it comes back — no tab event fires for "you were away".
        document.addEventListener("visibilitychange", refresh);

        return () => {
            chrome.tabs.onActivated.removeListener(refresh);
            chrome.tabs.onUpdated.removeListener(refresh);
            chrome.windows?.onFocusChanged?.removeListener(refresh);
            document.removeEventListener("visibilitychange", refresh);
        };
    }, [readActiveTab]);

    React.useEffect(() => {
        void readConnection();

        if (!chrome?.storage?.onChanged) return;
        // Catches a connection made from the approval window while this page was already
        // open — the case the bar previously missed entirely.
        const onChanged = (
            changes: Record<string, unknown>,
            area: string,
        ) => {
            if (area === "local" && PERMISSION_STORAGE_KEY in changes) void readConnection();
        };
        chrome.storage.onChanged.addListener(onChanged);
        return () => chrome.storage.onChanged.removeListener(onChanged);
    }, [readConnection]);

    if (!origin || !connected) return null;

    const label = origin.replace(/^https?:\/\//, "");

    const disconnect = async () => {
        if (!address) return;
        setBusy(true);
        try {
            // Only this account's access, matching what the bar claims. The site may be
            // connected to others, and they are not what the user is looking at.
            await wallet?.sitePermissions?.revokeAccount(origin, address);

            // Revoking the grant is not the same as disconnecting. Without this the page
            // keeps the accounts it was already handed and carries on believing it is
            // connected until it is reloaded — which is exactly how this button looked
            // like it did nothing. The worker is what pushes `accountsChanged: []` to it.
            await chrome?.runtime?.sendMessage({ type: "PERMISSIONS_CHANGED" });

            await readConnection();
        } catch {
            // Re-read rather than assume: a revoke that threw may still have landed, and a
            // bar that hides itself would claim a disconnection that did not happen.
            await readConnection();
        } finally {
            setBusy(false);
        }
    };

    return (
        <Box
            sx={{
                position: "fixed",
                bottom: BOTTOM_OFFSET,
                left: "50%",
                transform: "translateX(-50%)",
                width: "100%",
                maxWidth: 400,
                px: 2,
                zIndex: 999,
                pointerEvents: "none",
            }}
        >
            <Paper
                elevation={0}
                sx={{
                    pointerEvents: "auto",
                    px: 1.25,
                    py: 0.5,
                    borderRadius: "0px",
                    bgcolor: alpha(theme.palette.background.paper, 0.96),
                    border: "1px solid",
                    borderColor: alpha(theme.palette.success.main, 0.35),
                    backdropFilter: "blur(8px)",
                }}
            >
                <Stack direction="row" alignItems="center" gap={1}>
                    <PublicIcon sx={{ fontSize: 15, color: "success.main", flexShrink: 0 }} />
                    <Box sx={{ flex: 1, minWidth: 0 }}>
                        <Typography sx={{ fontSize: "0.72rem", fontWeight: 700 }} noWrap>
                            {label}
                        </Typography>
                        <Typography
                            variant="caption"
                            color="text.secondary"
                            component="div"
                            sx={{ fontSize: "0.62rem", lineHeight: 1.2 }}
                            noWrap
                        >
                            {t("home.activeDappConnected")}
                        </Typography>
                    </Box>
                    <Tooltip title={t("home.connectedDisconnect")}>
                        <span>
                            <IconButton
                                size="small"
                                color="error"
                                disabled={busy}
                                onClick={disconnect}
                                aria-label={`${t("home.connectedDisconnect")}: ${label}`}
                                sx={{ borderRadius: "0px" }}
                            >
                                <LinkOffIcon sx={{ fontSize: 15 }} />
                            </IconButton>
                        </span>
                    </Tooltip>
                </Stack>
            </Paper>
        </Box>
    );
}
