/**
 * The anchor this panel talks to, and the handful of constants that identify it.
 *
 * Everything else — where to authenticate, where to deposit, who issues the asset — is
 * discovered at runtime from the anchor's stellar.toml (SEP-1), which is the point of the
 * standard: the integration is two values, a home domain and an asset code, and swapping in
 * a real anchor later changes only those and the network passphrase.
 *
 * @see https://tr-mock-anchor.fly.dev/ — the sandbox this is built against. The bank and KYC
 * are simulated there; the Stellar leg is real testnet USDC.
 */

/** The anchor's home domain. SEP-1 discovery starts here. */
/**
 * Where the anchor lives.
 *
 * Build-time, not hardcoded: the sandbox anchor runs wherever it is convenient — on this
 * machine during development, on a forwarded Codespaces port for a demo — and each of those
 * is a different host. `VITE_ANCHOR_DOMAIN` moves it without touching source, and the
 * default keeps `npm run anchor` working with no configuration at all.
 *
 * Only the domain. Everything else — auth endpoint, transfer server, asset issuer — is read
 * from the anchor's own TOML at runtime, which is what makes swapping one in this cheap.
 */
export const ANCHOR_HOME_DOMAIN =
  (import.meta.env?.VITE_ANCHOR_DOMAIN as string | undefined) ?? "localhost:8790";

/**
 * `http` for a local anchor, `https` for anything else.
 *
 * The sandbox anchor this is built against now runs on the same machine, and a loopback
 * address is the one place a browser treats plain HTTP as trustworthy. Hardcoding `https`
 * made every request to it fail at the TLS handshake — an error that reads like the anchor
 * being down rather than the URL being wrong.
 */
export function anchorOrigin(homeDomain: string): string {
  const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(homeDomain);
  return `${local ? "http" : "https"}://${homeDomain}`;
}

/** The asset being ramped. The issuer is read from stellar.toml, never hardcoded here. */
export const ANCHOR_ASSET_CODE = "USDC";

/** Fiat side of the ramp. */
export const FIAT_CODE = "TRY";

/**
 * Stellar testnet, for as long as this is a sandbox.
 *
 * Kept next to the home domain deliberately: these two move together. Pointing the panel at
 * a production anchor means changing both, and a mismatch — mainnet passphrase against a
 * testnet anchor — fails in ways that look like an auth bug rather than a config one.
 */
export const NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";
export const HORIZON_URL = "https://horizon-testnet.stellar.org";

/** Deposit limits the anchor advertises, in TRY. Shown in the UI before a request is made. */
export const DEPOSIT_MIN_TRY = 50;
export const DEPOSIT_MAX_TRY = 3000;

/** Minimum off-ramp, in USDC. */
export const WITHDRAW_MIN_USDC = 1;
