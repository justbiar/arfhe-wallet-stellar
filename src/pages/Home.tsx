import React, { useEffect, useState, useMemo } from "react";
import {
  Typography,
  Box,
  Avatar,
  Paper,
  Stack,
  Button,
  Chip,
  IconButton,
  Menu,
  MenuItem,
  Tooltip,
  useTheme,
  alpha,
  Divider,
  Drawer,
} from "@mui/material";
import {
  SendOutlined,
  CallReceivedOutlined,
  TrendingUp,
  LinkOff,
  History,
  Shield,
  ExpandMore,
  Refresh,
  Add,
  Visibility,
  VisibilityOff,
  WarningAmber,
  VisibilityOffOutlined,
  ShoppingCart,
} from "@mui/icons-material";
import { useMatrixText } from "../hooks/useMatrixText.js";
import OnboardingTour, {
  BackupReminderBanner,
  isOnboardingCompleted,
  isBackupReminderDismissed,
  dismissBackupReminder,
} from "../components/OnboardingTour.js";
import { AppContext, WalletContext } from "../AppContext.js";
import { ActiveAccountContext } from "../ActiveAccountProvider.js";
import { useNavigate } from "react-router";
import { useTranslation } from "react-i18next";
import { NetworkId, isFheNetwork as isFheCapableNetwork } from "../backend/NetworkTypes.js";
import { onTxConfirmed } from "../backend/TxNotifier.js";
import { DailyChangeBadge } from "../components/PortfolioHistoryChart.js";
import WalletModeSwitch from "../components/WalletModeSwitch.js";
import StellarNetworkPanel from "../components/StellarNetworkPanel.js";
import { getAddress } from "ethers";
import type { TypographyProps } from "@mui/material";
import type { DisplayToken, BalanceMap, WrappedBalance } from "../types/index.js";
import { TokenListSkeleton } from "../components/SkeletonLoaders.js";
import { useToast } from "../components/ToastProvider.js";
import { classifyError, NetworkError, NetworkErrorType, getErrorFallbackMessage } from "../backend/NetworkErrorHandler.js";
import { getCoinGeckoBase } from "../backend/Network.js";
import { usePersistedState } from "../hooks/usePersistedState.js";
import { getHiddenTokenAddresses } from "../components/panels/shared.js";
import ActiveDAppBar from "../components/ActiveDAppBar.js";

const KNOWN_LOGOS: Record<string, string> = {
  "ETH": "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/info/logo.png",
  "WETH": "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2/logo.png",
  "aeETH": "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/info/logo.png",
  "USDC": "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48/logo.png",
  "aeUSDC": "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48/logo.png",
  "USDT": "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0xdAC17F958D2ee523a2206206994597C13D831ec7/logo.png",
  "LINK": "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0x514910771AF9Ca656af840dff83E8264EcF986CA/logo.png",
  "EURC": "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0x1aBaEA1f7C830bD89Acc67eC4af516284b1bC33c/logo.png",
  "BTC": "https://assets.coingecko.com/coins/images/1/small/bitcoin.png",
  "WBTC": "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599/logo.png",
  "DAI": "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0x6B175474E89094C44Da98b954EedeAC495271d0F/logo.png",
  "UNI": "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984/logo.png",
  "AAVE": "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9/logo.png",
  "ARB": "https://assets.coingecko.com/coins/images/16547/small/photo_2023-03-29_21.47.00.jpeg",
  "OP": "https://assets.coingecko.com/coins/images/25244/small/Optimism.png",
  "MATIC": "https://assets.coingecko.com/coins/images/4713/small/polygon.png",
  "POL": "https://assets.coingecko.com/coins/images/4713/small/polygon.png",
  "AVAX": "https://assets.coingecko.com/coins/images/12559/small/Avalanche_Circle_RedWhite_Trans.png",
  "BNB": "https://assets.coingecko.com/coins/images/825/small/bnb-icon2_2x.png",
  "SOL": "https://assets.coingecko.com/coins/images/4128/small/solana.png",
  "DOGE": "https://assets.coingecko.com/coins/images/5/small/dogecoin.png",
  "SHIB": "https://assets.coingecko.com/coins/images/11939/small/shiba.png",
  "PEPE": "https://assets.coingecko.com/coins/images/29850/small/pepe-token.jpeg",
  "MKR": "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2/logo.png",
  "CRV": "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0xD533a949740bb3306d119CC777fa900bA034cd52/logo.png",
  "COMP": "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0xc00e94Cb662C3520282E6f5717214004A7f26888/logo.png",
  "LDO": "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0x5A98FcBEA516Cf06857215779Fd812CA3beF1B32/logo.png",
  "SNX": "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0xC011a73ee8576Fb46F5E1c5751cA3B9Fe0af2a6F/logo.png",
  "MON": "https://coin-images.coingecko.com/coins/images/38927/small/mon.png",
};

// Token logo resolver: Alchemy → known symbol → TrustWallet CDN fallback
const getTokenLogoUrl = (contractAddress: string, logoSrc?: string, symbol?: string, name?: string): string => {
  // 1. Use cached/Alchemy logo if available (skip broken local placeholders like /logos/eth.png)
  if (logoSrc && logoSrc.length > 0 && !logoSrc.startsWith("/logos/")) return logoSrc;

  // 2. Known tokens by symbol (case-insensitive)
  const symUpper = symbol?.toUpperCase();
  if (symUpper && KNOWN_LOGOS[symUpper]) return KNOWN_LOGOS[symUpper];
  if (symbol && KNOWN_LOGOS[symbol]) return KNOWN_LOGOS[symbol];
  if (contractAddress === "ETH" || name === "Ethereum") return KNOWN_LOGOS["ETH"];

  // 3. TrustWallet assets CDN fallback (requires checksummed address)
  //    Works for Ethereum mainnet tokens — most widely used
  if (contractAddress && contractAddress.startsWith("0x")) {
    try {
      const checksummed = getAddress(contractAddress);
      return `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/${checksummed}/logo.png`;
    } catch {
      return "";
    }
  }
  return "";
};


// Generate a deterministic color from a string
const stringToColor = (str: string): string => {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash % 360);
  return `hsl(${hue}, 55%, 50%)`;
};

/** Renders a balance value with Matrix-style scramble animation on privacy toggle */
export function MatrixBalance({ value, isHidden, variant = "h3" }: {
  value: string;
  isHidden: boolean;
  variant?: TypographyProps["variant"];
}) {
  const displayed = useMatrixText(value, isHidden);
  const theme = useTheme();
  const isDark = theme.palette.mode === 'dark';
  return (
    <Typography
      variant={variant}
      fontWeight="800"
      sx={{
        letterSpacing: -1,
        background: 'none',
        WebkitBackgroundClip: 'unset',
        WebkitTextFillColor: 'currentColor',
        color: 'text.primary',
        fontFamily: isHidden ? 'monospace' : 'inherit',
        transition: 'all 0.3s ease',
        userSelect: 'none',
        filter: 'none',
      }}
    >
      {displayed}
    </Typography>
  );
}

