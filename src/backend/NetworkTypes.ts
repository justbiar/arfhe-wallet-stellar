
export enum NetworkId {
    Unknown = -1,
    Ethereum_Mainnet = 1,
    Zama = 2,
    Ethereum_Sepolia = 4,
    Ethereum_Hoodi = 5,
    Optimism = 10,
    BNB_Chain = 56,
    Polygon = 137,
    Sei = 1329,
    Monad_Testnet = 10143,
    Arbitrum_One = 42161,
    Arbitrum_Sepolia = 421614,
    Base_Mainnet = 8453,
    Base_Sepolia = 84532,
    Avalanche = 43114,
    Avalanche_Fuji = 43113,
    Linea = 59144,
}

export type TokenBalance = {
    contractAddress: string;   // "ETH" for native
    tokenBalance: string;      // human-readable string
    isNative: boolean;         // true if ETH, false if ERC20
    priceUsd?: number;         // Price in USD
    totalValueUsd?: number;    // Total value in USD
    isAlchemySpam?: boolean;   // true if Alchemy flagged this as spam
};

export type TransactionHistory = {
    hash: string;              // Transaction hash
    from: string;              // Sender address
    to: string;                // Receiver address
    contractAddress: string;   // "ETH" for native, otherwise token contract
    value: string;             // Human-readable value (ETH or token amount)
    timestamp: string;         // ISO timestamp of the block
    blockNum: string;          // Hex block number for pagination
    isNative: boolean;         // true if native token (ETH), false if ERC20
    status: "Success" | "Fail" | "Pending";
    explorerUrl: string;
    isShielded: boolean;       // true if interaction with cETH/cUSDC FHE contracts
    methodLabel: string;       // "Transfer" | "Wrap" | "Unwrap" | "Shield Transfer" | "Approve" etc.
    /**
     * Ticker as reported by the transfer itself.
     *
     * A token arriving from someone else is usually one the wallet has never held, so it
     * is absent from the token cache the row is otherwise named from — and the row was
     * rendered as a bare number with no asset beside it. The indexer already knows the
     * symbol; carrying it here means an incoming transfer reads as "Received 25 LINK" the
     * first time it is seen, without a metadata round trip per row.
     */
    assetSymbol?: string;
};

/** Tracks a pending transaction for speed-up / cancel support */
export type PendingTransaction = {
    hash: string;              // Original transaction hash
    nonce: number;             // Nonce used — critical for replacement
    from: string;              // Sender address
    to: string;                // Receiver address
    value: string;             // Value in wei (hex or decimal string)
    data: string;              // Calldata
    gasPrice?: string;         // Legacy gas price in wei
    maxFeePerGas?: string;     // EIP-1559 max fee in wei
    maxPriorityFeePerGas?: string; // EIP-1559 priority fee in wei
    timestamp: number;         // Unix ms when submitted
    networkId: NetworkId;      // Network this tx belongs to
};

export type TokenWithMetadata = TokenBalance & {
    name: string;
    symbol: string;
    decimals: number;
    logoSrc: string;
};

/**
 * Networks with a CoFHE coprocessor behind them.
 *
 * This is the official support list, not a wish list: encrypting or decrypting anywhere
 * else has no coprocessor to talk to.
 *
 * Must stay in sync with `COFHE_CHAIN_IDS` in FheCofheService.
 * @see https://cofhe-docs.fhenix.zone/get-started/introduction/compatibility
 */
export const FHE_NETWORK_IDS = new Set<NetworkId>([
    NetworkId.Ethereum_Sepolia,
    NetworkId.Arbitrum_Sepolia,
    NetworkId.Base_Sepolia,
]);

/**
 * The real EVM chain id for a network.
 *
 * `NetworkId` is the wallet's internal identifier and is NOT always the chain id —
 * `Ethereum_Sepolia` is 4 here while Sepolia's actual chain id is 11155111. Anything that
 * leaves the wallet must use this: a transaction is signed against a chain id, a dApp is
 * told one over EIP-1193, and a WalletConnect request names one. Passing the internal id
 * instead signs for chain 4 and tells websites the wrong network.
 *
 * Custom networks are added by their real chain id, so they pass through unchanged.
 */
