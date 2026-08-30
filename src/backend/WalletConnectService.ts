import { SignClient } from "@walletconnect/sign-client";
import { SessionTypes, ProposalTypes } from "@walletconnect/types";
import { getSdkError, buildApprovedNamespaces } from "@walletconnect/utils";
import Account from "./Account";
import type AccountManager from "./AccountManager";
import { PhishingDetector, PhishingCheckResult } from "./PhishingDetector";

// --- CONFIGURATION ---

/**
 * The WalletConnect (Reown) project this build connects with.
 *
 * Deliberately no fallback. It used to default to a public demo project id, and that is not
 * a working default — it is a broken one that takes a while to look broken. The relay
 * authorises the WebSocket against the project's own origin allowlist, and this extension's
 * origin (chrome-extension://<id>) is not on a demo project's list, so every pairing died
 * with `code: 3000 (Unauthorized: origin not allowed)` reported through pino at level 50 —
 * an object in the console with its message behind a disclosure triangle. What the user saw
 * was a spinner that never stopped.
 *
 * Same reasoning as Auth.tsx's Web3Auth client id, which dropped its own public-testing
 * fallback for the same class of reason: a default that quietly points at somebody else's
 * project makes a misconfigured build look configured.
 *
 * Set VITE_WALLETCONNECT_PROJECT_ID (see .env.example), and add this extension's origin to
 * that project's allowed origins in the Reown dashboard — the id alone is not enough.
 */
const PROJECT_ID = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID ?? "";

const METADATA = {
    name: "Arfhe Wallet",
    description: "Secure, Self-Custodial Arfhe Wallet",
    url: "https://arfhewallet.com",
    icons: ["https://avatars.githubusercontent.com/u/37784886"]
};

/**
 * Chains advertised to dApps during session negotiation.
 *
 * Exactly NetworkProvider.BUILT_IN_NETWORKS — the three testnets the wallet actually ships
 * with. This list used to carry thirteen chains, mainnets included, and every one of them
 * was handed to the site in approveSession's `accounts`. The session then connected
 * cleanly and every subsequent request died: RequestDialog only signs when the requested
 * chain IS the active one, and the wallet has no mainnet to be active on. A site told it
 * had Ethereum mainnet had no way to learn otherwise until the user had already approved
 * and the first signature silently failed.
 *
 * Advertising only what the wallet can sign on moves that failure to negotiation time,
 * where WalletConnect has a protocol for it and the site can say so up front.
 *
 * This is also a testnet build (see manifest.json's version_name) — a mainnet entry here
 * offers real-funds chains from a wallet whose own release notes tell users not to.
 */
export const SUPPORTED_CHAINS = [
    "eip155:11155111", // Ethereum Sepolia
    "eip155:421614",   // Arbitrum Sepolia
    "eip155:84532",    // Base Sepolia
];

/**
 * Methods advertised to dApps during session negotiation.
 *
 * Only what the approval flow actually implements belongs here. Advertising a method the
 * wallet then refuses pushes dApps into choosing it and failing at signing time, when the
 * user has already committed to the flow.
 *
 * Deliberately absent:
 *  - `eth_sign` — signs opaque bytes that may be a transaction hash the user never sees.
 *    The blind-signing attack; disabled by every major wallet.
 *  - `eth_signTransaction` — returns a signed transaction for the site to broadcast
 *    whenever it likes. The wallet has no implementation for it, and offering it would
 *    hand out a signature with no control over when it lands.
 */
const SUPPORTED_METHODS = [
    "eth_sendTransaction",
    "personal_sign",
    "eth_signTypedData",
    "eth_signTypedData_v4",
];

const SUPPORTED_EVENTS = ["chainChanged", "accountsChanged"];

export interface WalletConnectRequest {
    id: number;
    topic: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- WC SDK dynamic params
    params: Record<string, any>;
    dApp: {
        name: string;
        url: string;
        icon: string;
    };
}

