import * as React from 'react';

/**
 * The extension version, baked in at build time from `extension/manifest.json`.
 *
 * Not read from `chrome.runtime.getManifest()`: that reports whatever manifest Chrome has
 * loaded, so a rebuild that has not been reloaded keeps showing the old number, and the
 * dev server has no runtime at all. This value belongs to the build itself.
 */
declare const __APP_VERSION__: string;
const APP_VERSION: string = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev";
import { useContext, useState } from 'react';
import { useNavigate } from 'react-router';
import { Box, Typography, Container, Paper, List, ListItem, ListItemButton, ListItemText, ListItemIcon, Switch, Chip, IconButton, alpha, useTheme, Stack, Divider, Dialog, DialogTitle, DialogContent, DialogActions, TextField, Button, CircularProgress } from '@mui/material';
import { Notifications, DarkMode, Language, Security, Lock, Wifi, ChevronRight, Check, Close, Fingerprint, PrivacyTip, Gavel, Info, OpenInNew, ManageAccounts, ViewSidebar , PublicOutlined, AccountBalanceOutlined } from '@mui/icons-material';
import { ColorModeContext } from '../ThemeContext';
import { WalletContext } from '../AppContext';
import { CustomNetworkConfig } from '../backend/NetworkTypes';
import { useToast } from '../components/ToastProvider';
import { useTranslation } from 'react-i18next';
import { LANGUAGES, changeLanguage } from '../i18n';
import { BiometricService } from '../backend/BiometricService';
import { getDisplaySurface, setDisplaySurface, displaySurfaceSupported, openSidePanelNow, panelTarget, currentSurface, type PanelTarget, DEFAULT_DISPLAY_SURFACE, type DisplaySurface } from '../backend/DisplaySurfaceService';

