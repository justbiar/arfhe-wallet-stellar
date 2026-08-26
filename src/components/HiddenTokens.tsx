/**
 * HiddenTokens — the tokens this account chose not to see, and the way back.
 *
 * Hiding is done from a token's own page, which makes it easy to hide something and then
 * have no idea where it went. This is that list: what is hidden on the active network,
 * and a way to unhide it.
 *
 * Scoped to the active network because that is how `SpamFilter` stores it — the same
 * contract address on another chain is a different token.
 */

import { useCallback, useContext, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
    Box, Paper, Typography, List, ListItem, ListItemText, Button, Stack, Tooltip, IconButton,
} from "@mui/material";
import { VisibilityOff, Visibility } from "@mui/icons-material";
import { WalletContext } from "../AppContext.js";

export default function HiddenTokens() {
    const { t } = useTranslation();
    const context = useContext(WalletContext);
    const spamFilter = context?.spamFilter;
    const network = context?.networkProvider?.getActiveNetwork();
    const tokenCache = context?.tokenCache;

    const [hidden, setHidden] = useState<string[]>([]);

    const reload = useCallback(() => {
        if (!spamFilter || !network) {
            setHidden([]);
            return;
        }
        setHidden(spamFilter.getHiddenTokens(network.network_id));
    }, [spamFilter, network]);

    useEffect(() => { reload(); }, [reload]);

    const unhide = (address: string) => {
        if (!spamFilter || !network) return;
        spamFilter.unhideToken(network.network_id, address);
        reload();
    };

    const unhideAll = () => {
        if (!spamFilter || !network) return;
        spamFilter.resetHiddenForNetwork(network.network_id);
        reload();
    };

    if (hidden.length === 0) return null;

    return (
        <>
            <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ px: 1, mb: 1 }}>
                <Typography variant="h6" fontWeight={700}>
                    {t("hiddenTokens.title")}
                </Typography>
                {hidden.length > 1 && (
                    <Button size="small" onClick={unhideAll} sx={{ fontWeight: 700, fontSize: "0.72rem" }}>
                        {t("hiddenTokens.showAll")}
                    </Button>
                )}
            </Stack>

            <Paper
                elevation={0}
                sx={{ borderRadius: 4, overflow: "hidden", mb: 3, bgcolor: "background.paper", border: "1px solid", borderColor: "divider" }}
            >
                <Box sx={{ px: 2, pt: 1.5 }}>
                    <Typography variant="caption" color="text.secondary">
                        {t("hiddenTokens.scope", { network: network?.network_name ?? "" })}
                    </Typography>
                </Box>
                <List disablePadding>
                    {hidden.map((address) => {
                        const meta = network ? tokenCache?.getToken(network.network_id, address) : undefined;
                        return (
                            <ListItem
                                key={address}
                                divider
                                secondaryAction={
                                    <Tooltip title={t("hiddenTokens.show")}>
                                        <IconButton edge="end" aria-label={t("hiddenTokens.show")} onClick={() => unhide(address)}>
                                            <Visibility />
                                        </IconButton>
                                    </Tooltip>
                                }
                            >
                                <VisibilityOff sx={{ mr: 2, color: "text.disabled" }} />
                                <ListItemText
                                    primary={
                                        <Typography variant="body2" fontWeight={700}>
                                            {meta?.symbol || t("hiddenTokens.unknown")}
                                        </Typography>
                                    }
                                    secondary={
                                        <Typography variant="caption" color="text.secondary" sx={{ fontFamily: "monospace" }}>
                                            {`${address.slice(0, 8)}…${address.slice(-6)}`}
                                        </Typography>
                                    }
                                />
                            </ListItem>
                        );
                    })}
                </List>
            </Paper>
        </>
    );
}
