import * as React from "react";
import { Typography, Box, Button, Grid, Alert, Stack, TextField, Paper, Container, IconButton, InputAdornment, CircularProgress, LinearProgress, Dialog, DialogTitle, DialogContent, DialogActions } from "@mui/material";
import { AppContext, WalletContext } from "../AppContext.js";
import { useNavigate } from "react-router";
import { Visibility, VisibilityOff, Google, Lock, Fingerprint } from "@mui/icons-material";
import { Mnemonic } from "ethers";
import { useTranslation } from 'react-i18next';
import i18n from '../i18n';
import { BiometricService } from '../backend/BiometricService';
import type AccountManager from '../backend/AccountManager';
import type StorageManager from '../backend/StorageManager';

// --- Web3Auth Imports ---
import { Web3Auth } from "@web3auth/modal";
import { CHAIN_NAMESPACES, WEB3AUTH_NETWORK } from "@web3auth/base";
import { EthereumPrivateKeyProvider } from "@web3auth/ethereum-provider";

/**
 * Web3Auth project this build talks to.
 *
 * Deliberately no fallback. It used to default to Web3Auth's public testing client id,
 * which made a misconfigured build *look* like it worked: social login completed against a
 * shared demo project instead of ours. Since the derived key is scoped to the client id,
 * every account created that way lives at a different address than the same user would get
 * from a correct build — a silent fork of everyone's wallet, discovered far too late.
 *
 * An empty value now disables the button and says why.
 */
const clientId = import.meta.env.VITE_WEB3AUTH_CLIENT_ID ?? "";

/**
 * Whether this document is the browser-action popup rather than a tab or window.
 *
 * `chrome.tabs.getCurrent()` resolves to a tab in anything that *is* a tab — including a
 * `windows.create({type:"popup"})` window, whose content is a tab — and to `undefined` in
 * the action popup, which is not one. That is the distinction that matters here, and it
 * needs no extra permission.
 */
async function isActionPopup(): Promise<boolean> {
  try {
    const tabs = (globalThis as { chrome?: typeof chrome }).chrome?.tabs;
    if (!tabs?.getCurrent) return false;
    return !(await tabs.getCurrent());
  } catch {
    // Not an extension context at all (dev server) — treat as a normal page.
    return false;
  }
}

/**
 * Re-open the wallet in its own window so an OAuth flow can survive.
 *
 * The action popup is destroyed by Chrome the moment it loses focus, and Web3Auth's login
 * opens a window of its own — so the popup died mid-`await`, the resolved private key was
 * never imported, and the user was left staring at a closed wallet. Clicking again
 * appeared to fix it only because Web3Auth had cached the session by then and resolved
 * before focus moved.
 *
 * A window created here is an ordinary window: it keeps running while the OAuth window is
 * in front, so the flow completes where it started.
 */
async function openSocialLoginWindow(): Promise<boolean> {
  try {
    const runtime = (globalThis as { chrome?: typeof chrome }).chrome?.runtime;
    const windows = (globalThis as { chrome?: typeof chrome }).chrome?.windows;
    if (!runtime?.getURL || !windows?.create) return false;

    await windows.create({
      url: runtime.getURL("index.html#/auth?social=1"),
      type: "popup",
      width: 420,
      height: 700,
      focused: true,
    });
    return true;
  } catch {
    return false;
  }
}

/** Calculate password strength 0-100 */
function getPasswordStrength(pw: string): { score: number; label: string; color: string } {
  let score = 0;
  if (pw.length >= 6) score += 15;
  if (pw.length >= 8) score += 15;
  if (pw.length >= 12) score += 10;
  if (/[a-z]/.test(pw)) score += 10;
  if (/[A-Z]/.test(pw)) score += 15;
  if (/[0-9]/.test(pw)) score += 15;
  if (/[^a-zA-Z0-9]/.test(pw)) score += 20;
  score = Math.min(100, score);
  if (score < 30) return { score, label: i18n.t("auth.strengthWeak"), color: "#ef4444" };
  if (score < 60) return { score, label: i18n.t("auth.strengthFair"), color: "#f59e0b" };
  if (score < 80) return { score, label: i18n.t("auth.strengthGood"), color: "#3b82f6" };
  return { score, label: i18n.t("auth.strengthStrong"), color: "#22c55e" };
}

enum AuthStep {
  CHOICE,
  CREATE,
  IMPORT,
  LOGIN,
  SET_PASSWORD
}

