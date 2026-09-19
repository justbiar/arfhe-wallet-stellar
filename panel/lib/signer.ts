/**
 * Who signs, and where the key lives.
 *
 * The panel can run two ways and the difference matters more than it looks:
 *
 *   - **demo** — a throwaway testnet key this tab generates. Convenient, and it makes the
 *     flow work for a visitor with nothing installed.
 *   - **arfhe** — the extension. The key never enters this page; an envelope goes out, a
 *     signed envelope comes back, and a person approved it in between.
 *
 * Everything downstream is written against {@link PanelSigner} rather than a `Keypair`, so
 * the SEP calls, the trustline and the withdrawal payment are the same code either way. That
 * is the point: the demo path is not a separate implementation that might drift from the
 * real one, it is the same path with a different signer.
 *
 * What neither mode does is ask for a recovery phrase. There is no field for one anywhere in
 * this panel, and a page that asked would be indistinguishable from the phishing page that
 * imitates it.
 */

import { Keypair, TransactionBuilder } from "@stellar/stellar-sdk";
import { NETWORK_PASSPHRASE } from "./anchor";

export type SignerKind = "demo" | "arfhe";

export interface PanelSigner {
  kind: SignerKind;
  publicKey: string;
  /** Takes an unsigned envelope, returns a signed one. Never returns the key. */
  signXdr(xdr: string): Promise<string>;
}

/** The slice of the injected provider this panel uses. */
interface ArfheProvider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  stellar?: {
    getAddress(): Promise<string | null>;
    signTransaction(xdr: string, networkPassphrase: string): Promise<string>;
  };
}

function injected(): ArfheProvider | null {
  const w = window as unknown as { arfheWallet?: ArfheProvider };
  return w.arfheWallet ?? null;
}

/**
 * Whether the extension is present.
 *
 * The provider is injected by a content script, which may land after this module runs, so a
 * single check at import time reports "not installed" for a wallet that is merely slow. The
 * caller polls briefly instead.
 */
export function hasArfhe(): boolean {
  return injected()?.stellar !== undefined;
}

/** Resolves once the provider appears, or false after `timeoutMs`. */
export async function waitForArfhe(timeoutMs = 1500): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (hasArfhe()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return hasArfhe();
}

const SESSION_KEY = "arfhe_panel_demo_secret";

/**
 * The throwaway account for this tab, created on first use.
 *
 * sessionStorage: it survives a reload while someone works through the flow, and is gone
 * when the tab closes. It holds testnet assets with no value.
 */
export function demoSigner(): PanelSigner & { keypair: Keypair } {
  let kp: Keypair;
  try {
    const stored = sessionStorage.getItem(SESSION_KEY);
    kp = stored ? Keypair.fromSecret(stored) : Keypair.random();
    if (!stored) sessionStorage.setItem(SESSION_KEY, kp.secret());
  } catch {
    // Private window, or storage blocked. A memory-only key still completes the flow for
    // the length of this page view, which is the whole life of a demo account anyway.
    kp = Keypair.random();
  }

  return {
    kind: "demo",
    keypair: kp,
    publicKey: kp.publicKey(),
    async signXdr(xdr: string) {
      const tx = TransactionBuilder.fromXDR(xdr, NETWORK_PASSPHRASE);
      tx.sign(kp);
      return tx.toXDR();
    },
  };
}

/**
 * Connects the extension: asks for a connection, then for the Stellar address.
 *
 * `eth_requestAccounts` comes first because `stellar_getAddress` answers connected sites
 * only — it never prompts, so calling it cold returns nothing and would read as "the wallet
 * has no Stellar address" rather than "this site is not connected yet".
 *
 * A null address is a real answer, not a failure to paper over: an account imported from a
 * raw private key has no recovery phrase to derive a Stellar key from, and telling the user
 * that is more use than a retry loop.
 */
export async function connectArfhe(): Promise<PanelSigner> {
  const provider = injected();
  if (!provider?.stellar) {
    throw new Error("Arfhe Wallet bulunamadı. Uzantı kurulu ve açık olmalı.");
  }

  await provider.request({ method: "eth_requestAccounts" });

  const address = await provider.stellar.getAddress();
  if (!address) {
    throw new Error(
      "Bu hesabın Stellar adresi yok. Özel anahtarla içe aktarılmış hesapların türetilecek " +
      "kurtarma ifadesi bulunmaz; kurtarma ifadesiyle oluşturulmuş bir hesaba geçin."
    );
  }

  return {
    kind: "arfhe",
    publicKey: address,
    async signXdr(xdr: string) {
      // The passphrase is passed explicitly and the wallet checks it again on its side.
      // Two checks for one property is deliberate: this one is a convenience, the wallet's
      // is the one that cannot be bypassed by whatever is running on this page.
      const signed = await provider.stellar!.signTransaction(xdr, NETWORK_PASSPHRASE);
      if (typeof signed !== "string" || signed.length === 0) {
        throw new Error("Cüzdan imzalı işlemi döndürmedi.");
      }
      return signed;
    },
  };
}
