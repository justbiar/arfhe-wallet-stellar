/**
 * SettingsAccounts — the accounts in this wallet, and what can be done to them.
 *
 * Accounts were previously only reachable through the switcher in the header, which does
 * one thing: change which one is active. There was no way to correct a name, and no way to
 * remove an account at all — an imported key or a derived account was permanent once added.
 *
 * Removal is the part that needs care, because the two kinds of account are not equally
 * recoverable. One derived from the recovery phrase comes back the moment that phrase is
 * entered again; one imported from a private key does not, because the wallet holds no
 * other copy of that key. The confirmation says which case the user is in rather than
 * asking the same question about both.
 */

import React, { useCallback, useContext, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import {
  Alert,
  Box,
  Button,
  Chip,
  Container,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Paper,
  Stack,
  TextField,
  Typography,
  alpha,
  useTheme,
} from "@mui/material";
import {
  AddCircleOutline,
  ArrowBack,
  CheckCircle,
  ContentCopy,
  Delete,
  Edit,
} from "@mui/icons-material";

import { WalletContext } from "../AppContext";
import { useToast } from "../components/ToastProvider";

interface Row {
  index: number;
  name: string;
  address: string;
  isActive: boolean;
  /** No mnemonic means the key was imported, and this wallet holds the only copy. */
  isImported: boolean;
}

export default function SettingsAccounts() {
  const navigate = useNavigate();
  const theme = useTheme();
  const { t } = useTranslation();
  const { showToast } = useToast();
  const context = useContext(WalletContext);
  const accountManager = context?.accountManager;

  /** Bumped after every change so the list re-reads the manager rather than a stale copy. */
  const [revision, setRevision] = useState(0);
  const [renaming, setRenaming] = useState<Row | null>(null);
  const [draftName, setDraftName] = useState("");
  const [removing, setRemoving] = useState<Row | null>(null);

  const rows: Row[] = useMemo(() => {
    const accounts = accountManager?.accounts ?? [];
    const activeAddress = accountManager?.GetActive()?.GetAddress();
    return accounts.map((account, index) => ({
      index,
      name: account.name || `Account ${index + 1}`,
      address: account.GetAddress() ?? "",
      isActive: !!activeAddress && account.GetAddress() === activeAddress,
      isImported: !account.mnemonic,
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountManager, revision]);

  const refresh = () => setRevision((r) => r + 1);

  const activate = useCallback((row: Row) => {
    accountManager?.SetActive(row.index);
    refresh();
  }, [accountManager]);

  const copyAddress = useCallback(async (address: string) => {
    try {
      await navigator.clipboard.writeText(address);
      showToast(t("accounts.addressCopied"), "success");
    } catch {
      // No clipboard access; the address is on screen to read.
    }
  }, [showToast, t]);

  const openRename = (row: Row) => {
    setRenaming(row);
    setDraftName(row.name);
  };

  const commitRename = () => {
    if (!renaming || !accountManager) return;
    // Through the manager, so the in-memory account and its encrypted copy stay in step.
    accountManager.RenameAccount(renaming.index, draftName);
    setRenaming(null);
    refresh();
  };

  const commitRemove = () => {
    if (!removing || !accountManager) return;
    accountManager.RemoveAccount(removing.index);

    // RemoveAccount clears the active index when it removes the active account, which
    // would leave the wallet with nothing selected. Pick the first survivor.
    if (accountManager.GetActiveIndex() < 0 && accountManager.accounts.length > 0) {
      accountManager.SetActive(0);
    }
    setRemoving(null);
    refresh();
  };

  const addAccount = () => {
    try {
      accountManager?.DeriveNewAccount();
      refresh();
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), "error");
    }
  };

  // A wallet with no account has nothing to unlock, so the last one cannot be removed.
  const isLast = rows.length <= 1;

  return (
    <Box sx={{ pb: 12 }}>
      <Container maxWidth="md" sx={{ py: 2 }}>
        <Stack direction="row" alignItems="center" spacing={0.5} sx={{ mb: 0.5 }}>
          <IconButton onClick={() => navigate("/settings")} aria-label={t("common.back")} sx={{ ml: -1 }}>
            <ArrowBack />
          </IconButton>
          <Typography variant="h6" fontWeight={800} sx={{ letterSpacing: "-0.02em" }}>
            {t("accounts.accountsTitle")}
          </Typography>
        </Stack>
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ display: "block", mb: 2, pl: 0.5, textTransform: "none", lineHeight: 1.45 }}
        >
          {t("accounts.accountsIntro")}
        </Typography>

        <Paper
          elevation={0}
          sx={{ borderRadius: 0, overflow: "hidden", mb: 2, border: "1px solid", borderColor: "divider" }}
        >
          {accountManager?.CanDeriveNewAccount() && (
            <ListItemButton
              onClick={addAccount}
              sx={{ py: 1.5, gap: 1.5, borderBottom: `1px solid ${alpha(theme.palette.divider, 0.5)}` }}
            >
              <ListItemIcon sx={{ minWidth: 0 }}>
                <AddCircleOutline sx={{ color: "primary.main", fontSize: 22 }} />
              </ListItemIcon>
              <ListItemText
                primary={t("accounts.addAccount")}
                primaryTypographyProps={{ fontWeight: 600, color: "primary.main" }}
              />
            </ListItemButton>
          )}

          {rows.map((row, index) => (
            <Box
              key={row.address || row.index}
              sx={{
                display: "flex",
                alignItems: "center",
                px: 2,
                py: 1.5,
                borderBottom: index < rows.length - 1 ? `1px solid ${alpha(theme.palette.divider, 0.3)}` : "none",
                bgcolor: row.isActive ? alpha(theme.palette.primary.main, 0.04) : "transparent",
              }}
            >
              <Box
                onClick={() => activate(row)}
                sx={{ flex: 1, minWidth: 0, cursor: "pointer" }}
                role="button"
                aria-label={`${t("accounts.active")}: ${row.name}`}
              >
                <Stack direction="row" alignItems="center" spacing={0.75}>
                  <Typography fontWeight={600} fontSize={14} noWrap>
                    {row.name}
                  </Typography>
                  {row.isActive && <CheckCircle sx={{ fontSize: 14, color: "primary.main" }} />}
                </Stack>
                <Typography
                  variant="caption"
                  color="text.disabled"
                  sx={{ display: "block", fontFamily: "monospace", textTransform: "none" }}
                >
                  {row.address ? `${row.address.slice(0, 10)}…${row.address.slice(-8)}` : "—"}
                </Typography>
                {/* An imported account has a different recovery story, and the row is
                    where the user finds that out before the confirmation tells them. */}
                {row.isImported && (
                  <Chip
                    label={t("accounts.importedBadge")}
                    size="small"
                    variant="outlined"
                    sx={{ height: 18, fontSize: 10, fontWeight: 600, mt: 0.4 }}
                  />
                )}
              </Box>

              <IconButton size="small" aria-label={t("accounts.copyAddress")} onClick={() => void copyAddress(row.address)}>
                <ContentCopy sx={{ fontSize: 17 }} />
              </IconButton>
              <IconButton size="small" aria-label={`${t("accounts.rename")} ${row.name}`} onClick={() => openRename(row)}>
                <Edit sx={{ fontSize: 17 }} />
              </IconButton>
              <IconButton
                size="small"
                aria-label={`${t("accounts.removeAccount")} ${row.name}`}
                onClick={() => setRemoving(row)}
                disabled={isLast}
                sx={{ color: isLast ? "text.disabled" : "error.main" }}
              >
                <Delete sx={{ fontSize: 17 }} />
              </IconButton>
            </Box>
          ))}
        </Paper>

        {isLast && (
          <Alert severity="info" sx={{ borderRadius: 0, fontSize: "0.75rem" }}>
            {t("accounts.cannotRemoveLast")}
          </Alert>
        )}
      </Container>

      {/* ── Rename ── */}
      <Dialog open={!!renaming} onClose={() => setRenaming(null)} fullWidth maxWidth="xs">
        <DialogTitle sx={{ fontSize: 16, fontWeight: 800 }}>{t("accounts.renameTitle")}</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            size="small"
            label={t("accounts.accountName")}
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && commitRename()}
            sx={{ mt: 1, "& .MuiOutlinedInput-root": { borderRadius: 0 } }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRenaming(null)}>{t("common.cancel")}</Button>
          <Button variant="contained" onClick={commitRename} disabled={!draftName.trim()} sx={{ borderRadius: 0 }}>
            {t("accounts.rename")}
          </Button>
        </DialogActions>
      </Dialog>

      {/* ── Remove ── */}
      <Dialog open={!!removing} onClose={() => setRemoving(null)} fullWidth maxWidth="xs">
        <DialogTitle sx={{ fontSize: 16, fontWeight: 800 }}>
          {t("accounts.removeTitle", { name: removing?.name ?? "" })}
        </DialogTitle>
        <DialogContent>
          {/* The two kinds of account are not equally recoverable, and the difference is
              the whole substance of this decision. */}
          <Alert severity={removing?.isImported ? "error" : "warning"} sx={{ borderRadius: 0, fontSize: "0.78rem" }}>
            {removing?.isImported
              ? t("accounts.removeBodyImported")
              : t("accounts.removeBodyDerived")}
          </Alert>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRemoving(null)}>{t("common.cancel")}</Button>
          <Button color="error" variant="contained" onClick={commitRemove} sx={{ borderRadius: 0 }}>
            {t("accounts.removeConfirm")}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
