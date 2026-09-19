/**
 * The anchor's own side of the ledger: paying out, and noticing payments in.
 *
 * Two rules live here and both were learned the hard way elsewhere in this repo:
 *
 * 1. A payment to an account with no trustline for the asset fails. That is not an error to
 *    report as failure — the anchor has the money and the customer can fix it — so it maps
 *    to `pending_trust`, which is exactly what SEP-6 has that status for.
 * 2. A withdrawal is matched by memo. A payment that arrives without one is money in the
 *    anchor's account with nothing saying whose it is.
 */

import {
  Horizon, Keypair, TransactionBuilder, Operation, Asset, Memo, BASE_FEE,
} from "@stellar/stellar-sdk";
import {
  HORIZON_URL, NETWORK_PASSPHRASE, ASSET_CODE, ASSET_ISSUER, DISTRIBUTION_KEYPAIR,
} from "./config.js";

const server = new Horizon.Server(HORIZON_URL);
export const ASSET = new Asset(ASSET_CODE, ASSET_ISSUER);

export async function hasTrustline(publicKey: string): Promise<boolean> {
  try {
    const account = await server.loadAccount(publicKey);
    return account.balances.some(
      (b) => "asset_code" in b && b.asset_code === ASSET_CODE && b.asset_issuer === ASSET_ISSUER
    );
  } catch {
    // An account that does not exist cannot hold a trustline either.
    return false;
  }
}

export async function treasury(): Promise<{ usdc: string; xlm: string } | null> {
  try {
    const account = await server.loadAccount(DISTRIBUTION_KEYPAIR.publicKey());
    const usdc = account.balances.find(
      (b) => "asset_code" in b && b.asset_code === ASSET_CODE && b.asset_issuer === ASSET_ISSUER
    );
    const xlm = account.balances.find((b) => b.asset_type === "native");
    return { usdc: usdc?.balance ?? "0", xlm: xlm?.balance ?? "0" };
  } catch {
    return null;
  }
}

/** Pays the customer. Throws only for reasons the anchor itself must fix. */
export async function payout(destination: string, amount: string, memo?: string): Promise<string> {
  const source = await server.loadAccount(DISTRIBUTION_KEYPAIR.publicKey());
  const builder = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(Operation.payment({ destination, asset: ASSET, amount }))
    .setTimeout(120);

  if (memo) builder.addMemo(Memo.text(memo.slice(0, 28)));

  const tx = builder.build();
  tx.sign(DISTRIBUTION_KEYPAIR);
  const result = await server.submitTransaction(tx);
  return result.hash;
}

export interface IncomingPayment {
  from: string;
  amount: string;
  memo: string | null;
  transactionHash: string;
}

/**
 * The anchor's most recent incoming payments.
 *
 * Reads the newest page each tick rather than paging from a cursor. The cursor version of
 * this looked right and quietly dropped every payment: with `cursor("now")` re-evaluated on
 * each call, anything that arrived between two ticks was already in the past by the time
 * the next one asked. A withdrawal sat at `pending_user_transfer_start` while the money was
 * visibly in the anchor's account.
 *
 * The caller keeps the set of hashes it has already settled, so re-reading the same page is
 * harmless. At sandbox volumes one page is far more than a tick's worth of traffic.
 */
export async function incoming(): Promise<IncomingPayment[]> {
  const page = await server
    .payments()
    .forAccount(DISTRIBUTION_KEYPAIR.publicKey())
    .order("desc")
    .limit(30)
    .call();

  const payments: IncomingPayment[] = [];

  for (const record of page.records) {
    if (record.type !== "payment") continue;
    if (record.to !== DISTRIBUTION_KEYPAIR.publicKey()) continue;
    if (record.asset_type === "native") continue;
    if (record.asset_code !== ASSET_CODE || record.asset_issuer !== ASSET_ISSUER) continue;

    // The memo lives on the transaction, not the payment, so it costs one more call.
    const tx = await record.transaction();
    payments.push({
      from: record.from,
      amount: record.amount,
      memo: tx.memo ?? null,
      transactionHash: record.transaction_hash,
    });
  }

  return payments;
}

export const distributionAddress = (): string => DISTRIBUTION_KEYPAIR.publicKey();
export const keypairFor = (secret: string): Keypair => Keypair.fromSecret(secret);
