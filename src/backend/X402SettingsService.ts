/**
 * X402SettingsService.ts — user-controlled preferences for automatic x402 micro-payments (Faz 3).
 *
 * Same shape as NotificationService.ts: a static class over `chrome.storage.local` (falling
 * back to `localStorage` outside the extension), because these are non-sensitive, purely
 * local preferences — no signing authority lives here. `chrome.storage.local` specifically
 * (not `.session`, unlike AgentProposalHistory's chat log) because this is a durable user
 * choice that must survive a browser restart, same as SitePermissionService's grants.
 *
 * SECURITY: `perTransactionCapUsd`/`dailyBudgetCapUsd` are what the USER asked for, not what
 * the agent is actually allowed to spend — they are always clamped against
 * AgentPolicyEngine.X402_ABSOLUTE_CAPS before being persisted or returned, so no path (a typo,
 * a manually edited storage blob, a future release lowering the hard ceiling) can leave a
 * stored value the policy engine would need to re-clamp anyway. The engine (evaluateX402Payment,
 * a later step in this same phase) still clamps again at evaluation time — this service's
 * clamping is defense-in-depth, not the enforcement point itself.
 */

import { X402_ABSOLUTE_CAPS } from "./AgentPolicyEngine.js";

export interface X402Settings {
  /** Master switch — x402 auto-payments never happen while this is false. Default: off. */
  enabled: boolean;
  /** User's own per-payment ceiling, USD. Always <= X402_ABSOLUTE_CAPS.maxPerTransactionUsd. */
  perTransactionCapUsd: number;
  /** User's own rolling-day budget, USD. Always <= X402_ABSOLUTE_CAPS.maxDailyBudgetUsd. */
  dailyBudgetCapUsd: number;
}

/**
 * Conservative starting point for a first integration — x402 is meant for micro-payments
 * (fractions of a cent to a few dollars per API call), not general spending. Enabled defaults
 * to false: this is opt-in automatic spending, the user must explicitly turn it on.
 */
export const DEFAULT_X402_SETTINGS: X402Settings = {
  enabled: false,
  perTransactionCapUsd: 0.1,
  dailyBudgetCapUsd: 1,
};

const STORAGE_KEY = "arfhe_x402_settings";

function clampToAbsoluteCaps(settings: X402Settings): X402Settings {
  return {
    enabled: settings.enabled,
    perTransactionCapUsd: clampNonNegative(settings.perTransactionCapUsd, X402_ABSOLUTE_CAPS.maxPerTransactionUsd),
    dailyBudgetCapUsd: clampNonNegative(settings.dailyBudgetCapUsd, X402_ABSOLUTE_CAPS.maxDailyBudgetUsd),
  };
}

/** NaN/negative user input collapses to 0 (effectively "no budget") rather than being silently ignored. */
function clampNonNegative(value: number, max: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.min(value, max);
}

export class X402SettingsService {
  /** Load settings from storage, merged over defaults and clamped to the absolute caps. */
  static async getSettings(): Promise<X402Settings> {
    try {
      let stored: Partial<X402Settings> | undefined;
      if (typeof chrome !== "undefined" && chrome.storage) {
        const result = await chrome.storage.local.get(STORAGE_KEY);
        stored = result[STORAGE_KEY] as Partial<X402Settings> | undefined;
      } else {
        const raw = localStorage.getItem(STORAGE_KEY);
        stored = raw ? (JSON.parse(raw) as Partial<X402Settings>) : undefined;
      }
      return clampToAbsoluteCaps({ ...DEFAULT_X402_SETTINGS, ...stored });
    } catch {
      return DEFAULT_X402_SETTINGS;
    }
  }

  /** Persist settings, clamped to the absolute caps — what's stored is always what would actually be enforced. */
  static async saveSettings(settings: X402Settings): Promise<X402Settings> {
    const clamped = clampToAbsoluteCaps(settings);
    try {
      if (typeof chrome !== "undefined" && chrome.storage) {
        await chrome.storage.local.set({ [STORAGE_KEY]: clamped });
      } else {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(clamped));
      }
    } catch {
      // Best-effort, same as NotificationService — a failed write leaves the previous
      // (still valid) stored settings in place rather than throwing into the UI.
    }
    return clamped;
  }
}

export default X402SettingsService;
