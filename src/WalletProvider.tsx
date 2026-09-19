import React from "react";
import { currentSurface } from './backend/DisplaySurfaceService';
import { AppContext, WalletContext } from "./AppContext.js";
import { toChainId } from "./backend/NetworkTypes.js";
import { notifyTxConfirmed } from "./backend/TxNotifier.js";
import { useNavigate, useLocation } from "react-router";

import WalletConnectManager from "./components/WalletConnectManager";

export function WalletProvider({ children }: { children: React.ReactNode }) {
  // Create AppContext instance once
  const appContext = React.useMemo(() => new AppContext(), []);
  const navigate = useNavigate();

  /**
   * Show an approval here rather than in a window of its own.
   *
   * A site asking to connect used to open a separate full-size window even when the wallet
   * was already on screen beside it. The worker asks first now, and this is what answers:
   * the surface the user already has open takes the request and navigates to it.
   *
   * Only our own extension may ask. A content script's message carries `sender.tab`, so
   * requiring its absence keeps every page on the internet out of this; the id check keeps
   * other extensions out. Nothing but an id travels here — the screen still reads the
   * request through the privileged handler, so an id that names nothing shows an empty
   * screen rather than a forged one.
   */
  React.useEffect(() => {
    // Typed locally: the ambient `chrome.runtime.onMessage` declaration in this build has
    // no `removeListener`, and a listener that cannot be removed would keep answering
    // after this provider unmounts.
    const runtime = (globalThis as unknown as {
      chrome?: {
        runtime?: {
          id?: string;
          onMessage?: {
            addListener(cb: (m: unknown, s: chrome.runtime.MessageSender, r: (x: unknown) => void) => unknown): void;
            removeListener(cb: (m: unknown, s: chrome.runtime.MessageSender, r: (x: unknown) => void) => unknown): void;
          };
        };
      };
    }).chrome?.runtime;
    const onMessageApi = runtime?.onMessage;
    if (!onMessageApi) return;

    const onMessage = (
      raw: unknown,
      sender: chrome.runtime.MessageSender,
      sendResponse: (response: unknown) => void,
    ) => {
      const message = raw as { type?: string; requestId?: string } | null;
      if (message?.type !== "SHOW_APPROVAL") return;
      if (sender.tab || sender.id !== runtime.id) return;
      if (typeof message.requestId !== "string" || message.requestId === "") return;

      // `inline` tells the approval screen it is a guest here: when it is done it should
      // go back to the wallet rather than try to close a window it does not own.
      navigate(`/approve?requestId=${encodeURIComponent(message.requestId)}&inline=1`);
      sendResponse({ shown: true });
      return true;
    };

    onMessageApi.addListener(onMessage);
    return () => onMessageApi.removeListener(onMessage);
  }, [navigate]);

  /**
   * Adopt a request that was already waiting when this surface opened.
   *
   * The worker can open a surface but cannot reliably hand it the request: a message sent
   * the instant a page is created arrives before anything is listening, and racing that
   * with retries is guesswork. So the page asks, once, on mount. Nothing has to be timed.
   *
   * Skipped when the document is already on the approval screen — the dedicated approval
   * window loads straight there and does its own lookup.
   */
  React.useEffect(() => {
    const runtime = (globalThis as { chrome?: typeof chrome }).chrome?.runtime;
    if (!runtime?.sendMessage) return;
    if (window.location.hash.startsWith("#/approve")) return;

    let cancelled = false;
    (async () => {
      try {
        const res = await runtime.sendMessage({ type: "GET_PENDING_APPROVAL" }) as
            | { request?: { id?: string } | null }
            | undefined;
        const id = res?.request?.id;
        if (cancelled || typeof id !== "string" || id === "") return;
        navigate(`/approve?requestId=${encodeURIComponent(id)}&inline=1`);
      } catch {
        // No worker, or nothing parked. Either way there is nothing to show.
      }
    })();

    return () => { cancelled = true; };
  }, [navigate]);
  const location = useLocation();

  // Wires the AI Agent's tool runner to THIS committed appContext — see configureAgent's own
  // docs for why this has to be a layout effect keyed on the value above, not a side effect of
  // the constructor itself (React StrictMode's dev-only double-invocation of the useMemo
  // factory above was silently binding the agent to a phantom, account-less instance).
  React.useLayoutEffect(() => {
    appContext.configureAgent();
  }, [appContext]);

  // State just for forcing re-renders
  const [, setRefresh] = React.useState(0);

  // Subscribe to AccountManager and NetworkProvider changes
  React.useEffect(() => {
    const unsubscribeAccount = appContext.accountManager.subscribe(() => {
      setRefresh(f => f + 1);
    });
    const unsubscribeNetwork = appContext.networkProvider.subscribe(() => {
      setRefresh(f => f + 1);
    });
    return () => {
      unsubscribeAccount();
      unsubscribeNetwork();
    };
  }, [appContext.accountManager, appContext.networkProvider]);

  // --- Keep connected websites in step with the wallet ---
  //
  // The service worker answers sites on the wallet's behalf, so it has to know which chain
  // and RPC are active. It also cannot see React state, which is why this is pushed rather
  // than pulled.
  //
  // The `chainChanged` event is not optional politeness: EIP-1193 requires it, and a dApp
  // that never receives it keeps preparing transactions for the chain the user has left.
  React.useEffect(() => {
    const runtime = (window as unknown as { chrome?: { runtime?: { id?: string; sendMessage?: typeof chrome.runtime.sendMessage } } }).chrome?.runtime;
    if (!runtime?.id || !runtime.sendMessage) return;

    const push = () => {
      void (async () => {
        try {
          const net = appContext.networkProvider.getActiveNetwork();
          const active = appContext.accountManager.GetActive();

          /**
           * Derived here rather than in the worker, which has no access to the mnemonic —
           * it holds no keys by design, and this keeps it that way. Imported dynamically so
           * the Stellar SDK is not parsed on a path that runs every time the network or
           * account changes.
           *
           * Null for an account with no recovery phrase, and null on failure: a missing
           * address makes stellar_getAddress answer null, which is the honest result. It
           * must never break the rest of the push, since the worker needs the EVM address
           * to keep watching for incoming funds.
           */
          let stellarAddress: string | null = null;
          if (active) {
            stellarAddress = await import("./backend/StellarService.js")
              .then(({ getAddress }) => getAddress(active))
              .catch(() => null);
          }

          runtime.sendMessage?.({
            type: "SET_WALLET_STATE",
            // The real chain id, not the wallet's internal NetworkId — this is what
            // websites are told over EIP-1193.
            chainId: toChainId(net.network_id),
            rpcUrl: net.rpc_url ?? null,
            // The worker watches this address for arriving funds while the popup is
            // closed. A public address and nothing more — no key ever crosses this line.
            address: active?.GetAddress() ?? null,
            stellarAddress,
            // So an arriving confidential transfer is announced without an amount: the
            // wrapper's public Transfer event carries an activity indicator, not a value.
            confidentialContracts: await net.getConfidentialWrapperAddresses().catch(() => []),
          });
        } catch {
          // The worker may be restarting; the next change pushes again.
        }
      })();
    };

    push();
    const unsubscribeNetwork = appContext.networkProvider.subscribe(push);

    // An account switch changes what each connected site is allowed to see, and each site
    // must be told its own list — never the whole wallet's. It also changes whose funds
    // the worker is watching for, so the state goes out again with it.
    const unsubscribeAccount = appContext.accountManager.subscribe(() => {
      push();
      try {
        runtime.sendMessage?.({ type: "PERMISSIONS_CHANGED" });
      } catch { /* worker restarting */ }
    });

    return () => {
      unsubscribeNetwork();
      unsubscribeAccount();
    };
  }, [appContext.networkProvider, appContext.accountManager]);

  // --- Take the worker's word for it when the chain moved without us ---
  //
  // Two things happen behind the popup's back: a transaction it broadcast settles after
  // it was closed, and funds arrive that it never asked about. The worker sees both, and
  // until it said so the popup would keep serving balances read before either — a send
  // that looks like it never happened, a payment that never shows up.
  //
  // Routed through TxNotifier so it clears the caches and reaches every screen the same
  // way a locally observed confirmation does, rather than adding a second refresh path.
  React.useEffect(() => {
    type WorkerBroadcast = { type?: string; hash?: string; networkId?: number; address?: string | null };
    type MessagePort = {
      addListener(cb: (message: unknown) => void): void;
      removeListener(cb: (message: unknown) => void): void;
    };
    const runtime = (window as unknown as { chrome?: { runtime?: { id?: string; onMessage?: MessagePort } } }).chrome?.runtime;
    const onMessage = runtime?.onMessage;
    if (!runtime?.id || !onMessage) return;

    const handler = (raw: unknown) => {
      const message = raw as WorkerBroadcast | null;
      if (message?.type !== "TX_SETTLED" && message?.type !== "INCOMING_TX") return;
      try {
        notifyTxConfirmed(
          {
            hash: message.hash ?? "",
            networkId: Number(message.networkId ?? appContext.networkProvider.getActiveNetwork().network_id),
            address: message.address ?? appContext.accountManager.GetActive()?.GetAddress() ?? undefined,
            kind: message.type === "INCOMING_TX" ? "other" : "send",
          },
          appContext.dataCacheService
        );
      } catch {
        // A message arriving mid-teardown is not worth breaking the popup for.
      }
    };

    onMessage.addListener(handler);
    return () => onMessage.removeListener(handler);
  }, [appContext]);

  // --- Resume interrupted unshields ---
  // The second half of an unshield (decrypt + claim) can be cut short by the popup
  // closing, leaving burned balance behind an unsettled claim. Retry whenever the wallet
  // is open and unlocked so it completes without the user having to do anything.
  //
  // A locked wallet cannot participate: settling needs a signature, and the signing key
  // only exists in memory while unlocked. Resuming here is the safe equivalent of a
  // background worker, without handing that key to one.
  React.useEffect(() => {
    let cancelled = false;

    const resume = async () => {
      if (cancelled) return;
      if (!appContext.storageManager.isUnlocked()) return;
      if (location.pathname === '/auth' || location.pathname === '/') return;

      const account = appContext.accountManager.GetActive();
      if (!account?.ethers_wallet) return;

      const network = appContext.networkProvider.getActiveNetwork();
      try {
        const settled = await network.drainPendingClaims(account, appContext.pendingClaimQueue);
        if (settled > 0 && !cancelled) setRefresh(f => f + 1);
      } catch {
        // Best-effort background work; failures stay queued for the next attempt.
      }
    };

    void resume();
    // Also retry periodically: the threshold network may simply have been slow.
    const interval = setInterval(() => void resume(), 60_000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [appContext, location.pathname]);

  // --- Auto-Lock Feature ---
  React.useEffect(() => {
    let timeoutId: NodeJS.Timeout;

    // Default to 5 minutes, read from storage if available
    const getTimeout = () => {
      const saved = appContext.storageManager.getLocal<number>('autoLockTimeout');
      if (typeof saved === 'number') {
        return saved;
      }
      return 5 * 60 * 1000;
    };

    const performLock = () => {
      // Only lock if we are NOT already on the auth or splash screens
      if (location.pathname !== '/auth' && location.pathname !== '/') {
        // StorageManager.lock() now triggers all registered cleanup callbacks
        // (AccountManager.clearSensitiveData, FheCofheService.reset, DataCache.invalidate)
        appContext.storageManager.lock();
        navigate('/auth', { replace: true });
      }
    };

    /**
     * Arm the in-page lock timer. Deliberately does NOT stamp activity.
     *
     * `arfhe_last_active` is how a *closed* popup is judged on reopen: Auth compares it
     * against the auto-lock timeout and refuses to restore a stale session. This provider
     * wraps the router, so it mounts before Auth runs that check — stamping here overwrote
     * the timestamp with "now" every single time, and the staleness test could never fail.
     * A wallet left for hours reopened unlocked.
     *
     * So the stamp belongs to real user activity and to unlock, nothing else.
     */
    const scheduleLock = () => {
      clearTimeout(timeoutId);
      const currentTimeout = getTimeout();

      if (currentTimeout <= 0) return; // 0 or negative means never lock

      // Only lock if we are NOT already on the auth or splash screens
      if (location.pathname !== '/auth' && location.pathname !== '/') {
        timeoutId = setTimeout(performLock, currentTimeout);
      }
    };

    /** The user did something. Refresh the stamp and restart the countdown. */
    const markActivity = () => {
      localStorage.setItem('arfhe_last_active', Date.now().toString());
      scheduleLock();
    };

    const handleStorageUpdate = () => scheduleLock();

    // ── Tab Visibility Change ──
    // Lock wallet when user switches away from the tab
    // Grace period scales with configured auto-lock timeout:
    //   - 1min lock  → 15s hidden grace
    //   - 5min lock  → 30s hidden grace
    //   - 15min lock → 60s hidden grace
    //   - 30min+ lock → 120s hidden grace
    //   - Never       → no lock on hide
    let visibilityTimeoutId: NodeJS.Timeout;

    const getVisibilityDelay = (timeout: number): number => {
      if (timeout <= 0) return 0; // Never lock
      if (timeout <= 60_000) return 15_000;      // ≤1 min → 15s
      if (timeout <= 300_000) return 30_000;      // ≤5 min → 30s
      if (timeout <= 900_000) return 60_000;      // ≤15 min → 60s
      return 120_000;                              // >15 min → 2 min
    };

    /**
     * A side panel is not a popup that happens to stay open.
     *
     * A popup is destroyed the moment attention moves, so the short hidden-grace lock above
     * cost the user nothing: reopening ran the reopen check in Auth, which allows the full
     * configured timeout. The side panel keeps running, so the same rule fires for real —
     * switching to another window or another application for half a minute locked the
     * wallet, every time. That is not the timeout the user chose in Settings, and it made
     * the panel strictly harsher than the popup it replaced.
     *
     * Hidden here means "the user is looking at another window", not "the user has walked
     * away". Walking away is already covered, by `arfhe_last_active` and the expiry check
     * below, at the interval the user actually configured.
     */
    const isSidePanel = currentSurface() === 'sidepanel';

    const handleVisibilityChange = () => {
      if (document.hidden) {
        if (isSidePanel) return;

        // Tab hidden — start countdown to lock
        const currentTimeout = getTimeout();
        if (currentTimeout <= 0) return; // Never lock if disabled

        const lockDelay = getVisibilityDelay(currentTimeout);
        visibilityTimeoutId = setTimeout(() => {
          performLock();
        }, lockDelay);
      } else {
        // Tab visible again — cancel pending lock
        clearTimeout(visibilityTimeoutId);
        markActivity(); // Coming back to the wallet is the user being present
      }
    };

    // Listeners for user activity
    window.addEventListener('mousemove', markActivity);
    window.addEventListener('keydown', markActivity);
    window.addEventListener('click', markActivity);
    window.addEventListener('scroll', markActivity);
    window.addEventListener('touchstart', markActivity);
    window.addEventListener('autolock_updated', handleStorageUpdate);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    // Arm the countdown, but do not claim the user was just active — that decision
    // belongs to the reopen check in Auth, which runs after this.
    scheduleLock();

    // A second, independent check against the wall clock.
    //
    // The timer above is a single `setTimeout`, and it is not trustworthy on its own: this
    // effect re-runs on every navigation and re-arms it with a full timeout, and Chrome
    // throttles timers in backgrounded pages. Either can silently postpone the lock
    // indefinitely. Comparing the stored activity time against the clock cannot drift —
    // if the wallet has been idle past the limit, it locks on the next tick regardless of
    // what happened to the timer.
    const expiryCheck = setInterval(() => {
      const currentTimeout = getTimeout();
      if (currentTimeout <= 0) return; // "Never" is an explicit choice

      const raw = localStorage.getItem('arfhe_last_active');
      const lastActive = raw ? parseInt(raw, 10) : NaN;
      if (!Number.isFinite(lastActive)) return;

      if (Date.now() - lastActive > currentTimeout) performLock();
    }, 15_000);

    return () => {
      clearTimeout(timeoutId);
      clearTimeout(visibilityTimeoutId);
      clearInterval(expiryCheck);
      window.removeEventListener('mousemove', markActivity);
      window.removeEventListener('keydown', markActivity);
      window.removeEventListener('click', markActivity);
      window.removeEventListener('scroll', markActivity);
      window.removeEventListener('touchstart', markActivity);
      window.removeEventListener('autolock_updated', handleStorageUpdate);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [navigate, location.pathname, appContext.storageManager]);

  return (
    <WalletContext.Provider value={appContext}>
      {children}
      <WalletConnectManager />
    </WalletContext.Provider>
  );
}
