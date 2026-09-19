import { createContext } from "react";
import NetworkProvider from "./backend/NetworkProvider.js";
import AccountManager from "./backend/AccountManager.js";
import TokenCache from "./backend/TokenCache.js";
import NFTCache from "./backend/NFTCache.js";
import StorageManager from "./backend/StorageManager.js";
import DataCacheService from "./backend/DataCacheService.js";
import PortfolioHistoryService from "./backend/PortfolioHistoryService.js";
import { ContactManager } from "./backend/ContactManager.js";

import { WalletConnectService } from "./backend/WalletConnectService";
import SpamFilter from "./backend/SpamFilter.js";
import PendingClaimQueue from "./backend/PendingClaimQueue.js";
import SitePermissionService from "./backend/SitePermissionService.js";
import { configureAgentToolRunner } from "./backend/AgentToolRunner.js";
import { NetworkId } from "./backend/NetworkTypes.js";
import { CONTRACTS_BASE_SEPOLIA } from "./components/panels/shared.js";

export const WalletContext = createContext<AppContext | undefined>(undefined);

export class AppContext {

  storageManager: StorageManager;
  // accountsManager
  accountManager: AccountManager;
  // privateKey initialized from storageProvider.
  networkProvider: NetworkProvider;
  // token cache
  tokenCache: TokenCache;
  nftCache: NFTCache;
  // data cache (balances, prices with TTL)
  dataCacheService: DataCacheService;
  portfolioHistory: PortfolioHistoryService;
  // contact manager
  contactManager: ContactManager;
  // wallet connect
  walletConnectService: WalletConnectService;
  // spam filter
  spamFilter: SpamFilter;
  /** Unsettled unshields, so a closed popup never strands burned balance. */
  pendingClaimQueue: PendingClaimQueue;
  /** Which websites may see which accounts, for the injected provider. */
  sitePermissions: SitePermissionService;

  constructor() {
    this.storageManager = new StorageManager();
    this.accountManager = new AccountManager(this.storageManager);
    this.networkProvider = new NetworkProvider();
    this.tokenCache = new TokenCache(this.storageManager);
    this.nftCache = new NFTCache(this.storageManager);
    this.dataCacheService = new DataCacheService();
    this.dataCacheService.attachStorage(this.storageManager);
    this.portfolioHistory = new PortfolioHistoryService();
    this.portfolioHistory.attachStorage(this.storageManager);
    this.contactManager = new ContactManager(this.storageManager);
    this.walletConnectService = new WalletConnectService(this.accountManager);
    this.spamFilter = new SpamFilter(this.storageManager);
    this.pendingClaimQueue = new PendingClaimQueue(this.storageManager);
    this.sitePermissions = new SitePermissionService();

    // Removing an account must also remove every site's permission to use it.
    this.accountManager.onAccountRemoved = (address) =>
      this.sitePermissions.revokeAccountEverywhere(address);

    // ── Register lock cleanup callbacks ──
    // When wallet locks, wipe all sensitive data from memory
    this.storageManager.onLock(() => {
      this.accountManager.clearSensitiveData();
    });
    this.storageManager.onLock(() => {
      /**
       * Loaded here rather than at the top of the file.
       *
       * Network, AccountManager and Home all import FheCofheService dynamically, on the
       * reasoning that a 390 kB FHE bundle should not be part of opening the wallet. A
       * single static import at module scope silently undid all three: this file is on the
       * startup path, so the chunk was fetched and parsed every launch — for a callback
       * that only runs when the wallet locks.
       *
       * The reset stays correct. If FHE was used, the module is already in cache and this
       * resolves on the next microtask, before anything can paint. If it was never used
       * there is no client and no worker, so there is nothing to wipe either way.
       */
      void import("./backend/FheCofheService.js").then(({ default: FheCofheService }) => {
        FheCofheService.getInstance().reset();
      });
    });
    this.storageManager.onLock(() => {
      // Memory only. The encrypted snapshot on disk stays, so unlocking renders balances
      // straight away instead of starting from an empty list.
      this.dataCacheService.clearMemory();
      this.portfolioHistory.clearMemory();
    });
    this.storageManager.onLock(() => {
      /**
       * Stellar keys are derived from the mnemonic and held in memory only, so locking has
       * to drop them explicitly — otherwise the ed25519 key outlives the lock, which is the
       * one property locking exists to provide.
       *
       * Imported dynamically for the same reason the FHE reset above is: this file is on
       * the startup path, and the Stellar SDK has no business being parsed on every launch
       * for a callback that runs when the wallet closes.
       */
      void import("./backend/StellarService.js").then(({ forgetDerivedKeys }) => {
        forgetDerivedKeys();
      });
    });

  }

