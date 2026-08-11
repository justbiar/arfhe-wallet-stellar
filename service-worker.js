/**
 * Arfhe Wallet — Enhanced Service Worker (MV3)
 *
 * Background processing for a professional crypto wallet:
 *  1. Pending TX monitoring — poll receipts, notify on confirm/fail
 *  2. Price change alerts — periodic ETH price check, ±5% notification
 *  3. Badge management — unread count + pending TX count
 *  4. Heartbeat keepalive — prevent SW from being killed during active monitoring
 *
 * Communication protocol (popup → SW):
 *  WATCH_TX        — Add a TX hash to the monitoring watchlist
 *  REMOVE_TX       — Remove a TX from the watchlist
 *  GET_STATUS      — Get current SW state (pending TXs, last price, uptime)
 *  CLEAR_BADGE     — Reset badge to ""
 *  UPDATE_BADGE    — Set badge to a specific count
 *  SHOW_NOTIFICATION — Show a Chrome notification
 *  SET_RPC_URL     — Update the RPC URL for a network
 *  SET_PRICE_ALERT — Enable/disable/configure price alerts
 *  POPUP_OPENED    — Popup just opened, sync state
 *  POPUP_CLOSED    — Popup just closed, start autonomous monitoring
 */

// ─── Constants ──────────────────────────────────────────────────────
const ALARM_TX_MONITOR = "arfhe_tx_monitor";
const ALARM_PRICE_CHECK = "arfhe_price_check";
const ALARM_BADGE_SYNC = "arfhe_badge_sync";
const ALARM_KEEPALIVE = "arfhe_keepalive";

const STORAGE_KEY_NOTIFICATIONS = "arfhe_notifications";
const STORAGE_KEY_PENDING_TXS = "arfhe_pending_txs";
const STORAGE_KEY_PRICE_STATE = "arfhe_price_state";
const STORAGE_KEY_RPC_URLS = "arfhe_rpc_urls";
const STORAGE_KEY_PRICE_ALERT_CONFIG = "arfhe_price_alert_config";

const TX_POLL_INTERVAL_MINUTES = 0.25; // 15 seconds
const PRICE_CHECK_INTERVAL_MINUTES = 5; // 5 minutes
const BADGE_SYNC_INTERVAL_MINUTES = 1; // 1 minute
const MAX_TX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours — auto-expire old TXs
const MAX_TX_POLLS = 240; // 240 polls × 15s = 1 hour max
const PRICE_CHANGE_THRESHOLD = 0.05; // 5% change triggers alert

// ── Default public RPC endpoints (no API key needed) ────────────────
const DEFAULT_RPC = {
  1: "https://ethereum.publicnode.com",
  4: "https://ethereum-sepolia.publicnode.com",
  42161: "https://arbitrum.publicnode.com",
  421614: "https://arbitrum-sepolia.publicnode.com",
  8453: "https://base.publicnode.com",
  84532: "https://base-sepolia.publicnode.com",
  8008135: "https://api.helium.fhenix.zone",
};

// ─── In-Memory State (lost on SW restart, restored from storage) ────
let pendingTxs = new Map(); // txHash → { hash, networkId, rpcUrl, addedAt, pollCount, from, to, value }
let lastEthPrice = null; // { usd: number, timestamp: number }
let rpcOverrides = {}; // networkId → rpcUrl (set by popup when Alchemy key is available)
let priceAlertConfig = { enabled: true, threshold: PRICE_CHANGE_THRESHOLD };

// ─── Extension Install / Startup ────────────────────────────────────

/**
 * Keep session storage unreadable from web pages.
 *
 * The unlocked wallet's AES key lives in `chrome.storage.session` so the popup can be
 * reopened without retyping the password. Content scripts run on every site, so if they
 * could read that area a single visited page would own the wallet. `TRUSTED_CONTEXTS` is
 * already Chrome's default, but the default is not something to stake the master key on —
 * stating it makes the guarantee explicit and survives a change of default.
 */
async function hardenSessionStorage() {
  try {
    await chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  } catch {
    // Older Chrome without setAccessLevel; the default is already TRUSTED_CONTEXTS.
  }
}

chrome.runtime.onInstalled.addListener(async () => {

  // Clear stale cache on install
  try { chrome.browsingData.removeCache({}); } catch { /* */ }

  await hardenSessionStorage();
  await setupAlarms();
  await restoreState();
});

chrome.runtime.onStartup.addListener(async () => {
  await hardenSessionStorage();
  await setupAlarms();
  await restoreState();
});

async function setupAlarms() {
  // Clear all existing alarms first
  await chrome.alarms.clearAll();

  // Badge sync — always runs
  chrome.alarms.create(ALARM_BADGE_SYNC, { periodInMinutes: BADGE_SYNC_INTERVAL_MINUTES });

  // Price check — periodic
  chrome.alarms.create(ALARM_PRICE_CHECK, {
    delayInMinutes: 0.5,
    periodInMinutes: PRICE_CHECK_INTERVAL_MINUTES,
  });

}

