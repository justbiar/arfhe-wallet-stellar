/**
 * AnchorService — the wallet's bank side: Turkish lira in, USDC out.
 *
 * ── What an anchor actually gives you ──
 *
 * Not an IBAN per wallet. Measured against this anchor on 19 September 2026: two different
 * Stellar accounts asking for deposit instructions both got `TR050009900000000000000001`,
 * the anchor's own bank account, and differed only in the reference code. So the UI says
 * "send to this account with this reference" — the shape a Turkish exchange uses — rather
 * than inventing a per-user IBAN that no bank issued.
 *
 * The reference is minted per deposit request, not per account. It cannot be shown before
 * the user says how much they are sending, and a stale one belongs to a closed request.
 *
 * ── The trustline ──
 *
 * A deposit stops at `pending_trust` when the receiving account has no USDC trustline: the
 * anchor has the money and nowhere to put it. That is not an error to surface as a failure,
 * it is a step the user can complete — so this module can both detect it and open the line.
 *
 * Testnet only, like the rest of the wallet's Stellar side.
 */

import type Account from "./Account.js";
import { getKeypair, STELLAR_TESTNET_PASSPHRASE, STELLAR_HORIZON_TESTNET } from "./StellarService.js";

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
export const FIAT_CODE = "TRY";

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

export const ASSET_CODE = "USDC";

export interface AnchorConfig {
  webAuthEndpoint: string;
  transferServer: string;
  /** Circle's testnet USDC issuer, as the anchor declares it in its own TOML. */
  assetIssuer: string;
  networkPassphrase: string;
}

export interface DepositInstructions {
  id: string;
  /** The anchor's bank account — shared by every user, and labelled as such in the UI. */
  iban: string | null;
  bankName: string | null;
  /** What makes the transfer yours. Without it in the description, nothing matches. */
  reference: string | null;
  amountTry: string;
}

export interface AnchorTx {
  id: string;
  kind: string;
  status: string;
  amountIn: string | null;
  amountOut: string | null;
  amountFee: string | null;
  startedAt: string | null;
  stellarTxId: string | null;
  /** The anchor's own account of what it is doing. Shown rather than paraphrased. */
  message: string | null;
  /** Seconds the anchor claims the current step takes. Its own estimate, not a promise. */
  statusEta: number | null;
  /** Where the anchor will explain itself when this screen cannot. */
  moreInfoUrl: string | null;
  /** When the anchor last touched the record — the difference between working and stuck. */
  updatedAt: string | null;
}

/**
 * Read from the anchor's TOML rather than hardcoded.
 *
 * The endpoints are the anchor's to move, and a wallet that pins them keeps working right
 * up until it silently does not. Cached for the session because the file rarely changes and
 * every call below needs it.
 */
let cached: AnchorConfig | null = null;

export async function discover(homeDomain = ANCHOR_HOME_DOMAIN): Promise<AnchorConfig> {
  if (cached) return cached;

  const res = await fetch(`${anchorOrigin(homeDomain)}/.well-known/stellar.toml`);
  if (!res.ok) throw new Error(`Anchor bilgisi okunamadı (HTTP ${res.status}).`);
  const toml = await res.text();

  const read = (key: string): string | null =>
    toml.match(new RegExp(`^${key}\\s*=\\s*"([^"]+)"`, "m"))?.[1] ?? null;

  const webAuthEndpoint = read("WEB_AUTH_ENDPOINT");
  const transferServer = read("TRANSFER_SERVER");
  const networkPassphrase = read("NETWORK_PASSPHRASE") ?? STELLAR_TESTNET_PASSPHRASE;
  const assetIssuer = toml.match(/issuer\s*=\s*"([^"]+)"/)?.[1] ?? null;

  if (!webAuthEndpoint || !transferServer || !assetIssuer) {
    throw new Error("Anchor bilgisi eksik: giriş veya transfer ucu tanımlı değil.");
  }

  // Signing a challenge built for another network is the confusion SEP-10 warns about, so
  // the wallet refuses an anchor that is not on the network it believes it is on.
  if (networkPassphrase !== STELLAR_TESTNET_PASSPHRASE) {
    throw new Error(`Anchor başka bir ağda: "${networkPassphrase}".`);
  }

  cached = { webAuthEndpoint, transferServer, assetIssuer, networkPassphrase };
  return cached;
}

