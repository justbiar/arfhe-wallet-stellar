import React from "react";
import { Box } from "@mui/material";
import { getAddress } from "ethers";
import { NetworkId } from "../../backend/NetworkTypes.js";

// --- Tab Panel Wrapper ---
export function CustomTabPanel(props: { children: React.ReactNode; index: number; value: number }) {
  const { children, value, index, ...other } = props;
  return (
    <div
      role="tabpanel"
      hidden={value !== index}
      id={`action-tabpanel-${index}`}
      aria-labelledby={`action-tab-${index}`}
      {...other}
      style={{ width: '100%' }}
    >
      {value === index && <Box sx={{ pt: 1 }}>{children}</Box>}
    </div>
  );
}

/**
 * Fire-and-forget POST to backend-proxy's /activity/log. Never throws, never awaited by the
 * caller, and never sends an amount — only that this wallet address performed a
 * send/shield/unshield, mirroring AgentChatPanel.tsx's logActivity (same endpoint/shape),
 * but called from the manual (non-agent) send/shield/unshield flows so those show up in
 * /admin too, not just agent-confirmed transactions.
 */
export function logActivity(walletAddress: string, actionType: "send" | "shield" | "unshield"): void {
  const proxyBaseUrl = import.meta.env.VITE_AGENT_PROXY_URL as string | undefined;
  if (!proxyBaseUrl) return;
  fetch(`${proxyBaseUrl}/activity/log`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ wallet_address: walletAddress, action_type: actionType }),
  }).catch(() => { /* best-effort telemetry only */ });
}

// ArfheWallet - Wrapped Token Addresses (Ethereum Sepolia)
export const CONTRACTS_SEPOLIA = {
  "USDC": {
    public: getAddress("0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238"),
    // No fallback address. A stale default here is worse than none: it points the wallet
    // at a wrapper from an earlier deployment, which now rejects every proof the current
    // SDK produces, and does so while looking like the real thing.
    shielded: getAddress(import.meta.env.VITE_WRAPPED_USDC_ADDRESS || "0x0000000000000000000000000000000000000000")
  },
  "ETH": {
    public: getAddress(import.meta.env.VITE_SEPOLIA_WETH_ADDRESS || "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9"),
    shielded: getAddress(import.meta.env.VITE_WRAPPED_ETH_ADDRESS || "0x0000000000000000000000000000000000000000")
  },
  "LINK": {
    public: getAddress("0x779877A7B0D9E8603169DdbD7836e478b4624789"),
    shielded: getAddress("0x0000000000000000000000000000000000000000")
  }
};

// ArfheWallet - Wrapped Token Addresses (Arbitrum Sepolia)
export const CONTRACTS_ARB_SEPOLIA: Record<string, { public: string; shielded: string }> = {
  "ETH": {
    public: getAddress(import.meta.env.VITE_ARB_SEPOLIA_WETH_ADDRESS || "0x0000000000000000000000000000000000000000"),
    shielded: getAddress(import.meta.env.VITE_ARB_WRAPPED_ETH_ADDRESS || "0x0000000000000000000000000000000000000000")
  },
  "USDC": {
    public: getAddress(import.meta.env.VITE_ARB_SEPOLIA_USDC_ADDRESS || "0x0000000000000000000000000000000000000000"),
    shielded: getAddress(import.meta.env.VITE_ARB_WRAPPED_USDC_ADDRESS || "0x0000000000000000000000000000000000000000")
  }
};

// ArfheWallet - Wrapped Token Addresses (Base Sepolia)
export const CONTRACTS_BASE_SEPOLIA: Record<string, { public: string; shielded: string }> = {
  "ETH": {
    public: getAddress(import.meta.env.VITE_BASE_SEPOLIA_WETH_ADDRESS || "0x0000000000000000000000000000000000000000"),
    shielded: getAddress(import.meta.env.VITE_BASE_WRAPPED_ETH_ADDRESS || "0x0000000000000000000000000000000000000000")
  },
  "USDC": {
    public: getAddress(import.meta.env.VITE_BASE_SEPOLIA_USDC_ADDRESS || "0x0000000000000000000000000000000000000000"),
    shielded: getAddress(import.meta.env.VITE_BASE_WRAPPED_USDC_ADDRESS || "0x0000000000000000000000000000000000000000")
  }
};

// Backward compatible alias
export const CONTRACTS = CONTRACTS_SEPOLIA;

// Get contracts for the active network
export function getContractsForNetwork(networkId: NetworkId) {
  if (networkId === NetworkId.Arbitrum_Sepolia) return CONTRACTS_ARB_SEPOLIA;
  if (networkId === NetworkId.Base_Sepolia) return CONTRACTS_BASE_SEPOLIA;
  return CONTRACTS_SEPOLIA;
}

