/**
 * FheCofheService — TRUE FHE via @cofhe/sdk (successor to cofhejs)
 *
 * The wallet holds ethers v6 wallets, while @cofhe/sdk speaks viem. `Ethers6Adapter`
 * bridges the two, so account handling stays exactly where it already lives.
 *
 * Lifecycle:
 *   1. createCofheConfig({ supportedChains }) — declares the CoFHE-backed chains
 *   2. createCofheClient(config)              — no network work happens yet
 *   3. client.connect(publicClient, wallet)   — binds account + chain
 *   4. first encryptInputs() lazily boots TFHE WASM and fetches FHE keys
 *
 * Decryption is split by intent, and the two are not interchangeable:
 *   - decryptForView → plaintext for the UI only. Always needs a permit.
 *   - decryptForTx   → plaintext + Threshold Network signature that a contract can
 *                      verify. Used to settle unshield claims.
 *
 * @see https://cofhe-docs.fhenix.zone/client-sdk/introduction/overview
 */

import { JsonRpcProvider, Wallet } from "ethers";
import { createCofheConfig, createCofheClient, terminateWorker } from "@cofhe/sdk/web";
import { Ethers6Adapter } from "@cofhe/sdk/adapters";
import { chains } from "@cofhe/sdk/chains";
import {
  Encryptable,
  FheTypes,
  CofheErrorCode,
  isCofheError,
  assertCorrectEncryptedItemInput,
} from "@cofhe/sdk";
import { ValidationUtils } from "@cofhe/sdk/permits";
import type { CofheClient, EncryptedUint64Input } from "@cofhe/sdk";

/** Result of decrypting a handle for on-chain publication (unshield claims). */
export interface DecryptForTxResult {
  ctHash: bigint | string;
  decryptedValue: bigint;
  signature: `0x${string}`;
}

/**
 * The only chains CoFHE runs on. Deploying or encrypting anywhere else yields
 * contracts with no coprocessor behind them, so callers must gate on this.
 *
 * @see https://cofhe-docs.fhenix.zone/get-started/introduction/compatibility
 */
export const COFHE_CHAIN_IDS = new Set<number>([
  11155111, // Sepolia
  421614,   // Arbitrum Sepolia
  84532,    // Base Sepolia
]);

/**
 * How long to keep retrying a decrypt that 404s, in milliseconds.
 *
 * A handle exists on-chain the moment its transaction confirms, but the coprocessor
 * ingests it asynchronously — so a balance read straight after shielding, or a claim read
 * straight after unshielding, can legitimately 404 for a few seconds. The SDK retries for
 * 10s by default; claims get longer because giving up there leaves burned balance sitting
 * unsettled until the next drain, while a view just renders a stale zero.
 */
const VIEW_404_RETRY_MS = 10_000;
const TX_404_RETRY_MS = 20_000;

/** Thrown when a decrypt is attempted against a handle CoFHE has never seen. */
export class CiphertextNotFoundError extends Error {
  constructor() {
    super("Ciphertext not found: no shielded balance");
    this.name = "CiphertextNotFoundError";
  }
}

class FheCofheService {
  private static instance: FheCofheService;

  private client: CofheClient | null = null;
  private _isReady = false;
  private initPromise: Promise<void> | null = null;
  /** Identity of the connection currently being established, for de-duping concurrent init. */
  private pendingKey: string | null = null;

  public initError: string | null = null;

  private currentAccount: string | null = null;
  private currentChainId: number | null = null;
  private currentNetworkId?: number;
  /** `account:chainId:networkId` of the established connection. */
  private currentKey: string | null = null;

  private constructor() {}

  static getInstance(): FheCofheService {
    if (!FheCofheService.instance) {
      FheCofheService.instance = new FheCofheService();
    }
    return FheCofheService.instance;
  }

  isReady(): boolean {
    return this._isReady;
  }

  /**
   * Whether a usable permit exists right now for the connected account.
   *
   * Derived from the stored permit rather than cached: permits expire (7 days by default),
   * so a boolean set once at creation time silently goes stale and every later decrypt
   * fails with a permit error the wallet could have prevented.
   */
  hasPermit(): boolean {
    const permit = this.getActivePermit();
    return !!permit && ValidationUtils.isValid(permit).valid;
  }

  /**
   * Whether the SDK is connected as `accountAddress` on `networkId`.
   *
   * Permits and encrypted inputs are both scoped to `chainId + account`; reusing a
   * connection across either boundary produces inputs the contract will reject, so a
   * mismatch must force a reconnect rather than being tolerated.
   */
  isReadyForAccount(accountAddress: string, networkId?: number): boolean {
    if (!this._isReady || !this.currentAccount) return false;
    if (this.currentAccount.toLowerCase() !== accountAddress.toLowerCase()) return false;
    if (networkId !== undefined && this.currentNetworkId !== networkId) return false;
    return true;
  }

