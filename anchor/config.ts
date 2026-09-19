/**
 * What this anchor is, and what it pays with.
 *
 * ── Why we run our own ──
 *
 * The mock anchor we built against (`tr-mock-anchor.fly.dev`) answers HTTP but stopped
 * paying: a deposit sits at `pending_anchor` with the record untouched 60ms after it was
 * opened, while its treasury still holds 28,770 USDC. Measured on 20 September 2026. A demo
 * cannot depend on a service nobody can restart.
 *
 * It also ignores the destination a withdrawal names — three different IBANs came back with
 * the same payout account — so "send it to my IBAN" was not expressible at all. This one
 * honours `dest`, which is the whole reason it exists.
 *
 * ── Keys ──
 *
 * From the environment when it offers them, otherwise generated once into
 * `anchor/.keys.json` (gitignored). The environment comes first because of where this runs:
 * a Codespace's filesystem goes away with the Codespace, and a regenerated distribution key
 * is a treasury nobody can reach — the USDC stays in an account whose secret no longer
 * exists anywhere.
 *
 * Testnet only. The signing key proves the anchor's identity in SEP-10 challenges; the
 * distribution key holds the USDC it pays out.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { Keypair } from "@stellar/stellar-sdk";

export const PORT = Number(process.env.ANCHOR_PORT ?? 8790);

/** Where the anchor believes it is reachable. Must match what wallets are pointed at. */
export const HOME_DOMAIN = process.env.ANCHOR_DOMAIN ?? `localhost:${PORT}`;

/**
 * `http` only for loopback.
 *
 * The TOML publishes absolute URLs, so a forwarded Codespaces port — which is https — must
 * not advertise itself as http: wallets would follow the TOML and every call would fail
 * before it reached us.
 */
export const ORIGIN = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(HOME_DOMAIN)
  ? `http://${HOME_DOMAIN}`
  : `https://${HOME_DOMAIN}`;

export const NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";
export const HORIZON_URL = "https://horizon-testnet.stellar.org";

/**
 * Circle's testnet USDC, the same asset the confidential layer wraps.
 *
 * Deliberately not an asset of our own: the payroll engine's underlying token is this
 * issuer's USDC, and an anchor paying out something else would hand the user a second
 * "USDC" that the rest of the wallet cannot spend.
 */
export const ASSET_CODE = "USDC";
export const ASSET_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

export const FIAT_CODE = "TRY";

/** The anchor's own collection account — shared, the way a Turkish exchange's is. */
export const COLLECTION_IBAN = "TR300009900000000000000042";
export const BANK_NAME = "Arfhe Test Bank A.Ş.";

/**
 * Lira per USDC, and the spread taken on both sides.
 *
 * A fixed mid rate because this is a sandbox and a moving one would make every measurement
 * unrepeatable. The spread exists so the two directions do not quote the same number —
 * an anchor that buys and sells at one price is the one detail that makes a demo look fake
 * to anyone who has used a real one.
 */
export const MID_RATE = 48.79;
export const SPREAD_BPS = 50;

export const FEE_PERCENT = 0.5;

interface Keys { signing: string; distribution: string }

const KEYS_PATH = new URL("./.keys.json", import.meta.url);

function loadKeys(): Keys {
  const fromEnv = {
    signing: process.env.ANCHOR_SIGNING_SECRET,
    distribution: process.env.ANCHOR_DISTRIBUTION_SECRET,
  };
  if (fromEnv.signing && fromEnv.distribution) {
    return { signing: fromEnv.signing, distribution: fromEnv.distribution };
  }

  if (existsSync(KEYS_PATH)) {
    return JSON.parse(readFileSync(KEYS_PATH, "utf8")) as Keys;
  }
  const keys: Keys = {
    signing: Keypair.random().secret(),
    distribution: Keypair.random().secret(),
  };
  writeFileSync(KEYS_PATH, JSON.stringify(keys, null, 2));
  return keys;
}

const keys = loadKeys();

export const SIGNING_KEYPAIR = Keypair.fromSecret(keys.signing);
export const DISTRIBUTION_KEYPAIR = Keypair.fromSecret(keys.distribution);

/** Both prices SEP-38 is asked for, derived from one mid rate so they cannot drift apart. */
export function rates(): { buy: number; sell: number } {
  const spread = MID_RATE * (SPREAD_BPS / 10_000);
  return { buy: MID_RATE + spread, sell: MID_RATE - spread };
}