/** SEP-10 tokens, per Stellar address, for this session only. */
const tokens = new Map<string, string>();

/** Dropped wherever the wallet locks, alongside the derived Stellar keys. */
export function forgetAnchorSessions(): void {
  tokens.clear();
  cached = null;
}

export async function authenticate(account: Account, index = 0): Promise<string> {
  const kp = await getKeypair(account, index);
  if (!kp) throw new Error("Bu hesabın Stellar adresi yok.");

  const hit = tokens.get(kp.publicKey());
  if (hit) return hit;

  const cfg = await discover();
  const chRes = await fetch(`${cfg.webAuthEndpoint}?account=${encodeURIComponent(kp.publicKey())}`);
  const challenge = await chRes.json();
  if (!chRes.ok || !challenge.transaction) {
    throw new Error(challenge.error ?? `Anchor girişi reddedildi (HTTP ${chRes.status}).`);
  }
  if ((challenge.network_passphrase ?? cfg.networkPassphrase) !== cfg.networkPassphrase) {
    throw new Error("Anchor başka bir ağ için giriş isteği gönderdi.");
  }

  const { TransactionBuilder } = await import("@stellar/stellar-sdk");
  const tx = TransactionBuilder.fromXDR(challenge.transaction, cfg.networkPassphrase);
  tx.sign(kp);

  const tokRes = await fetch(cfg.webAuthEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ transaction: tx.toXDR() }),
  });
  const body = await tokRes.json();
  if (!tokRes.ok || !body.token) {
    throw new Error(body.error ?? `Anchor girişi tamamlanamadı (HTTP ${tokRes.status}).`);
  }

  tokens.set(kp.publicKey(), body.token);
  return body.token;
}

/**
 * The deposit identity this wallet shows at the top of the bank screen.
 *
 * ── Why it is cached rather than fetched ──
 *
 * Measured: the anchor mints a new reference on every `/deposit` call, tying it to the
 * request rather than to the account. Fetching one per visit would give the user a code
 * that changes while they are typing it into their banking app — and a transfer carrying
 * yesterday's code with nothing expecting it.
 *
 * So the first call is kept. One open deposit request per account, stored locally, shown
 * as "your reference" the way an exchange shows a collection account: the IBAN belongs to
 * the anchor, the reference is what makes the money yours. An amount is not needed to
 * create it (also measured), which is what lets this exist before the user decides to send
 * anything.
 *
 * Nothing secret lives here — a public bank account and a routing code — so it sits in
 * local storage next to the rest of the wallet's non-sensitive state.
 */
const IDENTITY_KEY = "arfhe_bank_identity";

type IdentityStore = Record<string, DepositInstructions>;

async function readIdentities(): Promise<IdentityStore> {
  try {
    const got = await chrome.storage.local.get(IDENTITY_KEY);
    return (got?.[IDENTITY_KEY] as IdentityStore) ?? {};
  } catch {
    return {};
  }
}

export async function getDepositIdentity(
  account: Account,
  index = 0,
  { refresh = false } = {}
): Promise<DepositInstructions> {
  const kp = await getKeypair(account, index);
  if (!kp) throw new Error("Bu hesabın Stellar adresi yok.");
  const key = kp.publicKey();

  const store = await readIdentities();
  if (!refresh && store[key]?.reference) return store[key];

  // No amount: the identity exists before the user has decided to send anything, and the
  // anchor settles whatever actually arrives against the reference.
  const fresh = await openDeposit(account, "", index);
  try {
    await chrome.storage.local.set({ [IDENTITY_KEY]: { ...store, [key]: fresh } });
  } catch {
    // An identity that cannot be cached is still usable for this session; the next visit
    // simply asks again rather than failing.
  }
  return fresh;
}

