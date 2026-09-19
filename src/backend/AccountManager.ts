import Account from "./Account.js";
import { normalizeMnemonic } from "./normalizeMnemonic";
import StorageManager from "./StorageManager.js";
import { HDNodeWallet, Wallet, keccak256, toUtf8Bytes, JsonRpcProvider } from "ethers";

/** Shape of an account as stored in localStorage / encrypted storage */
interface StoredAccount {
  name: string;
  mnemonic?: { phrase: string; path?: string; locale?: string };
  private_key?: string;
  public_key?: string;
  address?: string;
  derivationPath?: string;
  owned_tokens?: Record<string, string[]>;
}

export default class AccountManager {
  active: number;
  accounts: Account[];
  private listeners: (() => void)[];
  linkedStorageManager: StorageManager;

  constructor(storageManager: StorageManager) {
    this.listeners = [];
    this.linkedStorageManager = storageManager;

    // Synchronously load from plaintext localStorage for backward compatibility.
    // This ensures the app works immediately even before password unlock.
    // After unlock, loadFromEncryptedStorage() will replace with decrypted data.
    const plainAccounts = storageManager.getLocal<StoredAccount[]>("accounts") || [];
    const plainActive = storageManager.getLocal<number>("active") ?? -1;

    if (plainAccounts.length > 0) {
      this.accounts = this.hydrateAccounts(plainAccounts);
      this.active = plainActive >= 0 ? plainActive : 0;
    } else {
      this.accounts = [];
      this.active = -1;
    }
  }

  /**
   * Initialize accounts from encrypted storage.
   * Must be called AFTER storageManager.initEncryption() succeeds.
   * This replaces any accounts loaded from plaintext in the constructor.
   */
  async loadFromEncryptedStorage(): Promise<void> {
    try {
      // Try encrypted storage first
      const storedAccounts = await this.linkedStorageManager.decryptAndRetrieve<StoredAccount[]>("accounts");
      const storedActive = await this.linkedStorageManager.decryptAndRetrieve<number>("active");

      if (storedAccounts && storedAccounts.length > 0) {
        this.accounts = this.hydrateAccounts(storedAccounts);
        this.active = (storedActive !== null && storedActive >= 0) ? storedActive : 0;
      } else {
        // Fallback: check for unencrypted accounts (pre-migration)
        const plainAccounts = this.linkedStorageManager.getLocal<StoredAccount[]>("accounts") || [];
        const plainActive = this.linkedStorageManager.getLocal<number>("active") ?? -1;

        if (plainAccounts.length > 0) {
          this.accounts = this.hydrateAccounts(plainAccounts);
          this.active = plainActive >= 0 ? plainActive : 0;
          // Auto-migrate to encrypted
          await this.linkedStorageManager.migrateToEncrypted();
        }
        // If still no accounts, keep whatever was loaded in constructor
      }

      this.notifyListeners();
    } catch (error) {
      // Keep whatever was loaded in constructor
    }
  }

  /**
   * Hydrate raw stored objects back into Account instances with wallet objects.
   */
  private hydrateAccounts(storedAccounts: StoredAccount[]): Account[] {
    return storedAccounts.map((stored) => {
      const account = new Account();
      account.name = stored.name;
      account.private_key = stored.private_key;
      account.public_key = stored.public_key;
      account.address = stored.address;
      account.derivationPath = stored.derivationPath || "m/44'/60'/0'/0/0";
      account.owned_tokens = new Map(
        stored.owned_tokens
          ? Object.entries(stored.owned_tokens).map(([key, value]) => [
            Number(key),
            Array.isArray(value) ? value.map(String) : [],
          ])
          : []
      );

      // Re-hydrate the wallet instance
      if (stored.mnemonic && stored.mnemonic.phrase) {
        try {
          account.ethers_wallet = HDNodeWallet.fromPhrase(stored.mnemonic.phrase, "", account.derivationPath);
          account.mnemonic = account.ethers_wallet.mnemonic ?? undefined;
        } catch (e) {
          // The stored phrase will not rebuild a wallet. Swallowing this used to leave an
          // account in the list that looked ordinary — it kept its name and address — but
          // held no signing key and no mnemonic, so every later use of it failed somewhere
          // far from the cause. Most visibly, deriving a new account read the bad phrase
          // straight back out and reported the library's own "invalid mnemonic checksum"
          // to the user, on a screen that had nothing to do with mnemonics.
          //
          // The account is still returned, because dropping it would hide funds the user
          // can see on-chain, but it is marked so callers can refuse to treat it as a
          // parent and say something true about why.
          account.mnemonic = undefined;
          account.rehydrationFailed = true;
        }
      } else if (stored.private_key) {
        try {
          account.ethers_wallet = new Wallet(stored.private_key);
        } catch (e) {
        }
      }

      return account;
    });
  }

