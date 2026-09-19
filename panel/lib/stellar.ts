/**
 * Stellar account, balance and payment helpers for the panel.
 *
 * Nothing here holds a key. Everything that needs a signature takes a {@link PanelSigner}
 * and hands it an envelope — which is what lets the same code run against the tab's demo
 * account and against the extension, where the key never leaves the wallet.
 */

import {
  Horizon, Asset, TransactionBuilder, Networks, Operation, BASE_FEE, Memo,
} from "@stellar/stellar-sdk";
import { HORIZON_URL, ANCHOR_ASSET_CODE } from "./anchor";
import type { PanelSigner } from "./signer";

export const horizon = new Horizon.Server(HORIZON_URL);

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
          (b) => "asset_code" in b && b.asset_code === ANCHOR_ASSET_CODE && b.asset_issuer === usdcIssuer
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

/** True when the account already trusts the anchor's asset. */
async function hasTrustline(publicKey: string, issuer: string): Promise<boolean> {
  try {
    const acct = await horizon.loadAccount(publicKey);
    return acct.balances.some(
      (b) => "asset_code" in b && b.asset_code === ANCHOR_ASSET_CODE && b.asset_issuer === issuer
    );
  } catch (err) {
    if (isNotFound(err)) return false;
    throw err;
  }
}

/**
 * Opens a trustline for the anchor's asset. Returns false when one already exists.
 *
 * Without one the anchor cannot pay: its own docs say the deposit sits at `pending_trust`,
 * or becomes a claimable balance the user has to go and collect. Doing this up front turns a
 * confusing stuck state into a step the flow simply completes.
 */
export async function ensureTrustline(signer: PanelSigner, issuer: string): Promise<boolean> {
  if (await hasTrustline(signer.publicKey, issuer)) return false;

  const acct = await horizon.loadAccount(signer.publicKey);
  const unsigned = new TransactionBuilder(acct, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.changeTrust({ asset: new Asset(ANCHOR_ASSET_CODE, issuer) }))
    .setTimeout(60)
    .build()
    .toXDR();

  await submit(await signer.signXdr(unsigned));
  return true;
}

export interface PaymentRequest {
  destination: string;
  amount: string;
  issuer: string;
  /** The anchor's reference. See {@link buildMemo} for why an unknown type is refused. */
  memo: string;
  memoType: string;
}

/**
 * Sends the anchor its USDC for a withdrawal, and returns the transaction hash.
 *
 * The memo is not decoration. The anchor matches an incoming payment to a withdrawal order
 * by memo alone, so a payment sent without one — or with the wrong kind — arrives as an
 * unattributable transfer to a treasury account. There is no undo for that, which is why
 * {@link buildMemo} throws rather than guessing.
 */
export async function sendWithdrawalPayment(signer: PanelSigner, req: PaymentRequest): Promise<string> {
  const acct = await horizon.loadAccount(signer.publicKey);
  const unsigned = new TransactionBuilder(acct, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.payment({
      destination: req.destination,
      asset: new Asset(ANCHOR_ASSET_CODE, req.issuer),
      amount: req.amount,
    }))
    .addMemo(buildMemo(req.memoType, req.memo))
    .setTimeout(120)
    .build()
    .toXDR();

  const result = await submit(await signer.signXdr(unsigned));
  return result.hash;
}

/**
 * Turns SEP-6's `memo_type` into a memo.
 *
 * An unrecognised type is an error and not a fallback to text: a memo of the wrong type does
 * not match, and the payment it is attached to is gone. Refusing to build the transaction is
 * the only outcome here that keeps the money.
 */
export function buildMemo(memoType: string, value: string): Memo {
  switch (memoType) {
    case "id": return Memo.id(value);
    case "text": return Memo.text(value);
    // SEP-6 sends a hash memo base64-encoded; the SDK wants hex. Decoded by hand rather
    // than through Buffer, which is a Node shim the panel bundle has no reason to carry.
    case "hash": return Memo.hash(base64ToHex(value));
    default:
      throw new Error(
        `Anchor tanınmayan bir memo türü verdi: "${memoType}". Yanlış türde memo ile gönderilen ödeme eşleşmez.`
      );
  }
}

function base64ToHex(value: string): string {
  const binary = atob(value);
  let hex = "";
  for (let i = 0; i < binary.length; i++) hex += binary.charCodeAt(i).toString(16).padStart(2, "0");
  return hex;
}

/** Submits a signed envelope and surfaces Horizon's own reason when it is rejected. */
async function submit(signedXdr: string): Promise<{ hash: string }> {
  try {
    const tx = TransactionBuilder.fromXDR(signedXdr, Networks.TESTNET);
    const res = await horizon.submitTransaction(tx as Parameters<typeof horizon.submitTransaction>[0]);
    return { hash: res.hash };
  } catch (err) {
    throw new Error(horizonReason(err));
  }
}

/**
 * Horizon's failures arrive as a nested result-code object and are unreadable as thrown.
 *
 * The two that actually happen here are worth naming: `op_no_trust` means the recipient does
 * not trust the asset, and `op_underfunded` means the balance is short — both of which the
 * user can act on, unlike "Request failed with status code 400".
 */
function horizonReason(err: unknown): string {
  const extras = (err as { response?: { data?: { extras?: { result_codes?: { transaction?: string; operations?: string[] } } } } })
    ?.response?.data?.extras;
  const codes = extras?.result_codes;
  const op = codes?.operations?.find((c) => c && c !== "op_success");

  if (op === "op_no_trust") return "Alıcı bu varlığa güven hattı açmamış.";
  if (op === "op_underfunded") return "Bakiye yetersiz.";
  if (op) return `İşlem reddedildi: ${op}`;
  if (codes?.transaction) return `İşlem reddedildi: ${codes.transaction}`;
  return err instanceof Error ? err.message : String(err);
}

/** `GABC…WXYZ`, for display where the full 56 characters do not fit. */
export function shortAddress(publicKey: string, lead = 6, tail = 4): string {
  if (publicKey.length <= lead + tail + 1) return publicKey;
  return `${publicKey.slice(0, lead)}…${publicKey.slice(-tail)}`;
}