export async function openDeposit(
  account: Account,
  amountTry: string,
  index = 0
): Promise<DepositInstructions> {
  const kp = await getKeypair(account, index);
  if (!kp) throw new Error("Bu hesabın Stellar adresi yok.");
  const cfg = await discover();
  const token = await authenticate(account, index);

  const url =
    `${cfg.transferServer}/deposit?asset_code=${ASSET_CODE}` +
    `&account=${encodeURIComponent(kp.publicKey())}&type=bank_account` +
    // SEP-6 makes the amount optional, and the anchor answers without it — which is what
    // lets the bank screen show a reference before the user has picked a number.
    (amountTry ? `&amount=${encodeURIComponent(amountTry)}` : "");
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const body = await res.json();
  if (!res.ok || !body.id) {
    throw new Error(body.error ?? `Yatırma talimatı alınamadı (HTTP ${res.status}).`);
  }

  // SEP-6 carries these as named instruction fields; the prose in `how` is a fallback for
  // an anchor that only writes a sentence. Reading the fields first means a reworded
  // sentence cannot silently break the screen.
  const ins = body.instructions ?? {};
  const field = (k: string): string | null => ins[k]?.value ?? null;
  const how: string = body.how ?? "";

  return {
    id: body.id,
    iban: field("bank_account_number") ?? how.match(/\b(TR\d{24})\b/)?.[1] ?? null,
    bankName: field("bank_name"),
    reference: field("external_transfer_memo") ?? how.match(/"([A-Z0-9-]{8,})"/)?.[1] ?? null,
    amountTry,
  };
}

/**
 * The IBAN this account's lira come out to, as the anchor assigns it.
 *
 * Measured: the anchor mints one per Stellar account and returns the same one across
 * sessions, so a single lookup is enough for good. Cached for that reason and one more —
 * reading it means opening a withdrawal request, and a wallet that opened a fresh request
 * every time someone looked at the screen would leave a trail of orders nobody ever paid.
 *
 * Stored beside the deposit identity: both are public bank details, neither is a secret.
 */
const PAYOUT_KEY = "arfhe_bank_payout_iban";

export async function getPayoutIban(account: Account, index = 0): Promise<string | null> {
  const kp = await getKeypair(account, index);
  if (!kp) return null;
  const key = kp.publicKey();

  try {
    const got = await chrome.storage.local.get(PAYOUT_KEY);
    const store = (got?.[PAYOUT_KEY] as Record<string, string>) ?? {};
    if (store[key]) return store[key];

    // The smallest request that makes the anchor name the account. Never paid, and the
    // anchor drops an unpaid request on its own.
    const order = await openWithdraw(account, "1", index);
    if (!order.payoutIban) return null;
    await chrome.storage.local.set({ [PAYOUT_KEY]: { ...store, [key]: order.payoutIban } });
    return order.payoutIban;
  } catch {
    return null;
  }
}

export interface WithdrawOrder {
  id: string;
  /** The anchor's Stellar account. The USDC payment goes here and nowhere else. */
  accountId: string;
  /** Without this memo the anchor cannot tell whose withdrawal the payment settles. */
  memo: string;
  memoType: string;
  /**
   * Where the lira lands.
   *
   * Measured against this anchor: it assigns one per Stellar account and keeps it across
   * sessions, and it ignores a `dest` the caller supplies — three requests with three
   * different destinations all came back with the same payout account. So this is read
   * from the anchor's answer rather than collected from the user: a field whose value is
   * discarded is worse than no field, and asking for someone's real IBAN to then ignore it
   * would be the worst version of that.
   */
  payoutIban: string | null;
  etaSeconds: number | null;
}

