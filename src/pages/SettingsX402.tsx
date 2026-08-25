/**
 * SettingsX402 — user controls for automatic x402 micro-payments (Faz 3).
 *
 * Same shape as SettingsNotifications.tsx: loads X402SettingsService's preferences, autosaves
 * every change (no separate "Save" button), disables the sub-controls while the master switch
 * is off. The two numeric fields (per-payment cap, daily budget) keep their own local string
 * state rather than being bound directly to the stored number — X402SettingsService clamps on
 * save, and re-deriving the displayed string from the clamped value on every keystroke would
 * fight the user mid-typing (e.g. typing "0.05" would collapse to "0" the instant "0." parses
 * to 0). The clamp is applied — and reflected back into the field — only on blur/save, not on
 * every keystroke.
 */

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import {
    Box, Container, Stack, Typography, IconButton, Paper, List, ListItem,
    ListItemText, ListItemIcon, Switch, Divider, TextField, CircularProgress, InputAdornment,
} from "@mui/material";
import { ArrowBack, Bolt, Payments, CalendarMonth } from "@mui/icons-material";
import { X402SettingsService, type X402Settings } from "../backend/X402SettingsService.js";
import { X402_ABSOLUTE_CAPS } from "../backend/AgentPolicyEngine.js";

function formatUsd(amount: number): string {
    return `$${amount.toFixed(2)}`;
}

/** Digits with at most one decimal point — "", "0", "0.", "0.05" all match; "0.0.5", "abc" don't. */
const DECIMAL_INPUT_PATTERN = /^\d*\.?\d*$/;

/**
 * A native `type="number"` input sharing its flex row with both a startAdornment ("$") and
 * Chromium's own spin-button box, inside the ~120px width these fields use, renders correctly
 * (DOM `value` is right, confirmed via DevTools) but the browser can collapse the number input's
 * own text layer to near-zero visible width — the field then LOOKS empty (just the adornment
 * and a caret) even though it isn't. `type="text"` with `inputMode="decimal"` sidesteps that
 * rendering path entirely (no native spinner, no number-specific layout) while still bringing up
 * the numeric keyboard on mobile; DECIMAL_INPUT_PATTERN below does the digit-filtering the native
 * `type="number"` used to do for free.
 */
function isValidDecimalInput(value: string): boolean {
    return DECIMAL_INPUT_PATTERN.test(value);
}

