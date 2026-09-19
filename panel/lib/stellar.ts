/**
 * Stellar account and balance helpers for the panel.
 *
 * ── On keys ──
 *
 * This panel creates its OWN throwaway testnet account. It never asks for the user's
 * recovery phrase, and there is no field anywhere to type one into.
 *
 * That is a deliberate refusal, not a missing feature. A web page that asks for a recovery
 * phrase is indistinguishable from the phishing page that imitates it, and a wallet that
 * teaches its users to type twelve words into a website has undone its own security advice.
 * The extension itself makes the same call — see HuntMark.tsx, which avoids recovery-phrase
 * vocabulary entirely for this reason.
 *
 * The demo key lives in sessionStorage: it survives a reload while someone is working
 * through the flow, and is gone when the tab closes. It holds testnet assets with no value.
 */

import { Keypair, Horizon, Asset, TransactionBuilder, Networks, Operation, BASE_FEE } from "@stellar/stellar-sdk";
import { HORIZON_URL } from "./anchor";

const SESSION_KEY = "arfhe_panel_demo_secret";

export const horizon = new Horizon.Server(HORIZON_URL);

/** The demo account for this tab, created on first use. */
export function loadOrCreateDemoKeypair(): Keypair {
  try {
    const stored = sessionStorage.getItem(SESSION_KEY);
    if (stored) return Keypair.fromSecret(stored);
  } catch {
    // Private window, or storage blocked. Fall through and keep the key in memory only —
    // the flow still works for the length of this page view.
  }
  const kp = Keypair.random();
  try {
    sessionStorage.setItem(SESSION_KEY, kp.secret());
  } catch { /* memory-only is an acceptable degradation here */ }
  return kp;
}

/** Forgets the demo account. */
export function clearDemoKeypair(): void {
  try {
    sessionStorage.removeItem(SESSION_KEY);
  } catch { /* nothing to clear */ }
}

export interface StellarBalances {
  /** Native XLM, decimal string. */
  xlm: string;
  /** Anchor asset, decimal string. `null` when no trustline exists yet. */
  usdc: string | null;
  /** False before the account is funded — Horizon 404s until then. */
  funded: boolean;
}

/**
 * Reads balances straight from Horizon.
 *
 * An unfunded account is a 404, not an error worth surfacing: on Stellar an account does not
 * exist until something funds it, and "not created yet" is a normal state for a demo account
 * a second after it is generated.
 */
export async function readBalances(publicKey: string, usdcIssuer: string | null): Promise<StellarBalances> {
  try {
    const acct = await horizon.loadAccount(publicKey);
    const native = acct.balances.find((b) => b.asset_type === "native");
    const usdc = usdcIssuer
      ? acct.balances.find(
          (b) => "asset_code" in b && b.asset_code === "USDC" && b.asset_issuer === usdcIssuer
        )
      : undefined;
    return {
      xlm: native?.balance ?? "0",
      usdc: usdc ? usdc.balance : null,
      funded: true,
    };
  } catch (err) {
    if (isNotFound(err)) return { xlm: "0", usdc: null, funded: false };
    throw err;
  }
}

function isNotFound(err: unknown): boolean {
  const status = (err as { response?: { status?: number } })?.response?.status;
  return status === 404;
}

/** Asks friendbot for test XLM. Testnet only; there is no mainnet equivalent. */
export async function fundWithFriendbot(publicKey: string): Promise<void> {
  const res = await fetch(`https://friendbot.stellar.org?addr=${encodeURIComponent(publicKey)}`);
  if (!res.ok && res.status !== 400) {
    // 400 usually means "already funded", which is not a failure from the caller's side.
    throw new Error(`Friendbot hesabı fonlayamadı (HTTP ${res.status}).`);
  }
}

/**
 * Opens a trustline for the anchor's asset.
 *
 * Without one the anchor cannot pay: its own docs say the deposit sits at `pending_trust`,
 * or becomes a claimable balance the user has to go and collect. Doing this up front turns a
 * confusing stuck state into a step the flow simply completes.
 */
export async function ensureTrustline(kp: Keypair, issuer: string): Promise<boolean> {
  const asset = new Asset("USDC", issuer);
  const acct = await horizon.loadAccount(kp.publicKey());

  const already = acct.balances.some(
    (b) => "asset_code" in b && b.asset_code === "USDC" && b.asset_issuer === issuer
  );
  if (already) return false;

  const tx = new TransactionBuilder(acct, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.changeTrust({ asset }))
    .setTimeout(60)
    .build();
  tx.sign(kp);
  await horizon.submitTransaction(tx);
  return true;
}

/** `GABC…WXYZ`, for display where the full 56 characters do not fit. */
export function shortAddress(publicKey: string, lead = 6, tail = 4): string {
  if (publicKey.length <= lead + tail + 1) return publicKey;
  return `${publicKey.slice(0, lead)}…${publicKey.slice(-tail)}`;
}
