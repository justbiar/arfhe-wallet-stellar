/**
 * The SEP calls the ramp is made of: discovery, authentication, deposit, and polling.
 *
 * Nothing about the anchor is hardcoded beyond its home domain. Every endpoint and the
 * asset's issuer are read from stellar.toml at runtime, which is the whole point of the
 * standard — pointing this at a production anchor should be a change of domain, not a change
 * of code. The functions below therefore take a resolved `AnchorConfig` rather than reaching
 * for constants of their own.
 */

import { TransactionBuilder } from "@stellar/stellar-sdk";
import { ANCHOR_HOME_DOMAIN, ANCHOR_ASSET_CODE, anchorOrigin } from "./anchor";
import type { PanelSigner } from "./signer";

export interface AnchorConfig {
  webAuthEndpoint: string;
  transferServer: string;
  networkPassphrase: string;
  assetIssuer: string;
}

/** SEP-1: everything else is discovered from here. */
export async function discoverAnchor(homeDomain = ANCHOR_HOME_DOMAIN): Promise<AnchorConfig> {
  const res = await fetch(`${anchorOrigin(homeDomain)}/.well-known/stellar.toml`);
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
export async function authenticate(cfg: AnchorConfig, signer: PanelSigner): Promise<string> {
  const chRes = await fetch(`${cfg.webAuthEndpoint}?account=${encodeURIComponent(signer.publicKey)}`);
  const challenge = await chRes.json();
  if (!chRes.ok || !challenge.transaction) {
    throw new Error(challenge.error ?? `Giriş isteği reddedildi (HTTP ${chRes.status}).`);
  }

  // The anchor states the network it built the challenge for. Signing a challenge for one
  // network with a key the user believes is on another is exactly the confusion SEP-10's
  // own spec warns about, so a mismatch stops here rather than being signed and rejected.
  const challengeNetwork = challenge.network_passphrase ?? cfg.networkPassphrase;
  if (challengeNetwork !== cfg.networkPassphrase) {
    throw new Error(
      `Anchor başka bir ağ için giriş isteği gönderdi: "${challengeNetwork}".`
    );
  }

  const signedXdr = await signer.signXdr(challenge.transaction);

  const tokRes = await fetch(cfg.webAuthEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ transaction: signedXdr }),
  });
  const body = await tokRes.json();
  if (!tokRes.ok || !body.token) {
    throw new Error(body.error ?? `Giriş doğrulanamadı (HTTP ${tokRes.status}).`);
  }
  return body.token as string;
}

export interface DepositOrder {
  id: string;
  /** Human-readable bank instructions, for display where the structured fields are absent. */
  how: string;
  iban: string | null;
  bankName: string | null;
  /** The reference the transfer description must carry; without it the money is unroutable. */
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

  // SEP-6's `instructions` carries these as named fields. Reading them beats scraping the
  // prose in `how`: a reworded sentence or a different IBAN format would silently break a
  // regex, and the failure would look like the anchor returning nothing.
  const how: string = body.how ?? "";
  const ins = body.instructions ?? {};
  const field = (k: string): string | null => ins[k]?.value ?? null;