export interface WalletConnectProposal {
    id: number;
    params: ProposalTypes.Struct;
    dApp: {
        name: string;
        url: string;
        icon: string;
        description: string;
    };
    requiredChains: string[];
    optionalChains: string[];
    requiredMethods: string[];
    unsupportedChains: string[];
    isValid: boolean;
    /** Phishing detection result — populated asynchronously */
    phishingResult?: PhishingCheckResult;
}

/**
 * How long a pairing attempt may run before it is called a failure.
 *
 * Generous rather than snappy: a slow phone hotspot legitimately takes several seconds to
 * open the relay socket and subscribe, and cutting off a connection that would have worked
 * is its own bug. Fifteen seconds is well past that and well short of "the user has walked
 * away".
 */
/**
 * This extension's own id, for an error that has to tell the user what to allowlist.
 *
 * `typeof` rather than optional chaining: `chrome` is an undeclared identifier outside an
 * extension (tests, any non-extension host), and `chrome?.runtime` still throws
 * ReferenceError on one — optional chaining guards null, not undeclared.
 */
function extensionId(): string {
    try {
        if (typeof chrome !== "undefined" && chrome?.runtime?.id) return chrome.runtime.id;
    } catch { /* not an extension context */ }
    return "<uzanti-id>";
}

const PAIR_TIMEOUT_MS = 15_000;

/** Rejects with `describe()`'s message if `promise` has not settled within `ms`. */
async function withTimeout<T>(promise: Promise<T>, ms: number, describe: () => string): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error(describe())), ms);
            }),
        ]);
    } finally {
        // Cleared on the winning path too — a pending timer keeps the popup's event loop
        // holding a reference to this rejection for as long as it runs.
        clearTimeout(timer!);
    }
}

export class WalletConnectService {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- WC SignClient instance type
    public client: any;
    public session: SessionTypes.Struct | undefined;

    private onRequestCallback: ((req: WalletConnectRequest) => void) | null = null;
    private onSessionDeleteCallback: (() => void) | null = null;
    private onProposalCallback: ((proposal: WalletConnectProposal) => void) | null = null;
    private onSessionUpdateCallback: (() => void) | null = null;

    private accountManager: AccountManager;
    /**
     * The in-flight init(), so concurrent callers await the SAME one.
     *
     * A boolean here was worse than nothing. init() returned early on it — `if (this.client
     * || this.isInitializing) return;` — so a caller arriving while SignClient.init() was
     * still running got a resolved promise and an undefined client, and pair() went straight
     * to its own "Client not initialized" throw. That is exactly the timing of the real
     * flow: WalletConnectManager fires init() on mount without awaiting it, and the user
     * scans or pastes a URI seconds later, while the SDK is still opening its store and
     * setting up crypto. Waiting a moment and trying again "fixed" it, which is what made it
     * look intermittent rather than broken.
     */
    private initPromise: Promise<void> | null = null;

    /** Last transport failure the relay reported, or null while it is healthy. */
    private lastRelayError: string | null = null;

    // Deduplicate proposal events
    private processedProposalIds = new Set<number>();

    constructor(accountManager: AccountManager) {
        this.accountManager = accountManager;
    }

    async init(): Promise<void> {
        if (this.client) return;
        // Join the in-flight init rather than starting a second one or returning early —
        // see initPromise's own docs for the bug this closes.
        if (this.initPromise) return this.initPromise;

        if (!PROJECT_ID) {
            // Refused up front rather than at pairing time: without an id there is nothing to
            // retry, and the message has to name the fix rather than describe a symptom.
            throw new Error(
                "WalletConnect yapılandırılmamış: VITE_WALLETCONNECT_PROJECT_ID tanımlı değil. " +
                "cloud.reown.com üzerinden bir Project ID alıp .env dosyasına ekleyin."
            );
        }

        this.initPromise = (async () => {
            // Use the declared production URL — window.location.origin returns
            // "chrome-extension://..." in extension context which WalletConnect rejects.
            this.client = await SignClient.init({
                projectId: PROJECT_ID,
                metadata: METADATA,
                logger: "error",
            });

            this.setupEventListeners();
            this.watchRelay();

            // Restore active session if any
            if (this.client.session.length) {
                this.session = this.client.session.values[this.client.session.length - 1];
            }
        })();

        try {
            await this.initPromise;
        } finally {
            // Cleared either way: a failed init must be retryable (a dropped network on the
            // first attempt should not disable WalletConnect for the rest of the session),
            // and once it succeeds `this.client` is the guard that matters.
            this.initPromise = null;
        }
    }

