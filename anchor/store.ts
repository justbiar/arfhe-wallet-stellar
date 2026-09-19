/**
 * Everything the anchor remembers.
 *
 * In memory, and gone on restart. A real anchor's ledger of who is owed what is the one
 * thing it may never lose; this is a sandbox whose entire purpose is a demo that can be
 * restarted, and pretending otherwise with a database would add a migration to every
 * change without making a single claim more true.
 *
 * What is NOT in memory: the customer's IBAN survives in the same record as the withdrawal
 * that uses it, because a payout instruction that outlives its request is how money reaches
 * the wrong account.
 */

import { randomBytes } from "node:crypto";

export type TxStatus =
  | "incomplete"
  | "pending_user_transfer_start"
  | "pending_anchor"
  | "pending_trust"
  | "pending_stellar"
  | "completed"
  | "error";

export interface AnchorTransaction {
  id: string;
  kind: "deposit" | "withdrawal";
  status: TxStatus;
  statusEta: number | null;
  message: string;
  account: string;
  amountIn: string | null;
  amountInAsset: string;
  amountOut: string | null;
  amountOutAsset: string;
  amountFee: string | null;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
  stellarTransactionId: string | null;
  /** Deposits: what the sender writes in the description. Withdrawals: the payment memo. */
  reference: string;
  /** Withdrawals only: where the lira go. Supplied by the customer, not by us. */
  destIban: string | null;
}

const transactions = new Map<string, AnchorTransaction>();

/**
 * One reference per account, not per request.
 *
 * The anchor we replaced minted a new code on every call, so a wallet could not show "your
 * reference" without it changing while the user typed it into their banking app. Keyed by
 * Stellar account, so the code a person is told is the code that still matches tomorrow.
 */
const references = new Map<string, string>();

const id = (prefix: string) => `${prefix}_${randomBytes(9).toString("hex")}`;

export function referenceFor(account: string): string {
  const existing = references.get(account);
  if (existing) return existing;

  const code = `ARF-${randomBytes(2).toString("hex").toUpperCase()}-${randomBytes(2).toString("hex").toUpperCase()}`;
  references.set(account, code);
  return code;
}

export function create(tx: Omit<AnchorTransaction, "id" | "startedAt" | "updatedAt">): AnchorTransaction {
  const now = new Date().toISOString();
  const record: AnchorTransaction = { ...tx, id: id(tx.kind === "deposit" ? "dep" : "wd"), startedAt: now, updatedAt: now };
  transactions.set(record.id, record);
  return record;
}

export function update(id: string, patch: Partial<AnchorTransaction>): AnchorTransaction | null {
  const record = transactions.get(id);
  if (!record) return null;
  Object.assign(record, patch, { updatedAt: new Date().toISOString() });
  return record;
}

export const get = (id: string): AnchorTransaction | null => transactions.get(id) ?? null;

export const forAccount = (account: string): AnchorTransaction[] =>
  [...transactions.values()]
    .filter((t) => t.account === account)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));

/** Open withdrawals, for the worker matching incoming payments by memo. */
export const awaitingPayment = (): AnchorTransaction[] =>
  [...transactions.values()].filter((t) => t.kind === "withdrawal" && t.status === "pending_user_transfer_start");

/** Deposits whose fiat leg the sandbox has confirmed and which now owe USDC. */
export const owingPayout = (): AnchorTransaction[] =>
  [...transactions.values()].filter(
    (t) => t.kind === "deposit" && (t.status === "pending_anchor" || t.status === "pending_trust")
  );
