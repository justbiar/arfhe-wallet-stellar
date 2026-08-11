import { createContext } from "react";
import NetworkProvider from "./backend/NetworkProvider.js";
import AccountManager from "./backend/AccountManager.js";
import TokenCache from "./backend/TokenCache.js";
import NFTCache from "./backend/NFTCache.js";
import StorageManager from "./backend/StorageManager.js";
import DataCacheService from "./backend/DataCacheService.js";
import { ContactManager } from "./backend/ContactManager.js";
import FheCofheService from "./backend/FheCofheService.js";

import { WalletConnectService } from "./backend/WalletConnectService";
import SpamFilter from "./backend/SpamFilter.js";
import PendingClaimQueue from "./backend/PendingClaimQueue.js";
import SitePermissionService from "./backend/SitePermissionService.js";

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
      FheCofheService.getInstance().reset();
    });
    this.storageManager.onLock(() => {
      this.dataCacheService.invalidate();
    });
  }
}

