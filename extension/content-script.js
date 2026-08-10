// Arfhe Wallet — Content Script
//
// Bridges the injected page provider (inpage.js) to the extension's service worker.
//
// This file is the trust boundary. It runs on every page, and the page can post it
// anything, so it must not act as a general-purpose forwarder: it previously handed the
// page's payload to the service worker untouched, which exposed privileged handlers
// (arbitrary fetch, RPC reconfiguration, notifications, the pending-transaction list) to
// any website. Only EIP-1193 shaped requests are relayed, and only ever as such.

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

/** Reply to the page, echoing the request id so concurrent calls cannot cross-resolve. */
const reply = (id, payload) => {
    window.postMessage({ target: CONTENT_TARGET, id, data: payload }, window.location.origin);
};

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

    const request = { method };
    if (Array.isArray(data.params)) request.params = data.params;

    try {
        chrome.runtime.sendMessage(request, (response) => {
            // A dead service worker leaves lastError set and `response` undefined; without
            // this the page's promise would never settle.
            if (chrome.runtime.lastError) {
                reply(id, { error: { code: 4900, message: chrome.runtime.lastError.message } });
                return;
            }
            reply(id, response ?? { error: { code: 4900, message: 'Wallet did not respond' } });
        });
    } catch (e) {
        // Fires when the extension is reloaded or updated mid-session.
        reply(id, { error: { code: 4900, message: e?.message ?? 'Wallet unavailable' } });
    }
});