  return {
    id: body.id,
    how,
    iban: field("bank_account_number") ?? how.match(/\b(TR\d{24})\b/)?.[1] ?? null,
    bankName: field("bank_name"),
    reference: field("external_transfer_memo") ?? how.match(/"([A-Z0-9-]{8,})"/)?.[1] ?? null,
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

export interface WithdrawOrder {
  id: string;
  /** The anchor's treasury. The USDC payment goes here and nowhere else. */
  destination: string;
  /** The reference that ties the payment to this order. */
  memo: string;
  memoType: string;
  /** The anchor's own sentence about what it will do, shown verbatim. */
  message: string;
  /** Where the fiat lands, when the anchor names an account. */
  iban: string | null;
  /** Minimum off-ramp the anchor will accept, in the asset's units. */
  minAmount: string | null;
  /** The lira the anchor quoted for this withdrawal, when it names a figure. */
  amountOut: string | null;
}

/**
 * SEP-6 withdraw — the opposite direction, and the one where a mistake is unrecoverable.
 *
 * Deposit is safe to get wrong: the money has not moved, and a bad order is abandoned. A
 * withdrawal is the user sending real value to a treasury account, matched to their request
 * by memo alone. So every field the payment depends on is required here, and a response
 * missing one fails before anything is sent rather than after.
 *
 * `amount` is USDC on this side, unlike deposit's TRY.
 */
export async function startWithdraw(
  cfg: AnchorConfig,
  jwt: string,
  amountUsdc: string
): Promise<WithdrawOrder> {
  const url =
    `${cfg.transferServer}/withdraw?asset_code=${ANCHOR_ASSET_CODE}` +
    `&type=bank_account&amount=${encodeURIComponent(amountUsdc)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${jwt}` } });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `Çekim açılamadı (HTTP ${res.status}).`);

  if (!body.id || !body.account_id || !body.memo || !body.memo_type) {
    throw new Error("Anchor eksik çekim talimatı döndürdü: hesap ya da memo yok.");
  }

  const message: string = body.extra_info?.message ?? "";
  return {
    id: body.id,
    destination: body.account_id,
    memo: String(body.memo),
    memoType: body.memo_type,
    message,
    // No structured field carries the destination IBAN, so it is pulled out of the
    // anchor's sentence for display only — the payment does not depend on it, and a null
    // here costs nothing but a blank line.
    iban: message.match(/\b(TR\d{24})\b/)?.[1] ?? null,
    minAmount: body.min_amount != null ? String(body.min_amount) : null,
    // Read as a field where the anchor offers one, and left null otherwise rather than
    // scraped out of the sentence: a quote picked out of prose is a number the screen
    // cannot stand behind.
    amountOut: body.amount_out != null ? String(body.amount_out) : null,
  };
}

export interface TxStatus {
  status: string;
  amountIn: string | null;
  amountOut: string | null;
  /** The on-chain payment hash, once the anchor has settled. Checkable on any explorer. */
  stellarTxId: string | null;
  /** The anchor's own reference for the fiat leg. */
  externalTxId: string | null;
  /** Set when the payment could not be delivered and is waiting to be claimed. */
  claimableBalanceId: string | null;
}

export async function readTransaction(cfg: AnchorConfig, jwt: string, id: string): Promise<TxStatus> {
  const res = await fetch(`${cfg.transferServer}/transaction?id=${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${jwt}` },
  });
  const body = await res.json();

  // A request the anchor no longer knows about is the end of this flow, not a slow tick.
  // The anchor keeps its records in memory, so a restart drops whatever was in flight; the
  // page used to read the 404 as "no status yet" and poll for another minute before
  // reporting that the anchor had not settled in time — which sends the user looking for a
  // payment that nothing is working on.
  if (res.status === 404) {
    throw new Error(
      "Bu talep anchor'da bulunamadı — büyük ihtimalle anchor yeniden başlatıldı. " +
      "Yeni bir yükleme açın; gönderilmiş bir para varsa duruyor.",
    );
  }
  if (!res.ok) throw new Error(body.error ?? `Anchor işlem durumunu vermedi (HTTP ${res.status}).`);
  const t = body.transaction ?? {};
  return {
    status: t.status ?? "unknown",
    amountIn: t.amount_in ?? null,
    amountOut: t.amount_out ?? null,
    stellarTxId: t.stellar_transaction_id ?? null,
    externalTxId: t.external_transaction_id ?? null,
    claimableBalanceId: t.claimable_balance_id ?? null,
  };
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
  let last: TxStatus = { status: "unknown", amountIn: null, amountOut: null, stellarTxId: null, externalTxId: null, claimableBalanceId: null };
  for (let i = 0; i < maxTicks; i++) {
    await new Promise((r) => setTimeout(r, intervalMs));
    last = await readTransaction(cfg, jwt, id);
    onTick?.(last);
    if (TERMINAL_STATUSES.has(last.status)) return last;
  }
  throw new Error("Anchor beklenen sürede sonuçlandırmadı. İşlem hâlâ sürüyor olabilir.");
}
