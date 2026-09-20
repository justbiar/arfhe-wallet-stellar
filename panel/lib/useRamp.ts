/**
 * The ramp's state machine, shared by both panes.
 *
 * The two panes are one flow seen from two sides: the bank opens the order and confirms the
 * transfer, the wallet receives the asset — and in the other direction the wallet sends and
 * the bank receives. Keeping the state here rather than in either pane is what lets them
 * stay visually independent while staying in step.
 *
 * Both directions share `connect`, the anchor config and the SEP-10 session. What they do
 * not share is who moves first, which is the whole difference between them:
 *
 *   deposit  — the anchor waits for fiat, then pays on-chain. Nothing of the user's moves
 *              until the bank leg is confirmed, so an abandoned order costs nothing.
 *   withdraw — the user pays on-chain first, and the anchor pays fiat when it sees the
 *              payment. Value leaves before anything comes back, which is why the payment
 *              step here is deliberate and separate from opening the order.
 */
import React from "react";
import {
  discoverAnchor, authenticate, startDeposit, startWithdraw, simulateBankTransfer,
  waitForSettlement,
  type AnchorConfig, type DepositOrder, type WithdrawOrder, type TxStatus,
} from "./sep";
import {
  readBalances, fundWithFriendbot, ensureTrustline, sendWithdrawalPayment,
  type StellarBalances,
} from "./stellar";
import { demoSigner, connectArfhe, type PanelSigner, type SignerKind } from "./signer";

export type Phase =
  | "disconnected"
  | "connecting"
  | "ready"
  | "ordering"
  | "awaiting_transfer"
  /** Withdraw only: the order exists and the user has not sent the USDC yet. */
  | "awaiting_payment"
  | "paying"
  | "settling"
  | "done"
  | "error";

export interface RampState {
  phase: Phase;
  /** Which key signed — shown in the UI, because it is the difference that matters. */
  signerKind: SignerKind | null;
  address: string | null;
  balances: StellarBalances | null;
  order: DepositOrder | null;
  withdrawOrder: WithdrawOrder | null;
  /** The hash of the user's own payment, for the withdraw leg. Checkable on any explorer. */
  paymentHash: string | null;
  status: TxStatus | null;
  error: string | null;
}

const EMPTY: RampState = {
  phase: "disconnected", signerKind: null, address: null, balances: null,
  order: null, withdrawOrder: null, paymentHash: null, status: null, error: null,
};

/**
 * The connection lives in the module, not in the component.
 *
 * The panes that use it are mounted by a route, so reading the roadmap and coming back
 * unmounted them — and with them the connected account, the anchor session and any open
 * order. The wallet had not disconnected; the page had forgotten. Anything that survives a
 * click on the navigation has to live above the tree that the navigation replaces.
 *
 * Module scope rather than a context provider because there is exactly one ramp on the site
 * and a provider would only be a longer way of saying so. A reload still starts clean: the
 * anchor session is a SEP-10 token obtained by signing, and re-obtaining it is the approval
 * the user sees.
 */
let state: RampState = EMPTY;
let signer: PanelSigner | null = null;
let config: AnchorConfig | null = null;
let jwt: string | null = null;

const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
const snapshot = () => state;

function patch(p: Partial<RampState>) {
  state = { ...state, ...p };
  listeners.forEach((listener) => listener());
}

const fail = (e: unknown) =>
  patch({ phase: "error", error: e instanceof Error ? e.message : String(e) });

/**
 * Prepares an account and authenticates with the anchor.
 *
 * With `mode: "arfhe"` the extension's account is used and every signature below opens the
 * wallet's approval screen — including the trustline, which is the first thing the user
 * sees the wallet actually decode.
 */