  /**
   * Wires the in-wallet AI Agent (AgentChatPanel -> AgentOrchestrator -> AgentToolRunner) to
   * resolve a live Network / Account from the context it's given before it can execute any
   * tool call.
   *
   * MUST be called from WalletProvider's useLayoutEffect on the actual COMMITTED appContext,
   * never from this class's own constructor. configureAgentToolRunner sets a MODULE-LEVEL
   * singleton (see its docs) — a constructor call fires on every candidate render, including
   * one React StrictMode double-invokes and then throws away, and the LAST call wins that
   * singleton regardless of which instance actually ends up mounted. That silently wired the
   * agent to a phantom AppContext whose AccountManager never has any accounts loaded into it
   * — every propose_shield/unshield/get_shielded_* call failed with "Hesap bulunamadı veya
   * cüzdan kilitli" even though the wallet was fully unlocked, because requireAccount() was
   * asking an AccountManager that was never the one anything actually logged into. A
   * useLayoutEffect keyed on the appContext value only ever runs against whichever instance
   * useMemo actually kept, and fires synchronously before paint — before any child could call
   * runAgentTurn — so it closes the same "must be configured before first render" requirement
   * the old constructor-side comment described, without the phantom-instance risk.
   */
  configureAgent(): void {
    configureAgentToolRunner({
      // Resolves ANY built-in/custom network by id, not just the active one — see
      // NetworkProvider.getNetworkById's docs. Safety for state-changing tools (propose_*)
      // doesn't come from restricting this resolver: it comes from those tools always being
      // called with context.networkId (the active network) and nothing else, since only
      // AgentToolRunner's read-only cross-chain override (get_balance's `network` arg) ever
      // asks this for a network other than the active one.
      getNetwork: (networkId) => {
        const network = this.networkProvider.getNetworkById(Number(networkId) as NetworkId);
        if (!network) {
          throw new Error(`Network ${networkId} is not configured in this wallet.`);
        }
        return network;
      },
      getAccount: (address) => {
        const target = address.toLowerCase();
        return this.accountManager.GetAll().find((a) => a.GetAddress()?.toLowerCase() === target);
      },
      // Name + address only. Account carries the signer too, and handing the whole object to
      // a module that talks to a model is exactly the mistake this shape prevents — there is
      // no path from this list to a key.
      listAccounts: () => {
        const activeIndex = this.accountManager.GetActiveIndex();
        return this.accountManager.GetAll().map((account, index) => ({
          index,
          name: account.GetName(),
          address: account.GetAddress() ?? "",
          isActive: index === activeIndex,
        }));
      },
      // x402 (Faz 3) only targets Base Sepolia for now — any other network means "not
      // supported here", handled by AgentToolRunner as a normal tool error, not a crash.
      getUsdcTokenIdentity: (networkId) => {
        if (Number(networkId) !== NetworkId.Base_Sepolia) return undefined;
        return {
          address: CONTRACTS_BASE_SEPOLIA.USDC.public,
          name: "USDC", // Base Sepolia testnet USDC domain name — confirmed via Circle docs & BaseScan
          version: "2",
          chainId: NetworkId.Base_Sepolia,
        };
      },
      getConnectedSites: async (address) => {
        const target = address.toLowerCase();
        const allSites = await this.sitePermissions.getAll();
        const injectedSites = allSites
          .filter((p) => p.accounts.includes(target))
          .map((p) => ({ origin: p.origin, grantedAt: p.grantedAt, lastUsedAt: p.lastUsedAt }));

        // Not filtered by address — a WalletConnect session isn't scoped to one account the
        // way an injected-provider grant is, see getConnectedSites's own docs.
        const walletConnectSessions = this.walletConnectService.getActiveSessions().map((s) => ({
          name: s.peer?.metadata?.name || "Unknown",
          url: s.peer?.metadata?.url || "",
          expiry: s.expiry,
        }));

        return { injectedSites, walletConnectSessions };
      },
      createAccount: (name) => {
        const index = this.accountManager.CreateAccount(name);
        const account = this.accountManager.GetAll()[index];
        const address = account?.GetAddress();
        if (index < 0 || !address) {
          throw new Error("Yeni hesap oluşturulamadı.");
        }
        return { index, address, name: account.GetName() };
      },
    });
  }
}

