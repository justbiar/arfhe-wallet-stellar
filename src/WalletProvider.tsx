import React from "react";
import { AppContext, WalletContext } from "./AppContext.js";
import { useNavigate, useLocation } from "react-router";

import WalletConnectManager from "./components/WalletConnectManager";

export function WalletProvider({ children }: { children: React.ReactNode }) {
  // Create AppContext instance once
  const appContext = React.useMemo(() => new AppContext(), []);
  const navigate = useNavigate();
  const location = useLocation();

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
      try {
        const net = appContext.networkProvider.getActiveNetwork();
        runtime.sendMessage?.({
          type: "SET_WALLET_STATE",
          chainId: Number(net.network_id),
          rpcUrl: net.rpc_url ?? null,
        });
      } catch {
        // The worker may be restarting; the next change pushes again.
      }
    };

    push();
    const unsubscribeNetwork = appContext.networkProvider.subscribe(push);

    // An account switch changes what each connected site is allowed to see, and each site
    // must be told its own list — never the whole wallet's.
    const unsubscribeAccount = appContext.accountManager.subscribe(() => {
      try {
        runtime.sendMessage?.({ type: "PERMISSIONS_CHANGED" });
      } catch { /* worker restarting */ }
    });

    return () => {
      unsubscribeNetwork();
      unsubscribeAccount();
    };
  }, [appContext.networkProvider, appContext.accountManager]);

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

    const handleVisibilityChange = () => {
      if (document.hidden) {
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
