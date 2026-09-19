// Arfhe Wallet — Content Script
//
// Bridges the injected page provider (inpage.js) to the extension's service worker.
//
// This file is the trust boundary. It runs on every page, and the page can post it
// anything, so it must not act as a general-purpose forwarder: it once handed the page's
// payload to the service worker untouched, which exposed privileged handlers (arbitrary
// fetch, RPC reconfiguration, the pending-transaction list) to any website. Only EIP-1193
// shaped requests are relayed, and only ever as such.
//
// The transport is a long-lived port rather than one-shot messaging, for two reasons: an
// open port keeps the service worker alive while the user is looking at an approval
// window, and it gives the worker a channel to push `chainChanged` / `accountsChanged`
// back to this page.

const INPAGE_TARGET = 'arfhe-inpage';
const CONTENT_TARGET = 'arfhe-content-script';

const injectScript = (file_path) => {
    const container = document.head || document.documentElement;
    const script = document.createElement('script');
    script.setAttribute('type', 'text/javascript');
    script.setAttribute('src', chrome.runtime.getURL(file_path));
    script.onload = () => {
        script.remove();
    };
    container.insertBefore(script, container.children[0]);
};

injectScript('inpage.js');

/** Send to the page, always with an explicit origin rather than '*'. */
const post = (payload) => {
    window.postMessage({ target: CONTENT_TARGET, ...payload }, window.location.origin);
};

const reply = (id, data) => post({ id, data });

// ─── Port to the service worker ─────────────────────────────────────

let port = null;
/**
 * Requests sent but not yet answered, keyed by id → method.
 *
 * The method matters when the port drops. A read that was in flight is genuinely lost and
 * has to be failed, or the page waits on a promise nobody will settle. A request waiting on
 * a *person* is not lost: the approval window is still open and the user is still deciding,
 * and the worker being recycled underneath them says nothing about their answer. Failing
 * those was telling the site the connection had been refused while the user was in the
 * middle of granting it.
 */
const inFlight = new Map();

/** Methods whose answer is a person deciding — mirrors inpage.js. */
const APPROVAL_METHODS = new Set([
    'eth_requestAccounts',
    'wallet_requestPermissions',
    'eth_sendTransaction',
    'personal_sign',
    'eth_signTypedData',
    'eth_signTypedData_v4',
    'wallet_switchEthereumChain',
    'wallet_addEthereumChain',
    // Stellar signing waits on a person too, so a dropped port must not cancel it.
    'stellar_signTransaction',
    'stellar_signMessage',
]);

/** Backoff for re-opening the channel, so a wallet being reloaded is not hammered. */
let reconnectDelay = 500;
const RECONNECT_DELAY_MAX = 15_000;
let reconnectTimer = null;

/**
 * Re-open the channel after the worker goes away.
 *
 * The port is not only how requests travel — it is the only way the wallet can *push*
 * anything to this page. MV3 tears the worker down when it goes idle, which it does
 * routinely, and previously that left `port = null` for good: a page loaded once and left
 * open could never again receive `accountsChanged` or `chainChanged`.
 *
 * That is what made a first connection look like it had failed. Approving takes long
 * enough for the worker to be recycled, so by the time the grant existed there was no
 * channel to announce it on — the site sat waiting, and only a second click, which found
 * the stored permission, appeared to work.
 *
 * Reconnecting only while the tab is visible keeps a hundred background tabs from holding
 * the worker awake for no one's benefit; a hidden tab reconnects when it is looked at.
 */
function scheduleReconnect() {
    if (reconnectTimer !== null) return;

    const attempt = () => {
        reconnectTimer = null;
        if (port) return;
        if (document.visibilityState === 'hidden') return; // retried on visibilitychange
        if (connect()) {
            reconnectDelay = 500;
            return;
        }
        reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_DELAY_MAX);
        scheduleReconnect();
    };

    reconnectTimer = setTimeout(attempt, reconnectDelay);
}

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !port) {
        reconnectDelay = 500;
        scheduleReconnect();
    }
});