async function restoreState() {
  try {
    const result = await chrome.storage.local.get([
      STORAGE_KEY_PENDING_TXS,
      STORAGE_KEY_PRICE_STATE,
      STORAGE_KEY_RPC_URLS,
      STORAGE_KEY_PRICE_ALERT_CONFIG,
    ]);

    // Restore pending TXs
    const stored = result[STORAGE_KEY_PENDING_TXS];
    if (Array.isArray(stored)) {
      pendingTxs = new Map();
      const now = Date.now();
      for (const tx of stored) {
        // Skip expired TXs
        if (now - tx.addedAt > MAX_TX_AGE_MS) continue;
        pendingTxs.set(tx.hash, tx);
      }
      if (pendingTxs.size > 0) {
        startTxMonitorAlarm();
      }
    }

    // Restore price state
    if (result[STORAGE_KEY_PRICE_STATE]) {
      lastEthPrice = result[STORAGE_KEY_PRICE_STATE];
    }

    // Restore RPC overrides
    if (result[STORAGE_KEY_RPC_URLS]) {
      rpcOverrides = result[STORAGE_KEY_RPC_URLS];
    }

    // Restore price alert config
    if (result[STORAGE_KEY_PRICE_ALERT_CONFIG]) {
      priceAlertConfig = { ...priceAlertConfig, ...result[STORAGE_KEY_PRICE_ALERT_CONFIG] };
    }
  } catch (e) {
  }
}

// ─── Alarm Handler ──────────────────────────────────────────────────

chrome.alarms.onAlarm.addListener(async (alarm) => {
  switch (alarm.name) {
    case ALARM_TX_MONITOR:
      await pollPendingTransactions();
      break;
    case ALARM_PRICE_CHECK:
      await checkPriceChanges();
      break;
    case ALARM_BADGE_SYNC:
      await syncBadge();
      break;
    case ALARM_KEEPALIVE:
      // Just a keepalive ping — prevents SW from being killed
      break;
  }
});

// ─── TX Monitoring ──────────────────────────────────────────────────

function startTxMonitorAlarm() {
  chrome.alarms.create(ALARM_TX_MONITOR, {
    delayInMinutes: 0.05, // Start in 3 seconds
    periodInMinutes: TX_POLL_INTERVAL_MINUTES,
  });
  // Also create a keepalive to prevent SW from sleeping
  chrome.alarms.create(ALARM_KEEPALIVE, {
    delayInMinutes: 0.08,
    periodInMinutes: 0.2, // Every 12 seconds
  });
}

function stopTxMonitorAlarm() {
  chrome.alarms.clear(ALARM_TX_MONITOR);
  chrome.alarms.clear(ALARM_KEEPALIVE);
}

/**
 * Add a transaction to the monitoring watchlist.
 */
async function watchTransaction(txData) {
  const entry = {
    hash: txData.hash,
    networkId: txData.networkId || 1,
    rpcUrl: txData.rpcUrl || getRpcUrl(txData.networkId || 1),
    addedAt: Date.now(),
    pollCount: 0,
    from: txData.from || "",
    to: txData.to || "",
    value: txData.value || "",
    symbol: txData.symbol || "ETH",
    type: txData.type || "transfer", // transfer | swap | approve
  };

  pendingTxs.set(entry.hash, entry);
  await persistPendingTxs();

  // Start monitoring if not already running
  const existing = await chrome.alarms.get(ALARM_TX_MONITOR);
  if (!existing) {
    startTxMonitorAlarm();
  }

  // Update badge immediately
  await syncBadge();

  return entry;
}

/**
 * Poll all pending transactions for receipt.
 */
async function pollPendingTransactions() {
  if (pendingTxs.size === 0) {
    stopTxMonitorAlarm();
    return;
  }

  const completed = [];

  for (const [hash, tx] of pendingTxs) {
    tx.pollCount++;

    // Auto-expire after max polls
    if (tx.pollCount > MAX_TX_POLLS) {
      completed.push(hash);
      await notifyTxExpired(tx);
      continue;
    }

    // Auto-expire after max age
    if (Date.now() - tx.addedAt > MAX_TX_AGE_MS) {
      completed.push(hash);
      continue;
    }

    try {
      const receipt = await getTransactionReceipt(tx.rpcUrl, hash);

      if (receipt) {
        completed.push(hash);

        if (receipt.status === "0x1" || receipt.status === 1) {
          await notifyTxConfirmed(tx, receipt);
        } else {
          await notifyTxFailed(tx);
        }
      }
      // If receipt is null, TX is still pending — will retry next poll
    } catch (e) {
      // Don't remove on RPC error — will retry
    }
  }

  // Remove completed TXs
  for (const hash of completed) {
    pendingTxs.delete(hash);
  }

  if (completed.length > 0) {
    await persistPendingTxs();
    await syncBadge();
  }

  // Stop alarm if no more pending TXs
  if (pendingTxs.size === 0) {
    stopTxMonitorAlarm();
  }
}

/**
 * eth_getTransactionReceipt via JSON-RPC.
 */