  /**
   * Connect the SDK to a provider/signer pair.
   *
   * Re-entrant: concurrent callers share one in-flight connect, and a call for a
   * different account or chain tears down the previous connection first.
   */
  async init(provider: JsonRpcProvider, signer: Wallet, networkId?: number): Promise<void> {
    const signerAddress = await signer.getAddress();
    const chainId = Number((await provider.getNetwork()).chainId);

    if (!COFHE_CHAIN_IDS.has(chainId)) {
      throw new Error(
        `CoFHE is not available on chain ${chainId}. Supported: Sepolia, Arbitrum Sepolia, Base Sepolia.`
      );
    }

    const key = `${signerAddress.toLowerCase()}:${chainId}:${networkId ?? ""}`;

    if (this._isReady && this.currentKey === key) return;

    // Concurrent init for the *same* target can share one connect. For a different target
    // it must not: returning the in-flight promise would leave the caller believing it is
    // connected as its own account while the client is bound to another, and every input
    // it then encrypts would be rejected on-chain as belonging to the wrong signer.
    if (this.initPromise) {
      if (this.pendingKey === key) return this.initPromise;
      await this.initPromise.catch(() => { /* superseded; its failure is not ours */ });
    }

    // A different account/chain invalidates the connection and cached state.
    if (this._isReady) this.reset();

    this.pendingKey = key;
    this.initPromise = (async () => {
      try {
        this.initError = null;

        const config = createCofheConfig({
          supportedChains: [chains.sepolia, chains.arbSepolia, chains.baseSepolia],
        });
        const client = createCofheClient(config);

        // ethers v6 -> viem clients. The signer must be provider-connected already.
        const { publicClient, walletClient } = await Ethers6Adapter(provider, signer);
        await client.connect(publicClient, walletClient);

        this.client = client;
        this._isReady = true;
        this.currentAccount = signerAddress;
        this.currentChainId = chainId;
        this.currentNetworkId = networkId;
        this.currentKey = key;
      } catch (error) {
        this.initError = error instanceof Error ? error.message : String(error);
        this._isReady = false;
        this.client = null;
        throw error;
      } finally {
        this.initPromise = null;
        this.pendingKey = null;
      }
    })();

    return this.initPromise;
  }

  private requireClient(): CofheClient {
    if (!this.client || !this._isReady) {
      throw new Error("CoFHE client not initialized — call init() first");
    }
    return this.client;
  }

  // ============ PERMITS ============

  /**
   * Ensure an active self-permit exists for the connected account.
   *
   * Prompts the signer for an EIP-712 signature the first time. Permits default to a
   * 7-day expiry and are persisted by the SDK, so this is cheap on repeat calls.
   *
   * @see https://cofhe-docs.fhenix.zone/client-sdk/guides/permits
   */
  async ensurePermit(): Promise<void> {
    const client = this.requireClient();

    const active = client.permits.getActivePermit();
    if (active) {
      const check = ValidationUtils.isValid(active);
      if (check.valid) return;

      // A malformed stored permit is never recoverable by re-signing; drop it so
      // getOrCreateSelfPermit starts clean instead of failing on the same payload.
      if (check.error === "invalid-schema") client.permits.removeActivePermit();
    }

    await client.permits.getOrCreateSelfPermit();
  }

  /** Expose the active permit so the UI can surface its expiry. */
  getActivePermit() {
    if (!this.client || !this._isReady) return undefined;
    return this.client.permits.getActivePermit();
  }

  /**
   * Check a decryption result against the on-chain verifier before spending gas on it.
   *
   * `claimUnshielded` reverts on a bad proof, so pre-flighting turns a failed transaction
   * into a plain error. Returns false rather than throwing when the check itself cannot
   * run, so a verifier outage never blocks an otherwise valid claim.
   */
  async verifyDecryptResult(ctHash: bigint, cleartext: bigint, signature: `0x${string}`): Promise<boolean> {
    const client = this.requireClient();
    return client.verifyDecryptResult(ctHash, cleartext, signature);
  }

  /** Unix seconds at which the active permit expires, if any. */
  getPermitExpiry(): number | undefined {
    const permit = this.getActivePermit();
    return permit ? Number(permit.expiration) : undefined;
  }

  // ============ ENCRYPTION ============

