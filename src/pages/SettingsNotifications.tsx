/**
 * SettingsNotifications — controls for the alerts the wallet raises.
 *
 * `NotificationService` has carried these preferences all along and every notification
 * path already honours them; there was simply no screen to change them, and the Settings
 * entry that looked like it opened one did nothing.
 *
 * There is no price-alert toggle. Market movement is not the wallet's business, and a
 * notification stream that mixes it with "your transfer confirmed" and "funds arrived"
 * trains people to dismiss the whole channel — including the two that matter.
 */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import {
    Box, Container, Stack, Typography, IconButton, Paper, List, ListItem,
    ListItemText, ListItemIcon, Switch, Divider, Button, CircularProgress,
} from "@mui/material";
import {
    ArrowBack, NotificationsActive, CallReceived, CheckCircleOutline,
    WarningAmber, VolumeUp, DeleteSweep,
} from "@mui/icons-material";
import { NotificationService, type NotificationPreferences } from "../backend/NotificationService.js";
import { useToast } from "../components/ToastProvider";

/** Ask the service worker to change background behaviour. */
function tellWorker(message: Record<string, unknown>) {
    try {
        const runtime = (window as unknown as { chrome?: { runtime?: { id?: string; sendMessage?: typeof chrome.runtime.sendMessage } } }).chrome?.runtime;
        runtime?.sendMessage?.(message);
    } catch {
        // Worker restarting; the stored preference is still authoritative.
    }
}

export default function SettingsNotifications() {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const { showToast } = useToast();

    const [prefs, setPrefs] = useState<NotificationPreferences | null>(null);
    const [clearing, setClearing] = useState(false);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            const loaded = await NotificationService.getPreferences();
            if (!cancelled) setPrefs(loaded);
        })();
        return () => { cancelled = true; };
    }, []);

    const update = async (patch: Partial<NotificationPreferences>) => {
        if (!prefs) return;
        const next = { ...prefs, ...patch };
        setPrefs(next);
        await NotificationService.savePreferences(next);
    };

    const clearHistory = async () => {
        setClearing(true);
        try {
            await NotificationService.clearAll();
            tellWorker({ type: "CLEAR_BADGE" });
            showToast(t("notifications.cleared"), "success");
        } finally {
            setClearing(false);
        }
    };

    if (!prefs) {
        return (
            <Box sx={{ display: "flex", justifyContent: "center", py: 8 }}>
                <CircularProgress size={28} />
            </Box>
        );
    }

    // Everything below is a sub-setting of the master switch; showing them as operable
    // while notifications are off would promise behaviour that cannot happen.
    const disabled = !prefs.enabled;

    return (
        <Box sx={{ pb: 10 }}>
            <Container maxWidth="md" sx={{ py: 4 }}>
                <Stack direction="row" alignItems="center" spacing={2} sx={{ mb: 4 }}>
                    <IconButton onClick={() => navigate("/settings")} aria-label={t("common.back")}>
                        <ArrowBack />
                    </IconButton>
                    <Typography variant="h4" fontWeight={800}>
                        {t("notifications.title")}
                    </Typography>
                </Stack>

                <Paper
                    elevation={0}
                    sx={{ borderRadius: 4, overflow: "hidden", mb: 3, bgcolor: "background.paper", border: "1px solid", borderColor: "divider" }}
                >
                    <List disablePadding>
                        <ListItem>
                            <ListItemIcon><NotificationsActive /></ListItemIcon>
                            <ListItemText
                                primary={t("notifications.enable")}
                                secondary={t("notifications.enableDesc")}
                            />
                            <Switch
                                checked={prefs.enabled}
                                onChange={(e) => update({ enabled: e.target.checked })}
                            />
                        </ListItem>

                        <Divider />

                        <ListItem>
                            <ListItemIcon><CallReceived /></ListItemIcon>
                            <ListItemText
                                primary={t("notifications.incoming")}
                                secondary={t("notifications.incomingDesc")}
                            />
                            <Switch
                                disabled={disabled}
                                checked={prefs.incomingTx}
                                onChange={(e) => update({ incomingTx: e.target.checked })}
                            />
                        </ListItem>

                        <ListItem>
                            <ListItemIcon><CheckCircleOutline /></ListItemIcon>
                            <ListItemText
                                primary={t("notifications.confirmations")}
                                secondary={t("notifications.confirmationsDesc")}
                            />
                            <Switch
                                disabled={disabled}
                                checked={prefs.txConfirmation}
                                onChange={(e) => update({ txConfirmation: e.target.checked })}
                            />
                        </ListItem>

                        <ListItem>
                            <ListItemIcon><WarningAmber /></ListItemIcon>
                            <ListItemText
                                primary={t("notifications.approvalWarnings")}
                                secondary={t("notifications.approvalWarningsDesc")}
                            />
                            <Switch
                                disabled={disabled}
                                checked={prefs.approvalWarnings}
                                onChange={(e) => update({ approvalWarnings: e.target.checked })}
                            />
                        </ListItem>

                        <ListItem>
                            <ListItemIcon><VolumeUp /></ListItemIcon>
                            <ListItemText
                                primary={t("notifications.sound")}
                                secondary={t("notifications.soundDesc")}
                            />
                            <Switch
                                disabled={disabled}
                                checked={prefs.sound}
                                onChange={(e) => update({ sound: e.target.checked })}
                            />
                        </ListItem>
                    </List>
                </Paper>

                <Button
                    fullWidth
                    color="error"
                    variant="outlined"
                    startIcon={clearing ? <CircularProgress size={16} color="inherit" /> : <DeleteSweep />}
                    onClick={clearHistory}
                    disabled={clearing}
                    sx={{ borderRadius: 3, py: 1.2, fontWeight: 700 }}
                >
                    {t("notifications.clearHistory")}
                </Button>
            </Container>
        </Box>
    );
}