export function toChainId(networkId: NetworkId | number): number {
    switch (Number(networkId)) {
        case NetworkId.Ethereum_Sepolia: return 11155111;
        case NetworkId.Ethereum_Hoodi: return 560048;
        case NetworkId.Zama: return 8009;
        default: return Number(networkId);
    }
}

/**
 * Names for chains the wallet does not itself carry.
 *
 * A site can ask to switch to any chain, and the wallet ships with three. Everything else
 * was rendered as a bare number — "Chain 143" — which asks the user to approve something
 * they have no way to identify. The number is the least useful part of a chain id: it is
 * how machines refer to a network and how nobody else does.
 *
 * Deliberately a static list rather than a lookup against chainlist.org: this is used on
 * the approval screen, and fetching the name of a chain from a third party at the moment a
 * user is deciding whether to trust a site would leak that decision to that third party.
 * A wrong-but-offline "unknown" is better than a right-but-published one.
 */
const WELL_KNOWN_CHAINS: Record<number, string> = {
    1: "Ethereum",
    10: "OP Mainnet",
    56: "BNB Smart Chain",
    97: "BNB Smart Chain Testnet",
    100: "Gnosis",
    137: "Polygon",
    143: "Monad",
    250: "Fantom Opera",
    324: "zkSync Era",
    5000: "Mantle",
    8453: "Base",
    10143: "Monad Testnet",
    17000: "Holesky",
    42161: "Arbitrum One",
    43113: "Avalanche Fuji",
    43114: "Avalanche",
    59144: "Linea",
    80002: "Polygon Amoy",
    81457: "Blast",
    84532: "Base Sepolia",
    421614: "Arbitrum Sepolia",
    534352: "Scroll",
    560048: "Hoodi",
    11155111: "Sepolia",
    11155420: "OP Sepolia",
};

/**
 * The common name of a chain id, when there is one.
 *
 * @returns The name, or undefined for a chain nobody has a name for — in which case the
 *          caller should say so rather than inventing one.
 */
export function wellKnownChainName(chainId: number): string | undefined {
    return WELL_KNOWN_CHAINS[Number(chainId)];
}

/** Check whether a given network supports FHE operations */
export function isFheNetwork(networkId: NetworkId): boolean {
    return FHE_NETWORK_IDS.has(networkId);
}

/** Set of testnet network IDs */
export const TESTNET_IDS = new Set<NetworkId>([
    NetworkId.Ethereum_Sepolia,
    NetworkId.Arbitrum_Sepolia,
    NetworkId.Base_Sepolia,
    NetworkId.Monad_Testnet,
    NetworkId.Avalanche_Fuji,
]);

/** Check whether a given network is a testnet */
export function isTestnetNetwork(networkId: NetworkId): boolean {
    return TESTNET_IDS.has(networkId);
}

/** User-defined custom network configuration (persisted in localStorage) */
/**
 * A user's edits to a network the wallet ships with.
 *
 * Kept separate from {@link CustomNetworkConfig}: a built-in network still has its own
 * identity, Alchemy wiring and FHE capability, and the user is amending it rather than
 * defining it. Storing a full config instead would silently promote every edited network
 * to a custom one and lose all of that.
 *
 * Every field is optional — an absent field means "keep whatever the wallet ships".
 */
export type NetworkOverride = {
    /** Replaces the JSON-RPC endpoint. The single most common reason to edit a network. */
    rpcUrl?: string;
    /** Used when the primary is unreachable, so one dead provider does not strand a chain. */
    fallbackRpcUrl?: string;
    explorerUrl?: string;
    networkName?: string;
    currencySymbol?: string;
};

export type CustomNetworkConfig = {
    chainId: number;           // EVM chain ID (used as NetworkId)
    networkName: string;       // Display name (e.g. "Polygon Mainnet")
    rpcUrl: string;            // JSON-RPC endpoint
    explorerUrl: string;       // Block explorer base URL (e.g. "https://polygonscan.com")
    currencySymbol: string;    // Native currency symbol (e.g. "MATIC")
    currencyDecimals?: number; // Native currency decimals (default 18)
    iconColor?: string;        // Dot color for network menu
};
