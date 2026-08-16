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

import { useContext, useEffect, useState } from "react";
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

    const persist = async (next: X402Settings) => {
        const clamped = await X402SettingsService.saveSettings(next);
        setSettings(clamped);
        setPerTxInput(String(clamped.perTransactionCapUsd));
        setDailyBudgetInput(String(clamped.dailyBudgetCapUsd));
    };

    const toggleEnabled = (enabled: boolean) => {
        if (!settings) return;
        void persist({ ...settings, enabled });
    };

    const commitPerTx = () => {
        if (!settings) return;
        void persist({ ...settings, perTransactionCapUsd: Number.parseFloat(perTxInput) });
    };

    const commitDailyBudget = () => {
        if (!settings) return;
        void persist({ ...settings, dailyBudgetCapUsd: Number.parseFloat(dailyBudgetInput) });
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
                                type="number"
                                disabled={disabled}
                                value={perTxInput}
                                onChange={(e) => setPerTxInput(e.target.value)}
                                onBlur={commitPerTx}
                                onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                                slotProps={{
                                    input: {
                                        startAdornment: <InputAdornment position="start">$</InputAdornment>,
                                    },
                                    htmlInput: { min: 0, step: 0.01, "aria-label": t("x402.perTransactionCap") },
                                }}
                                sx={{ width: 120, ml: 2 }}
                            />
                        </ListItem>

                        <ListItem>
                            <ListItemIcon><CalendarMonth /></ListItemIcon>
                            <ListItemText primary={t("x402.dailyBudget")} secondary={t("x402.dailyBudgetDesc")} />
                            <TextField
                                size="small"
                                type="number"
                                disabled={disabled}
                                value={dailyBudgetInput}
                                onChange={(e) => setDailyBudgetInput(e.target.value)}
                                onBlur={commitDailyBudget}
                                onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                                slotProps={{
                                    input: {
                                        startAdornment: <InputAdornment position="start">$</InputAdornment>,
                                    },
                                    htmlInput: { min: 0, step: 0.01, "aria-label": t("x402.dailyBudget") },
                                }}
                                sx={{ width: 120, ml: 2 }}
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
