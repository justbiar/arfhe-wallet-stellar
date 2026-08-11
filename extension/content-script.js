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
/** Requests sent but not yet answered, so a dropped port can fail them explicitly. */
const inFlight = new Set();

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
        port = null;
        // The worker was torn down (extension reload, update, idle shutdown). Anything
        // still waiting will never be answered, and a promise that never settles leaves
        // the dApp spinning forever — so fail them explicitly.
        for (const id of inFlight) {
            reply(id, { error: { code: 4900, message: 'Arfhe Wallet disconnected' } });
        }
        inFlight.clear();
    });

    return port;
}

connect();

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
        inFlight.add(id);
        active.postMessage(request);
    } catch (e) {
        inFlight.delete(id);
        reply(id, { error: { code: 4900, message: e?.message ?? 'Arfhe Wallet is unavailable' } });
    }
});
