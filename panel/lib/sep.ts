/**
 * The SEP calls the ramp is made of: discovery, authentication, deposit, and polling.
 *
 * Nothing about the anchor is hardcoded beyond its home domain. Every endpoint and the
 * asset's issuer are read from stellar.toml at runtime, which is the whole point of the
 * standard — pointing this at a production anchor should be a change of domain, not a change
 * of code. The functions below therefore take a resolved `AnchorConfig` rather than reaching
 * for constants of their own.
 */

import { Keypair, TransactionBuilder } from "@stellar/stellar-sdk";
import { ANCHOR_HOME_DOMAIN, ANCHOR_ASSET_CODE } from "./anchor";

export interface AnchorConfig {
  webAuthEndpoint: string;
  transferServer: string;
  networkPassphrase: string;
  assetIssuer: string;
}

/** SEP-1: everything else is discovered from here. */
export async function discoverAnchor(homeDomain = ANCHOR_HOME_DOMAIN): Promise<AnchorConfig> {
  const res = await fetch(`https://${homeDomain}/.well-known/stellar.toml`);
  if (!res.ok) throw new Error(`Anchor bulunamadı: stellar.toml okunamadı (HTTP ${res.status}).`);
  const toml = await res.text();

  const scalar = (key: string) => toml.match(new RegExp(`^${key}\\s*=\\s*"([^"]+)"`, "m"))?.[1];

  // The issuer is inside a [[CURRENCIES]] block, so it is matched against the block that
  // names our asset rather than the first issuer in the file — a toml listing several
  // currencies would otherwise hand back the wrong one.
  const currencyBlock = toml
    .split(/\[\[CURRENCIES\]\]/)
    .find((b) => new RegExp(`code\\s*=\\s*"${ANCHOR_ASSET_CODE}"`).test(b));
  const assetIssuer = currencyBlock?.match(/issuer\s*=\s*"([^"]+)"/)?.[1];

  const webAuthEndpoint = scalar("WEB_AUTH_ENDPOINT");
  const transferServer = scalar("TRANSFER_SERVER");
  const networkPassphrase = scalar("NETWORK_PASSPHRASE");

  if (!webAuthEndpoint || !transferServer || !networkPassphrase || !assetIssuer) {
    throw new Error("Anchor'ın stellar.toml dosyası eksik: auth, transfer, ağ ya da varlık bilgisi yok.");
  }
  return { webAuthEndpoint, transferServer, networkPassphrase, assetIssuer };
}

/**
 * SEP-10: prove control of the key and get a session token.
 *
 * There is no password and no account — the signature over the anchor's challenge IS the
 * login. The challenge is signed locally and only the signed transaction leaves the browser.
 */
export async function authenticate(cfg: AnchorConfig, kp: Keypair): Promise<string> {
  const chRes = await fetch(`${cfg.webAuthEndpoint}?account=${encodeURIComponent(kp.publicKey())}`);
  const challenge = await chRes.json();
  if (!chRes.ok || !challenge.transaction) {
    throw new Error(challenge.error ?? `Giriş isteği reddedildi (HTTP ${chRes.status}).`);
  }

  const tx = TransactionBuilder.fromXDR(
    challenge.transaction,
    challenge.network_passphrase ?? cfg.networkPassphrase
  );
  tx.sign(kp);

  const tokRes = await fetch(cfg.webAuthEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ transaction: tx.toXDR() }),
  });
  const body = await tokRes.json();
  if (!tokRes.ok || !body.token) {
    throw new Error(body.error ?? `Giriş doğrulanamadı (HTTP ${tokRes.status}).`);
  }
  return body.token as string;
}

export interface DepositOrder {
  id: string;
  /** Human-readable bank instructions: the IBAN and the reference to put in the description. */
  how: string;
  /** Pulled out of `how` so the UI can show it as the field it is. */
  iban: string | null;
  reference: string | null;
}

/**
 * SEP-6 deposit.
 *
 * `amount` is TRY, not USDC. Asking for 100 returns roughly 2 USDC at the posted rate, which
 * reads like a broken conversion until you notice which side of the pair it names.
 */
export async function startDeposit(
  cfg: AnchorConfig,
  jwt: string,
  account: string,
  amountTry: string
): Promise<DepositOrder> {
  const url =
    `${cfg.transferServer}/deposit?asset_code=${ANCHOR_ASSET_CODE}` +
    `&account=${encodeURIComponent(account)}&type=bank_account&amount=${encodeURIComponent(amountTry)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${jwt}` } });
  const body = await res.json();
  if (!res.ok || !body.id) throw new Error(body.error ?? `Yükleme açılamadı (HTTP ${res.status}).`);

  const how: string = body.how ?? "";
  return {
    id: body.id,
    how,
    iban: how.match(/\b(TR\d{24})\b/)?.[1] ?? null,
    reference: how.match(/"([A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4})"/)?.[1] ?? null,
  };
}

/** Sandbox only: stands in for the bank confirming the transfer arrived. */
export async function simulateBankTransfer(
  cfg: AnchorConfig,
  jwt: string,
  id: string,
  amountTry: string
): Promise<void> {
  const res = await fetch(`${cfg.transferServer}/tx/${encodeURIComponent(id)}/simulate-bank-transfer`, {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
    body: JSON.stringify({ amount: amountTry }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Havale simülasyonu reddedildi (HTTP ${res.status}).`);
  }
}

export interface TxStatus {
  status: string;
  amountIn: string | null;
  amountOut: string | null;
}

export async function readTransaction(cfg: AnchorConfig, jwt: string, id: string): Promise<TxStatus> {
  const res = await fetch(`${cfg.transferServer}/transaction?id=${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${jwt}` },
  });
  const body = await res.json();
  const t = body.transaction ?? {};
  return { status: t.status ?? "unknown", amountIn: t.amount_in ?? null, amountOut: t.amount_out ?? null };
}

/** Terminal states — anything else means the anchor is still working. */
export const TERMINAL_STATUSES = new Set(["completed", "error", "refunded"]);

/**
 * Polls until the anchor settles or the budget runs out.
 *
 * Generous by design: observed runs settled in anything from two to four polls, so a tight
 * timeout would report a failure on a transaction that was about to succeed. `onTick` exists
 * so the UI can show the status changing rather than a spinner with nothing behind it.
 */
export async function waitForSettlement(
  cfg: AnchorConfig,
  jwt: string,
  id: string,
  onTick?: (s: TxStatus) => void,
  { intervalMs = 2500, maxTicks = 24 }: { intervalMs?: number; maxTicks?: number } = {}
): Promise<TxStatus> {
  let last: TxStatus = { status: "unknown", amountIn: null, amountOut: null };
  for (let i = 0; i < maxTicks; i++) {
    await new Promise((r) => setTimeout(r, intervalMs));
    last = await readTransaction(cfg, jwt, id);
    onTick?.(last);
    if (TERMINAL_STATUSES.has(last.status)) return last;
  }
  throw new Error("Anchor beklenen sürede sonuçlandırmadı. İşlem hâlâ sürüyor olabilir.");
}