export default function SettingsX402() {
    const { t } = useTranslation();
    const navigate = useNavigate();

    const [settings, setSettings] = useState<X402Settings | null>(null);
    const [perTxInput, setPerTxInput] = useState("");
    const [dailyBudgetInput, setDailyBudgetInput] = useState("");

    useEffect(() => {
        let cancelled = false;
        (async () => {
            const loaded = await X402SettingsService.getSettings();
            if (cancelled) return;
            setSettings(loaded);
            setPerTxInput(String(loaded.perTransactionCapUsd));
            setDailyBudgetInput(String(loaded.dailyBudgetCapUsd));
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    /**
     * Monotonic counter guarding against out-of-order persist() resolution: onBlur on either
     * numeric field, or the enable toggle, can each independently kick off an async
     * X402SettingsService.saveSettings() call, and nothing serializes them — a user editing
     * perTxInput then quickly editing it again (or toggling enabled mid-edit) can have TWO
     * saveSettings() calls in flight at once. Without this guard, whichever call's chrome.storage
     * round-trip happens to resolve LAST wins and overwrites local input state, even if it was
     * dispatched FIRST — so a slower-resolving stale write can clobber a newer, already-visible
     * value the user just typed (observed: setting a field to "0" then having it silently revert
     * to an earlier in-flight value once that older write finally resolved).
     */
    const persistRequestId = useRef(0);

    /** Which local input state (if any) to resync from the clamped result — see persist()'s own docs. */
    type PersistTarget = "enabled" | "perTx" | "dailyBudget";

    const persist = async (next: X402Settings, target: PersistTarget) => {
        const requestId = ++persistRequestId.current;
        const clamped = await X402SettingsService.saveSettings(next);
        // A newer persist() call has started since this one was dispatched — this result is
        // stale (whatever the newer call's own resolution says, or will say, wins instead).
        if (requestId !== persistRequestId.current) return;
        setSettings(clamped);
        // Only resync the field this specific commit was actually for — never the other one,
        // which may be mid-edit right now and must not be stomped by an unrelated commit.
        if (target === "perTx") setPerTxInput(String(clamped.perTransactionCapUsd));
        if (target === "dailyBudget") setDailyBudgetInput(String(clamped.dailyBudgetCapUsd));
    };

    const toggleEnabled = (enabled: boolean) => {
        if (!settings) return;
        void persist({ ...settings, enabled }, "enabled");
    };

    const commitPerTx = () => {
        if (!settings) return;
        void persist({ ...settings, perTransactionCapUsd: Number.parseFloat(perTxInput) }, "perTx");
    };

    const commitDailyBudget = () => {
        if (!settings) return;
        void persist({ ...settings, dailyBudgetCapUsd: Number.parseFloat(dailyBudgetInput) }, "dailyBudget");
    };

    if (!settings) {
        return (
            <Box sx={{ display: "flex", justifyContent: "center", py: 8 }}>
                <CircularProgress size={28} />
            </Box>
        );
    }

    const disabled = !settings.enabled;

    return (
        <Box sx={{ pb: 10 }}>
            <Container maxWidth="md" sx={{ py: 4 }}>
                <Stack direction="row" alignItems="center" spacing={2} sx={{ mb: 4 }}>
                    <IconButton onClick={() => navigate("/settings")} aria-label={t("common.back")}>
                        <ArrowBack />
                    </IconButton>
                    <Typography variant="h4" fontWeight={800}>
                        {t("x402.title")}
                    </Typography>
                </Stack>

                <Paper
                    elevation={0}
                    sx={{ borderRadius: 4, overflow: "hidden", mb: 3, bgcolor: "background.paper", border: "1px solid", borderColor: "divider" }}
                >
                    <List disablePadding>
                        <ListItem>
                            <ListItemIcon><Bolt /></ListItemIcon>
                            <ListItemText primary={t("x402.enable")} secondary={t("x402.enableDesc")} />
                            <Switch
                                checked={settings.enabled}
                                onChange={(e) => toggleEnabled(e.target.checked)}
                                slotProps={{ input: { "aria-label": t("x402.enable") } }}
                            />
                        </ListItem>

                        <Divider />

                        <ListItem>
                            <ListItemIcon><Payments /></ListItemIcon>
                            <ListItemText primary={t("x402.perTransactionCap")} secondary={t("x402.perTransactionCapDesc")} />
                            <TextField
                                size="small"
                                type="text"
                                disabled={disabled}
                                value={perTxInput}
                                onChange={(e) => isValidDecimalInput(e.target.value) && setPerTxInput(e.target.value)}
                                onBlur={commitPerTx}
                                onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                                slotProps={{
                                    input: {
                                        startAdornment: <InputAdornment position="start">$</InputAdornment>,
                                    },
                                    htmlInput: { inputMode: "decimal", "aria-label": t("x402.perTransactionCap") },
                                }}
                                sx={{
                                    width: 150,
                                    ml: 2,
                                    "& .MuiInputBase-input": { fontSize: 13 },
                                    "& .MuiInputAdornment-root .MuiTypography-root": { fontSize: 13 },
                                }}
                            />
                        </ListItem>

                        <ListItem>
                            <ListItemIcon><CalendarMonth /></ListItemIcon>
                            <ListItemText primary={t("x402.dailyBudget")} secondary={t("x402.dailyBudgetDesc")} />
                            <TextField
                                size="small"
                                type="text"
                                disabled={disabled}
                                value={dailyBudgetInput}
                                onChange={(e) => isValidDecimalInput(e.target.value) && setDailyBudgetInput(e.target.value)}
                                onBlur={commitDailyBudget}
                                onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                                slotProps={{
                                    input: {
                                        startAdornment: <InputAdornment position="start">$</InputAdornment>,
                                    },
                                    htmlInput: { inputMode: "decimal", "aria-label": t("x402.dailyBudget") },
                                }}
                                sx={{
                                    width: 150,
                                    ml: 2,
                                    "& .MuiInputBase-input": { fontSize: 13 },
                                    "& .MuiInputAdornment-root .MuiTypography-root": { fontSize: 13 },
                                }}
                            />
                        </ListItem>
                    </List>
                </Paper>

                <Typography variant="caption" color="text.secondary" sx={{ display: "block", px: 1 }}>
                    {t("x402.absoluteCapNotice", {
                        perTransactionCap: formatUsd(X402_ABSOLUTE_CAPS.maxPerTransactionUsd),
                        dailyBudget: formatUsd(X402_ABSOLUTE_CAPS.maxDailyBudgetUsd),
                    })}
                </Typography>
            </Container>
        </Box>
    );
}
