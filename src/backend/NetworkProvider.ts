import SepoliaNetwork from "./Sepolia.js";
import ArbitrumSepoliaNetwork from "./ArbitrumSepolia.js";
import BaseSepoliaNetwork from "./BaseSepolia.js";
import { Network } from "./Network.js";
import { NetworkId, CustomNetworkConfig, NetworkOverride, toChainId } from "./NetworkTypes.js";
import { rpcClient } from "./RpcClient.js";
import { getExplorerBaseForNetwork } from "../components/panels/shared.js";

const CUSTOM_NETWORKS_STORAGE_KEY = "arfhe_custom_networks";
const NETWORK_OVERRIDES_STORAGE_KEY = "arfhe_network_overrides";
const ACTIVE_NETWORK_SESSION_KEY = "arfhe_ps_active_network";

type Listener = () => void;

class NetworkProvider {
  /**
   * The networks the wallet ships with — the three chains the CoFHE coprocessor runs on.
   *
   * Confidential balances only exist on these, so they are the only ones the wallet has a
   * reason to guarantee. Every other chain is the user's to add.
   */
  static readonly BUILT_IN_NETWORKS = [
    NetworkId.Ethereum_Sepolia,
    NetworkId.Arbitrum_Sepolia,
    NetworkId.Base_Sepolia,
  ] as const;

  // Only the chains CoFHE runs on ship with the wallet.
  //
  // Bundling a dozen more made the wallet look complete while quietly committing it to
  // provider keys, explorer mappings and indexer coverage for each one. Everything the
  // user actually needs elsewhere is one "Add network" away, and a network added that way
  // is not second-class: the same balance discovery, history scan and send path serve it.
  private sepoliaNetwork?: SepoliaNetwork;
  private arbitrumSepoliaNetwork?: ArbitrumSepoliaNetwork;
  private baseSepoliaNetwork?: BaseSepoliaNetwork;

  /** User-added custom networks keyed by chainId */
  private customNetworks: Map<number, Network> = new Map();

  private activeNetworkId: NetworkId = NetworkId.Ethereum_Sepolia; // Default to Ethereum Sepolia
  private listeners: Listener[] = [];

  /** User edits to built-in networks, keyed by NetworkId. */
  private overrides: Map<number, NetworkOverride> = new Map();

  constructor() {
    this.init();
    this.loadOverrides();
    this.loadCustomNetworks();
    // Overrides are applied after both sets exist, so an edited RPC survives a reload
    // rather than being reset to the shipped default on every construction.
    this.applyAllOverrides();
    this.restoreActiveNetwork();
  }

  init() {
    if (!this.sepoliaNetwork) this.sepoliaNetwork = new SepoliaNetwork();
    if (!this.arbitrumSepoliaNetwork) this.arbitrumSepoliaNetwork = new ArbitrumSepoliaNetwork();
    if (!this.baseSepoliaNetwork) this.baseSepoliaNetwork = new BaseSepoliaNetwork();
  }

  getSepoliaNetwork(): SepoliaNetwork {
    if (!this.sepoliaNetwork) this.sepoliaNetwork = new SepoliaNetwork();
    return this.sepoliaNetwork;
  }

  getArbitrumSepoliaNetwork(): ArbitrumSepoliaNetwork {
    if (!this.arbitrumSepoliaNetwork) this.arbitrumSepoliaNetwork = new ArbitrumSepoliaNetwork();
    return this.arbitrumSepoliaNetwork;
  }

  getBaseSepoliaNetwork(): BaseSepoliaNetwork {
    if (!this.baseSepoliaNetwork) this.baseSepoliaNetwork = new BaseSepoliaNetwork();
    return this.baseSepoliaNetwork;
  }

  getActiveNetwork(): Network {
    switch (this.activeNetworkId) {
      case NetworkId.Ethereum_Sepolia:
        return this.getSepoliaNetwork();
      case NetworkId.Arbitrum_Sepolia:
        return this.getArbitrumSepoliaNetwork();
      case NetworkId.Base_Sepolia:
        return this.getBaseSepoliaNetwork();
      default: {
        const custom = this.customNetworks.get(this.activeNetworkId as number);
        if (custom) return custom;
        // A network the wallet no longer ships — a removed built-in left in session
        // storage, or a custom one the user deleted. Falling back keeps the wallet usable
        // instead of rendering against a network that does not exist.
        return this.getSepoliaNetwork();
      }
    }
  }