interface WalletStepProps {
  accountManager: AccountManager | undefined;
  onDone: () => void;
}

interface PasswordScreenProps {
  storageManager: StorageManager | undefined;
  accountManager: AccountManager | undefined;
  authMethod: 'password' | 'google' | null;
  pendingEmail: string | null;
  onDone: () => void;
}

interface LoginProps {
  storageManager: StorageManager | undefined;
  accountManager: AccountManager | undefined;
}

// --- Steps Components ---

/**
 * Pick `count` distinct word positions to quiz on.
 *
 * Random rather than fixed, so the answer cannot be learned from a screenshot or a
 * walkthrough — the point is to catch someone who did not write the phrase down, and a
 * fixed set of positions is something they could pass without having done so.
 */
function pickQuizPositions(total: number, count = 3): number[] {
  const positions = new Set<number>();
  while (positions.size < Math.min(count, total)) {
    positions.add(Math.floor(Math.random() * total));
  }
  return [...positions].sort((a, b) => a - b);
}

function CreateWallet({ accountManager, onDone }: WalletStepProps) {
  const { t } = useTranslation();
  const [username, setUsername] = React.useState('');
  const [words, setWords] = React.useState<string[]>([]);
  const [isGenerated, setIsGenerated] = React.useState(false);

  // A recovery phrase the user never actually wrote down is the single most common way
  // people lose a wallet permanently — no support channel can undo it. Showing the words
  // and accepting "I saved it" on trust verifies nothing, so the phrase has to be proved
  // back before the flow continues.
  const [isVerifying, setIsVerifying] = React.useState(false);
  const [quizPositions, setQuizPositions] = React.useState<number[]>([]);
  const [answers, setAnswers] = React.useState<Record<number, string>>({});
  const [quizError, setQuizError] = React.useState('');

  const handleGenerate = () => {
    if (!accountManager || !username.trim()) return;
    const index = accountManager.CreateAccount(username.trim());
    if (index < 0) return;

    const mnemonicWords = accountManager.accounts[index]?.GetWords();
    setWords(mnemonicWords ?? []);
    setIsGenerated(true);
  };

  const startVerification = () => {
    setQuizPositions(pickQuizPositions(words.length));
    setAnswers({});
    setQuizError('');
    setIsVerifying(true);
  };

  /** Back to the word list — someone who cannot answer needs to read them again. */
  const backToWords = () => {
    setIsVerifying(false);
    setQuizError('');
  };

  const submitVerification = () => {
    const allCorrect = quizPositions.every(
      (position) => (answers[position] ?? '').trim().toLowerCase() === words[position]?.toLowerCase()
    );

    if (!allCorrect) {
      setQuizError(t('auth.phraseCheckFailed'));
      return;
    }
    onDone();
  };

  return (
    <Box>
      <Typography variant="h5" fontWeight={700} gutterBottom align="center" color="text.primary">
        {t('auth.createNewWallet')}
      </Typography>

      {isVerifying ? (
        <>
          <Typography variant="body2" color="text.secondary" align="center" sx={{ mb: 2 }}>
            {t('auth.confirmPhrasePrompt')}
          </Typography>

          <Stack spacing={2}>
            {quizPositions.map((position) => (
              <TextField
                key={position}
                fullWidth
                size="small"
                label={t('auth.wordNumber', { number: position + 1 })}
                value={answers[position] ?? ''}
                onChange={(e) => {
                  setAnswers((prev) => ({ ...prev, [position]: e.target.value }));
                  setQuizError('');
                }}
                onKeyDown={(e) => e.key === 'Enter' && submitVerification()}
                autoComplete="off"
                spellCheck={false}
                error={!!quizError}
              />
            ))}
          </Stack>

          {quizError && (
            <Typography variant="caption" color="error" sx={{ display: 'block', mt: 1.5 }}>
              {quizError}
            </Typography>
          )}

          <Button
            variant="contained"
            fullWidth
            onClick={submitVerification}
            size="large"
            sx={{ mt: 3, borderRadius: 0, height: 44, fontSize: 15 }}
          >
            {t('auth.confirmPhrase')}
          </Button>

          {/* Someone who cannot answer has not written it down — send them back to the
              words rather than letting them guess until they get through. */}
          <Button fullWidth onClick={backToWords} sx={{ mt: 1, borderRadius: 0 }}>
            {t('auth.showPhraseAgain')}
          </Button>
        </>
      ) : isGenerated ? (
        <>
          <Typography variant="body2" color="text.secondary" align="center" sx={{ mb: 2 }}>
            {t('auth.writeDownWords')}
          </Typography>

          <Paper elevation={0} variant="outlined" sx={{ p: 1.5, borderRadius: 0, bgcolor: 'background.default' }}>
            <Grid container spacing={1}>
              {words.map((word, index) => (
                <Grid size={{ xs: 6, sm: 4 }} key={index}>
                  <Box sx={{
                    display: 'flex',
                    borderRadius: 0,
                    overflow: 'hidden',
                    bgcolor: 'background.paper',
                    boxShadow: '0 1px 2px rgba(0,0,0,0.05)'
                  }}>
                    <Box sx={{
                      width: 28,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      bgcolor: 'action.hover',
                      fontSize: 12,
                      color: 'text.secondary',
                      borderRight: 1, borderColor: 'divider'
                    }}>
                      {index + 1}
                    </Box>
                    <Typography sx={{ px: 1.5, py: 0.5, fontSize: 14, fontFamily: 'monospace', color: 'text.primary' }}>
                      {word}
                    </Typography>
                  </Box>
                </Grid>
              ))}
            </Grid>
          </Paper>

          <Button
            variant="contained"
            fullWidth
            onClick={startVerification}
            size="large"
            sx={{ mt: 3, borderRadius: 0, height: 44, fontSize: 15 }}
          >
            {t('auth.iSavedMyPhrase')}
          </Button>
        </>
      ) : (
        <Box sx={{ textAlign: 'center', py: 3 }}>
          <Typography variant="body1" sx={{ mb: 3, color: 'text.secondary' }}>
            {t('auth.generateDescription')}
          </Typography>
          <TextField
            fullWidth
            label={t('auth.usernameLabel')}
            placeholder={t('auth.usernamePlaceholder')}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && username.trim() && handleGenerate()}
            autoFocus
            sx={{ mb: 2, textAlign: 'left' }}
          />
          <Button
            variant="contained"
            fullWidth
            onClick={handleGenerate}
            disabled={!accountManager || !username.trim()}
            size="large"
            sx={{ borderRadius: 0, height: 44 }}
          >
            {t('auth.generatePhrase')}
          </Button>
        </Box>
      )}
    </Box>
  );
}