/**
 * Restored from the back/forward cache.
 *
 * Freezing a page for bfcache tears down its extension port. `onDisconnect` already calls
 * scheduleReconnect, but that attempt gives up without rescheduling while the document is
 * hidden and waits on `visibilitychange` instead — so the reconnect depends on that event
 * firing on restore. It normally does. This covers the case where it does not, at the cost
 * of one redundant call, because the failure it guards against is silent: a page that came
 * back looking connected while holding a dead channel would miss `accountsChanged` and
 * `chainChanged` entirely and only find out when a request of its own failed.
 *
 * Belt and braces rather than a proven fix — a harness driving the disconnect could not
 * distinguish this from the existing path, because it could not reproduce a hidden
 * document. Kept because pressing Back is common and the guard costs nothing.
 */
window.addEventListener('pageshow', (e) => {
    if (e.persisted && !port) {
        reconnectDelay = 500;
        scheduleReconnect();
    }
});

function connect() {
    try {
        port = chrome.runtime.connect({ name: 'arfhe-provider' });
    } catch {
        port = null;
        return null;
    }

    port.onMessage.addListener((msg) => {
        // Worker-pushed EIP-1193 events carry no id.
        if (msg?.event) {
            post({ event: msg.event, data: msg.data });
            return;
        }
        if (typeof msg?.id !== 'string') return;
        inFlight.delete(msg.id);
        reply(msg.id, msg.error ? { error: msg.error } : { result: msg.result });
    });

    port.onDisconnect.addListener(() => {
        // Reading this — even to discard it — marks the error as handled. Otherwise Chrome
        // logs "Unchecked runtime.lastError" on every disconnect this listener didn't
        // explicitly acknowledge, including the routine one where the tab this port lived on
        // is moved into the back/forward cache. That disconnect is expected (see connect()'s
        // docs) and carries no information the reconnect logic below needs.
        void chrome.runtime.lastError;
        port = null;
        // The worker was torn down (extension reload, update, idle shutdown). Anything
        // still waiting will never be answered, and a promise that never settles leaves
        // the dApp spinning forever — so fail them explicitly.
        for (const [id, method] of [...inFlight]) {
            if (APPROVAL_METHODS.has(method)) continue; // still in front of the user
            inFlight.delete(id);
            reply(id, { error: { code: 4900, message: 'Arfhe Wallet disconnected' } });
        }
        scheduleReconnect();
    });

    return port;
}

connect();

/**
 * Second route for wallet-pushed events.
 *
 * The port is the primary one, but it exists only while a content script is connected, and
 * the worker is recycled precisely when it matters — while an approval sits in front of the
 * user. A message addressed to this tab arrives whether or not a port is open, so the
 * "you are connected now" event reaches the page even when the channel it was supposed to
 * travel on no longer exists.
 *
 * Only events are accepted here. Request replies stay on the port, where they are matched
 * to the id that asked.
 */
chrome.runtime.onMessage.addListener((msg) => {
    if (!msg?.event) return;
    post({ event: msg.event, data: msg.data });
});

// ─── Page → worker ──────────────────────────────────────────────────

window.addEventListener('message', (event) => {
    // Only messages this window posted to itself. Without this an embedded frame could
    // drive the wallet on behalf of the top-level page.
    if (event.source !== window) return;
    if (event.data?.target !== INPAGE_TARGET) return;

    const { id, data } = event.data;
    if (typeof id !== 'string') return;

    // Rebuild the request from scratch rather than passing the page's object along, so no
    // extra field the page invented can reach the service worker.
    const method = typeof data?.method === 'string' ? data.method : '';
    if (!method) {
        reply(id, { error: { code: 4200, message: 'Missing method' } });
        return;
    }

    const request = { id, method };
    if (Array.isArray(data.params)) request.params = data.params;

    const active = port ?? connect();
    if (!active) {
        reply(id, { error: { code: 4900, message: 'Arfhe Wallet is unavailable' } });
        return;
    }

    try {
        inFlight.set(id, method);
        active.postMessage(request);
    } catch (e) {
        inFlight.delete(id);
        reply(id, { error: { code: 4900, message: e?.message ?? 'Arfhe Wallet is unavailable' } });
    }
});