    setupEventListeners() {
        if (!this.client) return;

        // Session Proposal (Connection Request) — deduplicated
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- WC SDK event
        this.client.on("session_proposal", async (proposal: any) => {
            const { id, params } = proposal;

            // Dedup: skip already-processed proposals
            if (this.processedProposalIds.has(id)) {
                return;
            }
            this.processedProposalIds.add(id);

            const { proposer, requiredNamespaces, optionalNamespaces } = params;

            // Extract chain requirements
            const requiredChains = requiredNamespaces?.eip155?.chains || [];
            const optionalChains = optionalNamespaces?.eip155?.chains || [];
            const requiredMethods = requiredNamespaces?.eip155?.methods || [];

            // Validate chains
            const unsupportedChains = requiredChains.filter((c: string) => !SUPPORTED_CHAINS.includes(c));
            const isValid = unsupportedChains.length === 0;

            if (this.onProposalCallback) {
                // ── Phishing Detection ──
                // Run async check on dApp domain — don't block proposal display
                const dAppUrl = proposer.metadata.url || "";
                let phishingResult: PhishingCheckResult | undefined;

                try {
                    phishingResult = await PhishingDetector.checkDomain(dAppUrl);
                    if (phishingResult.isPhishing) {
                    } else if (phishingResult.riskLevel === "SUSPICIOUS") {
                    }
                } catch (e) {
                    // Continue without phishing result — don't block the proposal
                }

                this.onProposalCallback({
                    id,
                    params,
                    dApp: {
                        name: proposer.metadata.name,
                        url: proposer.metadata.url,
                        icon: proposer.metadata.icons?.[0] || "",
                        description: proposer.metadata.description || ""
                    },
                    requiredChains,
                    optionalChains,
                    requiredMethods,
                    unsupportedChains,
                    isValid,
                    phishingResult,
                });
            } else {
                await this.client.reject({
                    id,
                    reason: getSdkError("USER_REJECTED"),
                });
            }
        });

        // Session Request (Sign / Tx)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- WC SDK event
        this.client.on("session_request", (event: any) => {
            const { topic, params, id } = event;
            const session = this.client?.session.get(topic);


            if (this.onRequestCallback && session) {
                this.onRequestCallback({
                    id,
                    topic,
                    params: params,
                    dApp: {
                        name: session.peer.metadata.name,
                        url: session.peer.metadata.url,
                        icon: session.peer.metadata.icons?.[0] || ""
                    }
                });
            }
        });

        // Session Delete
        this.client.on("session_delete", () => {
            this.session = undefined;
            if (this.onSessionDeleteCallback) this.onSessionDeleteCallback();
            if (this.onSessionUpdateCallback) this.onSessionUpdateCallback();
        });
    }

    // --- API ---

    public setOnRequest(callback: (req: WalletConnectRequest) => void) {
        this.onRequestCallback = callback;
    }

    public setOnSessionDelete(callback: () => void) {
        this.onSessionDeleteCallback = callback;
    }

    public setOnProposal(callback: (proposal: WalletConnectProposal) => void) {
        this.onProposalCallback = callback;
    }

    public setOnSessionUpdate(callback: () => void) {
        this.onSessionUpdateCallback = callback;
    }