  switchNetwork(networkId: NetworkId) {
    if (this.activeNetworkId === networkId) return;
    this.activeNetworkId = networkId;
    this.persistActiveNetwork(networkId);
    this.notifyListeners();
  }

  getActiveNetworkId(): NetworkId {
    return this.activeNetworkId;
  }

  // --- Custom Network Management ---

  /** Load custom networks from localStorage */
  private loadCustomNetworks(): void {
    try {
      const raw = localStorage.getItem(CUSTOM_NETWORKS_STORAGE_KEY);
      if (!raw) return;
      const configs: CustomNetworkConfig[] = JSON.parse(raw);
      for (const config of configs) {
        const net = Network.fromCustomConfig(config);
        this.customNetworks.set(config.chainId, net);
      }
    } catch (e) {
    }
  }

  /** Save custom networks to localStorage */
  private saveCustomNetworks(): void {
    try {
      const configs: CustomNetworkConfig[] = [];
      for (const [_, net] of this.customNetworks) {
        configs.push({
          chainId: net.network_id as number,
          networkName: net.network_name,
          rpcUrl: net.rpc_url || "",
          explorerUrl: net.explorer_url || "",
          currencySymbol: net.currency_symbol,
        });
      }
      localStorage.setItem(CUSTOM_NETWORKS_STORAGE_KEY, JSON.stringify(configs));
    } catch (e) {
    }
  }

  /** Add a custom network and persist */
  addCustomNetwork(config: CustomNetworkConfig): void {
    // Prevent overriding built-in networks
    // A built-in cannot be shadowed by a custom entry with the same chain id: two
    // Networks answering for one chain would disagree about FHE support and wrappers.
    // Editing the built-in is the supported route, which is what the network editor does.
    // Guard on both forms: a user pasting Sepolia's real chain id (11155111) and one
    // pasting the wallet's internal id must both be refused.
    const reserved = new Set<number>(NetworkProvider.BUILT_IN_NETWORKS.map((id) => Number(id)));
    for (const id of NetworkProvider.BUILT_IN_NETWORKS) reserved.add(toChainId(id));
    if (reserved.has(config.chainId)) {
      throw new Error(`Chain ID ${config.chainId} is a built-in network and cannot be overridden.`);
    }

    const net = Network.fromCustomConfig(config);
    this.customNetworks.set(config.chainId, net);
    this.saveCustomNetworks();
    this.notifyListeners();
  }

  /** Remove a custom network by chainId */
  removeCustomNetwork(chainId: number): void {
    if (!this.customNetworks.has(chainId)) return;
    this.customNetworks.delete(chainId);
    this.saveCustomNetworks();
    // If we were on the removed network, switch to Sepolia
    if ((this.activeNetworkId as number) === chainId) {
      this.activeNetworkId = NetworkId.Ethereum_Sepolia;
    }
    this.notifyListeners();
  }

  /** Get all custom network configs (for UI rendering) */
  getCustomNetworks(): CustomNetworkConfig[] {
    const configs: CustomNetworkConfig[] = [];
    for (const [_, net] of this.customNetworks) {
      configs.push({
        chainId: net.network_id as number,
        networkName: net.network_name,
        rpcUrl: net.rpc_url || "",
        explorerUrl: net.explorer_url || "",
        currencySymbol: net.currency_symbol,
        iconColor: "#1e40af", // Cool steel dot for custom networks
      });
    }
    return configs;
  }


  // --- Built-in Network Overrides ---

