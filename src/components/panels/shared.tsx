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

// ArfheWallet - Wrapped Token Addresses (Ethereum Sepolia)
export const CONTRACTS_SEPOLIA = {
  "USDC": {
    public: getAddress("0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238"),
    shielded: getAddress(import.meta.env.VITE_WRAPPED_USDC_ADDRESS || "0x730Bb4ee9EA1cdB0B45C1DB01cA67a616D2D3C88")
  },
  "ETH": {
    public: getAddress(import.meta.env.VITE_SEPOLIA_WETH_ADDRESS || "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9"),
    shielded: getAddress(import.meta.env.VITE_WRAPPED_ETH_ADDRESS || "0x17CecF8090B945932e2F592168B636F7A0c986e8")
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

// Get explorer URL for the active network — accepts the full Network object
// so custom networks can return their own configured explorer_url.
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
        // For other built-in or unknown networks, fall back to their explorer_url if set
        if (networkOrId.explorer_url) return networkOrId.explorer_url.replace(/\/+$/, '');
        return "https://etherscan.io";
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
    default: return "https://etherscan.io";
  }
}

// Shared input card style
export const inputCardSx = {
  p: 1.5,
  borderRadius: 3,
  border: '1px solid',
  borderColor: 'divider',
  bgcolor: 'action.hover',
  transition: 'border-color 0.2s',
  '&:hover': { borderColor: 'primary.main' }
};

// Shared CTA button sx
export const ctaButtonSx = {
  borderRadius: 3,
  height: 42,
  fontWeight: 700,
  fontSize: '0.82rem',
  letterSpacing: '0.02em',
  boxShadow: '0 4px 14px rgba(37, 99, 235, 0.3)',
  '&:hover': {
    boxShadow: '0 6px 20px rgba(37, 99, 235, 0.4)',
    transform: 'translateY(-1px)',
  },
  transition: 'all 0.2s ease',
};