function Home() {
  const { t } = useTranslation();
  const theme = useTheme();
  const wallet_context = React.useContext(WalletContext);
  const active_context = React.useContext(ActiveAccountContext);
  const navigate = useNavigate();
  const { showToast } = useToast();

  const [balances, setBalances] = useState<BalanceMap>({});
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [tokens, setTokens] = useState<DisplayToken[]>(() => {
    try {
      const initialNetId = wallet_context?.networkProvider?.getActiveNetworkId() ?? NetworkId.Ethereum_Mainnet;
      const cached = wallet_context?.tokenCache?.getAllTokens(initialNetId) ?? [];
      return cached.map(t => ({ ...t, isShielded: false, isSpam: false, isSuspicious: false, isHidden: false, spamScore: 0 }));
    } catch { return []; }
  });
  const [totalBalanceUsd, setTotalBalanceUsd] = useState(0.00);
  const [prices, setPrices] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(false);
  // Persisted state: survives popup close/reopen
  const [isBalanceHidden, setIsBalanceHidden] = usePersistedState("balance_hidden", false);
  const [showHiddenTokens, setShowHiddenTokens] = useState(false);

  // Onboarding tour (first-time UX)
  const [showOnboarding, setShowOnboarding] = useState(() => !isOnboardingCompleted());
  const [showBackupReminder, setShowBackupReminder] = useState(() => !isBackupReminderDismissed());

  // Network Switcher State
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
  const openNetworkMenu = Boolean(anchorEl);

  const activeNetworkId = wallet_context?.networkProvider.getActiveNetworkId() ?? NetworkId.Ethereum_Mainnet;
  const activeNetwork = wallet_context?.networkProvider.getActiveNetwork();

  /** Tokens actually rendered: the native unit plus anything with a balance. */
  const visibleTokenCount = tokens.filter((tk) => {
    if (tk.isSpam || tk.isHidden) return false;
    if (tk.contractAddress === "ETH") return true;
    const bal = balances[tk.contractAddress];
    return !!bal && parseFloat(bal.tokenBalance) > 0;
  }).length;

  const handleNetworkClick = (event: React.MouseEvent<HTMLElement>) => {
    setAnchorEl(event.currentTarget);
  };

  /**
   * Stellar is chosen from the same menu as the EVM chains, but it is not one of them.
   *
   * `NetworkProvider` feeds ethers, the RPC client and the token list; a Stellar entry in
   * there would be a network most of the wallet cannot read. So the menu sets a view, the
   * active EVM network stays whatever it was, and switching back needs no repair.
   *
   * Remembered across navigation because a person who picked Stellar and walked to another
   * screen did not mean to pick Sepolia again on the way back.
   */
  const [stellarMode, setStellarMode] = useState(() => {
    try { return localStorage.getItem("arfhe_home_stellar") === "1"; } catch { return false; }
  });

  const chooseStellar = () => {
    setAnchorEl(null);
    setStellarMode(true);
    try { localStorage.setItem("arfhe_home_stellar", "1"); } catch { /* private mode */ }
  };

  const handleNetworkClose = (networkId: NetworkId | null) => {
    setAnchorEl(null);
    if (networkId && wallet_context) {
      setStellarMode(false);
      try { localStorage.removeItem("arfhe_home_stellar"); } catch { /* private mode */ }
      wallet_context.networkProvider.switchNetwork(networkId);
    }
  };

  const fetchData = async (forceRefresh = false) => {
    if (!wallet_context || !active_context) return;

    const net = wallet_context.networkProvider.getActiveNetwork();
    if (!net) return;

    const address = active_context.activeAccount?.GetAddress();
    if (!address) return;

    // ── Serve the cache first, then decide whether to refresh ──
    //
    // Stale-while-revalidate. Whatever was last fetched is painted immediately, however
    // old; only then does the network get involved. Waiting for the fetch before showing
    // anything is what emptied the token list and put a spinner in its place on every
    // navigation, every network switch and every reopen.
    const dataCache = wallet_context.dataCacheService;
    let servedFromCache = false;

    if (dataCache) {
      const entry = dataCache.getAllowStale(address, activeNetworkId);
      if (entry) {
        setBalances(entry.data.balances);
        setTokens(entry.data.tokens.map(t => ({
          name: t.name,
          symbol: t.symbol,
          logoSrc: t.logoSrc,
          contractAddress: t.contractAddress,
          decimals: t.decimals,
          isShielded: t.isShielded ?? false,
          isSpam: false,
          isSuspicious: false,
          isHidden: false,
          spamScore: 0,
        })));
        setPrices(entry.data.prices);
        setTotalBalanceUsd(entry.data.totalUsd);
        servedFromCache = true;

        // Fresh and nobody asked for a refresh — nothing left to do.
        if (!forceRefresh && !entry.isStale) return;
      }
    }

    // The skeleton is only for a genuinely empty screen. With figures already on it, the
    // refresh happens quietly underneath and the numbers change when they change.
    if (!servedFromCache) setLoading(true);

    try {

      // Connect the CoFHE SDK if this network has a coprocessor behind it.
      // Connecting is cheap and prompts for nothing — permits and FHE key loading are
      // both deferred until the user actually decrypts or encrypts something.
      const isFheNetwork = activeNetworkId === NetworkId.Ethereum_Sepolia || activeNetworkId === NetworkId.Arbitrum_Sepolia || activeNetworkId === NetworkId.Base_Sepolia;
      if (isFheNetwork && active_context.activeAccount) {
        try {
          const { default: FheCofheService } = await import("../backend/FheCofheService.js");
          const instance = FheCofheService.getInstance();

          if (!instance.isReadyForAccount(address, activeNetworkId)) {
            const ethers = await import("ethers");
            const provider = new ethers.JsonRpcProvider(net.rpc_url);
            const privateKey = active_context.activeAccount.private_key;
            if (!privateKey) throw new Error("No private key available");
            const signer = new ethers.Wallet(privateKey, provider);

            // networkId must be passed, or isReadyForAccount above never matches and
            // every render reconnects.
            await instance.init(provider, signer, activeNetworkId);
          }
        } catch (e) {
        }
      }

      // 1. Fetch Public Token Balances
      const tokenBalances = await net.getTokenBalances(
        wallet_context.tokenCache, address
      );

      // 2. Fetch Wrapped Token Balances (Only on Sepolia)
      const wrappedBalances: WrappedBalance[] = [];
      /** Underlying address per confidential wrapper, for pricing shielded rows. */
      const shieldedUnderlying = new Map<string, string>();
      const IGNORED_CONTRACTS = getHiddenTokenAddresses(activeNetworkId);

      // FHERC20 wrappers report `balanceOfIsIndicator() == true`; their ERC-20 balance is
      // a ~7984 activity counter, not a holding. Ask the contracts directly so wrappers
      // from earlier deployments are excluded too — an address list cannot know about them.
      try {
        const erc20Addresses = tokenBalances
          .filter((tb) => !tb.isNative && tb.contractAddress !== "ETH")
          .map((tb) => tb.contractAddress);
        const confidential = await net.filterConfidentialTokens(erc20Addresses);
        confidential.forEach((addr) => IGNORED_CONTRACTS.add(addr));
      } catch {
        // Detection unavailable — fall back to the static list alone.
      }

      if (isFheNetwork) {
        // Every confidential wrapper this account holds, resolved from the on-chain
        // registry rather than a fixed pair of addresses. Shielding an ERC-20 through the
        // factory used to produce a balance no screen could see, because only aeETH and
        // aeUSDC were ever queried.
        try {
          if (!active_context.activeAccount) throw new Error("No active account");
          const holdings = await net.getShieldedPortfolio(active_context.activeAccount);

          for (const h of holdings) {
            const addr = h.wrapper.toLowerCase();

            // The wrapper's own ERC-20 balance is the ~7984 activity counter, so it must
            // never be listed twice — the confidential row below is the real one.
            IGNORED_CONTRACTS.add(addr);
            if (h.underlying) shieldedUnderlying.set(addr, h.underlying.toLowerCase());

            wrappedBalances.push({
              contractAddress: addr,
              tokenBalance: h.balance,
              isNative: false,
              isShielded: true,
              decryptFailed: h.decryptFailed,
            });

            wallet_context.tokenCache.setToken(activeNetworkId, {
              name: `Shielded ${h.symbol.replace(/^ae/, "")}`,
              symbol: h.symbol,
              decimals: h.confidentialDecimals,
              logoSrc: "",
              contractAddress: addr,
            });
          }
        } catch (e) {
          // Registry unreachable — public balances still render.
        }
      }

      // Merge public + wrapped balances
      const allBalances = [...tokenBalances, ...wrappedBalances];

      // 3. Extract Contracts for price fetching — wrappers have no market of their own,
      // they are priced through the underlying token they hold.
      const contractAddresses = tokenBalances
        .map(t => t.contractAddress)
        .filter(addr => !IGNORED_CONTRACTS.has(addr.toLowerCase()));

      // --- IMMEDIATE RENDER ---
      // We render the tokens immediately with 0 price, then update later.
      const nativeSym = net.currency_symbol || "ETH";
      const nativeName = nativeSym === "ETH" ? "Ethereum" : nativeSym;
      const initialDisplay: DisplayToken[] = allBalances.map(tb => {
        const cachedMeta = wallet_context.tokenCache.getToken(activeNetworkId, tb.contractAddress);
        const sym = cachedMeta?.symbol ?? (tb.isNative ? nativeSym : "???");
        return {
          name: cachedMeta?.name ?? (tb.isNative ? nativeName : "Unknown Token"),
          symbol: sym,
          logoSrc: getTokenLogoUrl(tb.contractAddress, cachedMeta?.logoSrc, sym),
          contractAddress: tb.contractAddress,
          decimals: cachedMeta?.decimals ?? 18,
          isShielded: ('isShielded' in tb) ? tb.isShielded : false,
          isSpam: false,
          isSuspicious: false,
          isHidden: false,
          spamScore: 0,
        };
      });
      setTokens(initialDisplay); // Show list instantly

      // 3. Fetch Prices (Async/Non-blocking)
      let currentPrices: Record<string, number> = {};
      try {
        currentPrices = await net.getTokenPrices(contractAddresses);
      } catch (e) { /* silenced */ }

      // Symbol → USD, shared with the shielded rows below: a wrapper whose underlying the
      // user no longer holds publicly (because they shielded all of it) has no address to
      // price against, so its symbol is the only handle left.
      const symbolPriceMap: Record<string, number> = {};

      // Testnet & custom network price fallback: fetch mainnet prices and map known tokens by symbol
      if (activeNetworkId !== NetworkId.Ethereum_Mainnet) {
        try {
          // Collect all token symbols we need to price. A confidential wrapper is worth
          // what it holds, so "aeUSDC" is priced as "USDC".
          const allSymbols = new Set<string>();
          allBalances.forEach((tb) => {
            const meta = wallet_context.tokenCache.getToken(activeNetworkId, tb.contractAddress);
            const sym = meta?.symbol ?? (tb.isNative ? nativeSym : "");
            if (!sym) return;
            allSymbols.add(sym.toUpperCase());
            if (/^ae/.test(sym)) allSymbols.add(sym.slice(2).toUpperCase());
          });

          // Map of symbol → CoinGecko ID for well-known tokens
          const symbolToCoinGeckoId: Record<string, string> = {
            // Keys are matched uppercased; shielded symbols are normalised to their
            // underlying before lookup, so no "ae*" entries are needed here.
            "ETH": "ethereum", "WETH": "ethereum",
            "BTC": "bitcoin", "WBTC": "wrapped-bitcoin", "TBTC": "bitcoin",
            "USDC": "usd-coin", "WUSDC": "usd-coin",
            "USDT": "tether",
            "DAI": "dai",
            "LINK": "chainlink",
            "UNI": "uniswap",
            "AAVE": "aave",
            "ARB": "arbitrum",
            "OP": "optimism",
            "MATIC": "matic-network", "POL": "matic-network",
            "SOL": "solana",
            "AVAX": "avalanche-2",
            "BNB": "binancecoin",
            "EURC": "euro-coin",
            "MKR": "maker",
            "SNX": "havven",
            "COMP": "compound-governance-token",
            "CRV": "curve-dao-token",
            "LDO": "lido-dao",
            "PEPE": "pepe",
            "SHIB": "shiba-inu",
            "DOGE": "dogecoin",
            "MON": "monad",  // Monad testnet
          };

          // Determine which CoinGecko IDs we need to fetch
          const idsToFetch = new Set<string>();
          allSymbols.forEach(sym => {
            const cgId = symbolToCoinGeckoId[sym];
            if (cgId) idsToFetch.add(cgId);
          });

          // Also add native token symbol mapping
          const nativeSymUpper = nativeSym.toUpperCase();
          if (symbolToCoinGeckoId[nativeSymUpper]) {
            idsToFetch.add(symbolToCoinGeckoId[nativeSymUpper]);
          }

          // Always include ethereum for ETH-based networks
          idsToFetch.add("ethereum");

          if (idsToFetch.size > 0) {
            const idsParam = Array.from(idsToFetch).join(",");
            const ethRes = await fetch(`${getCoinGeckoBase()}/simple/price?ids=${idsParam}&vs_currencies=usd`);
            const ethJson = await ethRes.json();

            // Build symbol → price map from CoinGecko response
            for (const [sym, cgId] of Object.entries(symbolToCoinGeckoId)) {
              if (ethJson[cgId]?.usd !== undefined) {
                symbolPriceMap[sym] = ethJson[cgId].usd;
              }
            }

            // Set ETH price key for built-in networks
            if (ethJson.ethereum?.usd && currentPrices["ETH"] === undefined) {
              currentPrices["ETH"] = ethJson.ethereum.usd;
            }

            // Apply prices by matching token symbol from cache ONLY if not already priced
            allBalances.forEach((tb) => {
              const meta = wallet_context.tokenCache.getToken(activeNetworkId, tb.contractAddress);
              const symbol = meta?.symbol ?? (tb.isNative ? nativeSym : "");
              const key = tb.contractAddress.toLowerCase();
              const symUpper = symbol.toUpperCase();

              if (currentPrices[key] === undefined && symUpper && symbolPriceMap[symUpper] !== undefined) {
                currentPrices[key] = symbolPriceMap[symUpper];
              }
            });

            // Also set native price key by symbol for custom networks
            if (net.isCustom && symbolPriceMap[nativeSymUpper] !== undefined) {
              currentPrices[nativeSym] = symbolPriceMap[nativeSymUpper];
            }

          }
        } catch (e) {
        }
      }

      setPrices(currentPrices);

      // 4. Calculate Values & Update Display
      let totalUsd = 0;
      const balanceMap: Record<string, any> = {};

      // Process public token balances
      // For native token, use currency symbol as price key; for custom networks prices may not exist
      const nativePriceKey = nativeSym;  // e.g. "ETH", "MON", "MATIC" etc.
      tokenBalances.forEach((tb) => {
        // Confidential wrappers are handled by `wrappedBalances` below, which carries the
        // decrypted balance. Their ERC-20 balanceOf is an activity indicator (~7984.0001),
        // so letting it through here would both show a fake row and inflate the USD total.
        if (IGNORED_CONTRACTS.has(tb.contractAddress.toLowerCase())) return;

        let p = 0;
        if (tb.isNative) {
          if (net.isCustom) {
            // Custom networks: only use price if explicitly fetched for this symbol
            p = currentPrices[nativePriceKey] ?? 0;
          } else {
            p = currentPrices["ETH"] ?? 0;
          }
        } else {
          p = currentPrices[tb.contractAddress.toLowerCase()] ?? 0;
        }
        const valUsd = parseFloat(tb.tokenBalance) * p;
        totalUsd += valUsd;

        balanceMap[tb.contractAddress] = {
          ...tb,
          priceUsd: p,
          totalValueUsd: valUsd
        };
      });

      // Process wrapped token balances with price mapping.
      // A wrapper is worth exactly what it holds, so it is priced through its underlying:
      // the native wrapper tracks ETH, an ERC-20 wrapper tracks the token it wraps.
      wrappedBalances.forEach((wb) => {
        const addr = wb.contractAddress.toLowerCase();
        const underlying = shieldedUnderlying.get(addr);
        const meta = wallet_context.tokenCache.getToken(activeNetworkId, wb.contractAddress);
        const symbol = meta?.symbol ?? "";

        // Prefer the underlying's own price; fall back to its symbol, which is all that is
        // left once the user has shielded their entire public balance of that token.
        const underlyingSymbol = symbol.replace(/^ae/, "").toUpperCase();
        const p = underlying
          ? (currentPrices[underlying] ?? symbolPriceMap[underlyingSymbol] ?? 0)
          : (currentPrices["ETH"] ?? symbolPriceMap["ETH"] ?? 0);

        // A balance we could not decrypt contributes an unknown amount, not zero. Adding
        // it as zero would quietly understate the wallet's worth.
        const valUsd = wb.decryptFailed ? 0 : parseFloat(wb.tokenBalance) * p;
        if (!wb.decryptFailed) totalUsd += valUsd;

        balanceMap[wb.contractAddress] = {
          ...wb,
          priceUsd: p,
          totalValueUsd: valUsd
        };
      });

      setBalances(balanceMap);
      setTotalBalanceUsd(totalUsd);


      // ── Spam Filter + Display Data ──
      const spamFilter = wallet_context.spamFilter;
      const displayTokens: DisplayToken[] = [];

      Object.values(balanceMap).forEach((b) => {
        const lowerAddr = b.contractAddress.toLowerCase();
        // Hide superseded wrappers and indicator rows — but never the shielded entries,
        // which carry the decrypted confidential balance and are the whole point.
        if (!b.isShielded && IGNORED_CONTRACTS.has(lowerAddr)) return;

        const meta = wallet_context.tokenCache.getToken(activeNetworkId, lowerAddr) ||
          wallet_context.tokenCache.getToken(activeNetworkId, b.contractAddress);

        const tokenName = meta?.name ?? (b.isNative ? nativeName : "Token");
        const tokenSymbol = meta?.symbol ?? (b.isNative ? nativeSym : "???");
        const hasLogo = !!(meta?.logoSrc && meta.logoSrc.length > 0);

        // Run spam check (skip native tokens)
        const spamResult = (b.contractAddress !== "ETH" && b.contractAddress !== "NATIVE" && !b.isNative)
          ? spamFilter.checkToken(activeNetworkId, b.contractAddress, tokenSymbol, tokenName, meta?.decimals ?? 18, hasLogo, b.isAlchemySpam ?? false)
          : { isSpam: false, isSuspicious: false, isHidden: false, score: 0, reasons: [] };

        displayTokens.push({
          name: tokenName,
          symbol: tokenSymbol,
          logoSrc: meta?.logoSrc ?? "",
          contractAddress: b.contractAddress,
          decimals: meta?.decimals ?? 18,
          isShielded: b.isShielded ?? false,
          decryptFailed: b.decryptFailed ?? false,
          isSpam: spamResult.isSpam,
          isSuspicious: spamResult.isSuspicious,
          isHidden: spamResult.isHidden,
          spamScore: spamResult.score,
        });
      });

      // Mark all current contracts as "known" for next visit
      const allContracts = displayTokens
        .filter(t => t.contractAddress !== "ETH" && t.contractAddress !== "NATIVE")
        .map(t => t.contractAddress);
      spamFilter.markAllKnown(activeNetworkId, allContracts);

      // Sort tokens by USD value (highest to lowest)
      displayTokens.sort((a, b) => {
        const valA = balanceMap[a.contractAddress]?.totalValueUsd ?? 0;
        const valB = balanceMap[b.contractAddress]?.totalValueUsd ?? 0;
        return valB - valA;
      });

      setTokens(displayTokens);


      // ── Persist to cache for next mount ──
      // Clear any previous error on successful fetch
      setFetchError(null);
      if (dataCache) {
        const finalTokens = displayTokens.length > 0
          ? displayTokens.map(t => ({ ...t, isShielded: balanceMap[t.contractAddress]?.isShielded ?? false }))
          : Object.values(balanceMap).map((b) => ({
            name: wallet_context.tokenCache.getToken(activeNetworkId, b.contractAddress)?.name ?? (b.isNative ? nativeName : "Token"),
            symbol: wallet_context.tokenCache.getToken(activeNetworkId, b.contractAddress)?.symbol ?? (b.isNative ? nativeSym : "???"),
            logoSrc: wallet_context.tokenCache.getToken(activeNetworkId, b.contractAddress)?.logoSrc ?? "",
            contractAddress: b.contractAddress,
            decimals: 18,
            isShielded: b.isShielded ?? false
          }));
        dataCache.set(address, activeNetworkId, {
          balances: balanceMap,
          tokens: finalTokens,
          prices: currentPrices,
          totalUsd,
        });

        // Record what the wallet is worth, after the cache write — reading it before would
        // sum this network's *previous* total and leave every point one refresh behind.
        //
        // This is the only source the portfolio chart has; there is no backfill, so a
        // series exists only because these points were written as the wallet was used.
        // The cross-network total is what gets recorded rather than this network's: a
        // chart that jumped on every chain switch would describe navigation, not value.
        try {
          const known = wallet_context.networkProvider.listAllNetworks().map((n) => n.id);
          const cached = dataCache.getCachedNetworks(address, known);
          const acrossNetworks = cached.reduce((sum, entry) => sum + entry.data.totalUsd, 0);
          wallet_context.portfolioHistory?.record(address, acrossNetworks, cached.length);
        } catch {
          // History is a nicety; failing to append a point must not fail the refresh.
        }
      }

    } catch (err) {

      // Classify the error and show a user-friendly toast
      const classified = err instanceof NetworkError
        ? err.classified
        : classifyError(err);

      const errorMsg = t(classified.i18nKey, { defaultValue: getErrorFallbackMessage(classified.type) });

      setFetchError(errorMsg);

      // Show toast with retry action for retryable errors
      if (classified.retryable) {
        showToast(errorMsg, "error", {
          duration: 8000,
          actionLabel: t("common.retry"),
          onAction: () => {
            setFetchError(null);
            fetchData(true);
          },
          dedupeKey: "home-fetch-error",
        });
      } else {
        showToast(errorMsg, "error", {
          duration: 6000,
          dedupeKey: "home-fetch-error",
        });
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setFetchError(null);
    fetchData();
  }, [active_context?.activeAccount, activeNetworkId]);

  // Refetch the moment a transaction is mined.
  //
  // Without this the balance sat on its cached value for the rest of the TTL, so a send
  // looked like it had done nothing — the one moment a wallet must not appear stale. The
  // caches are already cleared by the time this fires, so the refetch reaches the network.
  useEffect(() => onTxConfirmed(() => { void fetchData(true); }), [active_context?.activeAccount, activeNetworkId]);

  // Movement over the last 24 hours, from the recorded series rather than anything derived
  // on the fly. Keyed on the total so it refreshes once a new point has been written.
  const dailyChange = useMemo(
    () => wallet_context?.portfolioHistory?.getDailyChange(
      active_context?.activeAccount?.GetAddress() ?? ""
    ) ?? { absolute: 0, percent: 0, since: Date.now(), hasBaseline: false },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [wallet_context?.portfolioHistory, active_context?.activeAccount, totalBalanceUsd]
  );

  if (!active_context) return null;

  return (
    <Box sx={{ pb: 3, maxWidth: 560, mx: 'auto' }}>

      <WalletModeSwitch mode="web3" />

      {/* Network Switcher & Header */}
      <Box sx={{ px: 2, pt: 2, pb: 1, gap: 1, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Button
          onClick={handleNetworkClick}
          endIcon={<ExpandMore />}
          sx={{
            bgcolor: 'background.paper',
            color: 'text.primary',
            borderRadius: 4,
            px: 2,
            boxShadow: '0 2px 8px rgba(0,0,0,0.05)',
            textTransform: 'none',
            fontWeight: 600
          }}
        >
          <Box sx={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            bgcolor: stellarMode ? '#7c3aed' :
              activeNetworkId === NetworkId.Ethereum_Mainnet ? '#10b981' :
                activeNetworkId === NetworkId.Ethereum_Sepolia ? '#f59e0b' :
                  activeNetworkId === NetworkId.Arbitrum_One ? '#2563eb' :
                    activeNetworkId === NetworkId.Arbitrum_Sepolia ? '#60a5fa' :
                      activeNetworkId === NetworkId.Base_Mainnet ? '#0052ff' :
                        activeNetworkId === NetworkId.Base_Sepolia ? '#93c5fd' :
                          activeNetworkId === NetworkId.Polygon ? '#8247e5' :
                            activeNetworkId === NetworkId.Optimism ? '#ff0420' :
                              activeNetworkId === NetworkId.Avalanche ? '#e84142' :
                                activeNetworkId === NetworkId.BNB_Chain ? '#f0b90b' :
                                  activeNetworkId === NetworkId.Linea ? '#61dfff' :
                                    activeNetworkId === NetworkId.Sei ? '#9b1c1c' :
                                      activeNetworkId === NetworkId.Monad_Testnet ? '#836ef9' :
                                        (wallet_context?.networkProvider?.getCustomNetworks()?.find(cn => cn.chainId === (activeNetworkId as number))?.iconColor) || '#404040',
            mr: 1
          }} />
          {stellarMode ? t('stellar.networkName') : activeNetwork?.network_name}
        </Button>
        <Menu
          anchorEl={anchorEl}
          open={openNetworkMenu}
          onClose={() => handleNetworkClose(null)}
          PaperProps={{ sx: { borderRadius: 3, mt: 1, minWidth: 200, maxHeight: 400 } }}
        >
          {/* ── Testnets ── */}
          <MenuItem disabled sx={{ opacity: 0.6, fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1, py: 0.5, minHeight: 0 }}>
            Testnets
          </MenuItem>
          {/* The three chains CoFHE runs on. Confidential features light up on each once
              its wrappers are deployed; everything else works regardless. */}
          <MenuItem onClick={() => handleNetworkClose(NetworkId.Ethereum_Sepolia)}>
            <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: '#f59e0b', mr: 1 }} /> Eth Sepolia
          </MenuItem>
          <MenuItem onClick={() => handleNetworkClose(NetworkId.Arbitrum_Sepolia)}>
            <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: '#60a5fa', mr: 1 }} /> Arbitrum Sepolia
          </MenuItem>
          <MenuItem onClick={() => handleNetworkClose(NetworkId.Base_Sepolia)}>
            <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: '#93c5fd', mr: 1 }} /> Base Sepolia
          </MenuItem>

          {/* Not an EVM chain, so it sits under its own heading rather than pretending to
              be one more row in a list of chain ids. */}
          <Divider sx={{ my: 0.5 }} />
          <MenuItem disabled sx={{ opacity: 0.6, fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1, py: 0.5, minHeight: 0 }}>
            {t('stellar.menuHeading')}
          </MenuItem>
          <MenuItem onClick={chooseStellar} selected={stellarMode}>
            <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: '#7c3aed', mr: 1 }} /> {t('stellar.networkName')}
          </MenuItem>

          {/* Custom Networks */}
          {(wallet_context?.networkProvider?.getCustomNetworks() ?? []).length > 0 && (
            <Divider sx={{ my: 0.5 }} />
          )}
          {(wallet_context?.networkProvider?.getCustomNetworks() ?? []).map((cn) => (
            <MenuItem key={cn.chainId} onClick={() => handleNetworkClose(cn.chainId as NetworkId)}>
              <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: cn.iconColor || '#404040', mr: 1 }} />
              {cn.networkName}
            </MenuItem>
          ))}
        </Menu>

        <IconButton
          onClick={() => { setFetchError(null); fetchData(true); }}
          disabled={loading}
          aria-label={t('home.refreshBalances')}
          sx={{
            bgcolor: 'background.paper',
            ml: 1,
            '& svg': {
              animation: loading ? 'spin 1.5s linear infinite' : 'none'
            },
            '@keyframes spin': {
              '0%': { transform: 'rotate(0deg)' },
              '100%': { transform: 'rotate(360deg)' }
            }
          }}
        >
          <Refresh />
        </IconButton>
      </Box>

      {stellarMode && <StellarNetworkPanel />}

      {/* The EVM body is hidden rather than unmounted: it holds fetched balances and the
          token list, and tearing it down on every switch would re-fetch them for nothing. */}
      <Box sx={{ display: stellarMode ? 'none' : 'block' }}>

      {/* 1. Main Balance Card */}
      <Box sx={{ p: 2, pt: 1 }}>
        <Paper elevation={0} sx={{
          p: 0,
          borderRadius: '20px',
          background: `linear-gradient(145deg, ${theme.palette.background.paper}, ${alpha(theme.palette.primary.main, 0.06)})`,
          color: 'text.primary',
          boxShadow: 'none',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          position: 'relative',
          overflow: 'hidden',
          mb: 1,
          border: '1px solid',
          borderColor: 'divider',
        }}>

          {/* ── Card content ─────────────────────────────────── */}
          <Box sx={{ position: 'relative', zIndex: 2, p: 2.5, width: '100%', textAlign: 'center' }}>
            {/* Total Balance label with subtle icon */}
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 0.75, mb: 0.75 }}>
              <Box sx={{
                width: 6,
                height: 6,
                borderRadius: '0px',
                bgcolor: 'text.primary',
                boxShadow: 'none',
              }} />
              <Typography variant="body2" sx={{
                color: 'text.primary',
                fontWeight: 600,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                fontSize: '0.7rem',
                opacity: 0.8,
              }}>
                {t('home.totalBalance')}
              </Typography>
            </Box>

            {/* Balance with Matrix privacy toggle */}
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 0.5, '& h3': { fontSize: 'clamp(1.6rem, 8vw, 2.6rem)', overflowWrap: 'anywhere', minWidth: 0 } }}>
              <MatrixBalance
                value={`$${totalBalanceUsd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
                isHidden={isBalanceHidden}
                variant="h3"
              />
              <Tooltip title={isBalanceHidden ? t('home.showBalance') : t('home.hideBalance')}>
                <IconButton
                  size="small"
                  onClick={() => setIsBalanceHidden(!isBalanceHidden)}
                  aria-label={isBalanceHidden ? t('home.showBalance') : t('home.hideBalance')}
                  sx={{
                    color: 'text.primary',
                    opacity: 0.8,
                    transition: 'none',
                    borderRadius: '0px',
                    '&:hover': {
                      opacity: 1,
                      bgcolor: 'action.hover',
                    },
                  }}
                >
                  {isBalanceHidden ? <Visibility fontSize="small" /> : <VisibilityOff fontSize="small" />}
                </IconButton>
              </Tooltip>
            </Box>

            {/* How the wallet moved today, in money and in percent. Neither answers the
                question alone: a percentage hides how much moved, an amount hides whether
                that was a lot. */}
            <Box sx={{ display: 'flex', justifyContent: 'center', mt: 0.75 }}>
              <DailyChangeBadge {...dailyChange} hidden={isBalanceHidden} compact />
            </Box>

            <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 1, mt: 2.5 }}>
              <Button variant="contained" startIcon={<SendOutlined />}
                onClick={() => window.dispatchEvent(new CustomEvent('open-arf-menu', { detail: { tab: 0 } }))}
                sx={{ minHeight: 44, borderRadius: '12px', textTransform: 'none', fontWeight: 700 }}>
                {t('common.send')}
              </Button>
              <Button variant="outlined" startIcon={<CallReceivedOutlined />}
                onClick={() => window.dispatchEvent(new CustomEvent('open-arf-menu', { detail: { tab: 1 } }))}
                sx={{ minHeight: 44, borderRadius: '12px', textTransform: 'none', fontWeight: 700 }}>
                {t('common.receive')}
              </Button>
            </Box>

            {/* Action Buttons */}
            <Box sx={{ display: 'flex', justifyContent: 'center', gap: 1, mt: 1, flexWrap: 'wrap' }}>
              {/* Everything confidential lives behind this: what is shielded, what is
                  still owed from an interrupted unshield, and the shield form itself.
                  It takes the slot Portfolio used to hold — Portfolio moved next to the
                  asset tabs below, where a breakdown of holdings actually belongs. */}
              <Button
                variant="contained"
                onClick={() => navigate('/privacy')}
                startIcon={<Shield sx={{ fontSize: 14 }} />}
                sx={{
                  bgcolor: 'transparent',
                  color: 'text.primary',
                  boxShadow: 'none',
                  border: '1px solid',
                  borderColor: 'divider',
                  borderRadius: '10px',
                  minHeight: 40,
                  textTransform: 'none',
                  fontWeight: 600,
                  fontSize: '0.75rem',
                  px: 2,
                  py: 0.5,
                  transition: 'none',
                  '&:hover': {
                    bgcolor: 'action.hover',
                    borderColor: 'text.primary',
                    boxShadow: 'none',
                  },
                }}
              >
                {t('privacy.title')}
              </Button>
              <Button
                variant="contained"
                onClick={() => navigate('/revoke')}
                startIcon={<LinkOff sx={{ fontSize: 14 }} />}
                sx={{
                  bgcolor: 'transparent',
                  color: 'text.primary',
                  boxShadow: 'none',
                  border: '1px solid',
                  borderColor: 'divider',
                  borderRadius: '10px',
                  minHeight: 40,
                  textTransform: 'none',
                  fontWeight: 600,
                  fontSize: '0.75rem',
                  px: 2,
                  py: 0.5,
                  transition: 'none',
                  '&:hover': {
                    bgcolor: 'action.hover',
                    borderColor: 'text.primary',
                    boxShadow: 'none',
                  },
                }}
              >
                {t('revoke.title')}
              </Button>
            </Box>
          </Box>
        </Paper>
      </Box>

      {/* Backup Reminder Banner */}
      {showBackupReminder && !showOnboarding && (
        <BackupReminderBanner
          onBackup={() => {
            setShowBackupReminder(false);
            dismissBackupReminder();
            navigate('/settings/security');
          }}
          onDismiss={() => {
            setShowBackupReminder(false);
            dismissBackupReminder();
          }}
        />
      )}

      {/* Network Error Banner */}
      {fetchError && !loading && (
        <Box sx={{ px: 2, mb: 1 }}>
          <Paper
            elevation={0}
            sx={{
              p: 2,
              borderRadius: 3,
              bgcolor: alpha(theme.palette.error.main, 0.08),
              border: `1px solid ${alpha(theme.palette.error.main, 0.2)}`,
              display: 'flex',
              alignItems: 'center',
              gap: 1.5,
            }}
          >
            <WarningAmber sx={{ color: 'error.main', fontSize: 20 }} />
            <Typography variant="body2" color="error.main" sx={{ flex: 1, fontWeight: 600, fontSize: '0.78rem' }}>
              {fetchError}
            </Typography>
            <Button
              size="small"
              variant="outlined"
              color="error"
              onClick={() => { setFetchError(null); fetchData(true); }}
              startIcon={<Refresh sx={{ fontSize: 14 }} />}
              sx={{
                borderRadius: 2,
                textTransform: 'none',
                fontWeight: 700,
                fontSize: '0.72rem',
                minWidth: 'auto',
                px: 1.5,
              }}
            >
              {t("common.retry")}
            </Button>
          </Paper>
        </Box>
      )}

      {/* The standing list of connected sites — WalletConnect sessions included — moved to
          the Revoke page, which is where reviewing them belongs and where they were already
          listed. What is left here is one line about the tab the user is looking at right
          now; it is fixed above the bottom bar rather than in this flow. */}
      <ActiveDAppBar />

      {/* 3. Assets Tab List */}
      <Box sx={{ px: 2 }}>
        {/* One list, so no tab strip. The NFT gallery is out for the testnet release —
            it depends on the indexer, which user-added chains do not have. */}
        <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 1 }}>
          <Stack direction="row" spacing={1} alignItems="center">
            <Typography variant="subtitle2" fontWeight={800} sx={{ fontSize: '0.85rem' }}>
              {t('home.tokens')}
            </Typography>
            {visibleTokenCount > 0 && (
              <Chip
                label={visibleTokenCount}
                size="small"
                sx={{ height: 18, fontSize: '0.65rem', fontWeight: 800, bgcolor: 'transparent', border: '1px solid', borderColor: 'divider', color: 'text.primary', borderRadius: '0px' }}
              />
            )}
          </Stack>
          <Tooltip title={t('home.portfolio')}>
            <IconButton
              size="small"
              onClick={() => navigate('/portfolio')}
              aria-label={t('home.portfolio')}
              sx={{ borderRadius: '0px', color: 'text.primary', opacity: 0.6, '&:hover': { opacity: 1 } }}
            >
              <TrendingUp sx={{ fontSize: 18 }} />
            </IconButton>
          </Tooltip>
        </Stack>

        <Box>
            {(() => {
              // The balance provider returns every token it has ever seen for this
              // address, which buries the few that matter. Keep the native token (it is
              // the network's unit of account even at zero) and anything with a balance.
              const hasBalance = (tk: DisplayToken) => {
                if (tk.contractAddress === "ETH") return true;
                // A confidential balance that could not be decrypted reads as "0.0". It is
                // not zero — it is unknown, and the ciphertext proving it exists is on
                // chain. Filtering it out here is what made shielded tokens disappear from
                // the wallet after a coprocessor hiccup or an expired permit.
                if (tk.decryptFailed) return true;
                const bal = balances[tk.contractAddress];
                return !!bal && parseFloat(bal.tokenBalance) > 0;
              };

              const held = tokens.filter(hasBalance);
              const visibleTokens = held.filter((t) => !t.isSpam && !t.isHidden);
              const hiddenTokens = held.filter((t) => t.isSpam || t.isHidden);
              const displayList = showHiddenTokens ? held : visibleTokens;

              return (
                <>
                  {displayList.map((token, idx: number) => {
                    const b = balances[token.contractAddress];
                    const rawBalance = b ? parseFloat(b.tokenBalance) : 0;
                    const balanceStr = token.decryptFailed
                      ? t('privacy.couldNotDecrypt')
                      : rawBalance > 0
                        ? (rawBalance < 0.0001 ? '<0.0001' : rawBalance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 }))
                        : '0';
                    const valUsd = b?.totalValueUsd ?? 0;
                    const valStr = token.decryptFailed
                      ? '—'
                      : valUsd > 0 ? `$${valUsd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '$0.00';

                    return (
                      <AssetItem
                        key={`${token.contractAddress}-${idx}`}
                        symbol={token.symbol}
                        name={token.name}
                        balance={isBalanceHidden ? '•••••' : balanceStr}
                        value={isBalanceHidden ? '$•••••' : valStr}
                        icon={getTokenLogoUrl(token.contractAddress, token.logoSrc, token.symbol, token.name)}
                        isShielded={token.isShielded ?? false}
                        isLast={idx === displayList.length - 1}
                        isSuspicious={token.isSuspicious ?? false}
                        isSpamHidden={token.isSpam || token.isHidden}
                        onClick={() => navigate(`/token/${encodeURIComponent(token.contractAddress)}`, {
                          state: { logoSrc: getTokenLogoUrl(token.contractAddress, token.logoSrc, token.symbol, token.name) }
                        })}
                      />
                    );
                  })}
                  {visibleTokens.length === 0 && loading && (
                    <TokenListSkeleton rows={5} />
                  )}
                  {visibleTokens.length === 0 && !loading && (
                    <Box sx={{
                      textAlign: 'center',
                      py: 6,
                      px: 3,
                      bgcolor: 'background.paper',
                      borderRadius: 3,
                      border: '1px dashed',
                      borderColor: 'divider'
                    }}>
                      <Typography variant="body2" color="text.secondary" fontWeight={500}>
                        {t('home.noAssets')}
                      </Typography>
                    </Box>
                  )}

                  {/* Hidden token toggle */}
                  {hiddenTokens.length > 0 && (
                    <Box sx={{ mt: 1, display: 'flex', justifyContent: 'center' }}>
                      <Button
                        variant="text"
                        size="small"
                        color="warning"
                        startIcon={showHiddenTokens ? <VisibilityOff /> : <VisibilityOffOutlined />}
                        onClick={() => setShowHiddenTokens(!showHiddenTokens)}
                        sx={{ fontWeight: 600, fontSize: '0.75rem', textTransform: 'none' }}
                      >
                        {showHiddenTokens ? t('home.hideSpamTokens') : t('home.hiddenSpamCount', { count: hiddenTokens.length })}
                      </Button>
                    </Box>
                  )}
                </>
              );
            })()}

            {/* No "import a token" button. A token the account holds shows up on its own —
                balance discovery walks the chain for anything with a non-zero balance — so
                the button existed to solve a problem the wallet does not have. What it did
                instead was invite people to paste an address they were given, which is how
                a fake token with a real token's name ends up in a wallet looking legitimate. */}
        </Box>

      </Box>

      </Box>

      {/* Onboarding Tour (first-time users) */}
      <OnboardingTour
        open={showOnboarding}
        onClose={() => setShowOnboarding(false)}
      />

    </Box>
  );
}