    // --- Smart Pairing ---
    async pair(uri: string) {
        if (!this.client) await this.init();
        if (!this.client) throw new Error("Client not initialized");

        // Extract topic from WC URI
        const topic = uri.split("@")[0].replace("wc:", "");

        // Check for existing pairing with same topic
        try {
            const allPairings = this.client.pairing.getAll();
            const existing = allPairings.find((p: { topic: string }) => p.topic === topic);
            if (existing) {
                if (!existing.active) {
                    // Inactive/expired pairing → clean up and allow fresh pair
                    try {
                        await this.client.pairing.delete(topic, getSdkError("USER_DISCONNECTED"));
                    } catch { /* ignore deletion errors */ }
                } else {
                    // Active pairing exists — don't crash, inform user
                    throw new Error("ALREADY_PAIRED");
                }
            }
        } catch (e) {
            if (e instanceof Error && e.message === "ALREADY_PAIRED") throw e;
            // Other errors during pairing check → continue with pair attempt
        }


        try {
            // Bounded, because SignClient.pair() has no timeout of its own.
            //
            // Pairing subscribes to the pairing topic on the relay, and when that WebSocket
            // never comes up the SDK simply keeps retrying — the promise neither resolves nor
            // rejects. The UI has no state for that: ScanDialog sets "connecting" before the
            // await and only leaves it in resolve or reject, so the user watches a spinner
            // forever with nothing written down anywhere about why.
            //
            // A rejection is strictly better than a hang even when the cause is transient:
            // the user gets told, and can retry.
            await withTimeout(this.client.pair({ uri }), PAIR_TIMEOUT_MS, () => this.relayDiagnosis());
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (msg.includes("Pairing already exists")) {
                throw new Error("ALREADY_PAIRED");
            }
            if (msg.includes("Expired")) {
                throw new Error("URI_EXPIRED");
            }
            throw e;
        }
    }

    /**
     * Subscribes to the relay's own transport events, purely to keep the last failure.
     *
     * The SDK reports these through pino at level 50, which lands in the console as an object
     * whose message sits behind a disclosure triangle — technically present, practically
     * invisible, and impossible to show a user. Keeping the text here lets relayDiagnosis()
     * put the actual cause in front of whoever hit it.
     */
    private watchRelay() {
        const relayer = this.client?.core?.relayer;
        if (!relayer?.on) return;
        try {
            relayer.on("relayer_error", (e: unknown) => {
                this.lastRelayError = e instanceof Error ? e.message : String(e);
            });
            relayer.on("relayer_disconnect", () => {
                this.lastRelayError = this.lastRelayError ?? "Relay bağlantısı koptu.";
            });
            relayer.on("relayer_connect", () => {
                // A successful connect clears it: a stale error from an earlier attempt would
                // otherwise be reported as the reason for a completely different failure.
                this.lastRelayError = null;
            });
        } catch {
            // Older SDK without these events — diagnosis falls back to the connected flag.
        }
    }

    /**
     * What the relay looked like when something timed out — attached to the error so a hang
     * reports a cause instead of just "it did not finish".
     */
    private relayDiagnosis(): string {
        try {
            const relayer = this.client?.core?.relayer;
            if (!relayer) return "WalletConnect istemcisi hazır değil.";

            // The relay's own words first, when there are any — anything else here is this
            // module guessing from a boolean.
            if (this.lastRelayError) {
                // "origin not allowed" is a configuration answer, not a network one, and the
                // generic wording sent people to check their wifi.
                if (/origin not allowed/i.test(this.lastRelayError)) {
                    return (
                        "WalletConnect Project ID bu uzantının kaynağına izin vermiyor. " +
                        `Reown panelinde projenin izinli kaynaklarına "chrome-extension://${extensionId()}" ekleyin.`
                    );
                }
                return `Relay bağlantısı kurulamadı: ${this.lastRelayError}`;
            }
            return relayer.connected
                ? "Relay bağlantısı açık görünüyor — dApp'in QR kodu süresi dolmuş olabilir, yenileyip tekrar deneyin."
                : "Relay sunucusuna (relay.walletconnect.org) bağlanılamadı — ağ bağlantınızı veya VPN/güvenlik duvarı ayarlarınızı kontrol edin.";
        } catch {
            return "Relay durumu okunamadı.";
        }
    }

