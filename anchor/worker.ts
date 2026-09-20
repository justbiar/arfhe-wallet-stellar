/**
 * The part the anchor we replaced stopped doing: actually moving the money.
 *
 * Two jobs on one timer:
 *
 *   deposits     the sandbox says the lira arrived, so pay the USDC. An account with no
 *                trustline is not a failure — it is `pending_trust`, and the next tick
 *                tries again, because the customer can fix it from their wallet.
 *   withdrawals  watch the anchor's own account for payments, match them to open requests
 *                by memo, and settle. A payment with no matching memo is left alone and
 *                logged: refunding or crediting a guess is worse than a stuck balance.
 *
 * Every state change stamps the record, so a wallet can tell "working" from "stuck" — the
 * distinction the old anchor lost, where `updated_at` froze 60ms after the request opened.
 */

import { owingPayout, awaitingPayment, update } from "./store.js";
import { hasTrustline, payout, incoming } from "./stellar.js";

/**
 * How often the anchor looks for work.
 *
 * Every deposit waits for the next tick before it is paid, so this interval is dead time on
 * the demo's critical path — four seconds of it, in a flow a visitor is watching. A second
 * and a half keeps the payout inside a Stellar ledger close and still leaves Horizon alone
 * between passes; the tick only reads one page of payments.
 */
const TICK_MS = 1500;

/** Payments already turned into a settlement. Re-reading the same page must be harmless. */
const settled = new Set<string>();
let running = false;

async function settleDeposits(): Promise<void> {
  for (const tx of owingPayout()) {
    if (!tx.amountOut) continue;

    if (!(await hasTrustline(tx.account))) {
      if (tx.status !== "pending_trust") {
        update(tx.id, {
          status: "pending_trust",
          message: `Waiting for a ${"USDC"} trustline on ${tx.account.slice(0, 6)}…`,
          statusEta: null,
        });
      }
      continue;
    }

    try {
      update(tx.id, { status: "pending_stellar", message: "Paying out on Stellar.", statusEta: 5 });
      const hash = await payout(tx.account, tx.amountOut, tx.reference);
      update(tx.id, {
        status: "completed",
        message: "Paid.",
        statusEta: null,
        stellarTransactionId: hash,
        completedAt: new Date().toISOString(),
      });
      console.log(`  [anchor] deposit ${tx.id} paid ${tx.amountOut} USDC → ${hash.slice(0, 10)}…`);
    } catch (e) {
      // Left in a state the next tick retries. The message says what happened rather than
      // leaving the customer to guess from a status code.
      update(tx.id, {
        status: "pending_anchor",
        message: `Payout failed, retrying: ${e instanceof Error ? e.message : "unknown"}`,
      });
      console.error(`  [anchor] deposit ${tx.id} payout failed:`, e instanceof Error ? e.message : e);
    }
  }
}

async function settleWithdrawals(): Promise<void> {
  const open = awaitingPayment();
  if (open.length === 0) return;

  const payments = await incoming();

  for (const payment of payments) {
    if (settled.has(payment.transactionHash)) continue;
    const match = open.find((tx) => tx.reference === payment.memo);
    if (!match) {
      console.log(`  [anchor] payment ${payment.transactionHash.slice(0, 10)}… has no matching request (memo ${payment.memo ?? "none"})`);
      continue;
    }

    settled.add(payment.transactionHash);
    update(match.id, {
      status: "completed",
      message: `TRY paid to ${match.destIban ?? "the account on file"} (simulated).`,
      statusEta: null,
      amountIn: payment.amount,
      stellarTransactionId: payment.transactionHash,
      completedAt: new Date().toISOString(),
    });
    console.log(`  [anchor] withdrawal ${match.id} settled → ${match.destIban}`);
  }
}

export function startWorker(): void {
  setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await settleDeposits();
      await settleWithdrawals();
    } catch (e) {
      console.error("  [anchor] worker tick failed:", e instanceof Error ? e.message : e);
    } finally {
      running = false;
    }
  }, TICK_MS);
}