async function getTransactionReceipt(rpcUrl, txHash) {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "eth_getTransactionReceipt",
      params: [txHash],
      id: 1,
    }),
  });

  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);

  const json = await res.json();
  if (json.error) throw new Error(json.error.message);

  return json.result; // null if pending, object if mined
}

async function notifyTxConfirmed(tx, receipt) {
  const gasUsed = receipt.gasUsed ? parseInt(receipt.gasUsed, 16) : null;

  await addStoredNotification({
    type: "tx_confirmed",
    title: "✅ Transaction Confirmed",
    message: `${tx.type === "swap" ? "Swap" : "Transfer"} of ${tx.value} ${tx.symbol} confirmed${gasUsed ? ` (gas: ${gasUsed.toLocaleString()})` : ""}`,
    data: { txHash: tx.hash, from: tx.from, to: tx.to, value: tx.value, networkId: String(tx.networkId) },
  });

  try {
    chrome.notifications.create(`arfhe_tx_ok_${Date.now()}`, {
      type: "basic",
      iconUrl: "images/icon48.png",
      title: "✅ Transaction Confirmed",
      message: `${tx.value} ${tx.symbol} — ${shortHash(tx.hash)}`,
      priority: 2,
    });
  } catch { /* notifications API not available */ }
}

async function notifyTxFailed(tx) {
  await addStoredNotification({
    type: "tx_failed",
    title: "❌ Transaction Failed",
    message: `${tx.type === "swap" ? "Swap" : "Transfer"} of ${tx.value} ${tx.symbol} failed`,
    data: { txHash: tx.hash, from: tx.from, to: tx.to, value: tx.value, networkId: String(tx.networkId) },
  });

  try {
    chrome.notifications.create(`arfhe_tx_fail_${Date.now()}`, {
      type: "basic",
      iconUrl: "images/icon48.png",
      title: "❌ Transaction Failed",
      message: `${tx.value} ${tx.symbol} — ${shortHash(tx.hash)}`,
      priority: 2,
    });
  } catch { /* */ }
}

async function notifyTxExpired(tx) {
  await addStoredNotification({
    type: "tx_failed",
    title: "⏰ Transaction Timeout",
    message: `TX ${shortHash(tx.hash)} was not confirmed within the monitoring window`,
    data: { txHash: tx.hash, networkId: String(tx.networkId) },
  });
}

// ─── Price Monitoring ───────────────────────────────────────────────