/**
 * Superseded confidential wrappers from earlier iterations, kept out of the token list.
 *
 * Sepolia-only: these were never deployed on the other testnets.
 */
const LEGACY_HIDDEN_CONTRACTS = [
  "0xbde0a2e375b67c802d4651fecf3b678b1886d15b", // SimpleWrappedUSDC
  "0x3e0722a877e52fe755e8bf02372342c63930fd57", // MockFHEWrappedUSDC
  "0x6ab305c679002c0938c2be3f824fcb8b81be5b70", // CoFHEWrappedUSDC v1
  "0x5c3f1fe2c451ccc73443865fec914a595c3d1a7c", // CoFHEWrappedUSDC v2
  "0x730bb4ee9ea1cdb0b45c1db01ca67a616d2d3c88", // WrappedUSDC
  "0x23bad885b76c95ec9e2b47663022d552d780200f", // WrappedETH
  "0x503e16b7920420277ce1548444dbb30e97f87d40", // WrappedUSDC v2
  "0x3696a9a8ecd0dbd7111dd15f7837d7f38d83a0c0", // WrappedETH v3
  "0x7890673c207a728ef7d9378c7206030749351dad", // WrappedETH v3
  "0x4b3dd819cfbf1364cabd5c8f9c5c05917d09168c", // WrappedUSDC v2
  "0x421583e66b21de780b4f94fcecce858c07f3d2d9", // WrappedETH v3
  "0x0125c55244724c1bf1d16b91e046fe7e8a5719e2", // WrappedUSDC v2
  "0x8d0419e8a259366516fc4fbabebdc013cad8770f", // WrappedETH_V3
  "0x2210264a3775d5fbc51b1b73667f5590230ac2bd", // WrappedUSDC_V2
  "0x5396bc5ed8754a9e8c703021288fc07d1d91b99d", // WrappedETH_V4 (cofhejs era)
  "0x98271a408126bb7e0bc2af8d78a063feaa642f13", // WrappedUSDC_V3 (cofhejs era)

  // Retired when CoFHE moved to ACPs and cofhe-contracts 0.2. These were built against
  // the old `InEuint64` input struct, whose proof digest the current verifier no longer
  // produces — they can still be read, but nothing new can be encrypted into them.
  "0xf63b60286c8985af10d5bac8de2800d7256532c7", // aeETH  Sepolia
  "0xd030b2aa70dc793208b2b97888e7c0fa702aa078", // aeUSDC Sepolia
  "0x9d4fba144600b07c81deea2efc55bdbdd7d52c15", // aeETH  Arbitrum Sepolia
  "0xb9433565063443967fcb5a5969695c836593f905", // aeUSDC Arbitrum Sepolia
  "0x5ea8e9a8e317d6248ba64715699a217067d56a37", // aeETH  Base Sepolia
  "0xecddcfb7aee65f5dab530cc85587ef86196b4302", // aeUSDC Base Sepolia
];

/**
 * Contract addresses that must never appear in the generic ERC-20 token list.
 *
 * The active confidential wrappers are included deliberately: FHERC20's `balanceOf`
 * returns a non-revealing *activity indicator* (~7984.0000), not a real balance, so a
 * generic token row would show a meaningless number. Shielded balances are surfaced
 * separately via `confidentialBalanceOf` + decryption.
 *
 * Derived per network rather than hardcoded, so redeploying only requires an .env change.
 */
export function getHiddenTokenAddresses(networkId: NetworkId): Set<string> {
  const hidden = new Set(LEGACY_HIDDEN_CONTRACTS);

  const contracts = getContractsForNetwork(networkId);
  for (const config of Object.values(contracts)) {
    const shielded = config.shielded.toLowerCase();
    if (shielded !== "0x0000000000000000000000000000000000000000") hidden.add(shielded);
  }

  return hidden;
}

/**
 * Explorer base URL for a network, or "" when there is none.
 *
 * Returning "" rather than guessing matters now that most networks are user-added: an
 * etherscan.io fallback pointed every link for an unknown chain at the wrong explorer,
 * where the hash either shows nothing or — worse — resolves to an unrelated transaction
 * that happens to share it. Callers must treat "" as "offer no link".
 */
