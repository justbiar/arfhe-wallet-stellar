/**
 * TxNotifier — the one announcement every screen listens for after a transaction lands.
 *
 * The wallet caches balances aggressively; that is what makes it open instantly instead of
 * showing a spinner on every navigation. The cost is that a cache built for speed is, by
 * construction, wrong the moment the user spends something. Nothing invalidated it, so a
 * send appeared to do nothing for up to a minute — the user saw their old balance and
 * reasonably concluded the transaction had failed.
 *
 * Invalidation is not a per-screen concern. A send starts in the send drawer, but the
 * figures it changes are rendered by Home, Portfolio, Privacy and the asset pickers, none
 * of which know the send happened. Broadcasting once, here, is what keeps them consistent
 * without each one polling.
 *
 * Deliberately a DOM event rather than a subscriber registry: several listeners are inside
 * components that mount and unmount freely, and `addEventListener` already gets that right.
 */

import { rpcClient } from "./RpcClient.js";
import type DataCacheService from "./DataCacheService.js";

/** Fired once a transaction is mined and the wallet's cached view is known to be stale. */
export const TX_CONFIRMED_EVENT = "arf-tx-confirmed";

export interface TxConfirmedDetail {
  hash: string;
  networkId: number;
  /** Address whose balances moved, when known. */
  address?: string;
  /** What happened, for screens that only care about some kinds. */
  kind?: "send" | "shield" | "unshield" | "swap" | "approve" | "other";
}

/**
 * Drop every cached view of chain state, then tell the screens.
 *
 * Order matters: the caches are cleared first so a listener that refetches synchronously
 * cannot be served the very data this call exists to discard.
 *
 * Token metadata survives — `decimals()` did not change because someone sent a
 * transaction, and re-reading it for every token is exactly the request storm the RPC
 * layer was built to prevent.
 */
export function notifyTxConfirmed(
  detail: TxConfirmedDetail,
  dataCache?: DataCacheService
): void {
  rpcClient.invalidateVolatile();
  dataCache?.invalidate(detail.address, detail.networkId);

  try {
    window.dispatchEvent(new CustomEvent<TxConfirmedDetail>(TX_CONFIRMED_EVENT, { detail }));
  } catch {
    // No DOM (tests, worker context) — the cache clearing above is the part that matters.
  }
}

/**
 * Subscribe to confirmations. Returns an unsubscribe function.
 *
 * @param onConfirmed Runs after the caches are already clear, so a refetch inside it
 *                    reaches the network rather than the stale entry.
 */
export function onTxConfirmed(onConfirmed: (detail: TxConfirmedDetail) => void): () => void {
  const handler = (e: Event) => onConfirmed((e as CustomEvent<TxConfirmedDetail>).detail);
  window.addEventListener(TX_CONFIRMED_EVENT, handler);
  return () => window.removeEventListener(TX_CONFIRMED_EVENT, handler);
}
