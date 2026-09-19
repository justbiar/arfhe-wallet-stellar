/**
 * StellarAccount — a Stellar keypair derived from the wallet's existing recovery phrase.
 *
 * Stellar is not an EVM chain and this is not an EVM account. The curve is ed25519 rather
 * than secp256k1, the address is a base32 `G...` string rather than a hashed public key, and
 * the derivation path is SEP-5's rather than BIP-44's Ethereum branch. None of the wallet's
 * ethers-based account code applies here, which is why this is a separate module instead of
 * a network added to Network.ts.
 *
 * What it does share is the seed. A user who wrote down twelve words once should not be asked
 * to write down another twelve for a second chain, so the Stellar key is derived from the same
 * mnemonic along SEP-5's path. The two keys are cryptographically unrelated and neither can be
 * derived from the other; only the phrase they both descend from is shared.
 *
 * @see https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0005.md
 */

import { Keypair } from "@stellar/stellar-sdk";

/**
 * SEP-5's registered path for Stellar accounts.
 *
 * `148'` is Stellar's SLIP-44 coin type. Every level is hardened — ed25519 has no public
 * derivation, so unhardened children are not a thing on this curve, and a path written
 * without the apostrophes silently derives a different key.
 */
export const STELLAR_DERIVATION_PATH = "m/44'/148'/0'";

/** Path for the n-th account under the same phrase. */
export function stellarPathForIndex(index: number): string {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`Stellar hesap indeksi 0 veya daha büyük bir tam sayı olmalı: ${index}`);
  }
  return `m/44'/148'/${index}'`;
}

/**
 * Derives the Stellar keypair for one account index of a mnemonic.
 *
 * The passphrase argument is BIP-39's 25th word, not the wallet's unlock password — those are
 * different secrets and conflating them derives an account the user cannot reach from any
 * other wallet. It stays optional and defaults to empty, which is what every other Stellar
 * wallet assumes.
 */
export async function keypairFromMnemonic(
  mnemonic: string,
  index = 0,
  passphrase = ""
): Promise<Keypair> {
  // BIP-39 comes from ethers, which the wallet already depends on for every EVM account —
  // pulling in a second mnemonic library to do the same job would mean two wordlists and two
  // implementations that must agree about what a valid phrase is.
  //
  // ed25519-hd-key is imported lazily and does the part ethers cannot: SLIP-10 derivation on
  // ed25519. ethers' HD code is BIP-32 over secp256k1 and produces a different key entirely.
  const [{ Mnemonic }, { derivePath }] = await Promise.all([
    import("ethers"),
    import("ed25519-hd-key"),
  ]);

  const phrase = normalizeMnemonicPhrase(mnemonic);
  if (!Mnemonic.isValidMnemonic(phrase)) {
    throw new Error("Kurtarma ifadesi geçersiz — kelimeler BIP-39 listesinde değil ya da sağlaması tutmuyor.");
  }

  // `computeSeed` is BIP-39's PBKDF2, salted with "mnemonic" + passphrase, and returns the
  // 64-byte seed SLIP-10 expects. The 0x prefix has to go: derivePath takes plain hex.
  const seedHex = Mnemonic.fromPhrase(phrase, passphrase).computeSeed().replace(/^0x/, "");
  const { key } = derivePath(stellarPathForIndex(index), seedHex);
  return Keypair.fromRawEd25519Seed(key);
}

/**
 * Trims and collapses whitespace in a phrase before it is validated.
 *
 * Phrases arrive pasted, and a trailing newline or a double space between two correct words
 * fails validation in a way that tells the user nothing — the words are right and the wallet
 * says they are wrong. Case is left alone: BIP-39 wordlists are lowercase, and silently
 * lowercasing would hide a genuinely mistyped capital.
 */
export function normalizeMnemonicPhrase(mnemonic: string): string {
  return mnemonic.trim().replace(/\s+/g, " ");
}

/** True for a well-formed Stellar public key (`G...`, base32, 56 chars). */
export function isStellarAddress(value: string): boolean {
  if (typeof value !== "string") return false;
  const v = value.trim();
  if (!/^G[A-Z2-7]{55}$/.test(v)) return false;
  try {
    Keypair.fromPublicKey(v);
    return true;
  } catch {
    return false;
  }
}
