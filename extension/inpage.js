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

    /**
     * Deadline for a request waiting on a person.
     *
     * Matches how long the wallet itself keeps a parked request alive. These used to have
     * no deadline at all, on the reasoning that a person takes as long as they take — but
     * the answer travels over a channel the browser can recycle, and an approval whose
     * reply is lost then left the dApp spinning with no error and no way to retry. Five
     * minutes is long enough to read and decide, and short enough to be an answer.
     */
    const APPROVAL_TIMEOUT_MS = 5 * 60_000;

    /** Methods whose answer is a person deciding, so no timeout applies. */
    const APPROVAL_METHODS = new Set([
        'eth_requestAccounts',
        'wallet_requestPermissions',
        'eth_sendTransaction',
        'personal_sign',
        'eth_signTypedData',
        'eth_signTypedData_v4',
        'wallet_switchEthereumChain',
        'wallet_addEthereumChain',
        // Waits on a person, so it gets the long deadline rather than the RPC one.
        'stellar_signTransaction',
        'stellar_signMessage',
    ]);

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

    /** Resolve any outstanding connection request with the accounts just granted. */
    function settleConnectRequests(accounts) {
        for (const [id, entry] of [...pending]) {
            if (entry.method !== 'eth_requestAccounts' && entry.method !== 'wallet_requestPermissions') continue;
            pending.delete(id);
            if (entry.timer) clearTimeout(entry.timer);
            entry.resolve(
                entry.method === 'eth_requestAccounts'
                    ? accounts
                    : [{ parentCapability: 'eth_accounts' }]
            );
        }
    }

    window.addEventListener('message', (event) => {
        if (event.source !== window) return;
        if (event.data?.target !== CONTENT_TARGET) return;

        // Wallet-pushed EIP-1193 events carry no id.
        if (event.data.event) {
            handleWalletEvent(event.data.event, event.data.data);
            return;
        }

        // Correlate by id. Resolving on any reply — as this did before — meant two
        // in-flight calls could settle with each other's result: `eth_accounts` could
        // return whatever `eth_sendTransaction` answered, and vice versa.
        const entry = pending.get(event.data.id);
        if (!entry) return;

        pending.delete(event.data.id);
        if (entry.timer) clearTimeout(entry.timer);

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
            /** Populated from the wallet, and kept current by the events below. */
            this.chainId = null;
            this.selectedAddress = null;
            this._connected = false;
            this._listeners = new Map();
        }

        /** EIP-1193: a method, not a property. dApps call `provider.isConnected()`. */
        isConnected() {
            return this._connected;
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

                // Approval methods wait on a person, so they get a far longer deadline —
                // but a deadline all the same. Nothing here may hang forever: a promise
                // that never settles is the one outcome a dApp cannot recover from.
                const waitsForUser = APPROVAL_METHODS.has(method);
                const timer = setTimeout(() => {
                    pending.delete(id);
                    reject(new ProviderRpcError(4900, 'Arfhe Wallet did not respond'));
                }, waitsForUser ? APPROVAL_TIMEOUT_MS : REQUEST_TIMEOUT_MS);

                pending.set(id, {
                    method,
                    // Keep the provider's cached view in step with what it just learned,
                    // so `provider.chainId` is not stale the moment a dApp reads it.
                    resolve: (result) => {
                        if (method === 'eth_chainId' && typeof result === 'string') {
                            provider.chainId = result;
                        }
                        if ((method === 'eth_accounts' || method === 'eth_requestAccounts') && Array.isArray(result)) {
                            provider.selectedAddress = result[0] ?? null;
                            provider._connected = result.length > 0;
                        }
                        resolve(result);
                    },
                    reject,
                    timer,
                });

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

    /**
     * Apply a wallet-pushed event and forward it to the page's listeners.
     *
     * The cached `chainId` / `selectedAddress` are updated before emitting, because dApps
     * commonly read them inside the handler — reading a stale value there is how a site
     * ends up preparing a transaction for the chain the user just left.
     */
    function handleWalletEvent(event, data) {
        switch (event) {
            case 'chainChanged':
                provider.chainId = data;
                provider._connected = true;
                provider._emit('chainChanged', data);
                break;

            case 'accountsChanged': {
                const accounts = Array.isArray(data) ? data : [];
                provider.selectedAddress = accounts[0] ?? null;

                // A granted connection settles whatever asked for it. The direct answer to
                // `eth_requestAccounts` travels over a port that MV3 recycles while the
                // user is still reading the approval screen, so for a first connection the
                // event is routinely the only thing that arrives — and without this the
                // page kept waiting on a request the user had already approved.
                if (accounts.length > 0) settleConnectRequests(accounts);

                // An empty list is EIP-1193's "no longer authorised", which is a
                // disconnect from the site's point of view.
                if (accounts.length === 0 && provider._connected) {
                    provider._connected = false;
                    provider._emit('accountsChanged', accounts);
                    provider._emit('disconnect', { code: 4900, message: 'Disconnected from Arfhe Wallet' });
                    break;
                }

                if (!provider._connected) {
                    provider._connected = true;
                    provider._emit('connect', { chainId: provider.chainId });
                }
                provider._emit('accountsChanged', accounts);
                break;
            }

            default:
                provider._emit(event, data);
        }
    }

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
        // The Arfhe mark itself, inlined as a data URI.
        //
        // It has to be inline: the picker renders in the page's own document, and a
        // web-accessible extension URL would be blocked by the content security policy
        // of most of the sites this runs on — which is how a wallet ends up listed with
        // a blank tile next to every other wallet's logo.
        //
        // Composited onto the wallet's bone surface rather than shipped transparent: the
        // mark is near-black line art, and half the pickers that show it use a dark
        // modal, where transparent means invisible.
        icon: 'data:image/png;base64,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',
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
    /**
     * Stellar, alongside the EIP-1193 surface rather than inside it.
     *
     * EIP-1193 describes an Ethereum provider: its `request` carries Ethereum methods and a
     * dApp reading `window.ethereum` expects Ethereum semantics. Stellar is a different
     * chain with different keys and a different transaction format, so it gets a named
     * namespace instead of being smuggled through method strings nobody would discover.
     *
     * Both still travel the same pipe — the methods below are exactly what `request` sends,
     * so a caller that prefers the raw form loses nothing.
     *
     *   const address = await window.arfheWallet.stellar.getAddress();
     *   const signed  = await window.arfheWallet.stellar.signTransaction(xdr, passphrase);
     */
    provider.stellar = Object.freeze({
        /**
         * The active account's Stellar address, or null when it has none.
         *
         * Never prompts, and answers only a connected site — the same rule `eth_accounts`
         * follows. Null is a real answer: an account imported from a raw private key has no
         * recovery phrase to derive a Stellar key from.
         */
        getAddress() {
            return provider.request({ method: 'stellar_getAddress' });
        },

        /**
         * Signs a transaction envelope and returns the signed XDR. Opens the approval
         * screen; the wallet signs nothing without a person agreeing to it.
         *
         * `networkPassphrase` is required because it is part of what gets signed. A
         * signature made against the wrong network is invalid everywhere, and a default
         * here would let a caller produce a mainnet signature believing it made a testnet
         * one.
         *
         * Returns the signed XDR and does not submit it. When the transaction reaches the
         * network is the caller's decision.
         */
        signTransaction(xdr, networkPassphrase) {
            return provider.request({
                method: 'stellar_signTransaction',
                params: [{ xdr, networkPassphrase }],
            });
        },

        /**
         * Signs a message the SEP-53 way and returns `{ signature, address }`, the
         * signature base64-encoded. Opens the approval screen like any other signature.
         *
         * This exists for the privacy layers: they derive their encryption keys from a
         * signature over a fixed message rather than from the secret key, so a wallet can
         * keep the key and still let a site build a confidential balance. A message is not
         * a transaction and cannot become one — SEP-53 prefixes and hashes it precisely so
         * that a signature made here can never be replayed as a payment.
         */
        signMessage(message) {
            return provider.request({
                method: 'stellar_signMessage',
                params: [{ message }],
            });
        },
    });

    window.arfheWallet = provider;

    // Learn the current chain, and whether this site already has a grant, without asking
    // the user anything. `eth_accounts` never prompts, so this is silent for a site the
    // user has not connected — it simply comes back empty.
    provider.request({ method: 'eth_chainId' }).catch(() => { /* wallet not ready */ });
    provider.request({ method: 'eth_accounts' })
        .then((accounts) => {
            if (Array.isArray(accounts) && accounts.length > 0) {
                provider._emit('connect', { chainId: provider.chainId });
            }
        })
        .catch(() => { /* not connected */ });
})();