export function getExplorerBaseForNetwork(networkOrId: { network_id?: NetworkId; explorer_url?: string; isCustom?: boolean } | NetworkId | undefined) {
  // If a full Network object is passed and it's a custom network with its own URL, use it
  if (networkOrId && typeof networkOrId === 'object') {
    if (networkOrId.isCustom && networkOrId.explorer_url) return networkOrId.explorer_url.replace(/\/+$/, '');
    const networkId = networkOrId.network_id;
    switch (networkId) {
      case NetworkId.Ethereum_Mainnet: return "https://etherscan.io";
      case NetworkId.Ethereum_Sepolia: return "https://sepolia.etherscan.io";
      case NetworkId.Arbitrum_One: return "https://arbiscan.io";
      case NetworkId.Arbitrum_Sepolia: return "https://sepolia.arbiscan.io";
      case NetworkId.Base_Mainnet: return "https://basescan.org";
      case NetworkId.Base_Sepolia: return "https://sepolia.basescan.org";
      case NetworkId.Polygon: return "https://polygonscan.com";
      case NetworkId.Optimism: return "https://optimistic.etherscan.io";
      case NetworkId.Avalanche: return "https://snowtrace.io";
      case NetworkId.BNB_Chain: return "https://bscscan.com";
      case NetworkId.Linea: return "https://lineascan.build";
      case NetworkId.Sei: return "https://seitrace.com";
      case NetworkId.Monad_Testnet: return "https://testnet.monadexplorer.com";
      case NetworkId.Avalanche_Fuji: return "https://testnet.snowtrace.io";
      default:
        // A user-added chain carries its own explorer, or none at all.
        if (networkOrId.explorer_url) return networkOrId.explorer_url.replace(/\/+$/, '');
        return "";
    }
  }
  // Legacy: called with just a NetworkId enum value
  switch (networkOrId as NetworkId) {
    case NetworkId.Ethereum_Mainnet: return "https://etherscan.io";
    case NetworkId.Ethereum_Sepolia: return "https://sepolia.etherscan.io";
    case NetworkId.Arbitrum_One: return "https://arbiscan.io";
    case NetworkId.Arbitrum_Sepolia: return "https://sepolia.arbiscan.io";
    case NetworkId.Base_Mainnet: return "https://basescan.org";
    case NetworkId.Base_Sepolia: return "https://sepolia.basescan.org";
    case NetworkId.Polygon: return "https://polygonscan.com";
    case NetworkId.Optimism: return "https://optimistic.etherscan.io";
    case NetworkId.Avalanche: return "https://snowtrace.io";
    case NetworkId.BNB_Chain: return "https://bscscan.com";
    case NetworkId.Linea: return "https://lineascan.build";
    case NetworkId.Sei: return "https://seitrace.com";
    case NetworkId.Monad_Testnet: return "https://testnet.monadexplorer.com";
    case NetworkId.Avalanche_Fuji: return "https://testnet.snowtrace.io";
    default: return "";
  }
}

/**
 * Explorer link for a transaction, or "" when this network has no explorer.
 *
 * The empty string is the signal to render no link at all. A link built on an empty base
 * resolves inside the extension, which looks like a broken button rather than an absent
 * feature.
 */
export function explorerTxUrl(
  networkOrId: { network_id?: NetworkId; explorer_url?: string; isCustom?: boolean } | NetworkId | undefined,
  txHash: string
): string {
  const base = getExplorerBaseForNetwork(networkOrId);
  return base ? `${base}/tx/${txHash}` : "";
}

/** Explorer link for an address, or "" when this network has no explorer. */
export function explorerAddressUrl(
  networkOrId: { network_id?: NetworkId; explorer_url?: string; isCustom?: boolean } | NetworkId | undefined,
  address: string
): string {
  const base = getExplorerBaseForNetwork(networkOrId);
  return base ? `${base}/address/${address}` : "";
}

// Shared input card style. borderRadius: 0 matches the theme's sharp-corner convention
// (ArfTheme.ts's shape.borderRadius: 0) — don't reintroduce a rounded value here, callers
// used to override it individually because this default fought the theme.
export const inputCardSx = {
  p: 1.5,
  borderRadius: 0,
  border: '1px solid',
  borderColor: 'divider',
  bgcolor: 'action.hover',
  transition: 'border-color 0.2s',
  '&:hover': { borderColor: 'primary.main' }
};

// Shared CTA button sx. Neutral (non-color) shadow — a hardcoded blue shadow fought
// ArfTheme.ts's mode/accent-driven primary color on every non-blue theme.
export const ctaButtonSx = {
  borderRadius: 0,
  height: 42,
  fontWeight: 700,
  fontSize: '0.82rem',
  letterSpacing: '0.02em',
  boxShadow: '0 4px 14px rgba(0, 0, 0, 0.15)',
  '&:hover': {
    boxShadow: '0 6px 20px rgba(0, 0, 0, 0.25)',
    transform: 'translateY(-1px)',
  },
  transition: 'all 0.2s ease',
};