async function checkPriceChanges() {
  if (!priceAlertConfig.enabled) return;

  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd",
      { headers: { Accept: "application/json" } }
    );

    if (!res.ok) return;

    const data = await res.json();
    const currentPrice = data?.ethereum?.usd;
    if (!currentPrice || typeof currentPrice !== "number") return;

    const now = Date.now();

    if (lastEthPrice && lastEthPrice.usd > 0) {
      const change = (currentPrice - lastEthPrice.usd) / lastEthPrice.usd;
      const absChange = Math.abs(change);
      const threshold = priceAlertConfig.threshold || PRICE_CHANGE_THRESHOLD;

      if (absChange >= threshold) {
        const direction = change > 0 ? "📈" : "📉";
        const pct = (change * 100).toFixed(1);
        const sign = change > 0 ? "+" : "";


        await addStoredNotification({
          type: "price_alert",
          title: `${direction} ETH Price ${sign}${pct}%`,
          message: `ETH is now $${currentPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} (was $${lastEthPrice.usd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })})`,
          data: {},
        });

        try {
          chrome.notifications.create(`arfhe_price_${now}`, {
            type: "basic",
            iconUrl: "images/icon48.png",
            title: `${direction} ETH ${sign}${pct}%`,
            message: `$${currentPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
            priority: 1,
          });
        } catch { /* */ }
      }
    }

    // Update stored price
    lastEthPrice = { usd: currentPrice, timestamp: now };
    await chrome.storage.local.set({ [STORAGE_KEY_PRICE_STATE]: lastEthPrice });

  } catch (e) {
  }
}

// ─── Badge Management ───────────────────────────────────────────────

async function syncBadge() {
  try {
    const unreadCount = await getUnreadNotificationCount();
    const pendingCount = pendingTxs.size;
    const total = unreadCount + pendingCount;

    // Badge text: show total, with pending TX indicator
    let badgeText = "";
    if (total > 0) {
      badgeText = total > 99 ? "99+" : String(total);
    }

    // Badge color: orange if pending TXs, red if only notifications
    const badgeColor = pendingCount > 0 ? "#f59e0b" : "#ef4444";

    chrome.action.setBadgeText({ text: badgeText });
    chrome.action.setBadgeBackgroundColor({ color: badgeColor });
  } catch {
    // Not in extension context
  }
}

async function getUnreadNotificationCount() {
  try {
    const result = await chrome.storage.local.get(STORAGE_KEY_NOTIFICATIONS);
    const notifications = result[STORAGE_KEY_NOTIFICATIONS] || [];
    return notifications.filter((n) => !n.read).length;
  } catch {
    return 0;
  }
}

// ─── Message Handler (popup ↔ SW & content script ↔ SW) ────────────────

/**
 * EIP-1193 error codes used when answering a web page.
 * @see https://eips.ethereum.org/EIPS/eip-1193#provider-errors
 */
const RPC_ERR_REJECTED = 4001;
const RPC_ERR_UNSUPPORTED_METHOD = 4200;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Everything in `handleMessage` is privileged: it can fetch arbitrary URLs with the
  // extension's host permissions, repoint RPC endpoints, raise wallet-branded
  // notifications and read the pending-transaction list.
  //
  // A content script runs on every page and forwards what the page gives it, so anything
  // reachable from `sender.tab` is reachable by any website. Previously the split was
  // `sender.tab && message.method` — a page message with no `method` field fell straight
  // through to the privileged handler, which let any site use the wallet as an HTTP proxy
  // and read the user's pending transactions.
  //
  // The origin of a message is the only thing that can be trusted here, so that is what
  // gates it: extension pages (no `tab`, our own id) get the privileged surface, and
  // everything else is handled as an untrusted dApp request.
  const isExtensionPage = !sender.tab && sender.id === chrome.runtime.id;

  if (!isExtensionPage) {
    handleDappRequest(message, sender).then(sendResponse).catch((e) => {
      sendResponse({ error: { code: RPC_ERR_REJECTED, message: e?.message ?? "Request failed" } });
    });
    return true;
  }

  handleMessage(message).then(sendResponse).catch((e) => {
    sendResponse({ success: false, error: e.message });
  });
  return true; // Keep channel open for async response
});

// ════════════════════════════════════════════════════════════════════
//  Injected provider (window.ethereum)
// ════════════════════════════════════════════════════════════════════
//
// A web page reaches this through the content script's port. Nothing here is trusted, and
// the origin is taken from `sender` — never from the message — because the message is
// written by the page.
//
// Three tiers of access:
//
//   public      the chain id. Sites read it before connecting to decide what to show, and
//               it reveals nothing about the user.
//   permitted   account list and read-only chain calls. Requires a stored grant for the
//               origin, so an unconnected site learns nothing — not the address, not the
//               balance, not the history.
//   approved    signing, sending, chain switching. Requires a grant *and* a fresh
//               user decision in the approval window, every time.
//
// Signing never happens here: the key only exists in an unlocked extension page. The
// service worker routes and gates; the approval page decides and signs.

/** Storage key shared with SitePermissionService. Both sides must agree on it. */
const STORAGE_KEY_SITE_PERMISSIONS = "arfhe_site_permissions";
/** Wallet state pushed by the popup: which chain and RPC to answer with. */
const STORAGE_KEY_WALLET_STATE = "arfhe_wallet_state";
/** Requests waiting on the approval window. */
const STORAGE_KEY_PENDING_APPROVALS = "arfhe_pending_approvals";

const RPC_ERR_UNAUTHORIZED = 4100;
const RPC_ERR_DISCONNECTED = 4900;
const RPC_ERR_CHAIN_NOT_ADDED = 4902;

/**
 * Read-only chain calls a connected site may make.
 *
 * An allowlist, not a denylist: an unknown `eth_*` method could be anything, including
 * node-specific extensions that read local state. Each of these is forwarded to the
 * wallet's RPC for the active chain and nowhere else, which is what keeps this from
 * becoming the open proxy that a general URL fetch would be.
 */
const PROXY_METHODS = new Set([
  "eth_blockNumber",
  "eth_call",
  "eth_estimateGas",
  "eth_feeHistory",
  "eth_gasPrice",
  "eth_getBalance",
  "eth_getBlockByHash",
  "eth_getBlockByNumber",
  "eth_getCode",
  "eth_getLogs",
  "eth_getStorageAt",
  "eth_getTransactionByHash",
  "eth_getTransactionCount",
  "eth_getTransactionReceipt",
  "eth_maxPriorityFeePerGas",
]);

/** Methods that need a fresh user decision every time they are called. */
const APPROVAL_METHODS = new Set([
  "eth_sendTransaction",
  "personal_sign",
  "eth_signTypedData",
  "eth_signTypedData_v4",
  "wallet_switchEthereumChain",
  "wallet_addEthereumChain",
]);

// ─── Permission reads ───────────────────────────────────────────────
//
// Writes belong to SitePermissionService (src/backend), which owns normalisation and the
// replace-not-merge rule. This side only looks a grant up by the exact origin Chrome
// reports, so there is no second copy of that logic to drift.

async function getGrantedAccounts(origin) {
  if (!origin) return [];
  try {
    const result = await chrome.storage.local.get(STORAGE_KEY_SITE_PERMISSIONS);
    const all = result?.[STORAGE_KEY_SITE_PERMISSIONS];
    if (!Array.isArray(all)) return [];

    const entry = all.find((p) => p && p.origin === origin && Array.isArray(p.accounts));
    return entry ? entry.accounts.filter((a) => typeof a === "string") : [];
  } catch {
    // A store that cannot be read grants nothing.
    return [];
  }
}

/** Active chain and RPC, as last pushed by the wallet UI. */
async function getWalletState() {
  try {
    const result = await chrome.storage.local.get(STORAGE_KEY_WALLET_STATE);
    return result?.[STORAGE_KEY_WALLET_STATE] ?? null;
  } catch {
    return null;
  }
}

// ─── Request routing ────────────────────────────────────────────────

/**
 * Answer an EIP-1193 request from a web page.
 *
 * @param message `{ method, params }` rebuilt by the content script.
 * @param sender  Chrome's view of who is asking. The only trustworthy origin.
 */
async function handleDappRequest(message, sender) {
  const method = typeof message?.method === "string" ? message.method : "";
  if (!method) {
    return { error: { code: RPC_ERR_UNSUPPORTED_METHOD, message: "Missing method" } };
  }

  const origin = sender?.origin || (sender?.url ? safeOrigin(sender.url) : "");
  if (!origin) {
    return { error: { code: RPC_ERR_UNAUTHORIZED, message: "Requests are only accepted from a website." } };
  }

  const params = Array.isArray(message.params) ? message.params : [];
  const state = await getWalletState();

  // ── Public ────────────────────────────────────────────────────────
  if (method === "eth_chainId") {
    return { result: state?.chainIdHex ?? "0x0" };
  }
  if (method === "net_version") {
    return { result: state?.chainId ? String(state.chainId) : "0" };
  }

  // ── Account list ──────────────────────────────────────────────────
  // `eth_accounts` never prompts: EIP-1193 defines it as "what am I already allowed to
  // see", and a site polling it must not be able to raise a window.
  if (method === "eth_accounts") {
    return { result: await getGrantedAccounts(origin) };
  }

  if (method === "eth_requestAccounts" || method === "wallet_requestPermissions") {
    const existing = await getGrantedAccounts(origin);
    if (existing.length > 0) {
      touchPermission(origin);
      return { result: method === "eth_requestAccounts" ? existing : [{ parentCapability: "eth_accounts" }] };
    }
    return requestApproval({ method, params, origin, tabId: sender?.tab?.id });
  }

  if (method === "wallet_revokePermissions") {
    // Letting a site drop its own access needs no prompt; it only ever removes.
    await revokeOriginFromWorker(origin);
    broadcastToOrigin(origin, "accountsChanged", []);
    return { result: null };
  }

  // Everything below requires the site to be connected. Answering an unconnected site —
  // even a balance lookup — would tell it the user has this wallet and hand it chain data
  // tied to whatever address it asks about.
  const accounts = await getGrantedAccounts(origin);
  if (accounts.length === 0) {
    return {
      error: {
        code: RPC_ERR_UNAUTHORIZED,
        message: "This site is not connected to Arfhe Wallet. Request access first.",
      },
    };
  }
  touchPermission(origin);

  // ── Approval-gated ────────────────────────────────────────────────
  if (APPROVAL_METHODS.has(method)) {
    return requestApproval({ method, params, origin, tabId: sender?.tab?.id });
  }

  // ── Read-only proxy ───────────────────────────────────────────────
  if (PROXY_METHODS.has(method)) {
    if (!state?.rpcUrl) {
      return { error: { code: RPC_ERR_DISCONNECTED, message: "The wallet has no active network." } };
    }
    return proxyRpc(state.rpcUrl, method, params);
  }

  return {
    error: {
      code: RPC_ERR_UNSUPPORTED_METHOD,
      message: `Arfhe Wallet does not support ${method}.`,
    },
  };
}

function safeOrigin(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.origin : "";
  } catch {
    return "";
  }
}

/** Forward one allowlisted read to the wallet's RPC for the active chain. */
async function proxyRpc(rpcUrl, method, params) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      return { error: { code: RPC_ERR_DISCONNECTED, message: `RPC returned HTTP ${res.status}` } };
    }

    const json = await res.json();
    if (json.error) {
      return { error: { code: json.error.code ?? -32603, message: json.error.message ?? "RPC error" } };
    }
    return { result: json.result };
  } catch (e) {
    const msg = e?.message ?? String(e);
    return {
      error: {
        code: RPC_ERR_DISCONNECTED,
        message: msg.includes("abort") ? "The network request timed out." : msg,
      },
    };
  }
}

async function revokeOriginFromWorker(origin) {
  try {
    const result = await chrome.storage.local.get(STORAGE_KEY_SITE_PERMISSIONS);
    const all = Array.isArray(result?.[STORAGE_KEY_SITE_PERMISSIONS])
      ? result[STORAGE_KEY_SITE_PERMISSIONS]
      : [];
    await chrome.storage.local.set({
      [STORAGE_KEY_SITE_PERMISSIONS]: all.filter((p) => p?.origin !== origin),
    });
  } catch { /* nothing to revoke */ }
}

/** Best-effort "this grant was used" stamp; never blocks a request. */
function touchPermission(origin) {
  chrome.storage.local.get(STORAGE_KEY_SITE_PERMISSIONS).then((result) => {
    const all = result?.[STORAGE_KEY_SITE_PERMISSIONS];
    if (!Array.isArray(all)) return;
    let changed = false;
    const next = all.map((p) => {
      if (p?.origin !== origin) return p;
      changed = true;
      return { ...p, lastUsedAt: Date.now() };
    });
    if (changed) chrome.storage.local.set({ [STORAGE_KEY_SITE_PERMISSIONS]: next });
  }).catch(() => { /* stamping is cosmetic */ });
}

async function handleMessage(message) {
  switch (message.type) {
    // ── TX Monitoring ─────────────────────────────────────────
    case "WATCH_TX": {
      const entry = await watchTransaction(message);
      return { success: true, entry };
    }

    case "REMOVE_TX": {
      pendingTxs.delete(message.txHash);
      await persistPendingTxs();
      await syncBadge();
      return { success: true };
    }

    case "GET_PENDING_TXS": {
      return {
        success: true,
        pendingTxs: Array.from(pendingTxs.values()),
      };
    }

    // ── Status ────────────────────────────────────────────────
    case "GET_STATUS": {
      return {
        success: true,
        status: {
          pendingTxCount: pendingTxs.size,
          pendingTxs: Array.from(pendingTxs.values()).map((tx) => ({
            hash: tx.hash,
            networkId: tx.networkId,
            addedAt: tx.addedAt,
            pollCount: tx.pollCount,
            symbol: tx.symbol,
            value: tx.value,
          })),
          lastEthPrice: lastEthPrice,
          priceAlertConfig: priceAlertConfig,
        },
      };
    }

    // ── Badge ─────────────────────────────────────────────────
    case "CLEAR_BADGE": {
      chrome.action.setBadgeText({ text: "" });
      return { success: true };
    }

    case "UPDATE_BADGE": {
      const count = message.count || 0;
      chrome.action.setBadgeText({ text: count > 0 ? String(count) : "" });
      chrome.action.setBadgeBackgroundColor({ color: message.color || "#ef4444" });
      return { success: true };
    }

    // ── Notifications ─────────────────────────────────────────
    case "SHOW_NOTIFICATION": {
      try {
        chrome.notifications.create(`arfhe_${Date.now()}`, {
          type: "basic",
          iconUrl: message.iconUrl || "images/icon48.png",
          title: message.title || "Arfhe Wallet",
          message: message.message || "",
          priority: message.priority || 1,
        });
      } catch { /* */ }
      return { success: true };
    }

    case "TX_CONFIRMED": {
      // Legacy support — popup manually confirming a TX
      const sh = message.txHash ? shortHash(message.txHash) : "Unknown";
      try {
        chrome.notifications.create(`arfhe_tx_${Date.now()}`, {
          type: "basic",
          iconUrl: "images/icon48.png",
          title: "✅ Transaction Confirmed",
          message: `TX ${sh} confirmed on-chain`,
          priority: 2,
        });
      } catch { /* */ }
      return { success: true };
    }

    case "TX_FAILED": {
      try {
        chrome.notifications.create(`arfhe_txfail_${Date.now()}`, {
          type: "basic",
          iconUrl: "images/icon48.png",
          title: "❌ Transaction Failed",
          message: message.reason || "Transaction failed",
          priority: 2,
        });
      } catch { /* */ }
      return { success: true };
    }

    // ── RPC Configuration ─────────────────────────────────────
    case "SET_RPC_URL": {
      if (message.networkId && message.rpcUrl) {
        rpcOverrides[message.networkId] = message.rpcUrl;
        await chrome.storage.local.set({ [STORAGE_KEY_RPC_URLS]: rpcOverrides });
      }
      return { success: true };
    }

    // ── Price Alert Configuration ─────────────────────────────
    case "SET_PRICE_ALERT": {
      priceAlertConfig = {
        enabled: message.enabled !== undefined ? message.enabled : priceAlertConfig.enabled,
        threshold: message.threshold || priceAlertConfig.threshold,
      };
      await chrome.storage.local.set({ [STORAGE_KEY_PRICE_ALERT_CONFIG]: priceAlertConfig });
      return { success: true, config: priceAlertConfig };
    }

    // ── Popup lifecycle ───────────────────────────────────────
    case "POPUP_OPENED": {
      // Sync state when popup opens
      await syncBadge();
      return {
        success: true,
        pendingTxCount: pendingTxs.size,
        lastEthPrice: lastEthPrice,
      };
    }

    case "POPUP_CLOSED": {
      // Nothing special needed — alarms continue running
      return { success: true };
    }

    // ── Generic RPC Proxy (popup → service worker → external RPC) ──
    // Service workers are NOT subject to popup CSP restrictions.
    // Use this for any external fetch from popup that fails due to CORS / CSP.
    case "RPC_FETCH": {
      const { url, body: rpcBody } = message;
      if (!url) return { success: false, error: "No URL provided" };
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 12000);
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Accept": "application/json" },
          body: typeof rpcBody === "string" ? rpcBody : JSON.stringify(rpcBody),
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (!res.ok) return { success: false, error: `HTTP ${res.status}: ${res.statusText}` };
        const json = await res.json();
        return { success: true, data: json };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("abort")) return { success: false, error: "Connection timed out" };
        return { success: false, error: msg };
      }
    }

    // ── Injected provider support (extension pages only) ──────────
    //
    // Reachable only from the popup and the approval window; the origin gate in
    // onMessage keeps every website out of this branch.

    /** The wallet UI tells the worker which chain and RPC to answer sites with. */
    case "SET_WALLET_STATE": {
      const state = {
        chainId: message.chainId ?? null,
        chainIdHex: message.chainId ? `0x${Number(message.chainId).toString(16)}` : null,
        rpcUrl: message.rpcUrl ?? null,
      };
      await chrome.storage.local.set({ [STORAGE_KEY_WALLET_STATE]: state });

      // A chain switch invalidates what connected pages believe. EIP-1193 requires the
      // event, and without it a dApp keeps preparing transactions for the old chain.
      if (state.chainIdHex) broadcastEvent("chainChanged", state.chainIdHex);
      return { success: true };
    }

    /** Permissions changed in the wallet UI — tell each origin its own new list. */
    case "PERMISSIONS_CHANGED": {
      await broadcastAccountsForAllOrigins();
      return { success: true };
    }

    /** The approval window asks what it is being asked to approve. */
    case "GET_PENDING_APPROVAL": {
      const result = await chrome.storage.session.get(STORAGE_KEY_PENDING_APPROVALS);
      const all = Array.isArray(result?.[STORAGE_KEY_PENDING_APPROVALS])
        ? result[STORAGE_KEY_PENDING_APPROVALS]
        : [];
      const entry = message.requestId
        ? all.find((p) => p?.id === message.requestId)
        : all[0];
      return { success: true, request: entry ?? null, queued: all.length };
    }

    /** The user decided. `result` on approval, `error` on refusal. */
    case "APPROVAL_RESULT": {
      const payload = message.error
        ? { error: { code: message.error.code ?? RPC_ERR_REJECTED, message: message.error.message ?? "User rejected the request." } }
        : { result: message.result };

      const settled = settleApproval(message.requestId, payload);

      // A connection that was just granted has to reach the page as an event too — dApps
      // listen for `accountsChanged` rather than re-polling after connecting.
      if (settled && !message.error && message.origin) {
        broadcastToOrigin(message.origin, "accountsChanged", await getGrantedAccounts(message.origin));
      }
      return { success: settled };
    }

    default:
      return { success: false, error: `Unknown message type: ${message.type}` };
  }
}

// ─── Storage Helpers ────────────────────────────────────────────────

async function persistPendingTxs() {
  try {
    const txArray = Array.from(pendingTxs.values());
    await chrome.storage.local.set({ [STORAGE_KEY_PENDING_TXS]: txArray });
  } catch (e) {
  }
}

async function addStoredNotification(notification) {
  try {
    const result = await chrome.storage.local.get(STORAGE_KEY_NOTIFICATIONS);
    const notifications = result[STORAGE_KEY_NOTIFICATIONS] || [];

    const newNotif = {
      ...notification,
      id: `notif_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now(),
      read: false,
    };

    notifications.unshift(newNotif);

    // Keep max 50 notifications
    const trimmed = notifications.slice(0, 50);
    await chrome.storage.local.set({ [STORAGE_KEY_NOTIFICATIONS]: trimmed });

    // Update badge
    await syncBadge();

    return newNotif;
  } catch (e) {
  }
}

function getRpcUrl(networkId) {
  // Check for popup-provided override (e.g., Alchemy URL)
  if (rpcOverrides[networkId]) return rpcOverrides[networkId];
  // Fallback to public RPC
  return DEFAULT_RPC[networkId] || DEFAULT_RPC[1];
}

function shortHash(hash) {
  if (!hash || hash.length < 16) return hash || "???";
  return `${hash.slice(0, 10)}...${hash.slice(-6)}`;
}

// ─── Approval window ────────────────────────────────────────────────
//
// Signing needs the decrypted key, which only exists in an unlocked extension page. So the
// worker parks the request, opens a window, and waits for that page to come back with a
// result. The worker never sees a key and never decides on the user's behalf.

/** id → { resolve } for requests currently in front of the user. In-memory by nature. */
const pendingApprovals = new Map();

/** Window id of the approval popup, so repeat requests reuse one window. */
let approvalWindowId = null;

let approvalCounter = 0;

/**
 * Park a request, show it to the user, and resolve with whatever they decide.
 *
 * The promise stays open for as long as the window does. If the service worker is torn
 * down first the port drops with it and the page sees a disconnect — the honest outcome,
 * and better than resolving something the user never saw.
 */
async function requestApproval({ method, params, origin, tabId }) {
  const id = `${Date.now()}-${++approvalCounter}`;

  const entry = {
    id,
    method,
    params,
    origin,
    tabId: tabId ?? null,
    createdAt: Date.now(),
  };

  await persistPendingApproval(entry);

  const decision = new Promise((resolve) => {
    pendingApprovals.set(id, { resolve, origin });
  });

  try {
    await openApprovalWindow(id);
  } catch (e) {
    pendingApprovals.delete(id);
    await removePendingApproval(id);
    return { error: { code: RPC_ERR_DISCONNECTED, message: `Could not open the approval window: ${e?.message ?? e}` } };
  }

  return decision;
}

async function persistPendingApproval(entry) {
  try {
    const result = await chrome.storage.session.get(STORAGE_KEY_PENDING_APPROVALS);
    const all = Array.isArray(result?.[STORAGE_KEY_PENDING_APPROVALS]) ? result[STORAGE_KEY_PENDING_APPROVALS] : [];
    all.push(entry);
    await chrome.storage.session.set({ [STORAGE_KEY_PENDING_APPROVALS]: all });
  } catch { /* the in-memory resolver still drives the flow */ }
}

async function removePendingApproval(id) {
  try {
    const result = await chrome.storage.session.get(STORAGE_KEY_PENDING_APPROVALS);
    const all = Array.isArray(result?.[STORAGE_KEY_PENDING_APPROVALS]) ? result[STORAGE_KEY_PENDING_APPROVALS] : [];
    await chrome.storage.session.set({
      [STORAGE_KEY_PENDING_APPROVALS]: all.filter((p) => p?.id !== id),
    });
  } catch { /* nothing to clean */ }
}

async function openApprovalWindow(requestId) {
  const url = chrome.runtime.getURL(`index.html#/approve?requestId=${encodeURIComponent(requestId)}`);

  // Reuse an open approval window so a site firing several requests cannot paper the
  // screen with popups.
  if (approvalWindowId !== null) {
    try {
      await chrome.windows.get(approvalWindowId);
      await chrome.windows.update(approvalWindowId, { focused: true, drawAttention: true });
      return;
    } catch {
      approvalWindowId = null; // it was closed
    }
  }

  const created = await chrome.windows.create({
    url,
    type: "popup",
    width: 400,
    height: 660,
    focused: true,
  });
  approvalWindowId = created?.id ?? null;
}

chrome.windows?.onRemoved?.addListener((windowId) => {
  if (windowId !== approvalWindowId) return;
  approvalWindowId = null;

  // Closing the window is a refusal. Anything still waiting must be told so, or the page
  // sits on a promise that will never settle.
  for (const [id, entry] of pendingApprovals) {
    entry.resolve({ error: { code: RPC_ERR_REJECTED, message: "User rejected the request." } });
    removePendingApproval(id);
  }
  pendingApprovals.clear();
});

/** Called by the approval page once the user has decided. */
function settleApproval(requestId, payload) {
  const entry = pendingApprovals.get(requestId);
  if (!entry) return false;

  pendingApprovals.delete(requestId);
  removePendingApproval(requestId);
  entry.resolve(payload);
  return true;
}

// ─── Provider ports (content script ↔ worker) ───────────────────────
//
// A long-lived port rather than one-shot messaging, for two reasons: an open port keeps the
// worker alive while the user is looking at an approval window, and it gives the worker a
// channel to push `chainChanged` / `accountsChanged` back to pages that are already
// connected.

/** Connected content-script ports, so events can be pushed to them. */
const providerPorts = new Set();

chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== "arfhe-provider") return;

    const origin = port.sender?.origin || safeOrigin(port.sender?.url ?? "");
    port.__arfheOrigin = origin;
    providerPorts.add(port);

    port.onDisconnect.addListener(() => {
        providerPorts.delete(port);
    });

    port.onMessage.addListener(async (msg) => {
        // The page controls the payload, so the id is echoed back but nothing else from it
        // is trusted — the origin comes from `port.sender`.
        const id = typeof msg?.id === "string" ? msg.id : null;
        if (!id) return;

        let response;
        try {
            response = await handleDappRequest(
                { method: msg.method, params: msg.params },
                port.sender
            );
        } catch (e) {
            response = { error: { code: RPC_ERR_REJECTED, message: e?.message ?? "Request failed" } };
        }

        try {
            port.postMessage({ id, ...response });
        } catch {
            // Page navigated away mid-request; the port is already gone.
        }
    });
});