  /**
   * Encrypt a uint64 for a contract parameter of type `InEuint64`.
   *
   * The returned object carries the verifier signature that authorizes this ciphertext
   * for *this* account on *this* chain — it cannot be reused elsewhere.
   *
   * @param value Amount in confidential units (6 decimals), not underlying token units.
   * @see https://cofhe-docs.fhenix.zone/client-sdk/guides/encrypting-inputs
   */
  async encryptUint64(
    value: bigint,
    onStep?: (step: string) => void
  ): Promise<EncryptedUint64Input> {
    const client = this.requireClient();

    let builder = client.encryptInputs([Encryptable.uint64(value)]);
    if (onStep) {
      builder = builder.onStep((step, ctx) => {
        if (ctx?.isStart) onStep(String(step));
      });
    }

    const [encrypted] = await builder.execute();

    // Catches a malformed/mistyped input here rather than as an opaque on-chain revert.
    assertCorrectEncryptedItemInput(encrypted);

    return encrypted;
  }

  // ============ DECRYPTION ============

  /**
   * Decrypt a handle for UI display. Requires a permit; never publishable on-chain.
   *
   * @see https://cofhe-docs.fhenix.zone/client-sdk/guides/decrypt-to-view
   */
  async decryptForView(ctHash: bigint): Promise<bigint> {
    const client = this.requireClient();
    await this.ensurePermit();

    try {
      return await client
        .decryptForView(ctHash, FheTypes.Uint64)
        .set404RetryTimeout(VIEW_404_RETRY_MS)
        .execute();
    } catch (err) {
      // The Threshold Network can reject a permit the local schema check accepted (for
      // example after an ACL change). Drop it so the next call re-signs instead of
      // replaying a permit the network has already refused.
      if (isCofheError(err) && err.code === CofheErrorCode.PermitNotFound) {
        try { client.permits.removeActivePermit(); } catch { /* nothing to remove */ }
      }
      throw this.normalizeDecryptError(err);
    }
  }

  /**
   * Decrypt a handle together with a Threshold Network signature a contract can verify.
   *
   * Used to settle unshield claims: `unshield` calls `FHE.allowPublic` on the burned
   * handle, so no permit is needed — the ACL already permits anyone to decrypt it.
   *
   * @see https://cofhe-docs.fhenix.zone/client-sdk/guides/decrypt-to-tx
   */
  async decryptForTx(ctHash: bigint): Promise<DecryptForTxResult> {
    const client = this.requireClient();

    try {
      const result = await client
        .decryptForTx(ctHash)
        .set404RetryTimeout(TX_404_RETRY_MS)
        .withoutPermit()
        .execute();
      return result as DecryptForTxResult;
    } catch (err) {
      throw this.normalizeDecryptError(err);
    }
  }

  /**
   * Distinguish "this ciphertext will never exist" from a genuine failure.
   *
   * A missing ciphertext is the normal state for an account that has never shielded, and
   * callers render it as a zero balance rather than an error. The SDK reports it as a
   * decrypt failure, so the specific cause is only available in the message — the error
   * code alone cannot separate it from a real outage.
   */
  private normalizeDecryptError(err: unknown): Error {
    const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();

    if (msg.includes("ciphertext not found") || msg.includes("failed to fetch full ciphertext")) {
      return new CiphertextNotFoundError();
    }

    if (isCofheError(err)) {
      return new Error(`${err.code}: ${err.message}`);
    }
    return err instanceof Error ? err : new Error(String(err));
  }

  // ============ LIFECYCLE ============

  /**
   * Drop all connection state. Called on wallet lock so no signer, viem client or
   * permit reference survives in the JS heap.
   *
   * Note: `disconnect()` deliberately leaves persisted permits in storage — they are
   * scoped to an account the user still owns and re-signing on every unlock would be
   * hostile. Clearing them is `StorageManager`'s job on wallet removal.
   */
  reset(): void {
    try {
      this.client?.disconnect();
    } catch {
      // Disconnect is best-effort; a failure here must not block the lock path.
    }

    try {
      // The ZK-proving worker holds TFHE state and fetched FHE keys. Leaving it alive
      // across a lock would contradict the wallet's "wipe sensitive memory on lock"
      // guarantee. It is recreated lazily on the next encryption.
      terminateWorker();
    } catch {
      // No worker running (or none supported) — nothing to tear down.
    }

    this.client = null;
    this._isReady = false;
    this.initPromise = null;
    this.pendingKey = null;
    this.initError = null;
    this.currentAccount = null;
    this.currentChainId = null;
    this.currentNetworkId = undefined;
    this.currentKey = null;
  }
}

export default FheCofheService;