export function AssetItem({ symbol, name, balance, value, icon, isShielded = false, isLast = false, isSuspicious = false, isSpamHidden = false, onToggleHide, onClick }: {
  symbol: string,
  name: string,
  balance: string,
  value: string,
  icon: string,
  isShielded?: boolean,
  isLast?: boolean,
  isSuspicious?: boolean,
  isSpamHidden?: boolean,
  onToggleHide?: () => void,
  onClick?: () => void,
}) {
  const { t } = useTranslation();
  const [imgError, setImgError] = useState(false);
  const fallbackColor = stringToColor(symbol || name);

  return (
    <Box
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={(event: React.KeyboardEvent) => {
        if (event.target !== event.currentTarget) return;
        if (onClick && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault();
          onClick();
        }
      }}
      onClick={onClick}
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1.5,
        px: 1.5,
        py: 1.5,
        minHeight: 72,
        borderRadius: 2.5,
        cursor: onClick ? 'pointer' : 'default',
        transition: 'background-color 0.15s ease, opacity 0.2s ease',
        opacity: isSpamHidden ? 0.45 : 1,
        '&:hover': {
          bgcolor: 'action.hover',
        },
        ...(!isLast && {
          borderBottom: '1px solid',
          borderColor: 'divider',
        })
      }}
    >
      {/* Token Logo */}
      <Box sx={{ position: 'relative', flexShrink: 0 }}>
        <Avatar
          src={!imgError ? icon : undefined}
          onError={() => setImgError(true)}
          sx={{
            width: 36,
            height: 36,
            bgcolor: imgError || !icon ? fallbackColor : 'transparent',
            color: '#fff',
            fontSize: '1rem',
            fontWeight: 700,
            border: '2px solid',
            borderColor: 'divider',
          }}
        >
          {(imgError || !icon) && (symbol ? symbol.substring(0, 2) : '?')}
        </Avatar>
        {isShielded && (
          <Box sx={{
            position: 'absolute',
            bottom: -2,
            right: -2,
            width: 16,
            height: 16,
            borderRadius: '50%',
            bgcolor: '#10b981',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            border: '2px solid',
            borderColor: 'background.default',
          }}>
            <Shield sx={{ fontSize: 9, color: '#fff' }} />
          </Box>
        )}
      </Box>

      {/* Token Info */}
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, flexWrap: 'wrap' }}>
          <Typography
            variant="body2"
            sx={{ fontWeight: 700, color: 'text.primary', letterSpacing: '-0.01em' }}
          >
            {symbol}
          </Typography>
          {isShielded && (
            <Chip
              label={t('home.private')}
              size="small"
              sx={{
                height: 18,
                fontSize: '0.6rem',
                fontWeight: 700,
                bgcolor: 'rgba(16, 185, 129, 0.12)',
                color: '#10b981',
                '& .MuiChip-label': { px: 0.75 },
              }}
            />
          )}
          {isSuspicious && !isSpamHidden && (
            <Chip
              icon={<WarningAmber sx={{ fontSize: '0.7rem !important' }} />}
              label={t('home.suspicious')}
              size="small"
              sx={{
                height: 18,
                fontSize: '0.58rem',
                fontWeight: 700,
                bgcolor: 'rgba(245, 158, 11, 0.12)',
                color: '#f59e0b',
                '& .MuiChip-label': { px: 0.5 },
                '& .MuiChip-icon': { color: '#f59e0b', ml: 0.3 },
              }}
            />
          )}
          {isSpamHidden && (
            <Chip
              label={t('home.spam')}
              size="small"
              sx={{
                height: 18,
                fontSize: '0.58rem',
                fontWeight: 700,
                bgcolor: 'rgba(239, 68, 68, 0.12)',
                color: '#ef4444',
                '& .MuiChip-label': { px: 0.5 },
              }}
            />
          )}
        </Box>
        <Typography
          variant="caption"
          sx={{
            color: 'text.secondary',
            display: 'block',
            lineHeight: 1.3,
            fontSize: '0.72rem',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {name}
        </Typography>
      </Box>

      {/* Balance & Value */}
      <Box sx={{ textAlign: 'right', minWidth: 0, maxWidth: '48%', overflowWrap: 'anywhere', fontVariantNumeric: 'tabular-nums' }}>
        <Typography
          variant="body2"
          sx={{ fontWeight: 700, color: isSpamHidden ? 'text.disabled' : 'text.primary', letterSpacing: '-0.01em', lineHeight: 1.3 }}
        >
          {value}
        </Typography>
        <Typography
          variant="caption"
          sx={{
            color: 'text.secondary',
            fontSize: '0.72rem',
            lineHeight: 1.3,
          }}
        >
          {balance} {symbol}
        </Typography>
      </Box>

      {/* Hide/Unhide Toggle */}
      {onToggleHide && (
        <Tooltip title={isSpamHidden ? "Show token" : "Hide token"} arrow>
          <IconButton
            size="small"
            onClick={(e) => { e.stopPropagation(); onToggleHide(); }}
            aria-label={isSpamHidden ? "Show token" : "Hide token"}
            sx={{
              ml: 0.5,
              flexShrink: 0,
              width: 28,
              height: 28,
              color: isSpamHidden ? 'text.disabled' : 'text.secondary',
              '&:hover': { color: 'warning.main' },
            }}
          >
            {isSpamHidden ? <Visibility sx={{ fontSize: 16 }} /> : <VisibilityOffOutlined sx={{ fontSize: 16 }} />}
          </IconButton>
        </Tooltip>
      )}
    </Box>
  );
}

export default Home;