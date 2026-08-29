import { formatEther, parseUnits, TransactionRequest } from "ethers";
import { Alchemy, Network as AlchemyNetwork, SortingOrder, AssetTransfersCategory, NftFilters } from "alchemy-sdk";
import Account from "./Account.js";
import TokenCache, { TokenCacheItem } from "./TokenCache.js";
import type NFTCache from "./NFTCache.js";
import type { NFTCacheItem } from "./NFTCache.js";

import { NetworkId, TokenBalance, TransactionHistory, PendingTransaction, CustomNetworkConfig } from "./NetworkTypes.js";
import { ExplorerService } from "./ExplorerService.js";
import { withRetry, fetchWithTimeout, wssRpcCall, classifyError, NetworkErrorType } from "./NetworkErrorHandler.js";
import type { RetryOptions } from "./NetworkErrorHandler.js";
import type { ShieldedTokenMeta, UnshieldClaim, ShieldedHolding } from "../types/fhe.js";
import { rpcClient } from "./RpcClient.js";
import { notifyTxConfirmed } from "./TxNotifier.js";
import type { OwnedNftItem } from "../types/nft.js";
import type PendingClaimQueue from "./PendingClaimQueue.js";

/**
 * Returns the correct CoinGecko API base URL.
 * In dev (Vite proxy), returns "/api/coingecko".
 * In Chrome extension (no proxy), returns the real CoinGecko API URL.
 */
export function getCoinGeckoBase(): string {
  // Chrome extension environment detection
  try {
    if (typeof chrome !== "undefined" && chrome.runtime && (chrome.runtime as any).id) {
      return "https://api.coingecko.com/api/v3";
    }
  } catch { /* not in extension */ }
  // Vite dev server proxy
  return "/api/coingecko";
}
class Network {
  network_id: NetworkId;
  network_name: string;

  api_key?: string;
  rpc_url?: string;
  /**
   * Secondary endpoint, used only when the primary cannot be reached.
   *
   * A single RPC is a single point of failure for the whole chain: when it rate-limits or
   * goes down, every balance, every gas estimate and every send fails at once. This is the
   * user's escape hatch, set from the network editor.
   */
  fallbackRpcUrl?: string;
  /**
   * Endpoints to try, in order, when the primary one cannot answer.
   *
   * The wallet ships with one Alchemy key per chain, compiled into a bundle every user
   * downloads. That makes the key a shared resource: one quota for the whole userbase, and
   * extractable by anyone who installs the extension. Exhausting it — by accident at scale,
   * or on purpose — used to take the wallet down entirely, because a single endpoint that
   * stops answering is a single point of failure with nothing behind it.
   *
   * With a chain behind it the key becomes an accelerator rather than a dependency. The
   * indexer-backed features degrade (see {@link isAlchemyOnly}), but balances, sends and
   * everything else keep working on public infrastructure.
   */
  fallbackRpcUrls: string[] = [];

  /** Epoch ms until which the primary endpoint is skipped after it failed. */
  private primaryUnhealthyUntil = 0;

  /**
   * How long a failing primary is left alone.
   *
   * Long enough that a rate limit has a chance to reset, short enough that a user who
   * opens the wallet a minute later is back on the endpoint that can answer history.
   */
  private static readonly PRIMARY_COOLDOWN_MS = 60_000;
  explorer_url?: string;
  currency_symbol: string = "ETH";
  alchemy?: Alchemy;
  explorerService?: ExplorerService;
  isCustom: boolean = false;

  /** In-memory store of pending (unconfirmed) transactions */
  pendingTransactions: Map<string, PendingTransaction> = new Map();

