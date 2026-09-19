/**
 * The ramp's state machine, shared by both panes.
 *
 * The two panes are one flow seen from two sides: the bank opens the order and confirms the
 * transfer, the wallet receives the asset. Keeping the state here rather than in either pane
 * is what lets them stay visually independent while staying in step.
 */
import React from "react";
import { Keypair } from "@stellar/stellar-sdk";
import {
  discoverAnchor, authenticate, startDeposit, simulateBankTransfer, waitForSettlement,
  type AnchorConfig, type DepositOrder, type TxStatus,
} from "./sep";
import {
  loadOrCreateDemoKeypair, readBalances, fundWithFriendbot, ensureTrustline,
  type StellarBalances,
} from "./stellar";

export type Phase =
  | "disconnected"
  | "connecting"
  | "ready"
  | "ordering"
  | "awaiting_transfer"
  | "settling"
  | "done"
  | "error";

export interface RampState {
  phase: Phase;
  address: string | null;
  balances: StellarBalances | null;
  order: DepositOrder | null;
  status: TxStatus | null;
  error: string | null;
}

const EMPTY: RampState = {
  phase: "disconnected", address: null, balances: null, order: null, status: null, error: null,
};

export function useRamp() {
  const [state, setState] = React.useState<RampState>(EMPTY);
  const kpRef = React.useRef<Keypair | null>(null);
  const cfgRef = React.useRef<AnchorConfig | null>(null);
  const jwtRef = React.useRef<string | null>(null);

  const patch = (p: Partial<RampState>) => setState((s) => ({ ...s, ...p }));

  const fail = (e: unknown) =>
    patch({ phase: "error", error: e instanceof Error ? e.message : String(e) });

  /** Creates the demo account, funds it, opens the trustline, and authenticates. */
  const connect = React.useCallback(async () => {
    patch({ phase: "connecting", error: null });
    try {
      const cfg = await discoverAnchor();
      cfgRef.current = cfg;

      const kp = loadOrCreateDemoKeypair();
      kpRef.current = kp;
      patch({ address: kp.publicKey() });

      // Funding first: everything below needs the account to exist on the ledger.
      await fundWithFriendbot(kp.publicKey());
      await ensureTrustline(kp, cfg.assetIssuer);

      jwtRef.current = await authenticate(cfg, kp);
      patch({ phase: "ready", balances: await readBalances(kp.publicKey(), cfg.assetIssuer) });
    } catch (e) {
      fail(e);
    }
  }, []);

  const refreshBalances = React.useCallback(async () => {
    const kp = kpRef.current, cfg = cfgRef.current;
    if (!kp || !cfg) return;
    try {
      patch({ balances: await readBalances(kp.publicKey(), cfg.assetIssuer) });
    } catch { /* a failed refresh should not tear down a working flow */ }
  }, []);

  /** Opens the deposit order — this is what produces the IBAN and the reference. */
  const openDeposit = React.useCallback(async (amountTry: string) => {
    const kp = kpRef.current, cfg = cfgRef.current, jwt = jwtRef.current;
    if (!kp || !cfg || !jwt) return;
    patch({ phase: "ordering", error: null });
    try {
      const order = await startDeposit(cfg, jwt, kp.publicKey(), amountTry);
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

  const reset = React.useCallback(() => {
    patch({ phase: "ready", order: null, status: null, error: null });
  }, []);

  return { ...state, connect, openDeposit, confirmTransfer, refreshBalances, reset };
}

export type Ramp = ReturnType<typeof useRamp>;
