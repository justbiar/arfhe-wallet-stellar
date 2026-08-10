// Arfhe Wallet — Inpage Script
//
// Provides an EIP-1193 provider to the page and relays requests to the content script.
//
// Current scope: site connections are not implemented yet — there is no approval UI behind
// the injected provider — so requests are declined with a clear EIP-1193 error pointing at
// WalletConnect. That is deliberate: a wallet must never imply consent it did not obtain,
// and a request that hangs forever (the previous behaviour) is worse for a dApp than one
// that fails immediately.

(() => {
    const INPAGE_TARGET = 'arfhe-inpage';
    const CONTENT_TARGET = 'arfhe-content-script';

    /** Give up on a silent content script rather than leaking a pending promise per call. */
    const REQUEST_TIMEOUT_MS = 30_000;

    /** EIP-1193 error for a provider that is present but cannot service the request. */
    class ProviderRpcError extends Error {
        constructor(code, message, data) {
            super(message);
            this.name = 'ProviderRpcError';
            this.code = code;
            this.data = data;
        }
    }

    /** Pending requests by id, so concurrent calls resolve independently. */
    const pending = new Map();

    window.addEventListener('message', (event) => {
        if (event.source !== window) return;
        if (event.data?.target !== CONTENT_TARGET) return;

        // Correlate by id. Resolving on any reply — as this did before — meant two
        // in-flight calls could settle with each other's result: `eth_accounts` could
        // return whatever `eth_sendTransaction` answered, and vice versa.
        const entry = pending.get(event.data.id);
        if (!entry) return;

        pending.delete(event.data.id);
        clearTimeout(entry.timer);

        const payload = event.data.data;
        if (payload?.error) {
            entry.reject(new ProviderRpcError(
                payload.error.code ?? 4001,
                payload.error.message ?? 'Request rejected',
                payload.error.data
            ));
        } else {
            entry.resolve(payload?.result);
        }
    });

    class ArfheEthereumProvider {
        constructor() {
            this.isArfhe = true;
            /** No site connection is established until an approval flow exists. */
            this.chainId = null;
            this.selectedAddress = null;
            this._listeners = new Map();
        }

        /** EIP-1193: a method, not a property. dApps call `provider.isConnected()`. */
        isConnected() {
            return false;
        }

        request(args) {
            const method = args?.method;
            if (typeof method !== 'string' || method.length === 0) {
                return Promise.reject(
                    new ProviderRpcError(-32600, 'Expected a request with a string `method`')
                );
            }

            return new Promise((resolve, reject) => {
                const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

                const timer = setTimeout(() => {
                    pending.delete(id);
                    reject(new ProviderRpcError(4900, 'Arfhe Wallet did not respond'));
                }, REQUEST_TIMEOUT_MS);

                pending.set(id, { resolve, reject, timer });

                window.postMessage({
                    target: INPAGE_TARGET,
                    id,
                    data: { method, params: args?.params },
                }, window.location.origin);
            });
        }

        // ── Legacy surface still used by older dApps ────────────────────
        enable() {
            return this.request({ method: 'eth_requestAccounts' });
        }

        send(methodOrPayload, paramsOrCallback) {
            if (typeof methodOrPayload === 'string') {
                return this.request({ method: methodOrPayload, params: paramsOrCallback });
            }
            // Object form with a callback is the sendAsync signature.
            if (typeof paramsOrCallback === 'function') {
                return this.sendAsync(methodOrPayload, paramsOrCallback);
            }
            return this.request(methodOrPayload);
        }

        sendAsync(payload, callback) {
            this.request(payload).then(
                (result) => callback(null, { id: payload?.id, jsonrpc: '2.0', result }),
                (error) => callback(error, null)
            );
        }

        // ── EIP-1193 events ────────────────────────────────────────────
        on(eventName, listener) {
            if (!this._listeners.has(eventName)) this._listeners.set(eventName, new Set());
            this._listeners.get(eventName).add(listener);
            return this;
        }

        once(eventName, listener) {
            const wrapped = (...args) => {
                this.removeListener(eventName, wrapped);
                listener(...args);
            };
            return this.on(eventName, wrapped);
        }

        removeListener(eventName, listener) {
            this._listeners.get(eventName)?.delete(listener);
            return this;
        }

        removeAllListeners(eventName) {
            if (eventName) this._listeners.delete(eventName);
            else this._listeners.clear();
            return this;
        }

        /** @internal Emit to page listeners; one bad listener must not stop the rest. */
        _emit(eventName, payload) {
            for (const listener of this._listeners.get(eventName) ?? []) {
                try {
                    listener(payload);
                } catch { /* a dApp listener throwing is not our problem to propagate */ }
            }
        }
    }

    const provider = new ArfheEthereumProvider();

    // ── EIP-6963: announce alongside other wallets ─────────────────────
    //
    // Assigning `window.ethereum` is winner-takes-all, which is why the previous code
    // skipped injection whenever MetaMask was present — leaving Arfhe undiscoverable for
    // most users. EIP-6963 is the mechanism built to replace that race: every wallet
    // announces itself and the dApp lets the user choose.
    const providerInfo = {
        uuid: '9f8a6c14-2b7d-4e5a-9c31-6d0f2e8b4a17',
        name: 'Arfhe Wallet',
        rdns: 'zone.arfhe.wallet',
        // Inline SVG so the icon needs no web-accessible resource.
        icon: 'data:image/svg+xml;base64,' + btoa(
            '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">' +
            '<rect width="96" height="96" rx="22" fill="#10b981"/>' +
            '<path d="M48 22l20 9v20c0 13-8.5 21-20 25-11.5-4-20-12-20-25V31z" fill="#fff"/>' +
            '</svg>'
        ),
    };

    const announce = () => {
        window.dispatchEvent(new CustomEvent('eip6963:announceProvider', {
            detail: Object.freeze({ info: providerInfo, provider }),
        }));
    };

    window.addEventListener('eip6963:requestProvider', announce);
    announce();

    // Legacy fallback: only claim `window.ethereum` when nothing else has, so installing
    // Arfhe never breaks a dApp the user already reaches through another wallet.
    if (!window.ethereum) {
        window.ethereum = provider;
    }
    window.arfheWallet = provider;
})();