async function connect(mode: SignerKind = "demo") {
  patch({ phase: "connecting", error: null, signerKind: mode });
  try {
    const cfg = await discoverAnchor();
    config = cfg;

    const active = mode === "arfhe" ? await connectArfhe() : demoSigner();
    signer = active;
    patch({ address: active.publicKey });

    // Funding first: everything below needs the account to exist on the ledger. An
    // extension account that has been used before is already funded and friendbot says
    // so with a 400, which is not an error here.
    await fundWithFriendbot(active.publicKey);
    await ensureTrustline(active, cfg.assetIssuer);

    jwt = await authenticate(cfg, active);
    patch({ phase: "ready", balances: await readBalances(active.publicKey, cfg.assetIssuer) });
  } catch (e) {
    fail(e);
  }
}

async function refreshBalances() {
  if (!signer || !config) return;
  try {
    patch({ balances: await readBalances(signer.publicKey, config.assetIssuer) });
  } catch { /* a failed refresh should not tear down a working flow */ }
}

// ── Deposit: TRY → USDC ──────────────────────────────────────────

/** Opens the deposit order — this is what produces the IBAN and the reference. */
async function openDeposit(amountTry: string) {
  if (!signer || !config || !jwt) return;
  patch({ phase: "ordering", error: null });
  try {
    const order = await startDeposit(config, jwt, signer.publicKey, amountTry);
    patch({ phase: "awaiting_transfer", order });
  } catch (e) {
    fail(e);
  }
}

/** Plays the bank, then waits for the anchor to pay out. */
async function confirmTransfer(amountTry: string) {
  const order = state.order;
  if (!config || !jwt || !order) return;
  const cfg = config, token = jwt;
  patch({ phase: "settling", error: null });
  try {
    await simulateBankTransfer(cfg, token, order.id, amountTry);
    const final = await waitForSettlement(cfg, token, order.id, (s) => patch({ status: s }));
    patch({ phase: final.status === "completed" ? "done" : "error", status: final });
    await refreshBalances();
  } catch (e) {
    fail(e);
  }
}

// ── Withdraw: USDC → TRY ─────────────────────────────────────────

/**
 * Asks the anchor where to send the USDC. Nothing moves yet.
 *
 * Split from the payment on purpose. The anchor's answer — a treasury address and a memo —
 * is what the user is about to send value against, and it belongs on screen before they
 * agree to send it, not behind the same button.
 */
async function openWithdraw(amountUsdc: string) {
  if (!config || !jwt) return;
  patch({ phase: "ordering", error: null });
  try {
    const withdrawOrder = await startWithdraw(config, jwt, amountUsdc);
    patch({ phase: "awaiting_payment", withdrawOrder });
  } catch (e) {
    fail(e);
  }
}

/** Sends the USDC, then waits for the anchor to pay the fiat side. */
async function sendWithdrawal(amountUsdc: string) {
  const order = state.withdrawOrder;
  if (!signer || !config || !jwt || !order) return;
  const active = signer, cfg = config, token = jwt;
  patch({ phase: "paying", error: null });
  try {
    const hash = await sendWithdrawalPayment(active, {
      destination: order.destination,
      amount: amountUsdc,
      issuer: cfg.assetIssuer,
      memo: order.memo,
      memoType: order.memoType,
    });
    // The hash is published before the anchor is polled. The payment is irreversible from
    // this moment, and a user watching a spinner deserves the one thing that proves it
    // happened — whatever the anchor does next.
    patch({ phase: "settling", paymentHash: hash });
    await refreshBalances();

    const final = await waitForSettlement(cfg, token, order.id, (s) => patch({ status: s }));
    patch({ phase: final.status === "completed" ? "done" : "error", status: final });
    await refreshBalances();
  } catch (e) {
    fail(e);
  }
}

function reset() {
  patch({
    phase: "ready", order: null, withdrawOrder: null, paymentHash: null,
    status: null, error: null,
  });
}

/**
 * Subscribes a component to the ramp.
 *
 * The returned object is the same shape it always was, so the panes did not change: what
 * changed is that two panes on two different routes now see one connection.
 */
export function useRamp() {
  const live = React.useSyncExternalStore(subscribe, snapshot, snapshot);

  return {
    ...live,
    connect, refreshBalances, reset,
    openDeposit, confirmTransfer,
    openWithdraw, sendWithdrawal,
  };
}

export type Ramp = ReturnType<typeof useRamp>;
