/**
 * StellarService — the wallet's Stellar side: addresses, balances, and signing.
 *
 * ── Why nothing new is stored ──
 *
 * The Stellar keypair is derived from the account's existing mnemonic on demand and cached
 * in memory only. It is never written to storage.
 *
 * That is deliberate. Persisting it would add a second secret at rest, a migration for every
 * existing wallet, and another thing `wipeKeys` has to remember to clear — all to avoid a
 * derivation that takes milliseconds. The mnemonic is already the root of both keys; keeping
 * one derived and the other stored would mean two places where the same authority lives.
 *
 * The cache is cleared by {@link forgetDerivedKeys}, which the lock path calls. Without that
 * the ed25519 key would outlive the wallet being locked, which is exactly the property the
 * lock exists to provide.
 *
 * ── Accounts without a mnemonic ──
 *
 * An account imported from a raw private key has no phrase to derive from. There is no way
 * to produce its Stellar key, and inventing an unrelated one would give the user an address
 * their backup cannot restore. Those accounts report no Stellar address, and the UI says so
 * rather than showing an address that behaves like a trap.
 */

import type { Keypair } from "@stellar/stellar-sdk";
import type Account from "./Account.js";
import { keypairFromMnemonic } from "./StellarAccount.js";

/** Stellar testnet. The wallet ships no mainnet Stellar support. */
export const STELLAR_TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
export const STELLAR_HORIZON_TESTNET = "https://horizon-testnet.stellar.org";

/**
 * Derived keys, keyed by the EVM address that identifies the account in the UI.
 *
 * A plain Map rather than a WeakMap: Account objects are re-hydrated from storage on unlock,
 * so identity is not stable across a lock cycle and a WeakMap would never hit. The trade is
 * that this must be cleared explicitly, which {@link forgetDerivedKeys} does.
 */
const derived = new Map<string, Keypair>();

/** Drops every derived Stellar key. Call this wherever the wallet locks. */
export function forgetDerivedKeys(): void {
  derived.clear();
}

/**
 * The Stellar keypair for an account, or null when it has no recovery phrase.
 *
 * @param index SEP-5 account index. Defaults to 0; the wallet currently derives one Stellar
 *        account per EVM account rather than exposing the full path space, because a second
 *        index is a second address the user has to keep track of for no benefit yet.
 */
export async function getKeypair(account: Account, index = 0): Promise<Keypair | null> {
  const phrase = account.mnemonic?.phrase;
  if (!phrase) return null;

  const cacheKey = `${account.GetAddress() ?? phrase.slice(0, 8)}:${index}`;
  const hit = derived.get(cacheKey);
  if (hit) return hit;

  const kp = await keypairFromMnemonic(phrase, index);
  derived.set(cacheKey, kp);
  return kp;
}

/** The `G...` address, or null for an account with no phrase. */
export async function getAddress(account: Account, index = 0): Promise<string | null> {
  return (await getKeypair(account, index))?.publicKey() ?? null;
}

export interface StellarBalance {
  code: string;
  issuer: string | null;
  balance: string;
  isNative: boolean;
}

/**
 * Balances from Horizon.
 *
 * An account that has never been funded does not exist on the ledger and Horizon answers
 * 404. That is a normal state, not a failure, so it comes back as an empty list with
 * `exists: false` rather than throwing into the caller's error path.
 */
export async function getBalances(
  publicKey: string,
  horizonUrl = STELLAR_HORIZON_TESTNET
): Promise<{ exists: boolean; balances: StellarBalance[] }> {
  const res = await fetch(`${horizonUrl}/accounts/${encodeURIComponent(publicKey)}`);
  if (res.status === 404) return { exists: false, balances: [] };
  if (!res.ok) throw new Error(`Stellar hesabı okunamadı (HTTP ${res.status}).`);

  const body = await res.json();
  const balances: StellarBalance[] = (body.balances ?? []).map((b: Record<string, string>) => ({
    code: b.asset_type === "native" ? "XLM" : b.asset_code,
    issuer: b.asset_type === "native" ? null : b.asset_issuer,
    balance: b.balance,
    isNative: b.asset_type === "native",
  }));
  return { exists: true, balances };
}

/**
 * Signs a transaction envelope and returns the signed XDR.
 *
 * The network passphrase is part of what gets signed, so a signature made against the wrong
 * one is invalid everywhere — which is the protection worth having, and the reason it is a
 * required argument rather than a default. A caller that guesses is a caller that can sign a
 * mainnet transaction while believing it signed a testnet one.
 *
 * This only signs. It does not submit: deciding when a signed transaction reaches the
 * network belongs to the caller, and a function that did both would hand out a signature and
 * broadcast it in the same breath.
 */
export async function signTransactionXdr(
  account: Account,
  xdr: string,
  networkPassphrase: string,
  index = 0
): Promise<string> {
  // Checked here as well as in the decoder, because this is the function that actually
  // produces a signature. `TransactionBuilder.fromXDR` accepts any passphrase and records
  // it without complaint, so nothing below would fail on a mainnet envelope — the only
  // thing standing between a testnet signature and a mainnet one is this comparison.
  if (networkPassphrase !== STELLAR_TESTNET_PASSPHRASE) {
    throw new Error(
      `Bu ağ desteklenmiyor: "${networkPassphrase}". Cüzdan yalnızca Stellar testnet üzerinde imzalar.`
    );
  }

  const kp = await getKeypair(account, index);
  if (!kp) {
    throw new Error("Bu hesabın kurtarma ifadesi yok, Stellar işlemi imzalanamaz.");
  }

  const { TransactionBuilder } = await import("@stellar/stellar-sdk");
  const tx = TransactionBuilder.fromXDR(xdr, networkPassphrase);
  tx.sign(kp);
  return tx.toXDR();
}