    async disconnect(topic?: string) {
        if (!this.client) return;
        const sessionTopic = topic || this.session?.topic;
        if (!sessionTopic) return;

        try {
            await this.client.disconnect({
                topic: sessionTopic,
                reason: getSdkError("USER_DISCONNECTED"),
            });
        } catch (e) {
        }

        if (this.session?.topic === sessionTopic) {
            this.session = undefined;
        }
        if (this.onSessionUpdateCallback) this.onSessionUpdateCallback();
    }

    async disconnectAll(): Promise<number> {
        if (!this.client) return 0;
        const sessions = this.client.session.getAll();
        const count = sessions.length;

        // Disconnect all sessions in parallel, silently
        await Promise.all(
            sessions.map((session: SessionTypes.Struct) =>
                this.client.disconnect({
                    topic: session.topic,
                    reason: getSdkError("USER_DISCONNECTED"),
                }).catch(() => { /* ignore individual errors */ })
            )
        );

        this.session = undefined;
        if (this.onSessionUpdateCallback) this.onSessionUpdateCallback();
        return count;
    }

    // --- Session Approval with Lifecycle Management ---

    async approveSession(proposal: WalletConnectProposal) {
        if (!this.client) return;

        try {
            const { id, params } = proposal;

            const activeAccount = this.accountManager.GetActive();
            if (!activeAccount) throw new Error("No active account found");
            const address = activeAccount.GetAddress();

            const supportedNamespaces = {
                eip155: {
                    chains: SUPPORTED_CHAINS,
                    methods: SUPPORTED_METHODS,
                    events: SUPPORTED_EVENTS,
                    accounts: SUPPORTED_CHAINS.map(chain => `${chain}:${address}`)
                }
            };

            const approvedNamespaces = buildApprovedNamespaces({
                proposal: params,
                supportedNamespaces,
            });

            const session = await this.client.approve({
                id,
                namespaces: approvedNamespaces
            });

            // Wait for peer acknowledgment with timeout
            try {
                await Promise.race([
                    session.acknowledged(),
                    new Promise((_, reject) =>
                        setTimeout(() => reject(new Error("ACK_TIMEOUT")), 10000)
                    )
                ]);
            } catch (ackErr) {
            }

            // Verify session is registered in the store
            const latestSession = this.client.session.get(session.topic);
            if (!latestSession) {
                throw new Error("SESSION_SYNC_FAILED");
            }
            this.session = latestSession;


            // Clear processed proposal ID
            this.processedProposalIds.delete(proposal.id);

            if (this.onSessionUpdateCallback) this.onSessionUpdateCallback();
        } catch (e) {
            this.processedProposalIds.delete(proposal.id);
            throw e;
        }
    }

    async rejectSession(proposal: WalletConnectProposal) {
        if (!this.client) return;

        await this.client.reject({
            id: proposal.id,
            reason: getSdkError("USER_REJECTED"),
        });

        this.processedProposalIds.delete(proposal.id);
    }

    // --- Active Sessions ---

    getActiveSessions(): SessionTypes.Struct[] {
        if (!this.client) return [];
        try {
            return this.client.session.getAll() || [];
        } catch {
            return [];
        }
    }

    // --- Request Response ---

    async approveRequest(account: Account, req: WalletConnectRequest, result: unknown) {
        if (!this.client) return;


        await this.client.respond({
            topic: req.topic,
            response: {
                id: req.id,
                jsonrpc: "2.0",
                result: result,
            },
        });
    }

    async rejectRequest(req: WalletConnectRequest) {
        if (!this.client) return;


        await this.client.respond({
            topic: req.topic,
            response: {
                id: req.id,
                jsonrpc: "2.0",
                error: getSdkError("USER_REJECTED_METHODS"),
            },
        });
    }
}