  FETCH_HEADERS = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };

  constructor(network_id: NetworkId, network_name: string, baseUrl?: string, explicitApiKey?: string) {
    this.network_id = network_id;
    this.network_name = network_name;

    let rawKey = explicitApiKey || import.meta.env.VITE_ALCHEMY_API_KEY || "";

    if (rawKey.startsWith("http")) {
      const parts = rawKey.split("/");
      const potentialKey = parts[parts.length - 1];
      if (potentialKey && potentialKey.length > 20) {
        rawKey = potentialKey;
        this.api_key = rawKey;
        this.rpc_url = explicitApiKey;
      } else {
        this.rpc_url = rawKey;
        this.api_key = "CUSTOM_URL" as string;
      }
    } else {
      this.api_key = rawKey;
      if (baseUrl && this.api_key) {
        this.rpc_url = baseUrl + this.api_key;
      }
    }

    // Public endpoints stand behind whatever the primary is, including when the primary is
    // the shared Alchemy key. The primary itself is filtered out so a failover never
    // retries the endpoint that just failed.
    this.fallbackRpcUrls = (Network.PUBLIC_FALLBACKS[network_id] ?? []).filter(
      (url) => url !== this.rpc_url
    );

    // Alchemy only for networks that have Alchemy support
    const noAlchemyNetworks = new Set([NetworkId.Sei, NetworkId.Monad_Testnet]);
    if (this.isAlchemyConfigured() && !noAlchemyNetworks.has(network_id)) {
      let sdkNetwork = AlchemyNetwork.ETH_MAINNET;
      switch (network_id) {
        case NetworkId.Ethereum_Sepolia:
          sdkNetwork = AlchemyNetwork.ETH_SEPOLIA;
          break;
        case NetworkId.Ethereum_Mainnet:
          sdkNetwork = AlchemyNetwork.ETH_MAINNET;
          break;
        case NetworkId.Arbitrum_One:
          sdkNetwork = AlchemyNetwork.ARB_MAINNET;
          break;
        case NetworkId.Arbitrum_Sepolia:
          sdkNetwork = AlchemyNetwork.ARB_SEPOLIA;
          break;
        case NetworkId.Base_Mainnet:
          sdkNetwork = AlchemyNetwork.BASE_MAINNET;
          break;
        case NetworkId.Base_Sepolia:
          sdkNetwork = AlchemyNetwork.BASE_SEPOLIA;
          break;
        case NetworkId.Polygon:
          sdkNetwork = AlchemyNetwork.MATIC_MAINNET;
          break;
        case NetworkId.Optimism:
          sdkNetwork = AlchemyNetwork.OPT_MAINNET;
          break;
        case NetworkId.Avalanche:
          sdkNetwork = AlchemyNetwork.AVAX_MAINNET;
          break;
        case NetworkId.BNB_Chain:
          sdkNetwork = AlchemyNetwork.BNB_MAINNET;
          break;
        case NetworkId.Linea:
          sdkNetwork = AlchemyNetwork.LINEA_MAINNET;
          break;
        case NetworkId.Avalanche_Fuji:
          sdkNetwork = AlchemyNetwork.AVAX_FUJI;
          break;
      }

      const config = {
        apiKey: this.api_key,
        network: sdkNetwork,
      };
      this.alchemy = new Alchemy(config);
      this.explorerService = new ExplorerService(this.alchemy);
    }
    if (!this.rpc_url) {
      if (!this.api_key || this.api_key === "CUSTOM_URL") {
        switch (network_id) {
          case NetworkId.Ethereum_Mainnet:
            this.rpc_url = "https://ethereum.publicnode.com";
            break;
          case NetworkId.Ethereum_Sepolia:
            this.rpc_url = "https://ethereum-sepolia.publicnode.com";
            break;
          case NetworkId.Arbitrum_One:
            this.rpc_url = "https://arbitrum.publicnode.com";
            break;
          case NetworkId.Arbitrum_Sepolia:
            this.rpc_url = "https://arbitrum-sepolia.publicnode.com";
            break;
          case NetworkId.Base_Mainnet:
            this.rpc_url = "https://base.publicnode.com";
            break;
          case NetworkId.Base_Sepolia:
            this.rpc_url = "https://base-sepolia.publicnode.com";
            break;
          case NetworkId.Polygon:
            this.rpc_url = "https://polygon-bor-rpc.publicnode.com";
            break;
          case NetworkId.Optimism:
            this.rpc_url = "https://optimism.publicnode.com";
            break;
          case NetworkId.Avalanche:
            this.rpc_url = "https://avalanche-c-chain-rpc.publicnode.com";
            break;
          case NetworkId.BNB_Chain:
            this.rpc_url = "https://bsc-rpc.publicnode.com";
            break;
          case NetworkId.Linea:
            this.rpc_url = "https://rpc.linea.build";
            break;
          case NetworkId.Sei:
            this.rpc_url = "https://evm-rpc.sei-apis.com";
            break;
          case NetworkId.Monad_Testnet:
            this.rpc_url = "https://testnet-rpc.monad.xyz";
            break;
          case NetworkId.Avalanche_Fuji:
            this.rpc_url = "https://avalanche-fuji-c-chain-rpc.publicnode.com";
            break;
          default:
            this.rpc_url = "";
        }
      }
    }
  }

  /** Create a Network instance from a user-defined custom network config */
  static fromCustomConfig(config: CustomNetworkConfig): Network {
    // Pass NO api key / base URL → prevents Alchemy SDK from being created
    const net = new Network(
      config.chainId as NetworkId,
      config.networkName,
      undefined,
      undefined
    );
    // Override: set custom RPC directly, mark as non-Alchemy
    net.rpc_url = config.rpcUrl;
    net.api_key = "CUSTOM_URL";
    net.alchemy = undefined;
    net.explorerService = undefined;
    net.explorer_url = config.explorerUrl.replace(/\/+$/, ""); // strip trailing slash
    net.currency_symbol = config.currencySymbol;
    net.isCustom = true;
    return net;
  }

  /**
   * Public endpoints for the chains the wallet ships with, most reliable first.
   *
   * Verified against the live networks rather than copied from a list: `rpc.sepolia.org`
   * answers with an HTML error page and `sepolia.drpc.org` reports no chain id at all, so
   * neither is here. An endpoint that is in this table but broken is worse than no table,
   * because it turns one failure into two.
   */
  private static readonly PUBLIC_FALLBACKS: Partial<Record<NetworkId, string[]>> = {
    [NetworkId.Ethereum_Sepolia]: [
      "https://ethereum-sepolia-rpc.publicnode.com",
      "https://1rpc.io/sepolia",
    ],
    [NetworkId.Base_Sepolia]: [
      "https://sepolia.base.org",
      "https://base-sepolia-rpc.publicnode.com",
      "https://base-sepolia.drpc.org",
    ],
    [NetworkId.Arbitrum_Sepolia]: [
      "https://sepolia-rollup.arbitrum.io/rpc",
      "https://arbitrum-sepolia-rpc.publicnode.com",
      "https://arbitrum-sepolia.drpc.org",
    ],
  };

  /**
   * Whether a method only the indexer implements.
   *
   * Sending one of these to a public node produces "method not found" — a *different*
   * failure from the one that triggered the failover, and one the caller cannot tell apart
   * from a real answer. The callers of these already have non-indexed paths to fall back
   * to; letting the request fail cleanly is what lets them take those.
   */
  private isAlchemyOnly(method: string): boolean {
    return method.startsWith("alchemy_");
  }

  isAlchemyConfigured(): boolean {
    return !!this.api_key && this.api_key !== "CUSTOM_URL";
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async call(method: string, params: unknown[]): Promise<any> {
    if (!this.rpc_url) {
      throw new Error("RPC URL not set");
    }

    const rpcUrl = this.rpc_url;
    const isWs = rpcUrl.startsWith("ws://") || rpcUrl.startsWith("wss://");

    if (isWs) {
      // WebSocket JSON-RPC — used for ws:// and wss:// endpoints
      return withRetry(
        () => wssRpcCall(rpcUrl, method, params, 15_000),
        {
          maxRetries: 2,
          initialDelayMs: 800,
          shouldRetry: (err) => {
            if (err.type === NetworkErrorType.RpcError || err.type === NetworkErrorType.UserError) return false;
            return err.retryable;
          },
        }
      );
    }

    // HTTP / HTTPS — use fetch.
    //
    // Everything read goes through the shared client, which serves a recent answer, joins
    // an identical request already in flight, and caps how many connections this host has
    // open. Without it, mounting three screens at once produced three identical bursts and
    // the provider answered with 429.
    const body = JSON.stringify({ id: 1, jsonrpc: "2.0", method, params });
    const headers = this.FETCH_HEADERS;

    const post = async (url: string) => {
      const response = await fetchWithTimeout(url, { method: "POST", headers, body }, 15_000);
      const json = await response.json();
      if (json.error) throw new Error(json.error.message);
      return json.result;
    };

    // While the primary is cooling off, go straight to a fallback — unless the method is
    // one only the primary implements, in which case the attempt is still worth making:
    // failing there lets the caller take its non-indexed path, and it is how the wallet
    // notices the primary is back.
    const inCooldown = Date.now() < this.primaryUnhealthyUntil;
    const firstChoice =
      inCooldown && !this.isAlchemyOnly(method) && this.fallbackRpcUrls.length > 0
        ? this.fallbackRpcUrls[0]
        : rpcUrl;

    return rpcClient.request(firstChoice, method, params, async () => {
      try {
        return await withRetry(() => post(firstChoice), {
          maxRetries: 2,
          initialDelayMs: 800,
          onRetry: (_attempt, _max, err) => {
            if (err.type === NetworkErrorType.RateLimited) rpcClient.noteRateLimited();
          },
          shouldRetry: (err) => {
            if (err.type === NetworkErrorType.RpcError || err.type === NetworkErrorType.UserError) return false;
            return err.retryable;
          },
        });
      } catch (err) {
        // Fall back only for transport-level failures. An RPC that answered with an error
        // gave a real answer about the chain, and asking a different node would not change
        // it — retrying there would just double the load for the same rejection.
        const classified = classifyError(err);
        const worthFailover =
          classified.type !== NetworkErrorType.RpcError &&
          classified.type !== NetworkErrorType.UserError;

        // An indexer method has no equivalent on a public node. Failing over would swap a
        // rate-limit error for a "method not found" one and tell the caller nothing useful.
        if (!worthFailover || this.isAlchemyOnly(method)) throw err;

        // The user's own fallback first — they chose it — then the shipped public chain,
        // minus whichever endpoint just failed.
        const chain = [
          ...(this.fallbackRpcUrl ? [this.fallbackRpcUrl] : []),
          ...this.fallbackRpcUrls,
        ].filter((url) => url !== firstChoice);
        if (chain.length === 0) throw err;

        // Stop asking the primary for a while. Without this every request pays the full
        // retry budget against a dead endpoint before reaching a live one, which is slower
        // than having no primary at all.
        //
        // A cooldown rather than a permanent switch: the primary is the only endpoint that
        // can answer the indexer methods, and demoting the user to a public node for the
        // rest of the session over one bad minute costs them their transaction history.
        this.primaryUnhealthyUntil = Date.now() + Network.PRIMARY_COOLDOWN_MS;

        let lastError: unknown = err;
        for (const url of chain) {
          try {
            return await post(url);
          } catch (e) {
            lastError = e;
          }
        }
        throw lastError;
      }
    });
  }

  /**
   * Issue many JSON-RPC calls as a single batched HTTP request.
   *
   * Scanning the token list one `eth_call` at a time is what made the shield panel take
   * minutes to open: a hundred tokens meant a hundred round trips, each with its own
   * retry budget. Batching collapses that to a couple of requests.
   *
   * Failures are per-item, never fatal: an entry that errors (or is missing from the
   * response) comes back as `null` so callers degrade to "unknown" instead of losing the
   * whole batch. Falls back to individual calls when the endpoint rejects batching,
   * which some RPCs and all WebSocket transports do.
   *
   * @param requests One `{ method, params }` per call, in order.
   * @param chunkSize Maximum calls per HTTP request; providers cap batch sizes.
   * @returns Results positionally aligned with `requests`; `null` where the call failed.
   */
  async callBatch(
    requests: { method: string; params: unknown[] }[],
    chunkSize = 50
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<(any | null)[]> {
    if (requests.length === 0) return [];
    if (!this.rpc_url) throw new Error("RPC URL not set");

    const rpcUrl = this.rpc_url;
    const isWs = rpcUrl.startsWith("ws://") || rpcUrl.startsWith("wss://");

    // WebSocket transport has no batch helper here — fall back to bounded concurrency,
    // which still beats fully sequential calls.
    if (isWs) return this.callEachLimited(requests);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const results: (any | null)[] = new Array(requests.length).fill(null);

    for (let offset = 0; offset < requests.length; offset += chunkSize) {
      const chunk = requests.slice(offset, offset + chunkSize);
      const body = JSON.stringify(
        chunk.map((r, i) => ({ id: i, jsonrpc: "2.0", method: r.method, params: r.params }))
      );

      // A batch is one connection carrying many calls, so it cannot be keyed or cached —
      // but it must still queue behind the same per-host limit, or the largest requests
      // would be the ones that bypass it.
      const releaseSlot = await rpcClient.slot(rpcUrl);
      try {
        const response = await fetchWithTimeout(
          rpcUrl,
          { method: "POST", headers: this.FETCH_HEADERS, body },
          20_000
        );
        const json = await response.json();

        // A provider that does not support batching answers with a single object.
        if (!Array.isArray(json)) throw new Error("Batch not supported");

        for (const entry of json) {
          const index = typeof entry?.id === "number" ? offset + entry.id : -1;
          if (index < 0 || index >= requests.length) continue;
          results[index] = entry.error ? null : entry.result;
        }
      } catch {
        // Batch rejected or malformed — redo just this chunk one call at a time. The slot
        // is handed back first: the retry re-enters through `call`, which takes its own,
        // and holding both would deadlock a saturated host against itself.
        releaseSlot();
        const individual = await this.callEachLimited(chunk);
        individual.forEach((value, i) => { results[offset + i] = value; });
        continue;
      } finally {
        releaseSlot();
      }
    }

    return results;
  }

  /** Run calls with bounded concurrency, mapping individual failures to null. */
  private async callEachLimited(
    requests: { method: string; params: unknown[] }[],
    concurrency = 8
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<(any | null)[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const results: (any | null)[] = new Array(requests.length).fill(null);
    let cursor = 0;

    const worker = async () => {
      for (;;) {
        const index = cursor++;
        if (index >= requests.length) return;
        try {
          results[index] = await this.call(requests[index].method, requests[index].params);
        } catch {
          results[index] = null;
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(concurrency, requests.length) }, worker)
    );
    return results;
  }

  /** Resolved ERC-20 decimals per token address; immutable after deployment. */
  private decimalsCache = new Map<string, number>();

  /**
   * Read an ERC-20's `decimals()` from the contract.
   *
   * Decimals scale the amount that actually leaves the wallet, so they must come from the
   * token rather than from cached metadata supplied by a third-party indexer: treating a
   * 6-decimal token as 18-decimal sends a million times the intended amount.
   *
   * @throws When the token does not answer `decimals()`. Guessing here would mean signing
   *         a transfer whose size nobody has established.
   */
  async getErc20Decimals(tokenAddress: string): Promise<number> {
    const key = tokenAddress.toLowerCase();
    const cached = this.decimalsCache.get(key);
    if (cached !== undefined) return cached;

    const { Interface } = await import("ethers");
    const iface = new Interface(["function decimals() view returns (uint8)"]);

    const hex = await this.call("eth_call", [
      { to: tokenAddress, data: iface.encodeFunctionData("decimals", []) },
      "latest",
    ]);

    if (!hex || hex === "0x") {
      throw new Error(
        "This token does not report its decimals, so the amount to send cannot be determined safely."
      );
    }

    const decimals = Number(BigInt(hex));
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
      throw new Error(`This token reports an implausible decimals value (${decimals}).`);
    }

    this.decimalsCache.set(key, decimals);
    return decimals;
  }

  async getBlockNumber(): Promise<number> {
    const result = await this.call("eth_blockNumber", []);
    return parseInt(result, 16);
  }

  async getTokenMetadata(tokenCacheObj: TokenCache, contractAddress: string): Promise<TokenCacheItem> {
    try {
      if (this.alchemy) {
        try {
          const metadata = await this.alchemy.core.getTokenMetadata(contractAddress);
          if (metadata && (metadata.name || metadata.symbol)) {
            const item: TokenCacheItem = {
              name: metadata.name ?? "Unknown Token",
              symbol: metadata.symbol ?? "",
              decimals: metadata.decimals ?? 18,
              logoSrc: metadata.logo ?? "",
              contractAddress: contractAddress,
            };
            tokenCacheObj.setToken(this.network_id, item);
            return item;
          }
        } catch (e) {
        }
      }

      if (this.isAlchemyConfigured()) {
        const metadata = await this.call("alchemy_getTokenMetadata", [contractAddress]);
        if (metadata && (metadata.name || metadata.symbol)) {
          const item: TokenCacheItem = {
            name: metadata.name ?? "Unknown Token",
            symbol: metadata.symbol ?? "",
            decimals: metadata.decimals ?? 18,
            logoSrc: metadata.logo ?? "",
            contractAddress: contractAddress,
          };
          tokenCacheObj.setToken(this.network_id, item);
          return item;
        }
      }
    } catch (e) {
    }

    // Direct RPC Fallback for unindexed testnet tokens (Crucial for Custom Imports)
    const ethers = await import("ethers");
    const iface = new ethers.Interface([
      "function name() view returns (string)",
      "function symbol() view returns (string)",
      "function decimals() view returns (uint8)"
    ]);

    let name = "Unknown Token";
    let symbol = "???";
    let decimals = 18;

    try {
      const nameData = await this.call("eth_call", [{ to: contractAddress, data: iface.encodeFunctionData("name") }, "latest"]);
      if (nameData && nameData !== "0x") name = iface.decodeFunctionResult("name", nameData)[0];
    } catch (e) { }

    try {
      const symbolData = await this.call("eth_call", [{ to: contractAddress, data: iface.encodeFunctionData("symbol") }, "latest"]);
      if (symbolData && symbolData !== "0x") symbol = iface.decodeFunctionResult("symbol", symbolData)[0];
    } catch (e) { }

    try {
      const decData = await this.call("eth_call", [{ to: contractAddress, data: iface.encodeFunctionData("decimals") }, "latest"]);
      if (decData && decData !== "0x") decimals = Number(iface.decodeFunctionResult("decimals", decData)[0]);
    } catch (e) { }

    const item: TokenCacheItem = {
      name,
      symbol,
      decimals,
      logoSrc: "",
      contractAddress
    };

    tokenCacheObj.setToken(this.network_id, item);
    return item;
  }

  async getNftMetadata(nftCacheObj: NFTCache | null | undefined, contractAddress: string): Promise<NFTCacheItem> {
    const ethers = await import("ethers");
    const iface = new ethers.Interface([
      "function name() view returns (string)",
      "function symbol() view returns (string)"
    ]);

    let name = "Unknown NFT";
    let symbol = "NFT";

    try {
      const nameData = await this.call("eth_call", [{ to: contractAddress, data: iface.encodeFunctionData("name") }, "latest"]);
      if (nameData && nameData !== "0x") name = iface.decodeFunctionResult("name", nameData)[0];
    } catch (e) { }

    try {
      const symbolData = await this.call("eth_call", [{ to: contractAddress, data: iface.encodeFunctionData("symbol") }, "latest"]);
      if (symbolData && symbolData !== "0x") symbol = iface.decodeFunctionResult("symbol", symbolData)[0];
    } catch (e) { }

    const item = {
      name,
      symbol,
      logoSrc: "",
      contractAddress
    };

    if (nftCacheObj) {
      nftCacheObj.setNFT(this.network_id, item);
    }
    return item;
  }

  /**
   * NFTs this address actually owns, with their token IDs and artwork.
   *
   * The gallery previously knew only a contract address and a `balanceOf` count, so each
   * card guessed at `tokenURI(1)` — token #1 belongs to whoever minted first, not to this
   * user. Every card rendered as "Unknown NFT" with a broken image, and clicking one had
   * nowhere to go because there was no token ID to link to.
   *
   * Requires the Alchemy NFT API; without a key there is no way to enumerate holdings
   * from a plain RPC, so the gallery stays empty rather than showing guesses.
   */
  async getOwnedNfts(userAddress: string): Promise<OwnedNftItem[]> {
    if (!this.alchemy) return [];

    try {
      const response = await this.alchemy.nft.getNftsForOwner(userAddress, {
        // Spam is filtered by Alchemy's own classification; airdropped junk is the bulk
        // of what an address accumulates and none of it is worth a card.
        excludeFilters: [NftFilters.SPAM],
        pageSize: 60,
      });

      return response.ownedNfts.map((nft) => ({
        contractAddress: nft.contract.address,
        tokenId: nft.tokenId,
        name: nft.name || nft.contract.name || "",
        symbol: nft.contract.symbol || "",
        // Alchemy caches and normalises the media, which sidesteps dead IPFS gateways.
        imageUrl: nft.image?.cachedUrl || nft.image?.thumbnailUrl || nft.image?.pngUrl || "",
        balance: nft.balance ?? "1",
        tokenType: nft.tokenType,
      }));
    } catch {
      // No NFT support on this network, or the key lacks the NFT API.
      return [];
    }
  }

  async getNftBalance(contractAddress: string, userAddress: string): Promise<string> {
    try {
      const ethers = await import("ethers");
      const iface = new ethers.Interface([
        "function balanceOf(address owner) view returns (uint256)"
      ]);

      const data = iface.encodeFunctionData("balanceOf", [userAddress]);
      const result = await this.call("eth_call", [{
        to: contractAddress,
        data: data
      }, "latest"]);

      if (result && result !== "0x") {
        return BigInt(result).toString();
      }
    } catch (e) {
    }
    return "0";
  }

  private formatTokenAmount(value: bigint, decimals: number): string {
    if (decimals < 0) decimals = 0;
    const base = 10n ** BigInt(decimals);

    const whole = value / base;
    const fraction = value % base;

    let fractionStr = fraction.toString().padStart(Number(decimals), "0").replace(/0+$/, "");

    if (fractionStr.length === 0) {
      return whole.toString();
    }

    return `${whole}.${fractionStr}`;
  }


  async getBalance(address: string): Promise<string> {
    if (this.alchemy) {
      try {
        const big = await withRetry(
          () => this.alchemy!.core.getBalance(address),
          { maxRetries: 2, initialDelayMs: 500 }
        );
        return big.toString();
      } catch (e) {
        // Fallback to RPC
      }
    }
    const result = await this.call("eth_getBalance", [address, "latest"]);
    return BigInt(result).toString();
  }

  async getTokenBalances(tokenCacheObj: TokenCache | undefined, address: string): Promise<TokenBalance[]> {
    if (!tokenCacheObj) throw new Error("TokenCache is not initialized");

    let nativeBalance = "0";
    try {
      nativeBalance = await this.getBalance(address);
    } catch (e) {
    }

    let tokenBalancesRaw: Array<{ contractAddress: string; tokenBalance: string | null }> = [];

    if (this.alchemy) {
      try {
        const response = await withRetry(
          () => this.alchemy!.core.getTokenBalances(address),
          { maxRetries: 2, initialDelayMs: 800 }
        );
        tokenBalancesRaw = response.tokenBalances;
      } catch (e) {
        // Don't throw — fall through to manual/cache-based approach
      }
    } else if (this.isAlchemyConfigured()) {
      try {
        const result = await this.call("alchemy_getTokenBalances", [address, "erc20"]);
        tokenBalancesRaw = result.tokenBalances;
      } catch (e) {
      }
    }

    // Custom networks: discover ERC20 tokens via Transfer event logs
    // Scan recent blocks for incoming ERC20 Transfer(from, to, value) events
    if (!this.alchemy && !this.isAlchemyConfigured()) {
      try {
        const currentBlock = await this.getBlockNumber();
        // Scan last ~5000 blocks (adjust based on block time)
        const fromBlock = Math.max(0, currentBlock - 5000);
        // ERC20 Transfer topic: keccak256("Transfer(address,address,uint256)")
        const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
        // Pad address to 32 bytes for topic filter (to = recipient)
        const paddedAddress = "0x000000000000000000000000" + address.toLowerCase().replace("0x", "");

        const logs = await this.call("eth_getLogs", [{
          fromBlock: "0x" + fromBlock.toString(16),
          toBlock: "latest",
          topics: [TRANSFER_TOPIC, null, paddedAddress]  // Transfer(*, toAddress, *)
        }]);

        if (Array.isArray(logs)) {
          const discoveredContracts = new Set<string>();
          for (const log of logs) {
            if (log.address) {
              discoveredContracts.add(log.address.toLowerCase());
            }
          }

          // One batched request for every discovered contract.
          //
          // This used to be a sequential `await` per address, each with its own retry
          // budget. A chain the user has been active on surfaces dozens of contracts, so
          // adding a network meant dozens of serial round trips before the first balance
          // appeared — and a burst the provider answers with 429.
          const balanceOfSig = "0x70a08231000000000000000000000000" + address.toLowerCase().replace("0x", "");
          const contracts = [...discoveredContracts];
          const balances = await this.callBatch(
            contracts.map((to) => ({ method: "eth_call", params: [{ to, data: balanceOfSig }, "latest"] }))
          );

          contracts.forEach((contractAddr, i) => {
            const result = balances[i];
            // `null` here is a failed read, not a zero balance — skipping it is right
            // either way, since a token we cannot price or read has nothing to show.
            if (!result || result === "0x") return;
            try {
              if (BigInt(result) > 0n) {
                tokenBalancesRaw.push({
                  contractAddress: contractAddr,
                  tokenBalance: BigInt(result).toString(),
                });
              }
            } catch {
              // Not a valid ERC-20 response — skip.
            }
          });
        }
      } catch (e) {
      }
    }

    const activeTokensRaw = [...tokenBalancesRaw];

    // Ensure all known tokens in the local cache are queried directly if not natively returned.
    const rawSet = new Set(activeTokensRaw.map(t => (t.contractAddress || "").toLowerCase()));
    const cachedTokens = tokenCacheObj.getAllTokens(this.network_id) || [];

    const shieldedAddresses = [
      (import.meta.env.VITE_WRAPPED_ETH_ADDRESS || "").toLowerCase(),
      (import.meta.env.VITE_WRAPPED_USDC_ADDRESS || "").toLowerCase(),
      (import.meta.env.VITE_ARB_WRAPPED_ETH_ADDRESS || "").toLowerCase(),
      (import.meta.env.VITE_ARB_WRAPPED_USDC_ADDRESS || "").toLowerCase(),
      (import.meta.env.VITE_BASE_WRAPPED_ETH_ADDRESS || "").toLowerCase(),
      (import.meta.env.VITE_BASE_WRAPPED_USDC_ADDRESS || "").toLowerCase(),
    ].filter(Boolean);

    for (const cached of cachedTokens) {
      if (cached.contractAddress === "ETH") continue;
      const lowerAddr = cached.contractAddress.toLowerCase();

      // Skip shielded FHE tokens — their transparent balanceOf throws "execution reverted"
      // and their encrypted balances are handled separately in Home.tsx UI.
      if (shieldedAddresses.includes(lowerAddr)) continue;

      if (!rawSet.has(lowerAddr)) {
        try {
          // Explicitly query ERC20 balanceOf(address) signature: 0x70a08231
          const data = "0x70a08231000000000000000000000000" + address.toLowerCase().replace("0x", "");
          const result = await this.call("eth_call", [{
            to: cached.contractAddress,
            data: data
          }, "latest"]);

          if (result && result !== "0x") {
            activeTokensRaw.push({
              contractAddress: cached.contractAddress,
              tokenBalance: BigInt(result).toString()
            });
          }
        } catch (e) {
          // Token query failed or invalid contract
        }
      }
    }

    const activeTokens = activeTokensRaw.filter(t => {
      try {
        const bal = BigInt(t.tokenBalance ?? 0);
        // Retain tokens that have positive balances OR are specifically cached by the user
        return bal > 0n || tokenCacheObj.hasToken(this.network_id, (t.contractAddress || "").toLowerCase());
      } catch {
        return false;
      }
    });

    // ── Alchemy Spam Classification ──
    // Only run on mainnet networks (testnet contracts are not in Alchemy's spam DB)
    // Uses Alchemy's isSpamContract API — checks their curated spam/scam database
    const MAINNET_IDS = [NetworkId.Ethereum_Mainnet, NetworkId.Arbitrum_One, NetworkId.Base_Mainnet];
    const isMainnet = MAINNET_IDS.includes(this.network_id);
    const alchemySpamResults = new Map<string, boolean>();

    if (this.alchemy && isMainnet && activeTokens.length > 0) {
      try {
        // Skip tokens that are already in the user's cache (trusted / manually imported)
        const tokensToCheck = activeTokens.filter((t) => {
          const addr = (t.contractAddress || "").toLowerCase();
          return !tokenCacheObj.hasToken(this.network_id, addr);
        });

        if (tokensToCheck.length > 0) {
          const spamChecks = await Promise.all(
            tokensToCheck.map(async (t) => {
              try {
                const result = await this.alchemy!.nft.isSpamContract(t.contractAddress);
                return { address: t.contractAddress, isSpam: result };
              } catch {
                return { address: t.contractAddress, isSpam: false };
              }
            })
          );
          const alchemySpamMap = new Map(spamChecks.map(s => [s.address.toLowerCase(), s.isSpam]));
          for (const [addr, isSpam] of alchemySpamMap) {
            alchemySpamResults.set(addr, !!isSpam);
          }
          const flagged = spamChecks.filter(s => s.isSpam);
          if (flagged.length > 0) {
          }
        }
      } catch (e) {
      }
    }

    const processedTokens = await Promise.all(
      activeTokens.map(async (t): Promise<TokenBalance> => {
        const contract = t.contractAddress.toLowerCase();
        let decimals = 18;

        if (tokenCacheObj.hasToken(this.network_id, contract)) {
          const cached = tokenCacheObj.getToken(this.network_id, contract)!;
          decimals = cached.decimals ?? 18;
        } else {
          try {
            const metadata = await this.getTokenMetadata(tokenCacheObj, contract);
            decimals = metadata.decimals;
          } catch (err) {
          }
        }

        return {
          contractAddress: contract,
          tokenBalance: this.formatTokenAmount(BigInt(t.tokenBalance ?? 0), decimals),
          isNative: false,
          isAlchemySpam: alchemySpamResults.get(contract) ?? false,
        };
      })
    );

    const nativeSymbol = this.currency_symbol || "ETH";
    const nativeItem: TokenCacheItem = {
      name: nativeSymbol === "ETH" ? "Ethereum" : nativeSymbol,
      symbol: nativeSymbol,
      decimals: 18,
      logoSrc: "",  // Logo resolved dynamically by getTokenLogoUrl via symbol lookup
      contractAddress: "ETH",
    };
    // Always update native token cache to reflect current network's currency
    tokenCacheObj.setToken(this.network_id, nativeItem);

    const nativeBalanceData: TokenBalance = {
      contractAddress: "ETH",
      tokenBalance: this.formatTokenAmount(BigInt(nativeBalance), 18),
      isNative: true,
    };

    return [nativeBalanceData, ...processedTokens];
  }


  /**
   * Sign a transaction locally, then get it onto the network in a context that outlives
   * this popup.
   *
   * @returns The hash, the nonce, and a `wait()` that resolves with the receipt — the same
   *          surface `Wallet.sendTransaction` returns, so callers do not branch on which
   *          path was taken.
   */
  private async signAndBroadcast(
    connectedWallet: import("ethers").Wallet | import("ethers").HDNodeWallet,
    txRequest: TransactionRequest,
    meta: { from: string; to: string; value: string }
  ): Promise<{ hash: string; nonce: number; wait: () => Promise<{ status: number | null } | null> }> {
    const worker = (globalThis as { chrome?: typeof chrome }).chrome?.runtime;
    const canHandOff = !!worker?.id && typeof worker.sendMessage === "function" && !!this.rpc_url;

    if (!canHandOff) {
      const sent = await connectedWallet.sendTransaction(txRequest);
      return { hash: sent.hash, nonce: sent.nonce, wait: () => sent.wait() };
    }

    // `populateTransaction` fills nonce, chainId, gas and fee fields, so the signed blob is
    // complete and the worker only has to relay bytes.
    const populated = await connectedWallet.populateTransaction(txRequest);
    const rawTx = await connectedWallet.signTransaction(populated);

    let hash: string;
    try {
      const reply = await worker.sendMessage({
        type: "BROADCAST_TX",
        rawTx,
        networkId: Number(this.network_id),
        rpcUrl: this.rpc_url,
        meta,
      }) as { success?: boolean; hash?: string; error?: string } | undefined;

      if (!reply?.success || !reply.hash) throw new Error(reply?.error || "Broadcast failed");
      hash = reply.hash;
    } catch (e) {
      // The worker may be restarting, or the message channel may be unavailable. The
      // transaction is signed but definitely not sent, so sending it from here is safe —
      // and better than failing a send the user already approved.
      const message = e instanceof Error ? e.message : String(e);
      if (/already known|nonce too low|replacement/i.test(message)) throw e;

      const sent = await connectedWallet.sendTransaction(txRequest);
      return { hash: sent.hash, nonce: sent.nonce, wait: () => sent.wait() };
    }

    const nonce = Number(populated.nonce ?? 0);
    return {
      hash,
      nonce,
      // The worker is already polling for this receipt and will notify on its own. Waiting
      // here as well is for the UI in front of the user right now; if this popup closes,
      // the worker's copy of the job carries on regardless.
      wait: () => this.waitForTransaction(hash) as Promise<{ status: number | null } | null>,
    };
  }

  /**
   * Get balance for a single ERC20 token
   */
  async getTokenBalance(tokenAddress: string, walletAddress: string): Promise<string> {
    try {
      const ethers = await import("ethers");
      const ERC20_ABI = [
        "function balanceOf(address owner) view returns (uint256)",
        "function decimals() view returns (uint8)"
      ];

      const provider = new ethers.JsonRpcProvider(this.rpc_url);
      const contract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
      const [balance, decimals] = await Promise.all([
        contract.balanceOf(walletAddress),
        contract.decimals()
      ]);

      return this.formatTokenAmount(balance, decimals);
    } catch (error) {
      return "0";
    }
  }

  async getTokenPrices(contractAddresses: string[]): Promise<{ [key: string]: number }> {
    try {
      const prices: { [key: string]: number } = {};

      // Known identifiers for mainnet pegging (CoinGecko IDs)
      const mappedIds = new Set<string>();
      const addressesToFetchFromCG: string[] = [];

      // eToken addresses (ignore fetching)
      const eTokenAddresses = [
        "0xfff9976742d46cc05630d1f6ebab18b2324d6b14", // eETH (official)
        "0x2035f9228e160243be8e07973715c929845e445e", // eUSDC (official)
        "0xfff9976782d46cc05630d1f6ebab18b2324d6b14", // Old/test eETH variant
      ].map(a => a.toLowerCase());

      // Define lists of testnet and FHE token variants mapped to real assets
      const ethRelated = [
        "eth",
        "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        (import.meta.env.VITE_SEPOLIA_WETH_ADDRESS || "").toLowerCase(),
        (import.meta.env.VITE_ARB_SEPOLIA_WETH_ADDRESS || "").toLowerCase(),
        (import.meta.env.VITE_BASE_SEPOLIA_WETH_ADDRESS || "").toLowerCase(),
        (import.meta.env.VITE_WRAPPED_ETH_ADDRESS || "").toLowerCase(), // cETH Sepolia
        (import.meta.env.VITE_ARB_WRAPPED_ETH_ADDRESS || "").toLowerCase(), // cETH Arb
        (import.meta.env.VITE_BASE_WRAPPED_ETH_ADDRESS || "").toLowerCase(), // cETH Base
      ].filter(Boolean);

      const usdcRelated = [
        "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238", // Sepolia USDC
        (import.meta.env.VITE_ARB_SEPOLIA_USDC_ADDRESS || "").toLowerCase(),
        (import.meta.env.VITE_BASE_SEPOLIA_USDC_ADDRESS || "").toLowerCase(),
        (import.meta.env.VITE_WRAPPED_USDC_ADDRESS || "").toLowerCase(), // cUSDC Sepolia
        (import.meta.env.VITE_ARB_WRAPPED_USDC_ADDRESS || "").toLowerCase(), // cUSDC Arb
        (import.meta.env.VITE_BASE_WRAPPED_USDC_ADDRESS || "").toLowerCase(), // cUSDC Base
      ].filter(Boolean);

      const chainlinkRelated = [
        "0x779877a7b0d9e8603169ddbd7836e478b4624789" // Chainlink Sepolia
      ].filter(Boolean);

      // Map incoming addresses to CoinGecko IDs
      for (const rawAddr of contractAddresses) {
        const addr = rawAddr.toLowerCase();

        if (eTokenAddresses.includes(addr)) continue;

        if (ethRelated.includes(addr)) {
          mappedIds.add('ethereum');
        } else if (usdcRelated.includes(addr)) {
          mappedIds.add('usd-coin');
        } else if (chainlinkRelated.includes(addr)) {
          mappedIds.add('chainlink');
        } else {
          // If not mapped, only query standard contract addresses on mainnet
          if (this.network_id === NetworkId.Ethereum_Mainnet) {
            addressesToFetchFromCG.push(addr);
          }
        }
      }

      // Fetch pegged prices for known assets
      if (mappedIds.size > 0) {
        try {
          const idsParam = Array.from(mappedIds).join(',');
          const res = await fetchWithTimeout(`${getCoinGeckoBase()}/simple/price?ids=${idsParam}&vs_currencies=usd`, {}, 10_000);
          const json = await res.json();

          // Distribute the pegged prices back to all requesting testnet/FHE addresses
          for (const rawAddr of contractAddresses) {
            const addr = rawAddr.toLowerCase();
            if (ethRelated.includes(addr) && json.ethereum?.usd) {
              prices[addr] = json.ethereum.usd;
              if (addr === "eth") prices["ETH"] = json.ethereum.usd;
            } else if (usdcRelated.includes(addr) && json['usd-coin']?.usd) {
              prices[addr] = json['usd-coin'].usd;
            } else if (chainlinkRelated.includes(addr) && json.chainlink?.usd) {
              prices[addr] = json.chainlink.usd;
            }
          }
        } catch (e) {
        }
      }

      // Fetch random mainnet tokens using original contract address endpoint
      if (addressesToFetchFromCG.length > 0) {
        try {
          const platform = "ethereum";
          const addrStr = addressesToFetchFromCG.join(",");
          const url = `${getCoinGeckoBase()}/simple/token_price/${platform}?contract_addresses=${addrStr}&vs_currencies=usd`;
          const res = await fetchWithTimeout(url, {}, 10_000);
          const json = await res.json();

          for (const [addr, priceData] of Object.entries(json)) {
            const pd = priceData as { usd?: number };
            if (pd.usd) {
              prices[addr.toLowerCase()] = pd.usd;
            }
          }
        } catch (e) {
        }
      }

      return prices;

    } catch (err) {
      // Return empty object so flow continues without crashing
      return {};
    }
  }

  async getHistory(address: string, tokenCacheObj: TokenCache | undefined, toBlock: string = "latest"): Promise<{ history: TransactionHistory[], nextBlock?: string }> {
    if (!tokenCacheObj) return { history: [] };
    if (!this.alchemy && !this.isAlchemyConfigured()) {
      // ── Custom RPC / Non-Alchemy Fallback ──────────────────────────────────────
      // Scan last N blocks via eth_getLogs for ERC20 Transfer events and
      // eth_getBlockByNumber for native ETH transactions.
      try {
        const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
        const currentBlockHex = await this.call("eth_blockNumber", []);
        const currentBlock = parseInt(currentBlockHex, 16);
        const SCAN_DEPTH = 10000;
        const fromBlock = Math.max(0, currentBlock - SCAN_DEPTH);
        const fromHex = "0x" + fromBlock.toString(16);

        const paddedAddress = "0x000000000000000000000000" + address.toLowerCase().replace("0x", "");

        // Fetch incoming and outgoing ERC20 Transfer events
        const [logsIn, logsOut] = await Promise.all([
          this.call("eth_getLogs", [{
            fromBlock: fromHex, toBlock: "latest",
            topics: [TRANSFER_TOPIC, null, paddedAddress]
          }]).catch(() => [] as any[]),
          this.call("eth_getLogs", [{
            fromBlock: fromHex, toBlock: "latest",
            topics: [TRANSFER_TOPIC, paddedAddress, null]
          }]).catch(() => [] as any[]),
        ]);

        const explorerBase = (this.explorer_url || "").replace(/\/+$/, "") || "https://etherscan.io";
        const history: TransactionHistory[] = [];
        const seenHashes = new Set<string>();

        // Also get a small sample of native ETH txs from recent blocks
        // We scan a subset (last 20 blocks) to avoid huge payloads
        const nativeScanEnd = currentBlock;
        const nativeScanStart = Math.max(0, currentBlock - 20);
        for (let b = nativeScanEnd; b >= nativeScanStart; b--) {
          try {
            const block = await this.call("eth_getBlockByNumber", ["0x" + b.toString(16), true]);
            if (!block || !Array.isArray(block.transactions)) continue;
            const timestamp = new Date(parseInt(block.timestamp, 16) * 1000).toISOString();
            for (const tx of block.transactions) {
              const txFrom = (tx.from || "").toLowerCase();
              const txTo = (tx.to || "").toLowerCase();
              if (txFrom !== address.toLowerCase() && txTo !== address.toLowerCase()) continue;
              if (seenHashes.has(tx.hash)) continue;
              seenHashes.add(tx.hash);
              const valueWei = BigInt(tx.value || "0x0");
              const valueFmt = this.formatTokenAmount(valueWei, 18);
              history.push({
                hash: tx.hash,
                from: tx.from || "",
                to: tx.to || "",
                contractAddress: "ETH",
                value: valueFmt,
                timestamp,
                blockNum: "0x" + b.toString(16),
                isNative: true,
                status: "Success",
                explorerUrl: `${explorerBase}/tx/${tx.hash}`,
                isShielded: false,
                methodLabel: txTo === address.toLowerCase() ? "Receive" : "Transfer",
                assetSymbol: this.currency_symbol,
              });
            }
          } catch { /* skip bad block */ }
        }

        // Process ERC20 logs
        const allErcLogs = [...(logsIn || []), ...(logsOut || [])];
        for (const log of allErcLogs) {
          if (!log.transactionHash || seenHashes.has(log.transactionHash)) continue;
          seenHashes.add(log.transactionHash);

          const fromAddr = log.topics[1] ? "0x" + log.topics[1].slice(26) : "0x";
          const toAddr = log.topics[2] ? "0x" + log.topics[2].slice(26) : "0x";
          const contractLower = (log.address || "").toLowerCase();

          // A chain with no indexer behind it gives us the raw log and nothing else, so
          // the token has to be asked what it is. Reading it once and caching costs three
          // eth_calls the first time an unfamiliar token appears; skipping it prints the
          // amount at the wrong scale and with no ticker beside it.
          let meta = tokenCacheObj?.getToken(this.network_id, contractLower);
          if (!meta) {
            meta = await this.getTokenMetadata(tokenCacheObj, contractLower).catch(() => undefined);
          }

          let valueStr = "0";
          try {
            const raw = BigInt(log.data);
            valueStr = this.formatTokenAmount(raw, meta?.decimals ?? 18);
          } catch { /* leave 0 */ }

          // Get block timestamp
          let timestamp = new Date().toISOString();
          try {
            const blk = await this.call("eth_getBlockByNumber", [log.blockNumber, false]);
            if (blk?.timestamp) timestamp = new Date(parseInt(blk.timestamp, 16) * 1000).toISOString();
          } catch { /* skip */ }

          history.push({
            hash: log.transactionHash,
            from: fromAddr,
            to: toAddr,
            contractAddress: (log.address || "").toLowerCase(),
            value: valueStr,
            timestamp,
            blockNum: log.blockNumber || "0x0",
            isNative: false,
            status: "Success",
            explorerUrl: `${explorerBase}/tx/${log.transactionHash}`,
            isShielded: false,
            methodLabel: toAddr.toLowerCase() === address.toLowerCase() ? "Receive" : "Transfer",
            assetSymbol: meta?.symbol,
          });
        }

        // Sort descending by timestamp and return
        history.sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));
        return { history: history.slice(0, 50) };
      } catch (err) {
        return { history: [] };
      }
    }

    try {
      const category: AssetTransfersCategory[] = [AssetTransfersCategory.EXTERNAL, AssetTransfersCategory.ERC20];
      // Most L2s (Arbitrum, Base) do not support the "internal" category for getAssetTransfers on standard Alchemy tiers
      if (this.network_id === NetworkId.Ethereum_Mainnet || this.network_id === NetworkId.Ethereum_Sepolia) {
        category.push(AssetTransfersCategory.INTERNAL);
      }

      const optionsBase = {
        fromBlock: "0x0",
        toBlock: toBlock,
        category: category,
        withMetadata: true as const,
        excludeZeroValue: false,
        maxCount: 100,
        order: SortingOrder.DESCENDING
      };

      // Every confidential wrapper on this network, not just the two in .env. History has
      // to recognise all of them or a shielded ERC-20 transfer is rendered as a plain
      // ~7984 token movement — publishing an amount that is supposed to be encrypted.
      const shieldedContracts = this.isFheCapable()
        ? await this.getKnownWrapperSet().catch(() => new Set<string>())
        : new Set<string>();

      const promises: Promise<unknown>[] = [];

      // 1. Alchemy Fetches (Sent & Received normal transfers)
      if (this.alchemy) {
        promises.push(this.alchemy.core.getAssetTransfers({ ...optionsBase, fromAddress: address }).catch(e => { return { transfers: [] }; }));
        promises.push(this.alchemy.core.getAssetTransfers({ ...optionsBase, toAddress: address }).catch(e => { return { transfers: [] }; }));
      } else {
        // Fallback to raw call if SDK isn't happy but URL works
        // The SDK converts `maxCount` to hex on the way out; a raw JSON-RPC call does not,
        // and Alchemy answers a decimal with "Invalid hex string: 100" — which the catch
        // below turned into an empty history rather than an error anyone could see.
        const rawOptions = { ...optionsBase, maxCount: "0x" + optionsBase.maxCount.toString(16) };
        promises.push(this.call("alchemy_getAssetTransfers", [{ ...rawOptions, fromAddress: address }]).then(r => (r as { transfers?: unknown[] }) ?? { transfers: [] }).catch(() => { return { transfers: [] }; }));
        promises.push(this.call("alchemy_getAssetTransfers", [{ ...rawOptions, toAddress: address }]).then(r => (r as { transfers?: unknown[] }) ?? { transfers: [] }).catch(() => { return { transfers: [] }; }));
      }

      // 2. Direct eth_getLogs for incoming FHE ConfidentialTransfers
      const isFheNetwork = this.network_id === NetworkId.Ethereum_Sepolia || this.network_id === NetworkId.Arbitrum_Sepolia || this.network_id === NetworkId.Base_Sepolia;
      if (isFheNetwork) {
        const fheContracts = [...shieldedContracts];

        if (fheContracts.length > 0) {
          promises.push((async () => {
            try {
              const { id, zeroPadValue } = await import("ethers");
              const transferTopic = id("ConfidentialTransfer(address,address)");
              const paddedAddress = zeroPadValue(address, 32);

              const latestBlockHex = toBlock === "latest" ? await this.call("eth_blockNumber", []) : toBlock;
              let currentBlock = parseInt(latestBlockHex, 16);
              // Fetch at most the last 100 blocks, in 10-block chunks
              const targetOldestBlock = Math.max(0, currentBlock - 100);
              let allIncomingLogs: Array<{ blockNumber: string; transactionHash: string; address: string; topics: string[] }> = [];

              while (currentBlock > targetOldestBlock && allIncomingLogs.length < 100) {
                const chunkStart = Math.max(targetOldestBlock, currentBlock - 9);
                const fromHex = "0x" + chunkStart.toString(16);
                const toHex = "0x" + currentBlock.toString(16);

                try {
                  const chunkLogs = await this.call("eth_getLogs", [{
                    fromBlock: fromHex,
                    toBlock: toHex,
                    address: fheContracts,
                    topics: [transferTopic, null, paddedAddress]
                  }]);

                  if (chunkLogs && chunkLogs.length > 0) {
                    allIncomingLogs = [...allIncomingLogs, ...chunkLogs];
                  }
                } catch (chunkErr) {
                  // If a chunk fails, we just stop fetching older logs to prevent spam and return what we have
                  break;
                }

                currentBlock = chunkStart - 1;
              }

              return { incomingFheLogs: allIncomingLogs.slice(-100) };
            } catch (e) {
              return { incomingFheLogs: [] };
            }
          })());
        }
      }

      // Wait for all data
      const results = await Promise.all(promises);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Alchemy SDK response shapes vary
      const sentRes = results[0] as { transfers?: any[] };
      const receivedRes = results[1] as { transfers?: any[] };
      const fheLogsRes = results.length > 2
        ? (results[2] as { incomingFheLogs?: any[] })
        : { incomingFheLogs: [] as any[] };

      let allTransfers = [
        ...(sentRes.transfers || []),
        ...(receivedRes.transfers || [])
      ];

      // Format Alchemy Transfers
      const history: TransactionHistory[] = [];
      let explorerBase = this.explorer_url || "https://etherscan.io";
      if (!this.explorer_url) {
        if (this.network_id === NetworkId.Ethereum_Sepolia) explorerBase = "https://sepolia.etherscan.io";
        else if (this.network_id === NetworkId.Arbitrum_One) explorerBase = "https://arbiscan.io";
        else if (this.network_id === NetworkId.Arbitrum_Sepolia) explorerBase = "https://sepolia.arbiscan.io";
        else if (this.network_id === NetworkId.Base_Mainnet) explorerBase = "https://basescan.org";
        else if (this.network_id === NetworkId.Base_Sepolia) explorerBase = "https://sepolia.basescan.org";
      }

      // Known Uniswap V3 SwapRouter addresses (for swap detection in history)
      const SWAP_ROUTERS = new Set([
        "0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45", // Uniswap V3 SwapRouter02 Ethereum Mainnet & Arbitrum
        "0x2626664c2603336e57b271c5c0b26f421741e481", // Uniswap V3 SwapRouter02 Base
        "0x3bfa4769fb09eefc5a80d6e87c3b9c650f7ae48e", // Uniswap V3 SwapRouter02 Sepolia
        "0x101f443b4d1b059569d643917553c771e1b9663e", // Uniswap V3 SwapRouter02 Arb Sepolia
      ]);
      // Known WETH addresses (for wrap/unwrap detection)
      const WETH_ADDRESSES = new Set([
        "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", // WETH Mainnet
        "0x82af49447d8a07e3bd95bd0d56f35241523fbab1", // WETH Arbitrum
        "0x4200000000000000000000000000000000000006", // WETH Base
        "0xfff9976782d46cc05630d1f6ebab18b2324d6b14", // WETH Sepolia
        "0x980b62da83eff3d4576c647993b0c1d7faf17c73", // WETH Arb Sepolia
      ]);

      for (const tx of allTransfers) {
        const isNative = (tx.category === "external" || tx.category === "internal");

        // CRITICAL FIX: If external, the contract address shouldn't be hardcoded to "ETH", it should be where the tx was sent to (tx.to)!
        let contractAddress = tx.rawContract?.address?.toLowerCase();
        if (!contractAddress) {
          contractAddress = isNative ? (tx.to?.toLowerCase() ?? "ETH") : "ETH";
        }

        // A token someone sends us has never been held before, so it is not in the cache
        // the row is named from. The transfer already carries the symbol and the decimals
        // the indexer resolved, so record them: without this the arrival rendered as a
        // number with no asset next to it, and read as nothing having arrived.
        //
        // `rawContract.decimal` is authoritative here — assuming 18 would misstate a
        // 6-decimal token by a factor of a trillion in every later balance read.
        if (!isNative && contractAddress !== "eth" && tx.asset && !tokenCacheObj.hasToken(this.network_id, contractAddress)) {
          const decimals = Number.parseInt(tx.rawContract?.decimal ?? "0x12", 16);
          const basicItem: TokenCacheItem = {
            name: tx.asset,
            symbol: tx.asset,
            decimals: Number.isFinite(decimals) && decimals >= 0 && decimals <= 36 ? decimals : 18,
            logoSrc: "",
            contractAddress
          };
          tokenCacheObj.setToken(this.network_id, basicItem);
        }

        const isShielded = !!contractAddress && shieldedContracts.has(contractAddress);

        // On a confidential wrapper the ERC-20 Transfer event deliberately carries a fixed
        // activity indicator (~7984.0001) instead of the real amount, so explorers can show
        // activity without leaking value. Rendering it as an amount would be a lie, so any
        // erc20-category movement on these contracts is reported as encrypted.
        //
        // The native legs are different: the ETH deposited when shielding and the ETH paid
        // out when claiming are genuinely public, and their values are real.
        const isIndicatorTransfer = isShielded && tx.category === "erc20";
        const hasRealValue = !!tx.value && Number(tx.value) > 0;

        const finalValue = isShielded
          ? (isIndicatorTransfer || !hasRealValue ? "Encrypted" : tx.value.toString())
          : (tx.value?.toString() || "0");

        let methodLabel = "Transfer";
        if (isShielded) {
          if (tx.category === "external" && hasRealValue) methodLabel = "Shield";
          else if (tx.category === "internal" && hasRealValue) methodLabel = "Unshield Claim";
          else methodLabel = "Confidential Transfer";
        } else if (tx.to && SWAP_ROUTERS.has(tx.to.toLowerCase())) {
          methodLabel = "Swap";
        } else if (tx.to && WETH_ADDRESSES.has(tx.to.toLowerCase()) && tx.category === "external") {
          methodLabel = "Wrap";
        } else if (tx.from && WETH_ADDRESSES.has(tx.from.toLowerCase()) && tx.category === "internal") {
          methodLabel = "Unwrap";
        } else if (!isNative && tx.category !== "erc20") {
          methodLabel = "Contract Call";
        }

        history.push({
          hash: tx.hash,
          from: tx.from,
          to: tx.to || "",
          contractAddress: contractAddress,
          value: finalValue,
          timestamp: tx.metadata?.blockTimestamp || new Date().toISOString(),
          blockNum: (tx as Record<string, unknown>).blockNum as string || "0x0",
          isNative: isNative,
          status: "Success",
          explorerUrl: `${explorerBase}/tx/${tx.hash}`,
          isShielded: isShielded,
          methodLabel: methodLabel,
          assetSymbol: typeof tx.asset === "string" ? tx.asset : undefined
        });
      }

      // Process FHE Logs (Incoming ConfidentialTransfers missing from Alchemy)
      if (fheLogsRes && fheLogsRes.incomingFheLogs && fheLogsRes.incomingFheLogs.length > 0) {
        for (const log of fheLogsRes.incomingFheLogs) {
          // Avoid duplicates (if user sent to themselves, Alchemy external caught it)
          if (history.find(h => h.hash === log.transactionHash)) continue;

          // Fetch Block for timestamp
          let timestamp = new Date().toISOString();
          try {
            const block = await this.call("eth_getBlockByNumber", [log.blockNumber, false]);
            if (block && block.timestamp) {
              const epoch = parseInt(block.timestamp, 16);
              timestamp = new Date(epoch * 1000).toISOString();
            }
          } catch (e) { }

          // Topic 1 is the sender
          const fromTopic = log.topics[1];
          const fromAddr = fromTopic ? "0x" + fromTopic.slice(26) : "Unknown";

          history.push({
            hash: log.transactionHash,
            from: fromAddr,
            to: address,
            contractAddress: log.address.toLowerCase(),
            value: "Encrypted",
            timestamp: timestamp,
            blockNum: log.blockNumber || "0x0",
            isNative: false,
            status: "Success",
            explorerUrl: `${explorerBase}/tx/${log.transactionHash}`,
            isShielded: true,
            methodLabel: "Shield Transfer"
          });
        }
      }

      // Sort combined history
      history.sort((a, b) => {
        const tA = a.timestamp;
        const tB = b.timestamp;
        return tA < tB ? 1 : tA > tB ? -1 : 0;
      });

      // Squeeze unique hashes and limit
      const uniqueObj: Record<string, boolean> = {};
      const uniqueHistory: TransactionHistory[] = [];
      let minBlockNum = Infinity;

      for (const h of history) {
        if (!uniqueObj[h.hash]) {
          uniqueObj[h.hash] = true;
          uniqueHistory.push(h);
        }
      }

      const paginated = uniqueHistory.slice(0, 50);
      let nextBlock: string | undefined = undefined;

      if (paginated.length === 50) {
        // Find lowest block number to continue from
        for (const tx of paginated) {
          const bNum = parseInt(tx.blockNum, 16);
          if (!isNaN(bNum) && bNum < minBlockNum) {
            minBlockNum = bNum;
          }
        }
        if (minBlockNum !== Infinity && minBlockNum > 1) {
          nextBlock = "0x" + (minBlockNum - 1).toString(16);
        }
      }

      return { history: paginated, nextBlock };

    } catch (err) {
      return { history: [] };
    }
  }

  async sendTransaction(
    account: Account,
    tx: {
      to: string;
      value?: string;
      gasLimit?: bigint;
      gasPrice?: string;
      data?: string;
      gasMultiplier?: number;
    },
    /**
     * Called with the hash the moment the transaction is broadcast, before it is mined.
     *
     * This method only returns once there is a receipt, so without this hook the caller
     * holds nothing for the entire mining window — the user watches a spinner with no hash
     * and no explorer link, and a popup closed in that window leaves no record of a
     * transaction that is already on-chain. The same applies when the transaction reverts:
     * the error thrown below would otherwise discard the hash of a real transaction.
     */
    onBroadcast?: (hash: string) => void
  ): Promise<string> {
    if (!this.rpc_url) throw new Error("RPC URL not set");
    if (!account.ethers_wallet) throw new Error("Account is missing ethers_wallet");

    const wallet = account.ethers_wallet;
    const { JsonRpcProvider, parseUnits } = await import("ethers");
    const provider = new JsonRpcProvider(this.rpc_url);
    const connectedWallet = wallet.connect(provider);

    const valueWei = tx.value ? parseUnits(tx.value, "ether") : 0n;

    const txRequest: TransactionRequest = {
      to: tx.to,
      value: valueWei,
      data: tx.data ?? "0x",
    };

    if (tx.gasLimit) {
      txRequest.gasLimit = tx.gasLimit;
    }

    if (tx.gasPrice) {
      txRequest.gasPrice = parseUnits(tx.gasPrice, "gwei");
    }

    // Apply Premium Gas Multiplier if given (for Slow/Standard/Fast user choice)
    if (tx.gasMultiplier && tx.gasMultiplier !== 1.0) {
      try {
        // Let ethers estimate the base gas price first
        const feeData = await provider.getFeeData();
        if (feeData.gasPrice) {
          // Multiply gas price for older networks
          const estimatedGasPrice = Number(feeData.gasPrice) * tx.gasMultiplier;
          txRequest.gasPrice = BigInt(Math.floor(estimatedGasPrice));
        } else if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
          // Multiply EIP-1559 fees for modern networks
          const estimatedMaxFee = Number(feeData.maxFeePerGas) * tx.gasMultiplier;
          const estimatedPriorityFee = Number(feeData.maxPriorityFeePerGas) * tx.gasMultiplier;
          txRequest.maxFeePerGas = BigInt(Math.floor(estimatedMaxFee));
          txRequest.maxPriorityFeePerGas = BigInt(Math.floor(estimatedPriorityFee));
        }
      } catch (e) {
      }
    }


    try {
      // Sign here, broadcast in the service worker.
      //
      // Signing must stay in the popup — the key only exists in this context, and moving
      // it would defeat the lock. Broadcasting must not: the popup can be dismissed at any
      // moment, and a `fetch` that dies with it takes an already-authorised transaction
      // with it. Splitting the two is what lets a send survive the window closing.
      //
      // Falls back to sending from here when no worker is reachable (dev server, tests),
      // where nothing outlives the page anyway.
      const sentTx = await this.signAndBroadcast(connectedWallet, txRequest, {
        from: await connectedWallet.getAddress(),
        to: tx.to,
        value: (txRequest.value ?? 0n).toString(),
      });

      // Hand the hash over before waiting. Everything after this point can take minutes,
      // and the transaction is already irreversible on the network.
      try {
        onBroadcast?.(sentTx.hash);
      } catch {
        // A UI callback throwing must not look like a failed transaction.
      }

      // Track as pending until confirmed
      this.pendingTransactions.set(sentTx.hash, {
        hash: sentTx.hash,
        nonce: sentTx.nonce,
        from: await connectedWallet.getAddress(),
        to: tx.to,
        value: (txRequest.value ?? 0n).toString(),
        data: tx.data ?? "0x",
        gasPrice: txRequest.gasPrice ? txRequest.gasPrice.toString() : undefined,
        maxFeePerGas: txRequest.maxFeePerGas ? txRequest.maxFeePerGas.toString() : undefined,
        maxPriorityFeePerGas: txRequest.maxPriorityFeePerGas ? txRequest.maxPriorityFeePerGas.toString() : undefined,
        timestamp: Date.now(),
        networkId: this.network_id,
      });

      const receipt = await sentTx.wait();

      // Remove from pending once confirmed
      this.pendingTransactions.delete(sentTx.hash);

      // Every cached balance now describes the state before this transaction. Announce it
      // before the revert check below: a reverted transaction still burned gas, so the
      // native balance moved either way and the screens are stale either way.
      notifyTxConfirmed({
        hash: sentTx.hash,
        networkId: Number(this.network_id),
        address: account.GetAddress() ?? undefined,
      });

      if (receipt && receipt.status === 0) {
        throw new Error(`Transaction reverted on-chain. TX: ${sentTx.hash}`);
      }

      return sentTx.hash;
    } catch (err) {

      const e = err as { info?: { error?: { message?: string } }; reason?: string; message?: string };
      const errorMsg = e.info?.error?.message || e.reason || e.message || String(err);

      if (errorMsg.includes("insufficient funds for gas * price + value") || errorMsg.includes("insufficient funds")) {
        throw new Error("Yetersiz Bakiye: Bu işlemi gerçekleştirmek ve ağ ücretlerini (gas fee) karşılamak için yeterli ETH'niz bulunmuyor.");
      }

      throw new Error(errorMsg);
    }
  }

  async waitForTransaction(txHash: string): Promise<unknown> {
    if (this.alchemy) {
      return this.alchemy.core.waitForTransaction(txHash);
    }
    let attempts = 0;
    while (attempts < 60) {
      try {
        const receipt = await this.call("eth_getTransactionReceipt", [txHash]);
        if (receipt && BigInt(receipt.blockNumber) > 0n) return receipt;
      } catch (e) { }
      await new Promise(r => setTimeout(r, 2000));
      attempts++;
    }
    throw new Error("Transaction confirmation timed out");
  }

  // --- PENDING TRANSACTION MANAGEMENT ---

  /** Get all pending transactions for the current network */
  getPendingTransactions(): PendingTransaction[] {
    return Array.from(this.pendingTransactions.values())
      .filter(ptx => ptx.networkId === this.network_id)
      .sort((a, b) => b.timestamp - a.timestamp);
  }

  /** Remove a pending transaction (after confirm/replace/drop) */
  removePendingTransaction(txHash: string): void {
    this.pendingTransactions.delete(txHash);
  }

  /** Check which pending txs have been confirmed and prune them.
   *  Also returns still-pending list. */
  async refreshPendingTransactions(): Promise<PendingTransaction[]> {
    const pending = this.getPendingTransactions();
    for (const ptx of pending) {
      try {
        const receipt = await this.call("eth_getTransactionReceipt", [ptx.hash]);
        if (receipt && receipt.blockNumber) {
          // Confirmed — remove from pending
          this.pendingTransactions.delete(ptx.hash);
        }
      } catch {
        // RPC error — keep in pending
      }
    }
    // Also prune any pending tx whose nonce has been superseded
    // (a replacement tx with the same nonce got confirmed)
    try {
      const remaining = this.getPendingTransactions();
      if (remaining.length > 0) {
        const fromAddr = remaining[0].from;
        const currentNonceHex = await this.call("eth_getTransactionCount", [fromAddr, "latest"]);
        const currentNonce = parseInt(currentNonceHex, 16);
        for (const ptx of remaining) {
          if (ptx.nonce < currentNonce) {
            // This nonce is already used on-chain — tx was replaced or confirmed
            this.pendingTransactions.delete(ptx.hash);
          }
        }
      }
    } catch {
      // Ignore nonce check errors
    }
    return this.getPendingTransactions();
  }

  /**
   * Speed up a pending transaction by re-sending with the same nonce
   * but with higher gas fees (multiplied by gasMultiplier, default 1.3x).
   */
  async speedUpTransaction(
    account: Account,
    originalTxHash: string,
    gasMultiplier: number = 1.3
  ): Promise<string> {
    const pendingTx = this.pendingTransactions.get(originalTxHash);
    if (!pendingTx) throw new Error("Pending transaction not found");
    if (!this.rpc_url) throw new Error("RPC URL not set");
    if (!account.ethers_wallet) throw new Error("Account is missing ethers_wallet");

    const wallet = account.ethers_wallet;
    const { JsonRpcProvider } = await import("ethers");
    const provider = new JsonRpcProvider(this.rpc_url);
    const connectedWallet = wallet.connect(provider);

    // Build replacement tx with same nonce but higher gas
    const txRequest: TransactionRequest = {
      to: pendingTx.to,
      value: BigInt(pendingTx.value),
      data: pendingTx.data,
      nonce: pendingTx.nonce, // SAME nonce — this is what replaces the tx
    };

    // Bump gas fees by multiplier
    const feeData = await provider.getFeeData();
    if (pendingTx.maxFeePerGas) {
      // EIP-1559: bump both maxFeePerGas and maxPriorityFeePerGas
      const origMaxFee = BigInt(pendingTx.maxFeePerGas);
      const origPriorityFee = BigInt(pendingTx.maxPriorityFeePerGas || "0");
      const networkMaxFee = feeData.maxFeePerGas || origMaxFee;
      const networkPriorityFee = feeData.maxPriorityFeePerGas || origPriorityFee;

      // Use the higher of (original * multiplier) or (current network fee * multiplier)
      const bumpedMaxFee = BigInt(Math.floor(Number(origMaxFee > networkMaxFee ? origMaxFee : networkMaxFee) * gasMultiplier));
      const bumpedPriorityFee = BigInt(Math.floor(Number(origPriorityFee > networkPriorityFee ? origPriorityFee : networkPriorityFee) * gasMultiplier));
      txRequest.maxFeePerGas = bumpedMaxFee;
      txRequest.maxPriorityFeePerGas = bumpedPriorityFee;
    } else {
      // Legacy: bump gasPrice
      const origGasPrice = BigInt(pendingTx.gasPrice || "0");
      const networkGasPrice = feeData.gasPrice || origGasPrice;
      const bumpedGasPrice = BigInt(Math.floor(Number(origGasPrice > networkGasPrice ? origGasPrice : networkGasPrice) * gasMultiplier));
      txRequest.gasPrice = bumpedGasPrice;
    }


    try {
      const sentTx = await connectedWallet.sendTransaction(txRequest);

      // Remove old pending, add new one
      this.pendingTransactions.delete(originalTxHash);
      this.pendingTransactions.set(sentTx.hash, {
        ...pendingTx,
        hash: sentTx.hash,
        gasPrice: txRequest.gasPrice?.toString(),
        maxFeePerGas: txRequest.maxFeePerGas?.toString(),
        maxPriorityFeePerGas: txRequest.maxPriorityFeePerGas?.toString(),
        timestamp: Date.now(),
      });

      return sentTx.hash;
    } catch (err) {
      const e = err as { info?: { error?: { message?: string } }; reason?: string; message?: string };
      const errorMsg = e.info?.error?.message || e.reason || e.message || String(err);
      throw new Error(`Speed-up failed: ${errorMsg}`);
    }
  }

  /**
   * Cancel a pending transaction by sending a 0-value self-transfer
   * with the same nonce but higher gas fees.
   */
  async cancelTransaction(
    account: Account,
    originalTxHash: string,
    gasMultiplier: number = 1.5
  ): Promise<string> {
    const pendingTx = this.pendingTransactions.get(originalTxHash);
    if (!pendingTx) throw new Error("Pending transaction not found");
    if (!this.rpc_url) throw new Error("RPC URL not set");
    if (!account.ethers_wallet) throw new Error("Account is missing ethers_wallet");

    const wallet = account.ethers_wallet;
    const { JsonRpcProvider } = await import("ethers");
    const provider = new JsonRpcProvider(this.rpc_url);
    const connectedWallet = wallet.connect(provider);

    const selfAddress = await connectedWallet.getAddress();

    // Cancel = 0 ETH self-transfer with same nonce + higher gas
    const txRequest: TransactionRequest = {
      to: selfAddress,          // Send to self
      value: 0n,                // Zero value
      data: "0x",               // No data
      nonce: pendingTx.nonce,   // SAME nonce — replaces the original tx
    };

    // Bump gas aggressively (1.5x default) so miners prefer this over original
    const feeData = await provider.getFeeData();
    if (pendingTx.maxFeePerGas) {
      const origMaxFee = BigInt(pendingTx.maxFeePerGas);
      const origPriorityFee = BigInt(pendingTx.maxPriorityFeePerGas || "0");
      const networkMaxFee = feeData.maxFeePerGas || origMaxFee;
      const networkPriorityFee = feeData.maxPriorityFeePerGas || origPriorityFee;

      txRequest.maxFeePerGas = BigInt(Math.floor(Number(origMaxFee > networkMaxFee ? origMaxFee : networkMaxFee) * gasMultiplier));
      txRequest.maxPriorityFeePerGas = BigInt(Math.floor(Number(origPriorityFee > networkPriorityFee ? origPriorityFee : networkPriorityFee) * gasMultiplier));
    } else {
      const origGasPrice = BigInt(pendingTx.gasPrice || "0");
      const networkGasPrice = feeData.gasPrice || origGasPrice;
      txRequest.gasPrice = BigInt(Math.floor(Number(origGasPrice > networkGasPrice ? origGasPrice : networkGasPrice) * gasMultiplier));
    }


    try {
      const sentTx = await connectedWallet.sendTransaction(txRequest);

      // Remove original pending tx
      this.pendingTransactions.delete(originalTxHash);

      // Don't add cancellation as pending — it's a throwaway self-transfer
      // Wait in background for confirmation and log it
      sentTx.wait().then(() => {
      }).catch((e) => {
      });

      return sentTx.hash;
    } catch (err) {
      const e = err as { info?: { error?: { message?: string } }; reason?: string; message?: string };
      const errorMsg = e.info?.error?.message || e.reason || e.message || String(err);
      throw new Error(`Cancel failed: ${errorMsg}`);
    }
  }

  // --- FHE / CONFIDENTIAL TOKEN METHODS ---
  //
  // Backed by FHERC20 wrappers (fhenix-confidential-contracts) on the three chains CoFHE
  // supports. Two unit systems are in play and must not be mixed up:
  //
  //   underlying units  — what the wrapped ERC20/ETH uses (e.g. 18 decimals for ETH)
  //   confidential units — what the encrypted euint64 balance uses (capped at 6 decimals)
  //
  // `shield*` takes underlying units. `unshield` and `confidentialTransfer` take
  // confidential units. `rate()` converts between them.

  /** Per-contract metadata cache; these values are immutable after deployment. */
  private shieldedMetaCache = new Map<string, ShieldedTokenMeta>();

  /** ABI subset of the FHERC20 wrappers the wallet drives. */
  private static readonly SHIELDED_ABI = [
    "function decimals() view returns (uint8)",
    "function rate() view returns (uint256)",
    "function symbol() view returns (string)",
    "function name() view returns (string)",
    "function underlying() view returns (address)",
    "function confidentialBalanceOf(address account) view returns (bytes32)",
    // Claims are keyed by `id`, not by the ciphertext handle — the two are different
    // values and both are needed to settle. See `UnshieldClaim`.
    "function getUserClaims(address user) view returns (tuple(bytes32 id, address to, bytes32 ctHash, uint64 decryptedAmount, bool claimed)[])",
    "function shieldNative(address to) payable returns (bytes32)",
    "function shieldWrappedNative(address to, uint256 value) returns (bytes32)",
    "function shield(address to, uint256 amount) returns (bytes32)",
    "function unshield(address from, address to, uint64 amount) returns (bytes32)",
    "function claimUnshielded(bytes32 id, uint64 decryptedAmount, bytes decryptionProof)",
    "function claimUnshieldedBatch(bytes32[] ids, uint64[] decryptedAmounts, bytes[] decryptionProofs)",
    // `externalEuint64` handle plus its batch proof, as two arguments. The old single
    // `InEuint64` struct is gone from cofhe-contracts and its digest is no longer valid.
    "function confidentialTransfer(address to, bytes32 encryptedAmount, bytes inputProof) returns (bytes32)",
  ];

  /** Cached `balanceOfIsIndicator()` result per token address. */
  private confidentialTokenCache = new Map<string, boolean>();

  /**
   * Whether a token is a confidential FHERC20 wrapper.
   *
   * Asks the contract itself via `balanceOfIsIndicator()` rather than matching against a
   * list of known addresses. Address lists go stale the moment wrappers are redeployed —
   * and a stale list means old wrappers leak back into the token list showing their
   * ~7984 activity counter as if it were a balance.
   *
   * Plain ERC-20s have no such function, so the call reverts and the answer is false.
   * Results are cached because the answer is fixed at deployment.
   */
  async isConfidentialToken(tokenAddress: string): Promise<boolean> {
    const key = tokenAddress.toLowerCase();
    const cached = this.confidentialTokenCache.get(key);
    if (cached !== undefined) return cached;

    // The registry answers for free; only addresses it has never heard of need probing.
    const known = await this.getKnownWrapperSet();
    if (known.has(key)) {
      this.confidentialTokenCache.set(key, true);
      return true;
    }

    const { Interface } = await import("ethers");
    const iface = new Interface(["function balanceOfIsIndicator() view returns (bool)"]);

    let result = false;
    try {
      const hex = await this.call("eth_call", [
        { to: tokenAddress, data: iface.encodeFunctionData("balanceOfIsIndicator", []) },
        "latest",
      ]);
      if (hex && hex !== "0x") {
        [result] = iface.decodeFunctionResult("balanceOfIsIndicator", hex) as unknown as [boolean];
      }
    } catch {
      // Not an FHERC20 — a plain token has no such function.
    }

    this.confidentialTokenCache.set(key, result);
    return result;
  }

  /**
   * Resolve {@link isConfidentialToken} for many addresses; returns the confidential ones.
   *
   * Anything the factory registry already knows about is answered for free. Only genuinely
   * unknown addresses are probed on-chain, and those probes go out as a single batched
   * request rather than one round trip per token.
   */
  async filterConfidentialTokens(tokenAddresses: string[]): Promise<Set<string>> {
    const found = new Set<string>();
    if (tokenAddresses.length === 0) return found;

    const known = await this.getKnownWrapperSet();
    const unknown: string[] = [];

    for (const address of tokenAddresses) {
      const key = address.toLowerCase();
      if (known.has(key)) {
        this.confidentialTokenCache.set(key, true);
        found.add(key);
        continue;
      }
      const cached = this.confidentialTokenCache.get(key);
      if (cached !== undefined) {
        if (cached) found.add(key);
        continue;
      }
      unknown.push(key);
    }

    if (unknown.length === 0) return found;

    // Wrappers from superseded deployments are not in the current registry, so they still
    // need the standard's own detection hook — batched, so this stays one request.
    const { Interface } = await import("ethers");
    const iface = new Interface(["function balanceOfIsIndicator() view returns (bool)"]);
    const data = iface.encodeFunctionData("balanceOfIsIndicator", []);

    const results = await this.callBatch(
      unknown.map((to) => ({ method: "eth_call", params: [{ to, data }, "latest"] }))
    );

    unknown.forEach((key, i) => {
      let isConfidential = false;
      const hex = results[i];
      if (hex && hex !== "0x") {
        try {
          [isConfidential] = iface.decodeFunctionResult("balanceOfIsIndicator", hex) as unknown as [boolean];
        } catch {
          // Not an FHERC20 — a plain token returns something undecodable or reverts.
        }
      }
      this.confidentialTokenCache.set(key, isConfidential);
      if (isConfidential) found.add(key);
    });

    return found;
  }

  /** ABI subset of {ArfheWrapperFactory}. */
  private static readonly FACTORY_ABI = [
    "function wrapperFor(address underlying) view returns (address)",
    "function wrappersFor(address[] underlyings) view returns (address[])",
    "function createWrapper(address underlying) returns (address)",
    "function wrapperCount() view returns (uint256)",
    "function wrappersAt(uint256 offset, uint256 limit) view returns (address[])",
  ];

  /** Resolved underlying -> wrapper, cached per network instance. */
  private wrapperCache = new Map<string, string>();

  /** Address of the wrapper factory on this network, or "" when none is configured. */
  private factoryAddress(): string {
    const env = import.meta.env;
    if (this.network_id === NetworkId.Arbitrum_Sepolia) return env.VITE_ARB_WRAPPER_FACTORY_ADDRESS || "";
    if (this.network_id === NetworkId.Base_Sepolia) return env.VITE_BASE_WRAPPER_FACTORY_ADDRESS || "";
    if (this.network_id === NetworkId.Ethereum_Sepolia) return env.VITE_WRAPPER_FACTORY_ADDRESS || "";
    return "";
  }

  /**
   * Look up the confidential wrapper for an ERC-20, if one has been deployed.
   *
   * Shielding is per-token: each ERC-20 needs its own wrapper holding the deposits that
   * back its encrypted balances. The factory is the registry of those wrappers, which is
   * what lets the wallet offer shielding for arbitrary tokens instead of a fixed pair.
   *
   * @returns The wrapper address, or null when the token has none yet.
   */
  async getWrapperFor(underlyingAddress: string): Promise<string | null> {
    if (!this.isFheCapable()) return null;

    const factory = this.factoryAddress();
    if (!factory) return null;

    const key = underlyingAddress.toLowerCase();
    const cached = this.wrapperCache.get(key);
    if (cached !== undefined) return cached || null;

    const { Interface, ZeroAddress, getAddress } = await import("ethers");
    const iface = new Interface(Network.FACTORY_ABI);

    try {
      const resultHex = await this.call("eth_call", [
        { to: factory, data: iface.encodeFunctionData("wrapperFor", [underlyingAddress]) },
        "latest",
      ]);
      if (!resultHex || resultHex === "0x") return null;

      const [wrapper] = iface.decodeFunctionResult("wrapperFor", resultHex);
      const address = wrapper === ZeroAddress ? "" : getAddress(wrapper as string);
      this.wrapperCache.set(key, address);
      return address || null;
    } catch {
      return null;
    }
  }

  /** Resolve many tokens in one call — used to annotate a whole token list. */
  async getWrappersFor(underlyingAddresses: string[]): Promise<Map<string, string>> {
    const found = new Map<string, string>();
    if (!this.isFheCapable() || underlyingAddresses.length === 0) return found;

    const factory = this.factoryAddress();
    if (!factory) return found;

    const { Interface, ZeroAddress, getAddress } = await import("ethers");
    const iface = new Interface(Network.FACTORY_ABI);

    try {
      const resultHex = await this.call("eth_call", [
        { to: factory, data: iface.encodeFunctionData("wrappersFor", [underlyingAddresses]) },
        "latest",
      ]);
      if (!resultHex || resultHex === "0x") return found;

      const [wrappers] = iface.decodeFunctionResult("wrappersFor", resultHex);
      (wrappers as string[]).forEach((wrapper, i) => {
        const key = underlyingAddresses[i].toLowerCase();
        const address = wrapper === ZeroAddress ? "" : getAddress(wrapper);
        this.wrapperCache.set(key, address);
        if (address) found.set(key, address);
      });
    } catch {
      // Registry unavailable — callers fall back to "no wrapper", which only hides the
      // shielding option rather than breaking the token list.
    }

    return found;
  }

  /** Wrapper addresses shipped in .env for this network: the native one, plus USDC. */
  private configuredWrappers(): { native: string; extra: string[] } {
    const env = import.meta.env;
    let native = "";
    let usdc = "";

    if (this.network_id === NetworkId.Arbitrum_Sepolia) {
      native = env.VITE_ARB_WRAPPED_ETH_ADDRESS || "";
      usdc = env.VITE_ARB_WRAPPED_USDC_ADDRESS || "";
    } else if (this.network_id === NetworkId.Base_Sepolia) {
      native = env.VITE_BASE_WRAPPED_ETH_ADDRESS || "";
      usdc = env.VITE_BASE_WRAPPED_USDC_ADDRESS || "";
    } else if (this.network_id === NetworkId.Ethereum_Sepolia) {
      native = env.VITE_WRAPPED_ETH_ADDRESS || "";
      usdc = env.VITE_WRAPPED_USDC_ADDRESS || "";
    }

    return { native: native.toLowerCase(), extra: [usdc.toLowerCase()].filter(Boolean) };
  }

  /** Cached registry enumeration; wrappers are only ever added, never removed. */
  private registryWrappers: string[] | null = null;

  /**
   * Every wrapper the factory has ever deployed on this network.
   *
   * Enumerating the registry is what makes shielded balances discoverable at all. Deriving
   * the list from the tokens someone currently holds does not work: shielding the whole
   * balance leaves the public balance at zero, so the wrapper holding those funds would
   * drop out of the list precisely when it matters most.
   */
  private async listRegistryWrappers(): Promise<string[]> {
    if (this.registryWrappers) return this.registryWrappers;
    if (!this.isFheCapable()) return [];

    const factory = this.factoryAddress();
    if (!factory) return [];

    const { Interface } = await import("ethers");
    const iface = new Interface(Network.FACTORY_ABI);

    try {
      const countHex = await this.call("eth_call", [
        { to: factory, data: iface.encodeFunctionData("wrapperCount", []) },
        "latest",
      ]);
      if (!countHex || countHex === "0x") return [];

      const count = Number(BigInt(countHex));
      if (count === 0) {
        this.registryWrappers = [];
        return [];
      }

      // Page through the whole registry. Reading only the newest slice would be wrong:
      // creation is permissionless, so anyone can push a user's own wrapper out of a
      // trailing window and make their shielded balance disappear from the wallet. The
      // overall cap is a denial-of-service bound, not a correctness one, and the pages go
      // out as one batched request.
      const PAGE = 500;
      const MAX = 5000;
      const total = Math.min(count, MAX);

      const pageCalls = [];
      for (let offset = 0; offset < total; offset += PAGE) {
        pageCalls.push({
          method: "eth_call",
          params: [
            { to: factory, data: iface.encodeFunctionData("wrappersAt", [offset, Math.min(PAGE, total - offset)]) },
            "latest",
          ],
        });
      }

      const pages = await this.callBatch(pageCalls);
      const all: string[] = [];
      for (const pageHex of pages) {
        if (!pageHex || pageHex === "0x") continue;
        try {
          const [addresses] = iface.decodeFunctionResult("wrappersAt", pageHex);
          all.push(...(addresses as string[]).map((a) => a.toLowerCase()));
        } catch {
          // Skip an unreadable page rather than dropping the whole registry.
        }
      }

      this.registryWrappers = all;
      return all;
    } catch {
      // An unreadable registry is not an empty one. Returning [] made every
      // factory-created wrapper drop out of the wallet until the next successful read,
      // which looks exactly like the tokens having been lost. Fall back to the last good
      // answer if this session has one, and do not cache the failure.
      return this.registryWrappers ?? [];
    }
  }

  /** Registry wrappers plus the ones configured in .env, lowercased. */
  /**
   * Every confidential wrapper on this network, for callers outside this class.
   *
   * The service worker needs it to keep a confidential arrival confidential: the wrapper
   * emits a standard ERC-20 `Transfer` carrying a fixed activity indicator rather than the
   * amount, and a notification reading "7984.0001 aeETH received" would be both wrong and
   * a claim about a balance that is supposed to be secret. Knowing which contracts those
   * are is what lets it say "a confidential transfer arrived" and stop there.
   *
   * Lower-cased, matching how the addresses are compared everywhere else.
   */
  async getConfidentialWrapperAddresses(): Promise<string[]> {
    if (!this.isFheCapable()) return [];
    try {
      return [...(await this.getKnownWrapperSet())].map((a) => a.toLowerCase());
    } catch {
      return [];
    }
  }

  private async getKnownWrapperSet(): Promise<Set<string>> {
    const { native, extra } = this.configuredWrappers();
    const registry = await this.listRegistryWrappers();
    return new Set([native, ...extra, ...registry].filter(Boolean));
  }

  /**
   * Every confidential token this account actually holds a balance in.
   *
   * Reads `confidentialBalanceOf` across the whole registry in one batched request and
   * keeps the wrappers whose handle is non-zero — a zero handle means no ciphertext was
   * ever created for this account, so there is nothing to decrypt and nothing to show.
   *
   * Decryption is the expensive part (each one is a round trip to the coprocessor), which
   * is why it happens only for wrappers that passed the handle check. The native wrapper is
   * always included so "Shielded ETH" stays visible as a target even at zero.
   *
   * Callers get metadata alongside the balance because every downstream screen needs it:
   * the symbol to label the row, the underlying to pair it with its public token, and the
   * confidential decimals to format amounts in the right unit system.
   */
  async getShieldedPortfolio(account: Account): Promise<ShieldedHolding[]> {
    if (!this.isFheCapable()) return [];

    const owner = account.GetAddress();
    if (!owner) return [];

    const { native } = this.configuredWrappers();
    const known = await this.getKnownWrapperSet();
    const wrappers = [...known];
    if (wrappers.length === 0) return [];

    const { Interface, ZeroAddress, getAddress } = await import("ethers");
    const iface = new Interface(Network.SHIELDED_ABI);
    const balanceData = iface.encodeFunctionData("confidentialBalanceOf", [owner]);

    const handles = await this.callBatch(
      wrappers.map((to) => ({ method: "eth_call", params: [{ to, data: balanceData }, "latest"] }))
    );

    // `callBatch` reports a per-item failure as null, which is not the same as a zero
    // handle. Treating the two alike dropped wrappers whose balance read merely failed —
    // the token vanished from the wallet on a transient RPC error. Keep them: the second,
    // unbatched read inside `readShieldedBalance` settles it, and a genuinely zero handle
    // costs nothing there because it returns before any decryption.
    const active: string[] = [];
    wrappers.forEach((wrapper, i) => {
      const hex = handles[i];
      const readFailed = hex === null || hex === undefined;
      const hasHandle = !readFailed && hex !== "0x" && BigInt(hex) !== 0n;
      if (hasHandle || readFailed || wrapper === native) active.push(wrapper);
    });
    if (active.length === 0) return [];

    // One batch for all four metadata reads across all active wrappers.
    const metaCalls = active.flatMap((to) => [
      { method: "eth_call", params: [{ to, data: iface.encodeFunctionData("symbol", []) }, "latest"] },
      { method: "eth_call", params: [{ to, data: iface.encodeFunctionData("decimals", []) }, "latest"] },
      { method: "eth_call", params: [{ to, data: iface.encodeFunctionData("rate", []) }, "latest"] },
      { method: "eth_call", params: [{ to, data: iface.encodeFunctionData("underlying", []) }, "latest"] },
    ]);
    const metaResults = await this.callBatch(metaCalls);

    const parsed: (Omit<ShieldedHolding, "balance" | "decryptFailed"> & { key: string })[] = [];

    for (let i = 0; i < active.length; i++) {
      const wrapper = active[i];
      const [symbolHex, decimalsHex, rateHex, underlyingHex] = metaResults.slice(i * 4, i * 4 + 4);

      let symbol = "ae???";
      try {
        if (symbolHex && symbolHex !== "0x") {
          [symbol] = iface.decodeFunctionResult("symbol", symbolHex) as unknown as [string];
        }
      } catch { /* keep the placeholder */ }

      const confidentialDecimals = decimalsHex && decimalsHex !== "0x" ? Number(BigInt(decimalsHex)) : 6;
      const rate = rateHex && rateHex !== "0x" ? BigInt(rateHex) : 1n;

      // `underlying()` only exists on the ERC-20 wrapper; the native one reverts, which is
      // exactly how we tell the two apart.
      let underlying = "";
      try {
        if (underlyingHex && underlyingHex !== "0x") {
          const [addr] = iface.decodeFunctionResult("underlying", underlyingHex) as unknown as [string];
          if (addr && addr !== ZeroAddress) underlying = getAddress(addr);
        }
      } catch { /* native wrapper */ }

      this.shieldedMetaCache.set(wrapper, { confidentialDecimals, rate });

      parsed.push({
        key: wrapper,
        wrapper: getAddress(wrapper),
        underlying,
        symbol,
        confidentialDecimals,
        rate,
        isNative: wrapper === native,
        isLegacy: false, // resolved below, once the canonical wrappers are known
      });
    }

    // A token can end up with more than one wrapper — an early hand-deployed one plus the
    // registry's. Ask the registry which is canonical rather than assuming, so a superseded
    // wrapper is flagged instead of quietly competing with the real one under the same
    // symbol. Resolved in one batched call for every underlying at once.
    const underlyings = parsed.map((p) => p.underlying).filter(Boolean);
    if (underlyings.length > 0) {
      const canonical = await this.getWrappersFor(underlyings);
      for (const entry of parsed) {
        if (!entry.underlying) continue;
        const preferred = canonical.get(entry.underlying.toLowerCase());
        entry.isLegacy = !!preferred && preferred.toLowerCase() !== entry.key;
      }
    }

    // Decryption is a round trip to the coprocessor each — running them together keeps the
    // wallet responsive when several tokens are shielded. A wrapper that cannot be
    // decrypted right now (coprocessor hiccup, revoked permit) reports zero rather than
    // taking the rest of the portfolio down with it.
    const holdings: ShieldedHolding[] = await Promise.all(
      parsed.map(async ({ key, ...rest }) => ({
        ...rest,
        ...(await this.readShieldedBalance(key, owner, account)),
      }))
    );

    // Native first, superseded wrappers last, otherwise by balance. Unreadable rows sort
    // as if they had a balance, because they probably do — sinking them to the bottom
    // among the empties is how they get overlooked.
    return holdings.sort((a, b) => {
      if (a.isNative !== b.isNative) return a.isNative ? -1 : 1;
      if (a.isLegacy !== b.isLegacy) return a.isLegacy ? 1 : -1;
      if (a.decryptFailed !== b.decryptFailed) return a.decryptFailed ? -1 : 1;
      return parseFloat(b.balance) - parseFloat(a.balance);
    });
  }

  /**
   * Deploy the confidential wrapper for a token that does not have one yet.
   *
   * A one-time cost per token, paid by whoever shields it first; everyone else reuses the
   * same wrapper via the registry.
   *
   * Only plain ERC-20s are safe here — rebasing and fee-on-transfer tokens break the 1:1
   * backing invariant and cannot be detected on-chain, so the UI must warn before calling.
   */
  async createWrapperFor(account: Account, underlyingAddress: string): Promise<string> {
    if (!this.isFheCapable()) throw new Error("FHE is not available on this network");

    const factory = this.factoryAddress();
    if (!factory) throw new Error("No wrapper factory is deployed on this network");

    const { Interface } = await import("ethers");
    const iface = new Interface(Network.FACTORY_ABI);

    const hash = await this.sendTransaction(account, {
      to: factory,
      value: "0",
      data: iface.encodeFunctionData("createWrapper", [underlyingAddress]),
    });
    await this.waitForTransaction(hash);

    // Force a re-read so the freshly deployed address is picked up — both the per-token
    // lookup and the registry enumeration, or the new wrapper stays invisible until reload.
    this.wrapperCache.delete(underlyingAddress.toLowerCase());
    this.registryWrappers = null;

    // Some RPCs (Base Sepolia reliably) still answer from pre-transaction state for a few
    // seconds after the receipt lands. Returning immediately would leave the caller reading
    // address(0) and reporting "not enabled" for a wrapper that was just deployed.
    for (let attempt = 0; attempt < 8; attempt++) {
      const wrapper = await this.getWrapperFor(underlyingAddress);
      if (wrapper) return hash;
      this.wrapperCache.delete(underlyingAddress.toLowerCase());
      await new Promise((r) => setTimeout(r, 2000));
    }

    throw new Error(
      "The wrapper was deployed but the network is still serving old state. " +
      "It will appear shortly — reopen this panel in a moment."
    );
  }

  /** True when this network has a CoFHE coprocessor behind it. */
  private isFheCapable(): boolean {
    return (
      this.network_id === NetworkId.Ethereum_Sepolia ||
      this.network_id === NetworkId.Arbitrum_Sepolia ||
      this.network_id === NetworkId.Base_Sepolia
    );
  }

  /**
   * Connect the CoFHE SDK as `account` on this network.
   *
   * Encrypted inputs and permits are bound to a specific `account + chainId`, so this
   * reconnects whenever either changes rather than reusing a stale session.
   */
  private async ensureFhe(account: Account) {
    const { default: FheCofheService } = await import("./FheCofheService.js");
    const service = FheCofheService.getInstance();

    const address = account.GetAddress();
    if (!address) throw new Error("Account address not available");

    if (!service.isReadyForAccount(address, this.network_id)) {
      if (!account.ethers_wallet) throw new Error("Wallet is locked");
      if (!this.rpc_url) throw new Error("RPC URL not set");

      const { JsonRpcProvider } = await import("ethers");
      const provider = new JsonRpcProvider(this.rpc_url);
      const connectedWallet = account.ethers_wallet.connect(provider);
      await service.init(provider, connectedWallet as unknown as Parameters<typeof service.init>[1], this.network_id);
    }

    return service;
  }

  /**
   * Reject a shield amount smaller than one confidential unit.
   *
   * The confidential layer is capped at 6 decimals, so amounts below `rate()` underlying
   * units round to zero. The contract reverts with `AmountTooSmallForConfidentialPrecision`,
   * which surfaces as an unexplained failed transaction; this states the minimum instead.
   *
   * @param amountValue Amount in the underlying token's own units.
   * @param underlyingDecimals Decimals of the underlying token, for the error message.
   */
  private async assertAboveConfidentialPrecision(
    shieldedTokenAddress: string,
    amountValue: bigint,
    underlyingDecimals: number
  ): Promise<void> {
    if (amountValue <= 0n) throw new Error("Amount must be greater than zero");

    const { formatUnits } = await import("ethers");
    const meta = await this.getShieldedTokenMeta(shieldedTokenAddress);

    if (amountValue < meta.rate) {
      const minimum = formatUnits(meta.rate, underlyingDecimals);
      throw new Error(
        `Amount is below the confidential precision limit. The minimum you can shield is ${minimum}.`
      );
    }
  }

  /**
   * Reject an amount larger than the caller's confidential balance.
   *
   * This guard is not optional. FHE arithmetic cannot revert on insufficient funds —
   * reverting would itself leak that the balance is below the requested amount. Instead
   * the contract silently substitutes an encrypted zero, so an over-sized transfer or
   * unshield *succeeds* on-chain while moving nothing. Without this check the user pays
   * gas, sees a confirmed transaction, and loses nothing but also sends nothing.
   *
   * Costs one decryption round-trip, which is the correct trade against a silent no-op.
   *
   * @param amountValue Requested amount in confidential units.
   */
  private async assertSufficientShieldedBalance(
    account: Account,
    shieldedTokenAddress: string,
    amountValue: bigint
  ): Promise<void> {
    const address = account.GetAddress();
    if (!address) throw new Error("Account address not available");

    const { Interface, formatUnits } = await import("ethers");
    const iface = new Interface(Network.SHIELDED_ABI);
    const meta = await this.getShieldedTokenMeta(shieldedTokenAddress);

    const resultHex = await this.call("eth_call", [
      { to: shieldedTokenAddress, data: iface.encodeFunctionData("confidentialBalanceOf", [address]) },
      "latest",
    ]);

    const handle = !resultHex || resultHex === "0x" ? 0n : BigInt(resultHex);
    if (handle === 0n) {
      throw new Error("You have no shielded balance for this token — shield some first.");
    }

    const service = await this.ensureFhe(account);
    const balance = await service.decryptForView(handle);

    if (amountValue > balance) {
      const have = formatUnits(balance, meta.confidentialDecimals);
      const want = formatUnits(amountValue, meta.confidentialDecimals);
      throw new Error(
        `Insufficient shielded balance: you have ${have} but tried to use ${want}. ` +
        `Confidential transfers cannot revert on-chain, so this would have silently moved zero.`
      );
    }
  }

  /** Read and cache `decimals()` / `rate()` for a confidential wrapper. */
  private async getShieldedTokenMeta(contractAddress: string): Promise<ShieldedTokenMeta> {
    const key = contractAddress.toLowerCase();
    const cached = this.shieldedMetaCache.get(key);
    if (cached) return cached;

    const { Interface } = await import("ethers");
    const iface = new Interface(Network.SHIELDED_ABI);

    const [decimalsHex, rateHex] = await Promise.all([
      this.call("eth_call", [{ to: contractAddress, data: iface.encodeFunctionData("decimals", []) }, "latest"]),
      this.call("eth_call", [{ to: contractAddress, data: iface.encodeFunctionData("rate", []) }, "latest"]),
    ]);

    if (!decimalsHex || decimalsHex === "0x" || !rateHex || rateHex === "0x") {
      throw new Error(`${contractAddress} does not look like a confidential wrapper`);
    }

    const meta: ShieldedTokenMeta = {
      confidentialDecimals: Number(BigInt(decimalsHex)),
      rate: BigInt(rateHex),
    };
    this.shieldedMetaCache.set(key, meta);
    return meta;
  }

  /**
   * Decrypt the caller's confidential balance for display.
   *
   * Returns "0.0" rather than throwing for the two states that are normal rather than
   * exceptional: a non-FHE network, and an account that has never shielded (no
   * ciphertext exists yet). Any other failure propagates so the UI can report it.
   */
  async getShieldedBalance(contractAddress: string, userAddress: string, account?: Account): Promise<string> {
    return (await this.readShieldedBalance(contractAddress, userAddress, account)).balance;
  }

  /**
   * Read a confidential balance, keeping "empty" and "unreadable" apart.
   *
   * `getShieldedBalance` flattens both into "0.0", which is fine for a caller that only
   * wants a number to display next to a token it is already showing. It is not fine for a
   * caller that decides whether the token exists at all: every screen that hides
   * zero-balance rows was also hiding shielded tokens whose decrypt had merely timed out,
   * and the asset vanished from the wallet.
   *
   * A non-zero handle means the ciphertext is on-chain. Whatever went wrong after that
   * point is a failure to read, never evidence that the balance is empty.
   */
  private async readShieldedBalance(
    contractAddress: string,
    userAddress: string,
    account?: Account
  ): Promise<{ balance: string; decryptFailed: boolean }> {
    const empty = { balance: "0.0", decryptFailed: false };
    const unreadable = { balance: "0.0", decryptFailed: true };

    if (!this.isFheCapable()) return empty;
    // No unlocked account means no permit and no decryption key. The balance is unknown,
    // not zero — a locked wallet must not report its holdings as empty.
    if (!account) return unreadable;

    const { Interface } = await import("ethers");
    const iface = new Interface(Network.SHIELDED_ABI);

    let resultHex: string;
    try {
      resultHex = await this.call("eth_call", [
        { to: contractAddress, data: iface.encodeFunctionData("confidentialBalanceOf", [userAddress]) },
        "latest",
      ]);
    } catch {
      // The RPC is down, so nothing is known about this wrapper either way.
      return unreadable;
    }

    if (!resultHex || resultHex === "0x") return empty;

    const handle = BigInt(resultHex);
    // An uninitialised euint64 is the zero handle — no balance has ever been created.
    // This is the one case that genuinely proves the balance is empty.
    if (handle === 0n) return empty;

    try {
      const service = await this.ensureFhe(account);
      const meta = await this.getShieldedTokenMeta(contractAddress);
      const decrypted = await service.decryptForView(handle);
      return { balance: this.formatTokenAmount(decrypted, meta.confidentialDecimals), decryptFailed: false };
    } catch {
      // Coprocessor ingestion lag, an expired permit, a threshold-network hiccup — all of
      // them leave a real balance behind a handle we could not open this time.
      return unreadable;
    }
  }

  /**
   * Shield native ETH into an encrypted balance (ArfheShieldedETH only).
   *
   * @param amount Amount of ETH, as a decimal string.
   */
  async shieldNative(account: Account, shieldedTokenAddress: string, amount: string): Promise<string> {
    if (!this.isFheCapable()) throw new Error("FHE is not available on this network");

    const { Interface, parseEther } = await import("ethers");
    const iface = new Interface(Network.SHIELDED_ABI);

    const to = account.GetAddress();
    if (!to) throw new Error("Account address not available");

    await this.assertAboveConfidentialPrecision(shieldedTokenAddress, parseEther(amount), 18);

    // Dust above the minimum but below the next whole confidential unit is refunded by
    // the contract, so no rounding is needed here.
    return this.sendTransaction(account, {
      to: shieldedTokenAddress,
      value: amount,
      data: iface.encodeFunctionData("shieldNative", [to]),
    });
  }

  /**
   * Shield an ERC20 into an encrypted balance (ArfheShieldedERC20).
   *
   * Approves the wrapper first when the existing allowance is short, and waits for that
   * approval to confirm — `shield` reverts if it lands in the same block unconfirmed.
   *
   * @param amount Amount in the underlying token's own decimals, as a decimal string.
   */
  async shieldERC20(
    account: Account,
    underlyingTokenAddress: string,
    shieldedTokenAddress: string,
    amount: string
  ): Promise<string> {
    if (!this.isFheCapable()) throw new Error("FHE is not available on this network");

    const { Interface, parseUnits: parseUnitsFn } = await import("ethers");
    const erc20 = new Interface([
      "function allowance(address owner, address spender) view returns (uint256)",
      "function approve(address spender, uint256 amount) returns (bool)",
      "function decimals() view returns (uint8)",
    ]);

    const owner = account.GetAddress();
    if (!owner) throw new Error("Account address not available");

    // Shielding into a superseded wrapper is a one-way mistake: each wrapper holds its own
    // backing pool, so those funds could only ever be unshielded through that same
    // contract, while the rest of the wallet operates on the canonical one. The registry
    // decides which is canonical, and this refuses anything else.
    const canonical = await this.getWrapperFor(underlyingTokenAddress);
    if (canonical && canonical.toLowerCase() !== shieldedTokenAddress.toLowerCase()) {
      throw new Error(
        "This token's confidential contract has been replaced. Reopen the shield screen " +
        "to use the current one — your existing balance in the old contract is safe and " +
        "can still be unshielded."
      );
    }

    // Read from the token, never assume. Defaulting to 18 for a 6-decimal token would
    // approve and pull a million times the amount the user typed.
    const decimals = await this.getErc20Decimals(underlyingTokenAddress);
    const amountValue = parseUnitsFn(amount, decimals);

    await this.assertAboveConfidentialPrecision(shieldedTokenAddress, amountValue, decimals);

    const readAllowance = async (): Promise<bigint> => {
      const hex = await this.call("eth_call", [
        { to: underlyingTokenAddress, data: erc20.encodeFunctionData("allowance", [owner, shieldedTokenAddress]) },
        "latest",
      ]);
      return hex && hex !== "0x" ? BigInt(hex) : 0n;
    };

    if (await readAllowance() < amountValue) {
      const approveTx = await this.sendTransaction(account, {
        to: underlyingTokenAddress,
        value: "0",
        data: erc20.encodeFunctionData("approve", [shieldedTokenAddress, amountValue]),
      });
      await this.waitForTransaction(approveTx);

      // The receipt is not enough. Base Sepolia in particular keeps answering `allowance`
      // from pre-transaction state for several seconds, and `shield` is estimated against
      // that stale view — it reverts with "transfer amount exceeds allowance" for an
      // approval that has already confirmed. Wait for the approval to actually be visible.
      let visible = await readAllowance();
      for (let attempt = 0; visible < amountValue && attempt < 10; attempt++) {
        await new Promise((r) => setTimeout(r, 2000));
        visible = await readAllowance();
      }
      if (visible < amountValue) {
        throw new Error(
          "The approval confirmed but the network is still serving old state. " +
          "Wait a few seconds and try shielding again — no funds have moved."
        );
      }
    }

    const iface = new Interface(Network.SHIELDED_ABI);
    return this.sendTransaction(account, {
      to: shieldedTokenAddress,
      value: "0",
      data: iface.encodeFunctionData("shield", [owner, amountValue]),
    });
  }

  /**
   * Step 1 of unshielding: burn the confidential balance and open a claim.
   *
   * The burned handle is marked publicly decryptable by the contract, which is what lets
   * {@link claimUnshielded} settle it without a permit. Note the protocol's
   * zero-replacement rule: unshielding more than the balance burns zero and opens a claim
   * worth nothing rather than reverting, so callers must check the balance first.
   *
   * @param amount Amount in confidential units, as a decimal string.
   */
  async unshield(account: Account, shieldedTokenAddress: string, amount: string): Promise<string> {
    if (!this.isFheCapable()) throw new Error("FHE is not available on this network");

    const { Interface, parseUnits: parseUnitsFn } = await import("ethers");
    const iface = new Interface(Network.SHIELDED_ABI);

    const owner = account.GetAddress();
    if (!owner) throw new Error("Account address not available");

    const meta = await this.getShieldedTokenMeta(shieldedTokenAddress);
    const amountValue = parseUnitsFn(amount, meta.confidentialDecimals);

    if (amountValue <= 0n) throw new Error("Amount must be greater than zero");

    // Same zero-replacement trap as transfers: unshielding more than the balance burns
    // nothing and opens a claim worth zero, which the user cannot tell apart from success.
    await this.assertSufficientShieldedBalance(account, shieldedTokenAddress, amountValue);

    return this.sendTransaction(account, {
      to: shieldedTokenAddress,
      value: "0",
      data: iface.encodeFunctionData("unshield", [owner, owner, amountValue]),
    });
  }

  /** List the caller's unsettled unshield claims. */
  async getPendingClaims(shieldedTokenAddress: string, userAddress: string): Promise<UnshieldClaim[]> {
    if (!this.isFheCapable()) return [];

    const { Interface } = await import("ethers");
    const iface = new Interface(Network.SHIELDED_ABI);

    const resultHex = await this.call("eth_call", [
      { to: shieldedTokenAddress, data: iface.encodeFunctionData("getUserClaims", [userAddress]) },
      "latest",
    ]);

    if (!resultHex || resultHex === "0x") return [];

    const [claims] = iface.decodeFunctionResult("getUserClaims", resultHex);
    return (claims as unknown[]).map((c) => {
      const claim = c as { id: string; to: string; ctHash: string; decryptedAmount: bigint; claimed: boolean };
      return {
        id: claim.id,
        to: claim.to,
        ctHash: claim.ctHash,
        decryptedAmount: BigInt(claim.decryptedAmount),
        claimed: claim.claimed,
      };
    });
  }

  /**
   * Step 2 of unshielding: decrypt the burned amount off-chain and settle the claim.
   *
   * Uses `decryptForTx`, which returns the plaintext together with a Threshold Network
   * signature the contract verifies before releasing funds. No permit is required — the
   * burned handle was made publicly decryptable by `unshield`.
   *
   * The payout always goes to the address stored on the claim, regardless of who submits
   * this transaction.
   */
  async claimUnshielded(
    account: Account,
    shieldedTokenAddress: string,
    claimId: string,
    ctHash: string
  ): Promise<string> {
    if (!this.isFheCapable()) throw new Error("FHE is not available on this network");

    const service = await this.ensureFhe(account);
    const { Interface } = await import("ethers");
    const iface = new Interface(Network.SHIELDED_ABI);

    // Decrypt the handle; submit against the claim id. Using one for the other reverts —
    // the proof is bound to the handle, while the claim is stored under the id.
    const { decryptedValue, signature } = await service.decryptForTx(BigInt(ctHash));

    // The contract reverts on an unverifiable proof. Checking first turns a burnt
    // transaction into an error the UI can explain. A verifier that cannot answer is not
    // treated as a rejection — only an explicit `false` blocks the claim.
    let verified = true;
    try {
      verified = await service.verifyDecryptResult(BigInt(ctHash), decryptedValue, signature);
    } catch {
      // Verification unavailable; fall through and let the contract be the judge.
    }
    if (!verified) {
      throw new Error("Decryption proof failed verification — the claim was not submitted.");
    }

    return this.sendTransaction(account, {
      to: shieldedTokenAddress,
      value: "0",
      data: iface.encodeFunctionData("claimUnshielded", [claimId, decryptedValue, signature]),
    });
  }

  /**
   * Settle several claims against one token in a single transaction.
   *
   * The wrappers expose `claimUnshieldedBatch` precisely for this: a user who was
   * interrupted mid-unshield more than once accumulates claims, and settling them
   * separately costs a signature, a gas payment and a confirmation wait each.
   *
   * Every proof is verified off-chain first. The batch is atomic, so one bad proof would
   * revert the whole transaction and strand the good claims with it — rejecting up front
   * keeps a single unverifiable claim from blocking the rest.
   *
   * Falls through to {@link claimUnshielded} for a single claim, which is the common case
   * and avoids the array encoding overhead.
   */
  async claimUnshieldedMany(
    account: Account,
    shieldedTokenAddress: string,
    claims: { claimId: string; ctHash: string }[]
  ): Promise<string> {
    if (!this.isFheCapable()) throw new Error("FHE is not available on this network");
    if (claims.length === 0) throw new Error("No claims to settle");
    if (claims.length === 1) {
      return this.claimUnshielded(account, shieldedTokenAddress, claims[0].claimId, claims[0].ctHash);
    }

    const service = await this.ensureFhe(account);
    const { Interface } = await import("ethers");
    const iface = new Interface(Network.SHIELDED_ABI);

    const decrypted: { claimId: string; value: bigint; signature: `0x${string}` }[] = [];

    for (const { claimId, ctHash } of claims) {
      const { decryptedValue, signature } = await service.decryptForTx(BigInt(ctHash));

      let verified = true;
      try {
        verified = await service.verifyDecryptResult(BigInt(ctHash), decryptedValue, signature);
      } catch {
        // Verifier unavailable; let the contract be the judge rather than blocking.
      }
      if (!verified) {
        throw new Error("Decryption proof failed verification — no claims were submitted.");
      }

      decrypted.push({ claimId, value: decryptedValue, signature });
    }

    return this.sendTransaction(account, {
      to: shieldedTokenAddress,
      value: "0",
      data: iface.encodeFunctionData("claimUnshieldedBatch", [
        decrypted.map((d) => d.claimId),
        decrypted.map((d) => d.value),
        decrypted.map((d) => d.signature),
      ]),
    });
  }

  /**
   * Unshield and settle in one call, queueing the claim so it cannot be lost.
   *
   * The burn is recorded the instant it confirms, before the slow decrypt begins. If the
   * popup is dismissed mid-flight — or the claim simply fails — the intent survives in
   * `queue` and is retried the next time the wallet is open and unlocked, so burned
   * balance is never stranded behind an unsettled claim.
   *
   * @param onPhase Progress hook so the UI can narrate without blocking on it.
   * @returns The burn transaction hash. Settlement may still be in flight.
   */
  async unshieldAndClaim(
    account: Account,
    shieldedTokenAddress: string,
    amount: string,
    queue: PendingClaimQueue,
    symbol: string,
    onPhase?: (phase: "burning" | "confirming" | "decrypting" | "claiming" | "done") => void
  ): Promise<string> {
    const owner = account.GetAddress();
    if (!owner) throw new Error("Account address not available");

    onPhase?.("burning");
    const burnHash = await this.unshield(account, shieldedTokenAddress, amount);

    onPhase?.("confirming");
    await this.waitForTransaction(burnHash);

    // Persist before decrypting: everything after this point can be interrupted.
    //
    // Read with retries. Some RPCs (Base Sepolia notably) still serve pre-transaction
    // state for a moment after a receipt is available, which would return an empty claim
    // list — and a claim that never reaches the queue is burned balance nobody retries.
    let claims = await this.getPendingClaims(shieldedTokenAddress, owner);
    for (let attempt = 0; claims.length === 0 && attempt < 5; attempt++) {
      await new Promise((r) => setTimeout(r, 1500));
      claims = await this.getPendingClaims(shieldedTokenAddress, owner);
    }

    const fresh = claims[claims.length - 1];
    if (fresh) {
      queue.add({
        claimId: fresh.id,
        ctHash: fresh.ctHash,
        tokenAddress: shieldedTokenAddress,
        accountAddress: owner,
        networkId: this.network_id,
        symbol,
      });
    }

    onPhase?.("decrypting");
    await this.drainPendingClaims(account, queue, onPhase);
    onPhase?.("done");

    return burnHash;
  }

  /**
   * Settle every queued claim for this account on this network.
   *
   * Reconciles against the chain first so claims settled elsewhere are dropped rather
   * than retried. Never throws — a claim that fails stays queued for the next attempt.
   *
   * @returns Number of claims settled.
   */
  async drainPendingClaims(
    account: Account,
    queue: PendingClaimQueue,
    onPhase?: (phase: "claiming") => void
  ): Promise<number> {
    if (!this.isFheCapable()) return 0;

    const owner = account.GetAddress();
    if (!owner) return 0;

    // Drop anything the chain no longer lists as pending.
    const tokens = new Set(queue.getFor(owner, this.network_id).map((c) => c.tokenAddress));
    for (const token of tokens) {
      try {
        const live = await this.getPendingClaims(token, owner);
        queue.reconcile(owner, this.network_id, live.map((c) => c.id));
      } catch {
        // A failed read must not delete queued intents — leave them for the next pass.
      }
    }

    return queue.drainGrouped(owner, this.network_id, async (tokenAddress, intents) => {
      onPhase?.("claiming");
      const hash = await this.claimUnshieldedMany(
        account, tokenAddress, intents.map((i) => ({ claimId: i.claimId, ctHash: i.ctHash }))
      );
      await this.waitForTransaction(hash);
    });
  }

  /**
   * Send confidential tokens without revealing the amount.
   *
   * The amount is encrypted client-side into an `InEuint64` carrying a verifier
   * signature bound to this account and chain, so it cannot be replayed elsewhere.
   *
   * Zero-replacement applies here too: an amount exceeding the balance transfers
   * encrypted zero instead of reverting.
   *
   * @param amount Amount in confidential units, as a decimal string.
   */
  async transferConfidential(
    account: Account,
    shieldedTokenAddress: string,
    to: string,
    amount: string,
    onStep?: (step: string) => void
  ): Promise<string> {
    if (!this.isFheCapable()) throw new Error("FHE is not available on this network");

    const service = await this.ensureFhe(account);
    const { Interface, parseUnits: parseUnitsFn, isAddress, ZeroAddress } = await import("ethers");
    const iface = new Interface(Network.SHIELDED_ABI);

    // The contract rejects these, but only after the proof has been generated and the
    // transaction mined — cheaper and clearer to stop here.
    if (!isAddress(to)) throw new Error("Invalid recipient address");
    if (to === ZeroAddress) throw new Error("Cannot send to the zero address");

    const meta = await this.getShieldedTokenMeta(shieldedTokenAddress);
    const amountValue = parseUnitsFn(amount, meta.confidentialDecimals);

    if (amountValue <= 0n) throw new Error("Amount must be greater than zero");

    // Must precede encryption: an over-sized transfer would otherwise confirm on-chain
    // while moving encrypted zero (see assertSufficientShieldedBalance).
    await this.assertSufficientShieldedBalance(account, shieldedTokenAddress, amountValue);

    // The wrapper is the contract that will consume this ciphertext, and the verifier
    // binds that address into the proof — encrypting for one wrapper and submitting to
    // another is rejected rather than silently accepted.
    const encrypted = await service.encryptUint64(amountValue, shieldedTokenAddress, onStep);

    return this.sendTransaction(account, {
      to: shieldedTokenAddress,
      value: "0",
      data: iface.encodeFunctionData("confidentialTransfer", [
        to,
        encrypted.handle,
        encrypted.proof,
      ]),
    });
  }
}

export { Network };