export async function openWithdraw(
  account: Account,
  amountUsdc: string,
  index = 0
): Promise<WithdrawOrder> {
  const kp = await getKeypair(account, index);
  if (!kp) throw new Error("Bu hesabın Stellar adresi yok.");
  const cfg = await discover();
  const token = await authenticate(account, index);

  const url =
    `${cfg.transferServer}/withdraw?asset_code=${ASSET_CODE}&type=bank_account` +
    `&account=${encodeURIComponent(kp.publicKey())}&amount=${encodeURIComponent(amountUsdc)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const body = await res.json();
  if (!res.ok || !body.account_id) {
    throw new Error(body.error ?? `Çekim talebi açılamadı (HTTP ${res.status}).`);
  }

  return {
    id: body.id,
    accountId: body.account_id,
    memo: String(body.memo ?? ""),
    memoType: String(body.memo_type ?? "id"),
    payoutIban: body.extra_info?.message?.match(/\b(TR\d{24})\b/)?.[1] ?? null,
    etaSeconds: typeof body.eta === "number" ? body.eta : null,
  };
}

/**
 * Pays the anchor so it can pay the bank.
 *
 * The memo is the whole reason this cannot be a plain send: the anchor matches the payment
 * to the request by it, and a payment that arrives without one is money in the anchor's
 * account with nothing saying whose it is. It is set here rather than left to the caller
 * for the same reason the network passphrase is required elsewhere — the failure is silent
 * and the loss is the user's.
 */
export async function payWithdrawal(
  account: Account,
  order: WithdrawOrder,
  amountUsdc: string,
  index = 0
): Promise<string> {
  const kp = await getKeypair(account, index);
  if (!kp) throw new Error("Bu hesabın Stellar adresi yok.");
  const cfg = await discover();

  const { Horizon, TransactionBuilder, Operation, Asset, Memo, BASE_FEE } = await import("@stellar/stellar-sdk");
  const server = new Horizon.Server(STELLAR_HORIZON_TESTNET);
  const source = await server.loadAccount(kp.publicKey());

  const tx = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: cfg.networkPassphrase })
    .addOperation(Operation.payment({
      destination: order.accountId,
      asset: new Asset(ASSET_CODE, cfg.assetIssuer),
      amount: amountUsdc,
    }))
    .addMemo(order.memoType === "id" ? Memo.id(order.memo) : Memo.text(order.memo))
    .setTimeout(120)
    .build();
  tx.sign(kp);

  const result = await server.submitTransaction(tx);
  return result.hash;
}

/**
 * Sandbox only: stands in for the bank telling the anchor the money arrived.
 *
 * A real anchor learns this from its bank. This exists because the demo has no bank, and it
 * is labelled in the UI rather than hidden — a button that fakes a bank transfer should
 * never look like one that makes one.
 */
export async function simulateBankTransfer(
  account: Account,
  depositId: string,
  amountTry: string,
  index = 0
): Promise<void> {
  const cfg = await discover();
  const token = await authenticate(account, index);
  const res = await fetch(`${cfg.transferServer}/tx/${encodeURIComponent(depositId)}/simulate-bank-transfer`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ amount: amountTry }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Havale simülasyonu reddedildi (HTTP ${res.status}).`);
  }
}

export async function listTransactions(account: Account, index = 0): Promise<AnchorTx[]> {
  const kp = await getKeypair(account, index);
  if (!kp) return [];
  const cfg = await discover();
  const token = await authenticate(account, index);

  const url =
    `${cfg.transferServer}/transactions?asset_code=${ASSET_CODE}` +
    `&account=${encodeURIComponent(kp.publicKey())}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Anchor işlemleri okunamadı (HTTP ${res.status}).`);

  const body = await res.json();
  return (body.transactions ?? []).map((t: Record<string, string>) => ({
    id: t.id,
    kind: t.kind,
    status: t.status,
    amountIn: t.amount_in ?? null,
    amountOut: t.amount_out ?? null,
    amountFee: t.amount_fee ?? null,
    startedAt: t.started_at ?? null,
    stellarTxId: t.stellar_transaction_id ?? null,
    message: t.message ?? null,
    statusEta: typeof t.status_eta === "number" ? t.status_eta : null,
    moreInfoUrl: t.more_info_url ?? null,
    updatedAt: t.updated_at ?? null,
  }));
}