  // Subscribe to changes
  subscribe(fn: () => void) {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter(l => l !== fn);
    };
  }

  private notifyListeners() {
    this.listeners.forEach(fn => fn());
  }

  /**
   * Persist active index to storage.
   * Uses encrypted storage if unlocked, otherwise falls back to plaintext.
   */
  private async updateActive(): Promise<void> {
    if (this.linkedStorageManager.isUnlocked()) {
      await this.linkedStorageManager.encryptAndStore("active", this.active);
    } else {
      // Fallback to plaintext until encryption is set up
      this.linkedStorageManager.setLocal("active", this.active);
    }
    void this.publishActiveAddress();
  }

  /**
   * Publish which address the wallet would sign with, for the service worker to read.
   *
   * The worker gates `eth_requestAccounts` on the origin's stored grant, and without this
   * it cannot tell whether that grant covers the account in front of the user: a site
   * connected to account A got A's address handed back while the wallet was on account B,
   * so the site believed it was connected and every signature after that was refused, with
   * no way to reconnect from the site.
   *
   * An address is public — it is what the site is given on connect — so this is a hint, not
   * a secret. It is deliberately outside the encrypted store: the worker must be able to
   * read it while the wallet is locked, and there is nothing here worth protecting.
   */
  private async publishActiveAddress(): Promise<void> {
    try {
      const address = this.GetActive()?.GetAddress()?.toLowerCase() ?? null;
      await chrome.storage.local.set({ arfhe_active_address: address });
    } catch {
      // No extension storage (tests, or a page outside the extension). The worker falls
      // back to its previous behaviour when the hint is missing.
    }
  }

  /**
   * Persist all accounts to storage.
   * Uses encrypted storage if unlocked, otherwise falls back to plaintext.
   */
  private async updateStorage(): Promise<void> {
    const serializableAccounts = this.accounts.map(account => ({
      name: account.name,
      mnemonic: account.mnemonic,
      private_key: account.private_key,
      public_key: account.public_key,
      address: account.address,
      derivationPath: account.derivationPath,
      owned_tokens: Object.fromEntries(account.owned_tokens)
    }));

    if (this.linkedStorageManager.isUnlocked()) {
      await this.linkedStorageManager.encryptAndStore("active", this.active);
      await this.linkedStorageManager.encryptAndStore("accounts", serializableAccounts);
      return;
    }

    // Locked, which during onboarding means "no password chosen yet". This used to write
    // the mnemonic and private key to plaintext localStorage as a stopgap, cleared later
    // when the password was set. Anyone who abandoned onboarding before that — closing the
    // tab on the recovery-phrase screen — left their seed sitting unencrypted on disk
    // indefinitely.
    //
    // Nothing sensitive is written before there is a key to protect it. The account stays
    // in memory and is committed by {@link persistToEncryptedStorage} once the password
    // exists; abandoning now leaves nothing behind, which is the correct outcome for a
    // wallet the user never finished creating.
  }

  /**
   * Write the in-memory accounts to encrypted storage.
   *
   * Called once the password has been set, because until then there is deliberately no
   * persisted copy. Without this the freshly created account would live only in the
   * onboarding tab and vanish when it closed.
   *
   * @returns Whether anything was written.
   */
  async persistToEncryptedStorage(): Promise<boolean> {
    if (!this.linkedStorageManager.isUnlocked()) return false;
    if (this.accounts.length === 0) return false;

    await this.updateStorage();
    return true;
  }

  /**
   * Adopt a phrase the caller already generated and showed to the user.
   *
   * The creation screen needs this because generating the words and adding a wallet to the
   * running app are separate steps: an account that exists from the moment the phrase is
   * displayed is a usable wallet with no password behind it, reachable by anyone who
   * navigates away from the screen instead of finishing.
   *
   * @returns The new account's index, or -1 if the phrase does not build a wallet.
   */
  CreateAccountFromPhrase(phrase: string, name?: string): number {
    let account: Account;
    try {
      account = Account.FromMnemonic(normalizeMnemonic(phrase), name?.trim() || this.CreateRandomAccountName(), "m/44'/60'/0'/0/0");
    } catch {
      return -1;
    }

    const index = this.AddAccount(account);
    if (index < 0) return -1;

    if (this.active == -1 || this.active != index) {
      this.active = index;
      this.notifyListeners();
    }

    this.updateStorage();
    return index;
  }

  /** @param wordCount Length of the generated recovery phrase — 12 (default) or 24. */
  CreateAccount(name?: string, wordCount: number = 12): number {
    let account = Account.Random(name?.trim() || this.CreateRandomAccountName(), wordCount);
    let index = this.AddAccount(account);

    if (this.active == -1 || this.active != index) {
      this.active = index;
      this.notifyListeners();
    }

    // Fire-and-forget async persistence
    this.updateStorage();
    return index;
  }

  AddAccount(account: Account): number {
    if (!account.mnemonic && !account.ethers_wallet) {
      return -1;
    }
    const index = this.accounts.push(account) - 1;
    this.notifyListeners();
    this.updateStorage();
    return index;
  }

  ImportAccount(mnemonic: string): number {
    // Normalized here as well as at the screen, so a caller that did not clean its input
    // fails for a real reason rather than for a stray line break.
    let account = Account.FromMnemonic(normalizeMnemonic(mnemonic), this.CreateRandomAccountName(), "m/44'/60'/0'/0/0");
    let index = this.AddAccount(account);

    if (this.active == -1 || this.active != index) {
      this.active = index;
      this.notifyListeners();
    }

    this.updateStorage();
    return index;
  }

  ImportPrivateKey(privateKey: string, name: string = "Social Account"): number {
    try {
      let account = Account.FromPrivateKey(privateKey, name);
      let index = this.AddAccount(account);

      if (this.active == -1 || this.active != index) {
        this.active = index;
        this.notifyListeners();
      }

      this.updateStorage();
      return index;
    } catch (e) {
      return -1;
    }
  }

  CanDeriveNewAccount(): boolean {
    return this.accounts.length > 0;
  }

  DeriveNewAccount(parentIndex?: number): number {
    const pIndex = parentIndex !== undefined ? parentIndex : (this.active >= 0 ? this.active : 0);
    let parentAccount = this.accounts[pIndex];

    if (!parentAccount || (!parentAccount.mnemonic && !parentAccount.ethers_wallet)) {
      throw new Error("No master account found to derive from.");
    }

    if (!parentAccount.mnemonic && parentAccount.derivationPath?.startsWith("social/")) {
      const rootSocial = this.accounts.find(a => !a.mnemonic && !a.derivationPath);
      if (rootSocial) {
        parentAccount = rootSocial;
      }
    }

    let maxIndex = -1;
    for (const acc of this.accounts) {
      if (acc.derivationPath) {
        if (acc.derivationPath.startsWith("m/44'/60'/0'/0/")) {
          const parts = acc.derivationPath.split("/");
          const idx = parseInt(parts[parts.length - 1], 10);
          if (!isNaN(idx) && idx > maxIndex) {
            maxIndex = idx;
          }
        } else if (acc.derivationPath.startsWith("social/")) {
          const parts = acc.derivationPath.split("/");
          const idx = parseInt(parts[parts.length - 1], 10);
          if (!isNaN(idx) && idx > maxIndex) {
            maxIndex = idx;
          }
        }
      }
    }

    const nextIndex = maxIndex + 1;
    const name = `Account ${nextIndex + 1}`;

    let account: Account;

    if (parentAccount.mnemonic && parentAccount.mnemonic.phrase) {
      const path = `m/44'/60'/0'/0/${nextIndex}`;
      try {
        account = Account.FromMnemonic(parentAccount.mnemonic.phrase, name, path);
      } catch {
        // Never surface the library's wording here. "invalid mnemonic checksum" on a
        // screen where the user only pressed "Create New Account" reads as though their
        // recovery phrase — the one they wrote down and trust — has gone bad, which is a
        // frightening thing to be told and, in this case, not what happened.
        throw new Error(
          "This account's stored key could not be read, so a new account cannot be derived from it. " +
          "Existing accounts are unaffected. Re-import your recovery phrase to restore the ability to add accounts.",
        );
      }
    } else if (parentAccount.ethers_wallet) {
      const path = `social/${nextIndex}`;
      const entropy = toUtf8Bytes(`${parentAccount.ethers_wallet.privateKey}_${nextIndex}`);
      const derivedPrivateKey = keccak256(entropy);
      account = Account.FromPrivateKey(derivedPrivateKey, name);
      account.derivationPath = path;
    } else {
      throw new Error("Unable to derive new account from the master account.");
    }

    let index = this.AddAccount(account);

    this.active = index;
    this.notifyListeners();
    this.updateStorage();
    return index;
  }

  async AutoDiscoverAccounts(rpcUrls: string[], gapLimit = 3, rootIndex?: number): Promise<void> {
    if (!this.CanDeriveNewAccount()) return;

    const originalActive = this.active >= 0 ? this.active : 0;
    const parentIndex = rootIndex !== undefined ? rootIndex : originalActive;

    try {
      const providers = rpcUrls.map(url => new JsonRpcProvider(url));
      let gap = 0;
      let unusedIndices: number[] = [];

      while (gap < gapLimit) {
        const derivedIndex = this.DeriveNewAccount(parentIndex);
        const account = this.accounts[derivedIndex];

        if (!account || !account.address) {
          unusedIndices.push(derivedIndex);
          break;
        }


        let isUsed = false;
        await Promise.all(providers.map(async (provider, idx) => {
          if (isUsed) return;
          try {
            const [txCount, balance] = await Promise.all([
              provider.getTransactionCount(account.address!),
              provider.getBalance(account.address!)
            ]);
            if (txCount > 0 || balance > 0n) {
              isUsed = true;
            }
          } catch (e) {
          }
        }));

        if (isUsed) {
          gap = 0;
          unusedIndices = [];
        } else {
          gap++;
          unusedIndices.push(derivedIndex);
        }
      }

      this.SetActive(originalActive < this.accounts.length ? originalActive : 0);
    } catch (e) {
      this.SetActive(originalActive < this.accounts.length ? originalActive : 0);
    }
  }

  /**
   * Change an account's display name.
   *
   * A method rather than letting callers assign `account.name` directly: the name lives in
   * two places — the object in memory and the encrypted copy on disk — and setting the
   * field without persisting leaves them disagreeing until the next unrelated write.
   *
   * @returns False if the index is out of range or the name is blank.
   */
  RenameAccount(account_index: number, name: string): boolean {
    const trimmed = name.trim();
    if (!trimmed) return false;
    const account = this.accounts[account_index];
    if (!account) return false;

    account.name = trimmed;
    this.notifyListeners();
    this.updateStorage();
    return true;
  }

  RemoveAccount(account_index: number) {
    if (account_index < 0 || account_index >= this.accounts.length) {
      return;
    }
    const removed = this.accounts[account_index].GetAddress();
    this.accounts.splice(account_index, 1);

    if (this.active === account_index) this.active = -1;
    this.notifyListeners();
    this.updateStorage();

    // Site grants naming this account have to go with it. Left behind, they would sit in
    // the connected-sites list pointing at an address the wallet no longer holds — and
    // come back as live permissions the moment that account is re-imported.
    if (removed) void this.onAccountRemoved?.(removed);
  }

  /**
   * Called after an account is removed, so dependent records can be cleaned up.
   *
   * A callback rather than a direct import: AccountManager is constructed before the
   * services that depend on it, and reaching into them from here would make that ordering
   * load-bearing.
   */
  onAccountRemoved?: (address: string) => void | Promise<void>;

  GetActiveIndex(): number {
    return this.active;
  }

  GetActive(): Account | undefined {
    if (this.active < 0 || this.active >= this.accounts.length) return undefined;
    return this.accounts[this.active];
  }

  SetActive(index: number): boolean {
    if (index < 0 || index >= this.accounts.length) {
      return false;
    }
    const changed = this.active !== index;
    this.active = index;

    // FHE permits, encrypted inputs and the SDK connection are all bound to one account.
    // Correctness is already guarded (isReadyForAccount forces a reconnect), but leaving
    // the previous account's client and permit alive in memory after a switch is exactly
    // the state the wallet's lock policy exists to avoid — so tear it down here too.
    if (changed) {
      void import("./FheCofheService.js")
        .then(({ default: FheCofheService }) => FheCofheService.getInstance().reset())
        .catch(() => { /* FHE is optional; a switch must never fail because of it */ });
    }

    this.notifyListeners();
    this.updateActive();
    return true;
  }

  GetAll(): Account[] {
    return this.accounts;
  }

  private CreateRandomAccountName(): string {
    return "New User #" + (this.accounts.length + 1);
  }

  /**
   * Wipe all sensitive data (private keys, mnemonics, wallet objects) from memory.
   * Called during lock to ensure no decrypted key material remains in RAM.
   * After this, accounts still hold name/address for UI but cannot sign transactions.
   * Re-unlock (loadFromEncryptedStorage) will re-hydrate wallet objects.
   */
  clearSensitiveData(): void {
    for (const account of this.accounts) {
      account.wipeKeys();
    }
  }

  /**
   * Throw away accounts that were created during an onboarding the user did not finish.
   *
   * Nothing is written to disk before a password exists, so an account left over from an
   * abandoned run has no persisted copy — but it is still in memory, still able to sign,
   * and would be silently adopted by the next wallet the user creates. Wiping the keys
   * first so the seed does not outlive the decision to discard it.
   *
   * Refuses to run once a password exists: at that point the accounts are the real wallet,
   * and dropping them would be data loss rather than cleanup.
   *
   * @returns How many accounts were discarded.
   */
  discardUnpersistedAccounts(): number {
    if (this.linkedStorageManager.hasPassword()) return 0;
    if (this.accounts.length === 0) return 0;

    const discarded = this.accounts.length;
    this.clearSensitiveData();
    this.accounts = [];
    this.active = -1;
    this.notifyListeners();
    return discarded;
  }
}