export default function Settings() {
    const navigate = useNavigate();
    const { mode, toggleColorMode } = useContext(ColorModeContext);
    const walletContext = useContext(WalletContext);
    const { showToast } = useToast();
    const theme = useTheme();
    const { t, i18n } = useTranslation();

    /** Just the count for the row's badge — the list itself lives on its own screen. */
    const networkCount = walletContext?.networkProvider?.listAllNetworks().length ?? 0;
    const [langDialogOpen, setLangDialogOpen] = useState(false);
    const [biometricSupported, setBiometricSupported] = useState(false);
    const [biometricEnabled, setBiometricEnabled] = useState(BiometricService.isEnabled());
    const [biometricPasswordDialogOpen, setBiometricPasswordDialogOpen] = useState(false);
    const [biometricPassword, setBiometricPassword] = useState("");
    const [biometricLoading, setBiometricLoading] = useState(false);

    const currentLang = LANGUAGES.find(l => l.code === i18n.language) || LANGUAGES[0];

    // Only offered where it can be honoured: on the dev server there is no toolbar button
    // to change, and a switch that silently does nothing is worse than no switch.
    const surfaceSupported = displaySurfaceSupported();
    const [surface, setSurface] = useState<DisplaySurface>(DEFAULT_DISPLAY_SURFACE);

    /**
     * Held ready so the click handler can open the panel without awaiting anything first.
     *
     * `sidePanel.open()` only works inside a live user gesture, and an `await` ends one —
     * so the target cannot be looked up at the moment it is needed.
     */
    const panelTargetRef = React.useRef<PanelTarget>({ tabId: null, windowId: null });

    React.useEffect(() => {
        if (!surfaceSupported) return;
        let active = true;
        getDisplaySurface().then((value) => { if (active) setSurface(value); });
        panelTarget().then((target) => { if (active) panelTargetRef.current = target; });
        return () => { active = false; };
    }, [surfaceSupported]);

    const handleSurfaceToggle = async () => {
        const next: DisplaySurface = surface === 'sidepanel' ? 'popup' : 'sidepanel';

        // First statement in the handler, deliberately. The gesture that opened this
        // handler is what permits the call, and it does not survive the awaits below — nor
        // does it survive being forwarded to the worker, which is why the worker cannot
        // make this call on our behalf. Not awaited: doing so would not help, and a
        // rejection here is not a reason to abandon the preference change.
        //
        // A rejection is worth saying out loud, though. The preference still applied, so
        // the toolbar button works — but the user asked to be moved and was not, and
        // silence there is what made this look broken rather than merely incomplete.
        let panelOpening: Promise<void> | null = null;
        if (next === 'sidepanel') {
            const call = openSidePanelNow(panelTargetRef.current);
            panelOpening = call
                ? call
                      .then(() => {
                          // The panel is up; this popup is now a second copy of the same
                          // wallet sitting beside it. Only closed once the panel has
                          // actually opened — closing first and failing to open would
                          // leave the user with nothing.
                          //
                          // Nothing runs after this: the document is gone.
                          if (currentSurface() === 'popup') window.close();
                      })
                      .catch((e: unknown) => {
                          const reason = e instanceof Error ? e.message : String(e);
                          showToast(`${t('settings.displaySurfacePanelManual')} (${reason})`, 'info');
                      })
                : Promise.resolve(showToast(t('settings.displaySurfacePanelManual'), 'info'));
        }
        // Written first, shown second — if the write fails the switch stays where it was
        // rather than claiming a change the toolbar button will not make.
        const saved = await setDisplaySurface(next);
        if (!saved.ok) {
            // The worker's own words, not a generic failure: the switch not taking is a
            // Chrome API refusing something, and which one it was is the whole diagnosis.
            showToast(
                saved.error
                    ? `${t('settings.displaySurfaceFailed')} (${saved.error})`
                    : t('settings.displaySurfaceFailed'),
                'error',
            );
            return;
        }
        setSurface(next);

        // The panel either opened or explained why it could not; a second, cheerier toast
        // on top of that would only bury it.
        if (panelOpening) return;
        showToast(t('settings.displaySurfacePopupSet'), 'success');
    };

    // Check biometric support on mount
    React.useEffect(() => {
        (async () => {
            const supported = await BiometricService.isBiometricAvailable();
            setBiometricSupported(supported);
        })();
    }, []);

    const handleBiometricToggle = async () => {
        if (biometricEnabled) {
            // Disable biometric
            BiometricService.clearBiometric();
            setBiometricEnabled(false);
            showToast(t('security.biometricDisabled'), "info");
        } else {
            // Enable biometric — need password to register
            setBiometricPasswordDialogOpen(true);
        }
    };

    const handleBiometricRegister = async () => {
        if (!biometricPassword) return;
        setBiometricLoading(true);
        try {
            const ok = await BiometricService.registerBiometric(biometricPassword);
            if (ok) {
                setBiometricEnabled(true);
                showToast(t('security.biometricRegistered'), "success");
                setBiometricPasswordDialogOpen(false);
                setBiometricPassword("");
            } else {
                showToast(t('security.biometricNotSupported'), "error");
            }
        } catch (err) {
            showToast((err instanceof Error ? err.message : String(err)) || t('security.biometricNotSupported'), "error");
        } finally {
            setBiometricLoading(false);
        }
    };

    return (
        <Box sx={{ pb: 4 }}>
            <Container maxWidth="md" sx={{ py: 2 }}>
                <Typography variant="h4" fontWeight={800} gutterBottom>
                    {t('settings.title')}
                </Typography>

                <Paper elevation={0} sx={{ borderRadius: 4, overflow: 'hidden', mb: 2, border: '1px solid rgba(0,0,0,0.05)' }}>
                    <List>
                        <ListItem>
                            <ListItemIcon><DarkMode /></ListItemIcon>
                            <ListItemText primary={t('settings.darkMode')} secondary={t('settings.toggleTheme')} />
                            <Switch checked={mode === 'dark'} onChange={toggleColorMode} />
                        </ListItem>
                        {surfaceSupported && (
                            <ListItem>
                                <ListItemIcon><ViewSidebar /></ListItemIcon>
                                <ListItemText
                                    primary={t('settings.displaySurface')}
                                    secondary={surface === 'sidepanel' ? t('settings.displaySurfacePanelDesc') : t('settings.displaySurfacePopupDesc')}
                                />
                                <Switch
                                    checked={surface === 'sidepanel'}
                                    onChange={handleSurfaceToggle}
                                    inputProps={{ 'aria-label': t('settings.displaySurface') }}
                                />
                            </ListItem>
                        )}
                        <ListItemButton onClick={() => navigate('/settings/notifications')}>
                            <ListItemIcon><Notifications /></ListItemIcon>
                            <ListItemText primary={t('settings.notifications')} secondary={t('settings.manageAlerts')} />
                        </ListItemButton>
                        <ListItemButton onClick={() => setLangDialogOpen(true)}>
                            <ListItemIcon><Language /></ListItemIcon>
                            <ListItemText primary={t('settings.language')} secondary={`${currentLang.flag} ${currentLang.label}`} />
                        </ListItemButton>
                        <ListItemButton onClick={() => navigate('/settings/security')}>
                            <ListItemIcon><Security /></ListItemIcon>
                            <ListItemText primary={t('settings.security')} secondary={t('settings.keysPermissions')} />
                        </ListItemButton>
                        <ListItemButton onClick={() => navigate('/settings/accounts')}>
                            <ListItemIcon><ManageAccounts /></ListItemIcon>
                            <ListItemText primary={t('settings.accounts')} secondary={t('settings.accountsDesc')} />
                        </ListItemButton>
                        {biometricSupported && (
                            <ListItem>
                                <ListItemIcon><Fingerprint /></ListItemIcon>
                                <ListItemText primary={t('security.biometric')} secondary={t('security.enableBiometric')} />
                                <Switch checked={biometricEnabled} onChange={handleBiometricToggle} />
                            </ListItem>
                        )}
                        <ListItemButton onClick={() => {
                            walletContext?.storageManager?.lock();
                            navigate('/auth');
                        }}>
                            <ListItemIcon><Lock /></ListItemIcon>
                            <ListItemText primary={t('settings.lockWallet')} secondary={t('settings.secureLogout')} />
                        </ListItemButton>
                    </List>
                </Paper>

                {/* Networks now have their own screen: the list grows with whatever the
                    user adds, and each row carries an editable endpoint. Left inline it
                    buried the rest of Settings under it. */}
                <Paper
                    elevation={0}
                    sx={{ borderRadius: 4, overflow: 'hidden', mb: 2, border: '1px solid rgba(0,0,0,0.05)' }}
                >
                    <List disablePadding>
                        <ListItemButton onClick={() => navigate('/settings/networks')}>
                            <ListItemIcon><Wifi /></ListItemIcon>
                            <ListItemText
                                primary={t('network.allNetworks')}
                                secondary={t('network.allNetworksDesc')}
                            />
                            <Chip
                                label={networkCount}
                                size="small"
                                variant="outlined"
                                sx={{ height: 20, fontSize: 11, fontWeight: 700, mr: 1 }}
                            />
                            <ChevronRight sx={{ fontSize: 18, color: 'text.disabled' }} />
                        </ListItemButton>

                        {/* Stellar sits beside the network list rather than inside it: it is
                            not an EVM chain, and a switcher entry would promise a switch that
                            most of the wallet cannot honour. */}
                        <ListItemButton onClick={() => navigate('/settings/stellar')}>
                            <ListItemIcon><PublicOutlined /></ListItemIcon>
                            <ListItemText
                                primary={t('stellar.title')}
                                secondary={t('stellar.settingsDesc')}
                            />
                            <ChevronRight sx={{ fontSize: 18, color: 'text.disabled' }} />
                        </ListItemButton>

                        {/* The lira side of the same Stellar account: deposit instructions
                            from the anchor, and the trustline a deposit waits on. */}
                        <ListItemButton onClick={() => navigate('/bank')}>
                            <ListItemIcon><AccountBalanceOutlined /></ListItemIcon>
                            <ListItemText
                                primary={t('bank.title')}
                                secondary={t('bank.settingsDesc')}
                            />
                            <ChevronRight sx={{ fontSize: 18, color: 'text.disabled' }} />
                        </ListItemButton>
                    </List>
                </Paper>

                {/* Legal Section */}
                <Typography variant="h6" fontWeight={700} sx={{ mb: 1.5, mt: 2.5 }}>
                    {t('settings.legal')}
                </Typography>

                <Paper
                    elevation={0}
                    sx={{
                        borderRadius: 4,
                        overflow: 'hidden',
                        mb: 1.5,
                        border: '1px solid',
                        borderColor: alpha(theme.palette.divider, 0.5),
                    }}
                >
                    <List disablePadding>
                        <ListItemButton
                            onClick={() => window.open('https://www.arfhewallet.dev/privacy', '_blank', 'noopener,noreferrer')}
                        >
                            <ListItemIcon><PrivacyTip /></ListItemIcon>
                            <ListItemText
                                primary={t('settings.privacyPolicy')}
                                secondary={t('settings.privacyPolicyDesc')}
                            />
                            <OpenInNew sx={{ fontSize: 18, color: 'text.disabled' }} />
                        </ListItemButton>
                        <Divider variant="inset" component="li" />
                        <ListItemButton
                            onClick={() => window.open('https://www.arfhewallet.dev/terms', '_blank', 'noopener,noreferrer')}
                        >
                            <ListItemIcon><Gavel /></ListItemIcon>
                            <ListItemText
                                primary={t('settings.termsOfService')}
                                secondary={t('settings.termsOfServiceDesc')}
                            />
                            <OpenInNew sx={{ fontSize: 18, color: 'text.disabled' }} />
                        </ListItemButton>
                    </List>
                </Paper>

                {/* Version info */}
                <Box sx={{ textAlign: 'center', mt: 2.5, mb: 1.5 }}>
                    <Typography variant="caption" color="text.disabled">
                        Arfhe Wallet {t('settings.version')} {APP_VERSION}
                    </Typography>
                </Box>

            </Container>


            {/* Language Selector Dialog */}
            <Dialog open={langDialogOpen} onClose={() => setLangDialogOpen(false)} maxWidth="xs" fullWidth aria-labelledby="lang-dialog-title" PaperProps={{ sx: { borderRadius: 3 } }}>
                <DialogTitle id="lang-dialog-title" sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid', borderColor: 'divider' }}>
                    <Typography fontWeight={700}>{t('settings.selectLanguage')}</Typography>
                    <IconButton onClick={() => setLangDialogOpen(false)} size="small" aria-label="Close language selector"><Close /></IconButton>
                </DialogTitle>
                <DialogContent sx={{ p: 0 }}>
                    <List>
                        {LANGUAGES.map(lang => (
                            <ListItemButton
                                key={lang.code}
                                selected={i18n.language === lang.code}
                                onClick={() => {
                                    changeLanguage(lang.code);
                                    setLangDialogOpen(false);
                                }}
                                sx={{ py: 1.5 }}
                            >
                                <Typography sx={{ mr: 1.5, fontSize: '1.3rem' }}>{lang.flag}</Typography>
                                <ListItemText
                                    primary={lang.label}
                                    primaryTypographyProps={{ fontWeight: i18n.language === lang.code ? 700 : 400 }}
                                />
                                {i18n.language === lang.code && <Check color="primary" />}
                            </ListItemButton>
                        ))}
                    </List>
                </DialogContent>
            </Dialog>

            {/* Biometric Password Dialog */}
            <Dialog
                open={biometricPasswordDialogOpen}
                onClose={() => { setBiometricPasswordDialogOpen(false); setBiometricPassword(""); }}
                maxWidth="xs"
                fullWidth
                aria-labelledby="biometric-dialog-title"
                PaperProps={{ sx: { borderRadius: 3 } }}
            >
                <DialogTitle id="biometric-dialog-title" sx={{ display: 'flex', alignItems: 'center', gap: 1, borderBottom: '1px solid', borderColor: 'divider' }}>
                    <Fingerprint color="primary" />
                    <Typography fontWeight={700}>{t('security.biometric')}</Typography>
                </DialogTitle>
                <DialogContent sx={{ pt: 3 }}>
                    <Typography variant="body2" color="text.primary" sx={{ mb: 2, mt: 1, opacity: 0.7 }}>
                        {t('security.biometricEnablePrompt')}
                    </Typography>
                    <TextField
                        label={t('auth.password')}
                        type="password"
                        fullWidth
                        value={biometricPassword}
                        onChange={(e) => setBiometricPassword(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && handleBiometricRegister()}
                        sx={{ '& .MuiOutlinedInput-root': { borderRadius: 2 } }}
                    />
                </DialogContent>
                <DialogActions sx={{ px: 3, pb: 2 }}>
                    <Button
                        onClick={() => { setBiometricPasswordDialogOpen(false); setBiometricPassword(""); }}
                        color="inherit"
                    >
                        {t('common.cancel')}
                    </Button>
                    <Button
                        variant="contained"
                        onClick={handleBiometricRegister}
                        disabled={biometricLoading || !biometricPassword}
                        sx={{ borderRadius: 2, minWidth: 100 }}
                    >
                        {biometricLoading ? <CircularProgress size={20} color="inherit" /> : t('common.save')}
                    </Button>
                </DialogActions>
            </Dialog>
        </Box>
    );
}