function ImportWallet({ accountManager, onDone }: WalletStepProps) {
  const { t } = useTranslation();
  const [mnemonic, setMnemonic] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);

  const [isScanning, setIsScanning] = React.useState(false);

  const handleImport = async () => {
    if (!accountManager) return;

    if (!Mnemonic.isValidMnemonic(mnemonic.trim())) {
      setError(t('auth.invalidMnemonic'));
      return;
    }

    setIsScanning(true);
    try {
      const index = accountManager.ImportAccount(mnemonic.trim());
      if (index === -1) {
        setError(t('auth.importFailed'));
        setIsScanning(false);
        return;
      }

      const rpcs = [
        import.meta.env.VITE_ALCHEMY_MAINNET_API_KEY || "https://cloudflare-eth.com",
        import.meta.env.VITE_ALCHEMY_SEPOLIA_API_KEY || "https://rpc.sepolia.org",
        import.meta.env.VITE_ALCHEMY_ARBSEPOLIA_API_KEY || "https://sepolia-rollup.arbitrum.io/rpc",
        import.meta.env.VITE_ALCHEMY_BASESEPOLIA_API_KEY || "https://sepolia.base.org"
      ];
      await accountManager.AutoDiscoverAccounts(rpcs, 3, index);

      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setIsScanning(false);
    }
  };

  return (
    <Box>
      <Typography variant="h5" fontWeight={700} gutterBottom align="center" color="text.primary">
        {t('auth.importTitle')}
      </Typography>
      <Typography variant="body2" color="text.secondary" align="center" sx={{ mb: 3 }}>
        {t('auth.importDescription')}
      </Typography>

      {error && <Alert severity="error" sx={{ mb: 2, borderRadius: 0 }}>{error}</Alert>}

      <TextField
        placeholder="apple banana cat dog..."
        multiline
        fullWidth
        minRows={4}
        value={mnemonic}
        onChange={(e) => {
          setMnemonic(e.target.value);
          setError(null);
        }}
        sx={{
          '& .MuiOutlinedInput-root': {
            borderRadius: 0,
            bgcolor: 'background.default',
            fontFamily: 'monospace'
          }
        }}
      />

      <Button
        variant="contained"
        fullWidth
        onClick={handleImport}
        disabled={!accountManager || isScanning}
        size="large"
        sx={{ mt: 3, borderRadius: 0, height: 44 }}
      >
        {isScanning ? t('auth.scanningAccounts') : t('auth.importWallet')}
      </Button>
    </Box>
  );
}

