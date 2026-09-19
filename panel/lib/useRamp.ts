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

export function useRamp() {
  const [state, setState] = React.useState<RampState>(EMPTY);
  const signerRef = React.useRef<PanelSigner | null>(null);
  const cfgRef = React.useRef<AnchorConfig | null>(null);
  const jwtRef = React.useRef<string | null>(null);

  const patch = (p: Partial<RampState>) => setState((s) => ({ ...s, ...p }));

  const fail = (e: unknown) =>
    patch({ phase: "error", error: e instanceof Error ? e.message : String(e) });

  /**
   * Prepares an account and authenticates with the anchor.
   *
   * With `mode: "arfhe"` the extension's account is used and every signature below opens the
   * wallet's approval screen — including the trustline, which is the first thing the user
   * sees the wallet actually decode.
   */
  const connect = React.useCallback(async (mode: SignerKind = "demo") => {
    patch({ phase: "connecting", error: null, signerKind: mode });
    try {
      const cfg = await discoverAnchor();
      cfgRef.current = cfg;

      const signer = mode === "arfhe" ? await connectArfhe() : demoSigner();
      signerRef.current = signer;
      patch({ address: signer.publicKey });

      // Funding first: everything below needs the account to exist on the ledger. An
      // extension account that has been used before is already funded and friendbot says
      // so with a 400, which is not an error here.
      await fundWithFriendbot(signer.publicKey);
      await ensureTrustline(signer, cfg.assetIssuer);

      jwtRef.current = await authenticate(cfg, signer);
      patch({ phase: "ready", balances: await readBalances(signer.publicKey, cfg.assetIssuer) });
    } catch (e) {
      fail(e);
    }
  }, []);

  const refreshBalances = React.useCallback(async () => {
    const signer = signerRef.current, cfg = cfgRef.current;
    if (!signer || !cfg) return;
    try {
      patch({ balances: await readBalances(signer.publicKey, cfg.assetIssuer) });
    } catch { /* a failed refresh should not tear down a working flow */ }
  }, []);

  // ── Deposit: TRY → USDC ──────────────────────────────────────────

  /** Opens the deposit order — this is what produces the IBAN and the reference. */
  const openDeposit = React.useCallback(async (amountTry: string) => {
    const signer = signerRef.current, cfg = cfgRef.current, jwt = jwtRef.current;
    if (!signer || !cfg || !jwt) return;
    patch({ phase: "ordering", error: null });
    try {
      const order = await startDeposit(cfg, jwt, signer.publicKey, amountTry);
      patch({ phase: "awaiting_transfer", order });
    } catch (e) {
      fail(e);
    }
  }, []);

  /** Plays the bank, then waits for the anchor to pay out. */
  const confirmTransfer = React.useCallback(async (amountTry: string) => {
    const cfg = cfgRef.current, jwt = jwtRef.current;
    const order = state.order;
    if (!cfg || !jwt || !order) return;
    patch({ phase: "settling", error: null });
    try {
      await simulateBankTransfer(cfg, jwt, order.id, amountTry);
      const final = await waitForSettlement(cfg, jwt, order.id, (s) => patch({ status: s }));
      patch({ phase: final.status === "completed" ? "done" : "error", status: final });
      await refreshBalances();
    } catch (e) {
      fail(e);
    }
  }, [state.order, refreshBalances]);

  // ── Withdraw: USDC → TRY ─────────────────────────────────────────

  /**
   * Asks the anchor where to send the USDC. Nothing moves yet.
   *
   * Split from the payment on purpose. The anchor's answer — a treasury address and a memo —
   * is what the user is about to send value against, and it belongs on screen before they
   * agree to send it, not behind the same button.
   */
  const openWithdraw = React.useCallback(async (amountUsdc: string) => {
    const cfg = cfgRef.current, jwt = jwtRef.current;
    if (!cfg || !jwt) return;
    patch({ phase: "ordering", error: null });
    try {
      const withdrawOrder = await startWithdraw(cfg, jwt, amountUsdc);
      patch({ phase: "awaiting_payment", withdrawOrder });
    } catch (e) {
      fail(e);
    }
  }, []);

  /** Sends the USDC, then waits for the anchor to pay the fiat side. */
  const sendWithdrawal = React.useCallback(async (amountUsdc: string) => {
    const signer = signerRef.current, cfg = cfgRef.current, jwt = jwtRef.current;
    const order = state.withdrawOrder;
    if (!signer || !cfg || !jwt || !order) return;
    patch({ phase: "paying", error: null });
    try {
      const hash = await sendWithdrawalPayment(signer, {
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

      const final = await waitForSettlement(cfg, jwt, order.id, (s) => patch({ status: s }));
      patch({ phase: final.status === "completed" ? "done" : "error", status: final });
      await refreshBalances();
    } catch (e) {
      fail(e);
    }
  }, [state.withdrawOrder, refreshBalances]);

  const reset = React.useCallback(() => {
    patch({
      phase: "ready", order: null, withdrawOrder: null, paymentHash: null,
      status: null, error: null,
    });
  }, []);

  return {
    ...state,
    connect, refreshBalances, reset,
    openDeposit, confirmTransfer,
    openWithdraw, sendWithdrawal,
  };
}

export type Ramp = ReturnType<typeof useRamp>;