  /** Every network the user can edit: the ones we ship, plus the ones they added. */
  listAllNetworks(): {
    /** Internal NetworkId — the key an override is stored under. */
    id: number;
    /** The real EVM chain id, which is what an endpoint reports and a user recognises. */
    chainId: number;
    name: string;
    rpcUrl: string;
    explorerUrl: string;
    currencySymbol: string;
    isCustom: boolean;
    isOverridden: boolean;
  }[] {
    const builtIn = NetworkProvider.BUILT_IN_NETWORKS;

    const rows = builtIn.map((id) => {
      const net = this.networkFor(id);
      return {
        id: id as number,
        // Sepolia is NetworkId 4 but chain 11155111. Showing the internal id would label
        // it wrongly, and the editor's endpoint check would call every correct RPC a
        // mismatch.
        chainId: toChainId(id),
        name: net.network_name,
        rpcUrl: net.rpc_url ?? "",
        // Built-in networks resolve their explorer through a lookup rather than storing
        // one, so reading the field directly showed an empty box the user could only make
        // worse by typing in it.
        explorerUrl: net.explorer_url ?? getExplorerBaseForNetwork(id),
        currencySymbol: net.currency_symbol,
        isCustom: false,
        isOverridden: this.overrides.has(id as number),
      };
    });

    for (const config of this.getCustomNetworks()) {
      rows.push({
        id: config.chainId,
        // Custom networks are registered by their real chain id, so the two coincide.
        chainId: config.chainId,
        name: config.networkName,
        rpcUrl: config.rpcUrl,
        explorerUrl: config.explorerUrl,
        currencySymbol: config.currencySymbol,
        isCustom: true,
        isOverridden: false,
      });
    }

    return rows;
  }

  /** The Network instance for an id, built-in or custom. */
  private networkFor(id: NetworkId): Network {
    const previous = this.activeNetworkId;
    this.activeNetworkId = id;
    try {
      return this.getActiveNetwork();
    } finally {
      this.activeNetworkId = previous;
    }
  }

  getNetworkOverride(networkId: number): NetworkOverride | undefined {
    return this.overrides.get(networkId);
  }

  /**
   * Apply the user's edits to a built-in network and persist them.
   *
   * Custom networks are not handled here — they are fully user-defined already, so editing
   * one is a rewrite of its config rather than an overlay on a shipped default.
   */
  setNetworkOverride(networkId: number, override: NetworkOverride): void {
    const cleaned: NetworkOverride = {};
    if (override.rpcUrl?.trim()) cleaned.rpcUrl = override.rpcUrl.trim();
    if (override.fallbackRpcUrl?.trim()) cleaned.fallbackRpcUrl = override.fallbackRpcUrl.trim();
    if (override.explorerUrl?.trim()) cleaned.explorerUrl = override.explorerUrl.trim().replace(/\/+$/, "");
    if (override.networkName?.trim()) cleaned.networkName = override.networkName.trim();
    if (override.currencySymbol?.trim()) cleaned.currencySymbol = override.currencySymbol.trim();

    if (Object.keys(cleaned).length === 0) {
      this.clearNetworkOverride(networkId);
      return;
    }

    this.overrides.set(networkId, cleaned);
    this.saveOverrides();
    this.applyOverride(networkId as NetworkId, cleaned);
    // Answers cached against the previous endpoint describe a node the wallet is no
    // longer talking to; keeping them would mix two providers' views of the chain.
    rpcClient.invalidate();
    this.notifyListeners();
  }

  /** Drop the user's edits and return the network to what the wallet ships. */
  clearNetworkOverride(networkId: number): void {
    if (!this.overrides.delete(networkId)) return;
    this.saveOverrides();
    // Rebuilding is the only reliable reset: the shipped values live in each subclass's
    // constructor, and there is nowhere else to read them back from.
    this.rebuild(networkId as NetworkId);
    rpcClient.invalidate();
    this.notifyListeners();
  }

  /** Discard and reconstruct one built-in network from its shipped definition. */
  private rebuild(networkId: NetworkId): void {
    switch (networkId) {
      case NetworkId.Ethereum_Sepolia: this.sepoliaNetwork = new SepoliaNetwork(); break;
      case NetworkId.Arbitrum_Sepolia: this.arbitrumSepoliaNetwork = new ArbitrumSepoliaNetwork(); break;
      case NetworkId.Base_Sepolia: this.baseSepoliaNetwork = new BaseSepoliaNetwork(); break;
      default: break;
    }
  }