/**
 * Set Password screen — shown AFTER wallet creation/import to encrypt account data.
 */
function SetPasswordScreen({ storageManager, accountManager, authMethod, pendingEmail, onDone }: PasswordScreenProps) {
  const { t } = useTranslation();
  const context = React.useContext(WalletContext);
  const [password, setPassword] = React.useState("");
  const [confirmPassword, setConfirmPassword] = React.useState("");
  const [showPassword, setShowPassword] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [isLoading, setIsLoading] = React.useState(false);

  const strength = getPasswordStrength(password);

  const handleSubmit = async () => {
    if (password.length < 8) {
      setError(t('auth.passwordMinLength'));
      return;
    }
    if (strength.score < 30) {
      setError(t('auth.passwordTooWeak'));
      return;
    }
    if (password !== confirmPassword) {
      setError(t('auth.passwordMismatch'));
      return;
    }

    setIsLoading(true);
    try {
      // Initialize encryption with the new password (generates salt + hashes password)
      const ok = await storageManager?.initEncryption(password);
      if (!ok) {
        setError(t('auth.encryptionFailed'));
        setIsLoading(false);
        return;
      }

      // Migrate any plaintext accounts left by an older build, then commit what is in
      // memory. A freshly created account is only in memory at this point — nothing
      // sensitive is written to disk before a password exists to encrypt it — so this
      // call is what actually saves the wallet.
      await accountManager?.loadFromEncryptedStorage();
      // Balances are persisted encrypted; loading them here means Home renders with
      // real numbers instead of an empty list and a spinner.
      await context?.dataCacheService?.hydrate();
      await context?.portfolioHistory?.hydrate();
      if (storageManager?.hasUnencryptedAccounts()) {
        await storageManager?.migrateToEncrypted();
      }
      const persisted = await accountManager?.persistToEncryptedStorage();

      // Fire-and-forget: registers this wallet with the pseudonymous user/activity backend
      // (backend-proxy /users/register). Never blocks or fails the onboarding flow — the
      // wallet is fully usable offline regardless of whether this call succeeds.
      if (persisted) {
        const address = accountManager?.GetActive()?.GetAddress();
        const proxyBaseUrl = import.meta.env.VITE_AGENT_PROXY_URL as string | undefined;
        if (address && proxyBaseUrl) {
          fetch(`${proxyBaseUrl}/users/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              wallet_address: address,
              email: authMethod === 'google' ? (pendingEmail ?? undefined) : undefined,
              source: authMethod ?? 'password',
            }),
          }).catch(() => { /* best-effort telemetry only */ });
        }
      }

      onDone();
    } catch (e) {
      setError((e instanceof Error ? e.message : String(e)) || "Encryption failed.");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Box>
      <Box sx={{ textAlign: 'center', mb: 3 }}>
        <Lock sx={{ fontSize: 40, color: 'primary.main', mb: 1 }} />
        <Typography variant="h5" fontWeight={700} color="text.primary">
          {t('auth.secureYourWallet')}
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          {t('auth.secureDescription')}
        </Typography>
      </Box>

      {error && <Alert severity="error" sx={{ mb: 2, borderRadius: 0 }}>{error}</Alert>}

      <Stack spacing={2}>
        <TextField
          label={t('auth.password')}
          type={showPassword ? "text" : "password"}
          fullWidth
          value={password}
          onChange={(e) => { setPassword(e.target.value); setError(null); }}
          InputProps={{
            endAdornment: (
              <InputAdornment position="end">
                <IconButton onClick={() => setShowPassword(!showPassword)} edge="end" aria-label={showPassword ? "Hide password" : "Show password"}>
                  {showPassword ? <VisibilityOff /> : <Visibility />}
                </IconButton>
              </InputAdornment>
            ),
          }}
          sx={{ '& .MuiOutlinedInput-root': { borderRadius: 0, bgcolor: 'background.paper' } }}
        />

        {/* Password Strength Meter */}
        {password.length > 0 && (
          <Box>
            <LinearProgress
              variant="determinate"
              value={strength.score}
              sx={{
                height: 6,
                borderRadius: 0,
                bgcolor: 'action.disabledBackground',
                '& .MuiLinearProgress-bar': {
                  bgcolor: strength.color,
                  borderRadius: 0,
                  transition: 'transform 0.3s ease, background-color 0.3s ease',
                },
              }}
            />
            <Typography variant="caption" sx={{ color: strength.color, fontWeight: 600, mt: 0.5, display: 'block', textAlign: 'right' }}>
              {strength.label}
            </Typography>
          </Box>
        )}

        <TextField
          label={t('auth.confirmPassword')}
          type={showPassword ? "text" : "password"}
          fullWidth
          value={confirmPassword}
          onChange={(e) => { setConfirmPassword(e.target.value); setError(null); }}
          onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
          sx={{ '& .MuiOutlinedInput-root': { borderRadius: 0, bgcolor: 'background.paper' } }}
        />
      </Stack>

      <Button
        variant="contained"
        fullWidth
        onClick={handleSubmit}
        disabled={isLoading}
        size="large"
        sx={{ mt: 3, borderRadius: 0, height: 44 }}
      >
        {isLoading ? <CircularProgress size={24} color="inherit" /> : t('auth.encryptAndContinue')}
      </Button>
    </Box>
  );
}

/**
 * Login / Unlock screen — decrypts accounts using password.
 */
function LoginIntoWallet({ storageManager, accountManager }: LoginProps) {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const context = React.useContext(WalletContext);
  const [password, setPassword] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [showPassword, setShowPassword] = React.useState(false);
  const [isLoading, setIsLoading] = React.useState(false);
  const [biometricAvailable, setBiometricAvailable] = React.useState(false);
  const [resetOpen, setResetOpen] = React.useState(false);
  const [resetting, setResetting] = React.useState(false);

  // Check if biometric login is available on mount
  React.useEffect(() => {
    (async () => {
      const available = await BiometricService.isBiometricAvailable();
      const registered = BiometricService.isEnabled();
      setBiometricAvailable(available && registered);
    })();
  }, []);

  const handleSubmit = async () => {
    if (!storageManager) {
      navigate("/home");
      return;
    }

    if (password.length < 1) {
      setError(t('auth.enterPasswordPrompt'));
      return;
    }

    setIsLoading(true);
    try {
      // Verify password and derive AES key
      const ok = await storageManager.initEncryption(password);
      if (!ok) {
        setError(t('auth.incorrectPassword'));
        setIsLoading(false);
        return;
      }

      // Load and decrypt accounts into memory
      await accountManager?.loadFromEncryptedStorage();
      // Balances are persisted encrypted; loading them here means Home renders with
      // real numbers instead of an empty list and a spinner.
      await context?.dataCacheService?.hydrate();
      await context?.portfolioHistory?.hydrate();

      navigate("/home");
    } catch (e) {
      setError((e instanceof Error ? e.message : String(e)) || "Unlock failed.");
    } finally {
      setIsLoading(false);
    }
  };

  const handleBiometricUnlock = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const masterPassword = await BiometricService.authenticateBiometric();
      if (!masterPassword) {
        setError(t('auth.biometricFailed'));
        setIsLoading(false);
        return;
      }

      const ok = await storageManager?.initEncryption(masterPassword);
      if (!ok) {
        setError(t('auth.biometricFailed'));
        setIsLoading(false);
        return;
      }

      await accountManager?.loadFromEncryptedStorage();
      // Balances are persisted encrypted; loading them here means Home renders with
      // real numbers instead of an empty list and a spinner.
      await context?.dataCacheService?.hydrate();
      await context?.portfolioHistory?.hydrate();
      navigate("/home");
    } catch (e) {
      setError(t('auth.biometricFailed'));
    } finally {
      setIsLoading(false);
    }
  };

  /**
   * Erase the wallet so a new one can be created or restored.
   *
   * There is no password reset for a non-custodial wallet: the password is never stored,
   * and the accounts are encrypted with a key derived from it. Wiping and restoring from
   * the recovery phrase is the only way back, so the dialog says that plainly rather than
   * calling itself a reset.
   */
  const handleReset = async () => {
    if (!storageManager) return;
    setResetting(true);
    try {
      await storageManager.resetWallet();
      // A full reload is deliberate: every in-memory service still holds state belonging
      // to a wallet that no longer exists.
      window.location.hash = '#/';
      window.location.reload();
    } catch (e) {
      setError((e instanceof Error ? e.message : String(e)) || 'Reset failed.');
      setResetting(false);
      setResetOpen(false);
    }
  };

  return (
    <Box>
      <Typography variant="h5" fontWeight={700} gutterBottom align="center" color="text.primary">
        {t('auth.welcomeBack')}
      </Typography>
      <Typography variant="body2" color="text.secondary" align="center" sx={{ mb: 3 }}>
        {t('auth.welcomeBackDesc')}
      </Typography>

      {error && <Alert severity="error" sx={{ mb: 2, borderRadius: 0 }}>{error}</Alert>}

      <TextField
        label={t('auth.password')}
        type={showPassword ? "text" : "password"}
        fullWidth
        value={password}
        onChange={(e) => {
          setPassword(e.target.value);
          setError(null);
        }}
        onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
        InputProps={{
          endAdornment: (
            <InputAdornment position="end">
              <IconButton onClick={() => setShowPassword(!showPassword)} edge="end" aria-label={showPassword ? "Hide password" : "Show password"}>
                {showPassword ? <VisibilityOff /> : <Visibility />}
              </IconButton>
            </InputAdornment>
          ),
        }}
        sx={{
          '& .MuiOutlinedInput-root': {
            borderRadius: 0,
            bgcolor: 'background.paper'
          }
        }}
      />

      <Button
        variant="contained"
        fullWidth
        onClick={handleSubmit}
        disabled={isLoading}
        size="large"
        sx={{ mt: 3, borderRadius: 0, height: 44 }}
      >
        {isLoading ? <CircularProgress size={24} color="inherit" /> : t('auth.unlock')}
      </Button>

      {/* Biometric Unlock Button */}
      {biometricAvailable && (
        <Button
          variant="outlined"
          fullWidth
          onClick={handleBiometricUnlock}
          disabled={isLoading}
          size="large"
          startIcon={<Fingerprint />}
          sx={{
            mt: 2,
            borderRadius: 0,
            height: 44,
            borderColor: 'rgba(37, 99, 235, 0.25)',
            color: 'primary.main',
            '&:hover': {
              borderColor: 'primary.main',
              bgcolor: 'rgba(37, 99, 235, 0.04)',
            }
          }}
        >
          {t('auth.biometricUnlock')}
        </Button>
      )}

      <Button
        fullWidth
        onClick={() => setResetOpen(true)}
        disabled={isLoading}
        sx={{ mt: 2, borderRadius: 0, color: 'text.secondary', fontWeight: 500 }}
      >
        {t('auth.forgotPassword')}
      </Button>

      <Dialog open={resetOpen} onClose={() => !resetting && setResetOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle sx={{ fontWeight: 800 }}>{t('auth.resetWalletTitle')}</DialogTitle>
        <DialogContent>
          <Alert severity="warning" sx={{ mb: 2, borderRadius: 0 }}>
            {t('auth.resetWalletWarning')}
          </Alert>
          <Typography variant="body2" color="text.secondary">
            {t('auth.resetWalletExplain')}
          </Typography>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setResetOpen(false)} disabled={resetting}>
            {t('common.cancel')}
          </Button>
          <Button color="error" variant="contained" onClick={handleReset} disabled={resetting} sx={{ borderRadius: 0 }}>
            {resetting ? <CircularProgress size={20} color="inherit" /> : t('auth.resetWalletConfirm')}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}

// --- Main Auth Component ---

export default function Auth() {
  const { t } = useTranslation();
  const context = React.useContext(WalletContext);
  const accountManager = context?.accountManager;
  const storageManager = context?.storageManager;

  const [step, setStep] = React.useState(AuthStep.CHOICE);
  const [isSocialLoading, setIsSocialLoading] = React.useState(false);
  /** Surfaced under the button — social login used to fail with no explanation at all. */
  const [socialError, setSocialError] = React.useState("");
  const [authMethod, setAuthMethod] = React.useState<'password' | 'google' | null>(null);
  const [pendingEmail, setPendingEmail] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!storageManager) return;

    const initAuth = async () => {
      // Attempt to auto-restore session from background/sessionStorage
      const timeoutMs = storageManager.getLocal<number>('autoLockTimeout') ?? (5 * 60 * 1000);
      const restored = await storageManager.restoreSession(timeoutMs);

      if (restored) {
        try {
          // Load accounts and proceed immediately without showing login screen
          await accountManager?.loadFromEncryptedStorage();
      // Balances are persisted encrypted; loading them here means Home renders with
      // real numbers instead of an empty list and a spinner.
      await context?.dataCacheService?.hydrate();
      await context?.portfolioHistory?.hydrate();
          window.location.hash = "#/home";
          return;
        } catch (e) {
          console.error("Failed to load accounts after session restore", e);
        }
      }

      // Determine initial step based on existing state
      if (storageManager.hasPassword()) {
        // Existing encrypted wallet — go to login
        setStep(AuthStep.LOGIN);
      } else if (storageManager.hasUnencryptedAccounts()) {
        // Legacy plaintext wallet — need to set password first, then migrate
        setStep(AuthStep.SET_PASSWORD);
      } else {
        // No wallet exists — show choice screen
        setStep(AuthStep.CHOICE);
      }
    };

    initAuth();
  }, [storageManager, accountManager]);

  const handleWalletCreated = (method: 'password' | 'google' = 'password') => {
    // After create/import, go to set password step
    setAuthMethod(method);
    setStep(AuthStep.SET_PASSWORD);
  };

  const handlePasswordSet = () => {
    // After password is set and encryption is done, navigate to home
    const nav = document.querySelector("[data-auth-navigate]");
    // Use navigate directly
    window.location.hash = "#/home";
  };

  const navigate = React.useCallback(() => {
    window.location.hash = "#/home";
  }, []);

  return (
    <Box sx={{
      minHeight: '100%',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      bgcolor: 'background.default',
      p: 2
    }}>
      <Container maxWidth="xs">
        <Paper elevation={0} sx={{
          p: 3,
          borderRadius: 0,
          bgcolor: 'background.default',
          border: 1, borderColor: 'divider',
          boxShadow: 'none',
        }}>
          {/* Logo Area */}
          <Box sx={{ textAlign: 'center', mb: 3 }}>
            <Box
              component="img"
              src="/Arfhe-logo.png"
              alt="Arfhe"
              sx={{
                width: 44,
                height: 44,
                mb: 1,
                filter: (theme) => theme.palette.mode === 'dark' ? 'invert(1) brightness(1.05)' : 'none',
              }}
            />
            <Typography variant="h5" fontWeight={800} letterSpacing={2} sx={{
              fontFamily: 'var(--font-mono)',
              color: 'text.primary',
              textTransform: 'uppercase',
            }}>
              ARFHE WALLET
            </Typography>
          </Box>

          {/* Login Screen (Existing encrypted wallet) */}
          {step === AuthStep.LOGIN && (
            <LoginIntoWallet storageManager={storageManager} accountManager={accountManager} />
          )}

          {/* Set Password Screen (After create/import or migration) */}
          {step === AuthStep.SET_PASSWORD && (
            <SetPasswordScreen
              storageManager={storageManager}
              accountManager={accountManager}
              authMethod={authMethod}
              pendingEmail={pendingEmail}
              onDone={() => { window.location.hash = "#/home"; }}
            />
          )}

          {/* New Wallet Choice Screen */}
          {step === AuthStep.CHOICE && (
            <Stack spacing={2}>
              <Typography variant="body1" align="center" color="text.secondary" sx={{ mb: 2 }}>
                {t('auth.welcomeMessage')}
              </Typography>

              <Button
                fullWidth
                variant="contained"
                disabled={isSocialLoading}
                onClick={async () => {
                  // A misconfigured build must say so rather than silently authenticate
                  // against someone else's project.
                  if (!clientId) {
                    setSocialError(t('auth.socialNotConfigured'));
                    return;
                  }

                  // Web3Auth opens its own window, which costs the action popup its focus —
                  // and Chrome destroys a popup that loses focus. Move to a real window
                  // first and let the flow run there.
                  if (await isActionPopup()) {
                    if (await openSocialLoginWindow()) {
                      window.close();
                      return;
                    }
                    // Could not open one; fall through and try inline rather than dead-end.
                  }

                  setIsSocialLoading(true);
                  setSocialError("");
                  try {
                    const chainConfig = {
                      chainNamespace: CHAIN_NAMESPACES.EIP155,
                      chainId: "0x1",
                      rpcTarget: import.meta.env.VITE_ALCHEMY_MAINNET_API_KEY || "https://cloudflare-eth.com",
                      displayName: "Ethereum Mainnet",
                      blockExplorerUrl: "https://etherscan.io",
                      ticker: "ETH",
                      tickerName: "Ethereum",
                    };

                    const privateKeyProvider = new EthereumPrivateKeyProvider({ config: { chainConfig } });

                    const web3auth = new Web3Auth({
                      clientId,
                      web3AuthNetwork: WEB3AUTH_NETWORK.SAPPHIRE_DEVNET,
                      privateKeyProvider,
                    });

                    await web3auth.initModal();
                    await web3auth.connect();

                    if (web3auth.provider) {
                      const privateKey = await web3auth.provider.request({ method: "eth_private_key" }) as string;
                      let accountName = "Social Account";
                      let socialEmail: string | null = null;
                      try {
                        const userInfo = await web3auth.getUserInfo();
                        if (userInfo.email) {
                          accountName = userInfo.email;
                          socialEmail = userInfo.email;
                        } else if (userInfo.name) {
                          accountName = userInfo.name;
                        }
                      } catch (e) {
                      }

                      if (privateKey) {
                        const importedIndex = accountManager?.ImportPrivateKey(privateKey, accountName);

                        const rpcs = [
                          chainConfig.rpcTarget,
                          import.meta.env.VITE_ALCHEMY_SEPOLIA_API_KEY || "https://rpc.sepolia.org",
                          import.meta.env.VITE_ALCHEMY_ARBSEPOLIA_API_KEY || "https://sepolia-rollup.arbitrum.io/rpc",
                          import.meta.env.VITE_ALCHEMY_BASESEPOLIA_API_KEY || "https://sepolia.base.org"
                        ];
                        await accountManager?.AutoDiscoverAccounts(rpcs, 3, importedIndex);

                        setPendingEmail(socialEmail);
                        handleWalletCreated('google');
                      }
                    }
                  } catch (error) {
                    // Previously swallowed whole, so a failed login looked like nothing
                    // had happened and the user simply clicked again.
                    setSocialError(error instanceof Error ? error.message : String(error));
                  } finally {
                    setIsSocialLoading(false);
                  }
                }}
                startIcon={<Google />}
                sx={{
                  borderRadius: 0,
                  height: 44,
                  bgcolor: 'primary.main',
                  color: 'primary.contrastText',
                  '&:hover': { bgcolor: 'primary.dark' }
                }}
              >
                {isSocialLoading ? t('auth.connectingScanning') : t('auth.continueWithSocial')}
              </Button>

              {socialError && (
                <Alert severity="error" sx={{ borderRadius: 0, fontSize: '0.75rem' }}>
                  {socialError}
                </Alert>
              )}

              <Box sx={{ display: 'flex', alignItems: 'center', my: 1 }}>
                <Box sx={{ flex: 1, height: '1px', bgcolor: 'divider' }} />
                <Typography variant="caption" sx={{ px: 2, color: 'text.secondary', fontWeight: 600 }}>{t('auth.or')}</Typography>
                <Box sx={{ flex: 1, height: '1px', bgcolor: 'divider' }} />
              </Box>

              <Button
                variant="outlined"
                size="large"
                onClick={() => setStep(AuthStep.CREATE)}
                sx={{ borderRadius: 0, height: 44, borderColor: 'divider', color: 'text.primary' }}
              >
                {t('auth.createWallet')}
              </Button>
              <Button
                variant="outlined"
                size="large"
                onClick={() => setStep(AuthStep.IMPORT)}
                sx={{ borderRadius: 0, height: 44, borderColor: 'divider', color: 'text.primary' }}
              >
                {t('auth.iHaveAWallet')}
              </Button>
            </Stack>
          )}

          {/* Create Wallet Screen */}
          {step === AuthStep.CREATE && (
            <CreateWallet accountManager={accountManager} onDone={handleWalletCreated} />
          )}

          {/* Import Wallet Screen */}
          {step === AuthStep.IMPORT && (
            <Box>
              <ImportWallet accountManager={accountManager} onDone={handleWalletCreated} />
              <Button
                onClick={() => setStep(AuthStep.CHOICE)}
                color="inherit"
                sx={{ mt: 2, textTransform: 'none', color: 'text.secondary' }}
              >
                {t('auth.cancel')}
              </Button>
            </Box>
          )}
        </Paper>
      </Container>
    </Box>
  );
}
