/**
 * OnboardingTour.tsx — First-Time User Welcome Dialog
 *
 * A single, simple welcome message shown once after wallet creation.
 * State persisted via localStorage key `arfhe_onboarding_completed`.
 */

import React from "react";
import {
  Dialog,
  Box,
  Typography,
  Button,
} from "@mui/material";
import { useTranslation } from "react-i18next";

// ─── Storage Key ────────────────────────────────────────────────────

const ONBOARDING_KEY = "arfhe_onboarding_completed";
const BACKUP_REMINDER_KEY = "arfhe_backup_dismissed";

/** Check if onboarding has been completed */
export function isOnboardingCompleted(): boolean {
  try {
    return localStorage.getItem(ONBOARDING_KEY) === "true";
  } catch {
    return false;
  }
}

/** Mark onboarding as completed */
export function markOnboardingCompleted(): void {
  try {
    localStorage.setItem(ONBOARDING_KEY, "true");
  } catch {}
}

/** Check if backup reminder was dismissed */
export function isBackupReminderDismissed(): boolean {
  try {
    return localStorage.getItem(BACKUP_REMINDER_KEY) === "true";
  } catch {
    return false;
  }
}

/** Dismiss the backup reminder */
export function dismissBackupReminder(): void {
  try {
    localStorage.setItem(BACKUP_REMINDER_KEY, "true");
  } catch {}
}

// ─── Component ──────────────────────────────────────────────────────

interface OnboardingTourProps {
  open: boolean;
  onClose: () => void;
}

export default function OnboardingTour({ open, onClose }: OnboardingTourProps) {
  const { t } = useTranslation();
  const handleClose = () => {
    markOnboardingCompleted();
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      maxWidth="xs"
      fullWidth
      PaperProps={{
        sx: {
          borderRadius: 0,
          border: "1px solid",
          borderColor: "divider",
          bgcolor: "background.default",
          boxShadow: "none",
        },
      }}
    >
      <Box sx={{ p: 3, textAlign: "center" }}>
        <Typography
          variant="h6"
          sx={{
            fontFamily: "var(--font-mono)",
            color: "text.primary",
            textTransform: "uppercase",
            letterSpacing: 1,
            mb: 1.5,
          }}
        >
          {t("onboarding.welcomeTitle")}
        </Typography>

        <Typography variant="body2" sx={{ color: "text.secondary", mb: 3, lineHeight: 1.6 }}>
          {t("onboarding.welcomeDesc")}
        </Typography>

        <Button
          variant="contained"
          fullWidth
          onClick={handleClose}
          sx={{ height: 44 }}
        >
          {t("onboarding.start")}
        </Button>
      </Box>
    </Dialog>
  );
}

// ─── Backup Reminder Banner ─────────────────────────────────────────

interface BackupReminderProps {
  onBackup: () => void;
  onDismiss: () => void;
}

export function BackupReminderBanner({ onBackup, onDismiss }: BackupReminderProps) {
  const { t } = useTranslation();
  return (
    <Box
      sx={{
        mx: 2,
        mb: 2,
        p: 2,
        border: "1px solid",
        borderColor: "warning.main",
        display: "flex",
        alignItems: "center",
        gap: 1.5,
      }}
    >
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography
          variant="body2"
          sx={{ fontWeight: 700, color: "text.primary", fontSize: "0.82rem", lineHeight: 1.3 }}
        >
          {t("onboarding.backupTitle")}
        </Typography>
        <Typography
          variant="caption"
          sx={{ color: "text.secondary", fontSize: "0.72rem", lineHeight: 1.3 }}
        >
          {t("onboarding.backupDesc")}
        </Typography>
      </Box>
      <Box sx={{ display: "flex", flexDirection: "column", gap: 0.5, flexShrink: 0 }}>
        <Button
          size="small"
          variant="contained"
          color="warning"
          onClick={onBackup}
          sx={{
            fontSize: "0.68rem",
            minWidth: 64,
            py: 0.3,
          }}
        >
          {t("onboarding.backupAction")}
        </Button>
        <Button
          size="small"
          onClick={onDismiss}
          sx={{
            color: "text.secondary",
            fontWeight: 600,
            fontSize: "0.62rem",
            textTransform: "none",
            minWidth: 64,
            py: 0,
          }}
        >
          {t("onboarding.backupLater")}
        </Button>
      </Box>
    </Box>
  );
}