/**
 * Creates the account on testnet, because an account that does not exist cannot hold a
 * trustline and therefore cannot receive the anchor's payment.
 *
 * Friendbot drops the connection when called in quick succession, and a single attempt
 * makes account creation randomly fail for reasons the user cannot see or act on — so it
 * backs off and retries rather than reporting a network hiccup as a refusal.
 */
export async function fundWithFriendbot(publicKey: string, attempts = 3): Promise<void> {
  let last = "";
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 1500 * i));
    try {
      const res = await fetch(`https://friendbot.stellar.org?addr=${encodeURIComponent(publicKey)}`);
      // 400 is usually "already funded", which is the state the caller wanted anyway.
      if (res.ok || res.status === 400) return;
      last = `HTTP ${res.status}`;
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
  }
  throw new Error(`Hesap fonlanamadı: ${last}`);
}

/**
 * What a USDC is worth in lira right now, as the anchor prices it.
 *
 * SEP-38 quotes a price in units of the SELL asset per unit of the BUY asset. Selling USDC
 * for lira therefore comes back as USDC-per-TRY — 0.0206, not 48.54 — and printing it
 * straight puts "1 USDC = 0.02 TRY" on screen, which is the same rate upside down and
 * reads as a collapse. The panel hit exactly this; the inversion lives here so the wallet
 * cannot repeat it.
 *
 * Null rather than a guess when the anchor does not answer: a balance shown in lira at a
 * made-up rate is worse than one the screen admits it cannot convert.
 */
export async function getSellRate(): Promise<number | null> {
  const cfg = await discover();
  const quoteServer = cfg.transferServer.replace(/\/sep6$/, "/sep38");
  const usdc = `stellar:${ASSET_CODE}:${cfg.assetIssuer}`;
  const fiat = `iso4217:${FIAT_CODE}`;

  try {
    const res = await fetch(
      `${quoteServer}/prices?sell_asset=${encodeURIComponent(usdc)}&sell_amount=1` +
      `&buy_asset=${encodeURIComponent(fiat)}`
    );
    if (!res.ok) return null;
    const body = await res.json();
    const raw = (body?.buy_assets as { price?: string }[] | undefined)?.[0]?.price;
    const usdcPerTry = raw ? Number(raw) : 0;
    return usdcPerTry > 0 ? 1 / usdcPerTry : null;
  } catch {
    return null;
  }
}

/** True when the account can receive the anchor's USDC. `false` is why a deposit waits. */
export async function hasTrustline(
  publicKey: string,
  horizonUrl = STELLAR_HORIZON_TESTNET
): Promise<{ exists: boolean; trusted: boolean }> {
  const cfg = await discover();
  const res = await fetch(`${horizonUrl}/accounts/${encodeURIComponent(publicKey)}`);
  if (res.status === 404) return { exists: false, trusted: false };
  if (!res.ok) throw new Error(`Stellar hesabı okunamadı (HTTP ${res.status}).`);

  const body = await res.json();
  const trusted = (body.balances ?? []).some(
    (b: Record<string, string>) => b.asset_code === ASSET_CODE && b.asset_issuer === cfg.assetIssuer
  );
  return { exists: true, trusted };
}

/**
 * Opens the USDC trustline, so a deposit sitting at `pending_trust` can land.
 *
 * Costs a reserve in XLM, which is why it is a deliberate step the user takes rather than
 * something the wallet does behind their back the first time they open this screen.
 */
export async function openTrustline(account: Account, index = 0): Promise<string> {
  const kp = await getKeypair(account, index);
  if (!kp) throw new Error("Bu hesabın Stellar adresi yok.");
  const cfg = await discover();

  const { Horizon, TransactionBuilder, Operation, Asset, BASE_FEE } = await import("@stellar/stellar-sdk");
  const server = new Horizon.Server(STELLAR_HORIZON_TESTNET);
  const source = await server.loadAccount(kp.publicKey());

  const tx = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: cfg.networkPassphrase })
    .addOperation(Operation.changeTrust({ asset: new Asset(ASSET_CODE, cfg.assetIssuer) }))
    .setTimeout(60)
    .build();
  tx.sign(kp);

  const result = await server.submitTransaction(tx);
  return result.hash;
}