/** Push an EIP-1193 event to every connected page. */
function broadcastEvent(event, data) {
    for (const port of providerPorts) {
        try {
            port.postMessage({ event, data });
        } catch { /* dropped port */ }
    }
}

/** Push an event to the pages of one origin only. */
function broadcastToOrigin(origin, event, data) {
    for (const port of providerPorts) {
        if (port.__arfheOrigin !== origin) continue;
        try {
            port.postMessage({ event, data });
        } catch { /* dropped port */ }
    }
}

/**
 * Re-send `accountsChanged` to every connected page after a permission change.
 *
 * Each origin gets its own list: a site that was never granted account B must not learn
 * that B exists just because the user connected it somewhere else.
 */
async function broadcastAccountsForAllOrigins() {
    const origins = new Set();
    for (const port of providerPorts) {
        if (port.__arfheOrigin) origins.add(port.__arfheOrigin);
    }
    for (const origin of origins) {
        broadcastToOrigin(origin, "accountsChanged", await getGrantedAccounts(origin));
    }
}

// ─── Notification click handler ─────────────────────────────────────

chrome.notifications.onClicked.addListener((notifId) => {
  // Open the extension popup when a notification is clicked
  chrome.action.openPopup?.().catch(() => {
    // openPopup not available in all contexts, ignore
  });
  chrome.notifications.clear(notifId);
});