  /** Overlay one override onto its live Network instance. */
  private applyOverride(networkId: NetworkId, override: NetworkOverride): void {
    const net = this.networkFor(networkId);
    if (!net) return;

    if (override.networkName) net.network_name = override.networkName;
    if (override.currencySymbol) net.currency_symbol = override.currencySymbol;
    if (override.explorerUrl) net.explorer_url = override.explorerUrl;

    if (override.rpcUrl) {
      net.rpc_url = override.rpcUrl;
      net.fallbackRpcUrl = override.fallbackRpcUrl;

      // The Alchemy SDK talks to its own endpoint, not `rpc_url`. Leaving it attached to a
      // network the user has pointed elsewhere would split the wallet across two
      // providers — balances from one, transaction history from the other — which is worse
      // than losing the SDK's extras. Keep it only when the new endpoint is still Alchemy.
      if (!/\.g\.alchemy\.com/i.test(override.rpcUrl)) {
        net.alchemy = undefined;
        net.api_key = "CUSTOM_URL";
      }
    } else if (override.fallbackRpcUrl) {
      net.fallbackRpcUrl = override.fallbackRpcUrl;
    }
  }

  /** Re-apply every stored override; used at construction. */
  private applyAllOverrides(): void {
    for (const [id, override] of this.overrides) {
      try {
        this.applyOverride(id as NetworkId, override);
      } catch {
        // A malformed override must not stop the wallet from starting.
      }
    }
  }

  private loadOverrides(): void {
    try {
      const raw = localStorage.getItem(NETWORK_OVERRIDES_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Record<string, NetworkOverride>;
      for (const [id, override] of Object.entries(parsed)) {
        const numeric = Number(id);
        if (Number.isFinite(numeric)) this.overrides.set(numeric, override);
      }
    } catch {
      // Unreadable overrides fall back to the shipped defaults rather than blocking start.
    }
  }

  private saveOverrides(): void {
    try {
      const out: Record<string, NetworkOverride> = {};
      for (const [id, override] of this.overrides) out[String(id)] = override;
      localStorage.setItem(NETWORK_OVERRIDES_STORAGE_KEY, JSON.stringify(out));
    } catch {
      // Storage full or unavailable — the in-memory override still applies this session.
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener);
    };
  }

  /** Restore active network from session storage (sync read for instant restore) */
  private restoreActiveNetwork(): void {
    try {
      const stored = sessionStorage.getItem(ACTIVE_NETWORK_SESSION_KEY);
      if (stored !== null) {
        const id = Number(stored);
        if (!isNaN(id)) {
          this.activeNetworkId = id as NetworkId;
        }
      }
      // Also try chrome.storage.session for extension popup persistence
      if (typeof chrome !== "undefined" && chrome?.storage?.session) {
        chrome.storage.session.get(ACTIVE_NETWORK_SESSION_KEY).then((result: Record<string, unknown>) => {
          const val = result[ACTIVE_NETWORK_SESSION_KEY];
          if (val !== undefined && val !== null) {
            const id = Number(val);
            if (!isNaN(id) && id !== this.activeNetworkId) {
              this.activeNetworkId = id as NetworkId;
              this.notifyListeners();
            }
          }
        }).catch(() => {/* ignore */ });
      }
    } catch {
      // sessionStorage not available
    }
  }

  /** Persist active network to session storage + chrome.storage.session */
  private persistActiveNetwork(networkId: NetworkId): void {
    try {
      sessionStorage.setItem(ACTIVE_NETWORK_SESSION_KEY, String(networkId));
    } catch {
      // sessionStorage not available
    }
    try {
      if (typeof chrome !== "undefined" && chrome?.storage?.session) {
        chrome.storage.session.set({ [ACTIVE_NETWORK_SESSION_KEY]: networkId });
      }
    } catch {
      // chrome.storage.session not available
    }
  }

  private notifyListeners() {
    this.listeners.forEach(l => l());
  }
}

export default NetworkProvider;