import React, { useState, useEffect, useContext, useCallback } from 'react';
import {
  Paper,
  Typography,
  Box,
  Button,
  CircularProgress,
  Chip,
  Alert,
  Snackbar,
  LinearProgress,
  Avatar,
  Stack,
  Divider,
  Tooltip,
  IconButton,
  useTheme,
  alpha
} from '@mui/material';
import {
  ArrowBack,
  QrCode,
  RefreshRounded,
  SearchRounded,
  LinkOffRounded,
  LanguageRounded,
  AccessTimeRounded,
  CheckCircleOutlineRounded,
  ShieldRounded,
  WarningAmberRounded,
  GppBadRounded,
  GppGoodRounded,
  SecurityRounded,
} from '@mui/icons-material';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { WalletContext } from '../AppContext';
import { useHuntState } from "../components/HuntStateProvider";
import ScanDialog from "../components/panels/ScanDialog";
import { formatUnits, Interface, MaxUint256, JsonRpcProvider, Contract, Log } from 'ethers';
import type { WCSessionInfo, WCNamespace } from '../types/index';
import type { SitePermission } from '../backend/SitePermissionService.js';

// ERC20 ABI
const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function name() view returns (string)"
];

// Common spenders (DEXs, protocols, etc.)
const COMMON_SPENDERS = [
  { address: '0x7a250d5630b4cF539739dF2C5dAcb4c659F2488D', name: 'Uniswap V2 Router' },
  { address: '0xE592427A0AEce92De3Edee1F18E0157C05861564', name: 'Uniswap V3 Router' },
  { address: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45', name: 'Uniswap Universal Router' },
  { address: '0xC532a74256D3Db42D0Bf7a0400fEFDbad7694008', name: 'Uniswap Sepolia Router' },
  { address: '0x1111111254EEB25477B68fb85Ed929f73A960582', name: '1inch V5 Router' },
  { address: '0xDef1C0ded9bec7F1a1670819833240f027b25EfF', name: '0x Exchange Proxy' },
  { address: '0x000000000022D473030F116dDEE9F6B43aC78BA3', name: 'Permit2' },
];

interface TokenApproval {
  tokenAddress: string;
  tokenName: string;
  tokenSymbol: string;
  tokenDecimals: number;
  spenderAddress: string;
  spenderName: string;
  allowance: string;
  allowanceRaw: bigint;
  isUnlimited: boolean;
  riskScore: number;       // 0-100
  riskLevel: 'critical' | 'high' | 'medium' | 'low';
  riskReasons: string[];   // List of reasons contributing to risk
}

// ─── Risk Score Calculation ─────────────────────────────────────
function calculateApprovalRisk(
  allowanceRaw: bigint,
  isUnlimited: boolean,
  spenderAddress: string,
  tokenDecimals: number,
  /** False when the token would not report `decimals()`, so the size is unverified. */
  decimalsKnown: boolean = true,
): { score: number; level: 'critical' | 'high' | 'medium' | 'low'; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];

  // 1. Unlimited approval (+50 points)
  if (isUnlimited) {
    score += 50;
    reasons.push('Unlimited approval — spender can drain all tokens');
  } else if (!decimalsKnown) {
    // Scoring an amount whose scale is unknown would be guessing, and guessing low is the
    // dangerous direction. An unsized allowance is treated as significant until the token
    // says otherwise.
    score += 35;
    reasons.push('Token does not report its decimals — the allowance size cannot be verified');
  } else {
    // Large but finite approval
    const allowanceFloat = Number(allowanceRaw) / Math.pow(10, tokenDecimals);
    if (allowanceFloat > 1_000_000) {
      score += 35;
      reasons.push(`Very large allowance (${allowanceFloat.toLocaleString()} tokens)`);
    } else if (allowanceFloat > 10_000) {
      score += 20;
      reasons.push(`Significant allowance (${allowanceFloat.toLocaleString()} tokens)`);
    } else if (allowanceFloat > 100) {
      score += 10;
      reasons.push('Moderate allowance');
    } else {
      score += 5;
      reasons.push('Small allowance');
    }
  }

  // 2. Unknown spender (+30 points)
  const isKnownSpender = COMMON_SPENDERS.some(
    s => s.address.toLowerCase() === spenderAddress.toLowerCase()
  );
  if (!isKnownSpender) {
    score += 30;
    reasons.push('Unknown/unverified spender contract');
  } else {
    score += 5;
    reasons.push('Known protocol spender');
  }

  // 3. Base risk for any active approval (+10)
  score += 10;

  // Cap at 100
  score = Math.min(score, 100);

  // Determine level
  let level: 'critical' | 'high' | 'medium' | 'low';
  if (score >= 75) level = 'critical';
  else if (score >= 50) level = 'high';
  else if (score >= 30) level = 'medium';
  else level = 'low';

  return { score, level, reasons };
}

type RiskLevel = 'critical' | 'high' | 'medium' | 'low';

/**
 * Risk level → colour and icon.
 *
 * The only palette this page keeps of its own. Severity is the one thing here that the
 * wallet's divider-and-paper surface genuinely cannot say, and the labels are translated at
 * render rather than stored, so this stays a visual table.
 */
const RISK_CONFIG = {
  critical: { color: '#dc2626', bg: '#dc262615', label: 'Critical', icon: GppBadRounded },
  high: { color: '#ef4444', bg: '#ef444412', label: 'High Risk', icon: WarningAmberRounded },
  medium: { color: '#f59e0b', bg: '#f59e0b10', label: 'Medium', icon: ShieldRounded },
  low: { color: '#22c55e', bg: '#22c55e10', label: 'Low Risk', icon: GppGoodRounded },
};

// ============================================
// 🔧 PURE ETHERS.JS APPROVAL SCANNER SERVICE
// ============================================
class RevokeService {
  private provider: JsonRpcProvider;
  private approvalTopic = '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925'; // keccak256("Approval(address,address,uint256)")

  constructor(rpcUrl: string) {
    this.provider = new JsonRpcProvider(rpcUrl);
  }

  /**
   *  Ana fonksiyon: Kullanıcının tüm token approval'larını tara
   * @param ownerAddress - Cüzdan adresi (0x...)
   * @param scanDepth - Kaç blok geriye taranacak (varsayılan: 10,000 blok)
   * @param onProgress - Progress callback (0-100)
   */
  async scanApprovals(
    ownerAddress: string,
    scanDepth: number = 10000,
    onProgress?: (progress: number, message: string) => void
  ): Promise<TokenApproval[]> {

    // Blok numaralarını hesapla
    const latestBlock = await this.provider.getBlockNumber();
    const startBlock = Math.max(0, latestBlock - scanDepth);
    const endBlock = latestBlock;

    // Owner topic (indexed parameter)
    const ownerTopic = '0x' + ownerAddress.slice(2).toLowerCase().padStart(64, '0');

    // STEP 1: Tüm Approval eventlerini tara (CHUNKED - Alchemy Free tier için)
    const CHUNK_SIZE = 10; // Alchemy Free tier max 10 blok
    const allLogs: Log[] = [];
    const totalChunks = Math.ceil((endBlock - startBlock) / CHUNK_SIZE);

    // Progress tracking
    let processedChunks = 0;

    for (let currentBlock = startBlock; currentBlock <= endBlock; currentBlock += CHUNK_SIZE) {
      const chunkEnd = Math.min(currentBlock + CHUNK_SIZE - 1, endBlock);

      try {
        const chunkLogs = await this.provider.getLogs({
          topics: [this.approvalTopic, ownerTopic],
          fromBlock: currentBlock,
          toBlock: chunkEnd
        });

        allLogs.push(...chunkLogs);
        processedChunks++;

        // 🔥 Gerçek zamanlı progress güncelle!
        const progressPercent = Math.round((processedChunks / totalChunks) * 70); // 0-70% (STEP 1)
        const progressMessage = `Scanning blocks... ${processedChunks}/${totalChunks} chunks`;

        if (onProgress) {
          onProgress(30 + progressPercent, progressMessage); // 30-100% aralığı
        }

      } catch (err) {
        // Continue with next chunk
      }
    }

    if (allLogs.length === 0) {
      return [];
    }

    // STEP 2: Token adreslerini grupla
    const tokenAddresses = new Set<string>();
    allLogs.forEach(log => {
      if (log.address) {
        tokenAddresses.add(log.address.toLowerCase());
      }
    });

    // STEP 3: Her token için en güncel approval'ları bul
    const approvals: TokenApproval[] = [];
    let processedCount = 0;

    for (const tokenAddress of tokenAddresses) {
      processedCount++;

      try {
        // Token metadata çek (symbol, decimals, name)
        const tokenContract = new Contract(tokenAddress, ERC20_ABI, this.provider);

        // A token that will not report its decimals cannot have its allowance sized.
        // Assuming 18 was the quiet failure mode here: a 6-decimal allowance rendered as
        // 18-decimal looks a million times smaller, so a dangerous approval scores as a
        // trivial one. The unknown case is tracked and treated as unsized instead.
        const [symbol, rawDecimals, name] = await Promise.all([
          tokenContract.symbol().catch(() => 'UNKNOWN'),
          tokenContract.decimals().catch(() => null),
          tokenContract.name().catch(() => 'Unknown Token')
        ]);
        const decimalsKnown = rawDecimals !== null && rawDecimals !== undefined;
        const decimals = decimalsKnown ? Number(rawDecimals) : 18;

        // Bu token için tüm approval loglarını filtrele
        const tokenLogs = allLogs.filter((log) => log.address.toLowerCase() === tokenAddress);

        // Spender'ları grupla ve en son logu al
        const latestApprovals = this.getLatestApprovalsPerSpender(tokenLogs);

        // Her spender için güncel allowance kontrolü
        for (const [spenderAddress, log] of latestApprovals.entries()) {
          try {
            // allowance(owner, spender) çağrısı
            const currentAllowance = await tokenContract.allowance(ownerAddress, spenderAddress);

            // Sıfırsa (iptal edilmiş), atla
            if (currentAllowance === 0n) {
              continue;
            }

            // Unlimited mı kontrol et
            const isUnlimited = currentAllowance >= MaxUint256 / 2n;
            const allowanceFormatted = isUnlimited
              ? '∞ UNLIMITED'
              : decimalsKnown
                ? formatUnits(currentAllowance, decimals)
                : `${currentAllowance.toString()} (raw)`;

            // Spender ismini bul (varsa)
            const spenderInfo = COMMON_SPENDERS.find(
              s => s.address.toLowerCase() === spenderAddress.toLowerCase()
            );
            const spenderName = spenderInfo?.name || `Contract ${spenderAddress.slice(0, 6)}...`;

            const risk = calculateApprovalRisk(currentAllowance, isUnlimited, spenderAddress, decimals, decimalsKnown);

            approvals.push({
              tokenAddress,
              tokenName: name,
              tokenSymbol: symbol,
              tokenDecimals: decimals,
              spenderAddress,
              spenderName,
              allowance: `${allowanceFormatted} ${symbol}`,
              allowanceRaw: currentAllowance,
              isUnlimited,
              riskScore: risk.score,
              riskLevel: risk.level,
              riskReasons: risk.reasons,
            });

          } catch (err) {
          }
        }

      } catch (err) {
      }
    }

    return approvals;
  }

  /**
   * 🎯 Her spender için en son (en güncel) approval'ı döndür
   * Aynı spender için birden fazla log varsa, sadece en son blok numaralısını al
   */
  private getLatestApprovalsPerSpender(logs: Log[]): Map<string, Log> {
    const spenderMap = new Map<string, Log>();

    logs.forEach(log => {
      if (!log.topics || log.topics.length < 3) return;

      // Spender adresi topic[2]'de (indexed parameter)
      const spenderAddress = ('0x' + log.topics[2].slice(-40)).toLowerCase();

      // Eğer bu spender için daha eski bir log varsa, yeniyle değiştir
      const existing = spenderMap.get(spenderAddress);
      if (!existing || log.blockNumber > existing.blockNumber) {
        spenderMap.set(spenderAddress, log);
      }
    });

    return spenderMap;
  }
}

/** The compact chip shape used for every tag on this page. */
const chipSx = {
  fontSize: '0.6rem',
  height: 18,
  fontWeight: 700,
  borderRadius: '0px',
  border: 'none',
} as const;

const CHAIN_LABELS: Record<string, { name: string; color: string }> = {
  "eip155:1": { name: "Ethereum", color: "#627EEA" },
  "eip155:11155111": { name: "Sepolia", color: "#9B59B6" },
  "eip155:137": { name: "Polygon", color: "#8247E5" },
  "eip155:42161": { name: "Arbitrum", color: "#28A0F0" },
  "eip155:421614": { name: "Arb Sepolia", color: "#28A0F0" },
  "eip155:10": { name: "Optimism", color: "#FF0420" },
  "eip155:11155420": { name: "OP Sepolia", color: "#FF0420" },
  "eip155:8453": { name: "Base", color: "#0052FF" },
  "eip155:84532": { name: "Base Sepolia", color: "#0052FF" },
  "eip155:56": { name: "BNB Chain", color: "#F0B90B" },
  "eip155:43114": { name: "Avalanche", color: "#E84142" },
  "eip155:250": { name: "Fantom", color: "#1969FF" },
  "eip155:100": { name: "Gnosis", color: "#04795B" },
  "eip155:42220": { name: "Celo", color: "#35D07F" },
  "eip155:130": { name: "Unichain", color: "#FF007A" },
  "eip155:480": { name: "World Chain", color: "#1A1A1A" },
  "eip155:59144": { name: "Linea", color: "#61DFFF" },
  "eip155:1329": { name: "Sei", color: "#9B1C1C" },
  "eip155:10143": { name: "Monad Testnet", color: "#836EF9" },
};

const RevokeAlchemyPage = () => {
  const context = useContext(WalletContext);
  const activeAccount = context?.accountManager?.GetActive();
  const network = context?.networkProvider?.getActiveNetwork();
  const wcService = context?.walletConnectService;
  const sitePermissions = context?.sitePermissions;
  const theme = useTheme();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [scanOpen, setScanOpen] = useState(false);

  const [approvals, setApprovals] = useState<TokenApproval[]>([]);
  const [sessions, setSessions] = useState<WCSessionInfo[]>([]);
  /** Sites connected through the injected provider (`window.ethereum`). */
  const [sites, setSites] = useState<SitePermission[]>([]);
  /**
   * Grants that belong to the wallet's *other* accounts.
   *
   * Kept apart rather than merged: the scoping below is right, but hiding these entirely
   * left no way out of a real dead end. A site connected to account A refuses to sign for
   * account B ("switch to the connected account, or reconnect"), and `eth_requestAccounts`
   * hands back A's grant without prompting — so from account B the site is unusable and,
   * until now, invisible. Showing it, named by the account it belongs to, is what makes
   * "reconnect" something a person can actually do.
   */
  const [otherSites, setOtherSites] = useState<SitePermission[]>([]);
  const [loading, setLoading] = useState(false);
  const [disconnectingAll, setDisconnectingAll] = useState(false);
  const hunt = useHuntState();
  const [scanProgress, setScanProgress] = useState(0);
  const [scanMessage, setScanMessage] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Fetch WalletConnect sessions via service helper
  const fetchSessions = useCallback(() => {
    if (!wcService) {
      setSessions([]);
      return;
    }
    try {
      const activeSessions = wcService.getActiveSessions();
      setSessions(activeSessions || []);
    } catch (err) {
      setSessions([]);
    }
  }, [wcService]);

  // Auto-refresh when sessions change
  useEffect(() => {
    if (!wcService) return;
    wcService.setOnSessionUpdate(() => fetchSessions());
    return () => wcService.setOnSessionUpdate(() => { });
  }, [wcService, fetchSessions]);

  // Sites connected through the injected provider. A grant made there is exactly the kind
  // of standing access this page exists to take back, so it belongs next to the
  // WalletConnect sessions rather than only in Settings.
  //
  // Scoped to the account in front of the user. A grant is per origin *and* per account,
  // and listing every grant regardless meant switching accounts changed the address at the
  // top of the wallet while the connections underneath stayed the same — inviting someone
  // to revoke access they were not looking at, on behalf of an account they had left.
  const fetchSites = useCallback(async () => {
    const address = activeAccount?.GetAddress()?.toLowerCase();
    if (!sitePermissions || !address) {
      setSites([]);
      return;
    }
    try {
      const all = await sitePermissions.getAll();
      const mine = (p: SitePermission) => p.accounts.some((a) => a.toLowerCase() === address);
      setSites(all.filter(mine));
      setOtherSites(all.filter((p) => !mine(p) && p.accounts.length > 0));
    } catch {
      setSites([]);
      setOtherSites([]);
    }
  }, [sitePermissions, activeAccount]);

  /** Tell the worker so connected pages get `accountsChanged: []` without a reload. */
  const notifyPermissionChange = () => {
    try {
      const runtime = (window as unknown as { chrome?: { runtime?: { sendMessage?: typeof chrome.runtime.sendMessage } } }).chrome?.runtime;
      runtime?.sendMessage?.({ type: 'PERMISSIONS_CHANGED' });
    } catch {
      // Worker restarting; pages pick it up on their next request.
    }
  };

  /** Revokes every account's access for this origin — used only from the "other" list. */
  const handleDisconnectOther = async (site: SitePermission) => {
    if (!sitePermissions) return;
    try {
      for (const address of site.accounts) {
        await sitePermissions.revokeAccount(site.origin, address);
      }
      notifyPermissionChange();
      setSuccess(`${site.origin} disconnected`);
      await fetchSites();
    } catch (err) {
      setError('Failed to disconnect: ' + (err instanceof Error ? err.message : String(err)));
    }
  };

  const handleDisconnectSite = async (origin: string) => {
    const address = activeAccount?.GetAddress();
    if (!sitePermissions || !address) return;
    try {
      // Only this account's access. The site may be connected to others, and they are not
      // what the user is looking at or asking about.
      await sitePermissions.revokeAccount(origin, address);
      notifyPermissionChange();
      setSuccess(`${origin} disconnected`);
      // A moment rather than a condition: it clears itself, so it cannot follow the user
      // onto another screen and make a mark appear somewhere it does not belong.
      hunt.pulse("just-disconnected");
      await fetchSites();
    } catch (err) {
      setError('Failed to disconnect: ' + (err instanceof Error ? err.message : String(err)));
    }
  };

  const handleDisconnectAllSites = async () => {
    const address = activeAccount?.GetAddress();
    if (!sitePermissions || !address) return;
    try {
      // "All" means all of *this account's*, matching the list it sits under. Wiping
      // every account's grants from a screen showing one account's would be a much
      // larger action than the button appears to offer.
      await sitePermissions.revokeAccountEverywhere(address);
      notifyPermissionChange();
      setSuccess('All site connections removed for this account');
      await fetchSites();
    } catch (err) {
      setError('Failed to disconnect all: ' + (err instanceof Error ? err.message : String(err)));
    }
  };

  // Disconnect single WalletConnect session
  const handleDisconnectSession = async (topic: string) => {
    if (!wcService) return;
    try {
      await wcService.disconnect(topic);
      setSuccess('dApp disconnected successfully');
      fetchSessions();
    } catch (err) {
      setError('Failed to disconnect: ' + (err instanceof Error ? err.message : String(err)));
    }
  };

  // Disconnect ALL sessions silently
  const handleDisconnectAll = async () => {
    if (!wcService) return;
    setDisconnectingAll(true);
    try {
      const count = await wcService.disconnectAll();
      setSuccess(`All ${count} connection(s) disconnected`);
      fetchSessions();
    } catch (err) {
      setError('Failed to disconnect all: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setDisconnectingAll(false);
    }
  };

  // ============================================
  //  PURE ETHERS.JS APPROVAL SCANNER
  // ============================================
  const fetchApprovals = async () => {
    if (!activeAccount || !network || !network.rpc_url) {
      setError('Wallet not connected or RPC not available');
      return;
    }

    setLoading(true);
    setError(null);
    setScanProgress(0);
    setScanMessage('Initializing scanner...');

    try {
      const ownerAddress = activeAccount.GetAddress();

      if (!ownerAddress) {
        throw new Error('No wallet address found');
      }

      setScanMessage('Connecting to blockchain...');
      setScanProgress(10);
      const scanner = new RevokeService(network.rpc_url);

      setScanMessage('Scanning recent blocks for approvals...');
      setScanProgress(30);

      const results = await scanner.scanApprovals(ownerAddress, 500, (progress, message) => {
        setScanProgress(progress);
        // Strip emojis from the scanner callback
        setScanMessage(message.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '').trim());
      });

      setScanProgress(100);
      setScanMessage('Scan complete');

      // Shielding a token approves the confidential wrapper, so those approvals land in
      // this list looking like an anonymous contract the user never recognises. Naming
      // them is what stops a user revoking their own shielding — and, in the other
      // direction, stops an unrelated contract borrowing that trust by looking familiar.
      let labelled = results;
      try {
        const spenders = [...new Set(results.map((a) => a.spenderAddress))];
        const confidential = await network.filterConfidentialTokens(spenders);
        if (confidential.size > 0) {
          labelled = results.map((a) =>
            confidential.has(a.spenderAddress.toLowerCase())
              ? { ...a, spenderName: `Arfhe shielded ${a.tokenSymbol}` }
              : a
          );
        }
      } catch {
        // Detection unavailable — the raw address is still shown, just unlabelled.
      }

      setApprovals(labelled);

      if (results.length === 0) {
        setSuccess('No active approvals found in last 500 blocks');
      } else {
        const unlimitedCount = results.filter(a => a.isUnlimited).length;
        setSuccess(`Found ${results.length} approval(s)${unlimitedCount > 0 ? ` — ${unlimitedCount} unlimited` : ''}`);
      }

    } catch (err) {
      setError((err instanceof Error ? err.message : String(err)) || 'Failed to scan approvals');
      setScanMessage('');
    } finally {
      setLoading(false);
      setTimeout(() => setScanMessage(''), 2000);
    }
  };

  // Revoke approval
  const handleRevoke = async (approval: TokenApproval) => {
    if (!activeAccount || !network) return;

    try {
      const iface = new Interface(ERC20_ABI);
      const data = iface.encodeFunctionData('approve', [approval.spenderAddress, 0]);

      const txHash = await network.sendTransaction(
        activeAccount,
        {
          to: approval.tokenAddress,
          value: '0',
          data,
          gasLimit: 100000n
        },
        // Show the hash as soon as it is broadcast. `sendTransaction` returns only once
        // the transaction is mined, so without this the user sees nothing at all for the
        // whole confirmation window — on a page whose entire purpose is reassurance.
        (hash) => setSuccess(`Revoking — tx: ${hash.slice(0, 10)}…`)
      );

      setSuccess(`Revoked — tx: ${txHash.slice(0, 10)}…`);
      // Re-read from the chain rather than assuming; the allowance is only actually zero
      // once the transaction is in a block.
      await fetchApprovals();

    } catch (e) {
      setError((e instanceof Error ? e.message : String(e)) || 'Revoke failed');
    }
  };

  useEffect(() => {
    if (activeAccount && network) {
      fetchApprovals();
      fetchSessions();
      void fetchSites();
    }
  }, [activeAccount, network]);

  /**
   * The card shape the rest of the wallet uses: square corners, a divider-coloured hairline,
   * and the paper background.
   *
   * This page used to carry its own look — translucent slate panels, blurred backdrops,
   * rounded corners, its own risk palette — which made it read as a different application
   * bolted on beside the wallet. The risk colours are kept, because they carry meaning that
   * the palette does not; everything else here is now the same surface as Portfolio,
   * Privacy and History.
   */
  const cardSx = {
    p: 2,
    border: '1px solid',
    borderColor: 'divider',
    bgcolor: 'background.paper',
    borderRadius: '0px',
  } as const;

  const shortAddress = (value: string) => `${value.slice(0, 6)}…${value.slice(-4)}`;

  /** Section heading — the same one Portfolio and Privacy use above each block. */
  const SectionTitle = ({ children }: { children: React.ReactNode }) => (
    <Typography variant="subtitle2" fontWeight={800} sx={{ mb: 1, pl: 0.5 }}>
      {children}
    </Typography>
  );

  return (
    <Box sx={{ pb: 12, px: 2, pt: 2 }}>
      {/* ── Header ─────────────────────────────────────────────── */}
      <Stack direction="row" alignItems="center" spacing={0.5} sx={{ mb: 0.5 }}>
        <IconButton onClick={() => navigate(-1)} aria-label={t('common.back')} sx={{ ml: -1 }}>
          <ArrowBack />
        </IconButton>
        <SecurityRounded sx={{ fontSize: 20, color: 'primary.main' }} />
        <Typography variant="h6" fontWeight={800} sx={{ letterSpacing: '-0.02em', flex: 1 }}>
          {t('revoke.pageTitle')}
        </Typography>
        {/* Pairing a new dApp belongs beside the sessions it creates, not on the toolbar of
            every screen in the wallet. */}
        <Tooltip title={t('revoke.pairDapp')}>
          <IconButton size="small" onClick={() => setScanOpen(true)} aria-label={t('revoke.pairDapp')}>
            <QrCode fontSize="small" />
          </IconButton>
        </Tooltip>
        <Tooltip title={t('revoke.scan')}>
          <span>
            <IconButton
              size="small"
              onClick={() => { fetchApprovals(); fetchSessions(); void fetchSites(); }}
              disabled={loading}
              aria-label={t('revoke.scan')}
            >
              {loading ? <CircularProgress size={16} /> : <RefreshRounded fontSize="small" />}
            </IconButton>
          </span>
        </Tooltip>
      </Stack>

      {/* Whose permissions these are. The lists are scoped to one account, and a page that
          takes access away should say which account it is taking it away from rather than
          leaving it to be inferred from the header. */}
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2, pl: 0.5 }}>
        {t('revoke.subtitle')}
        {activeAccount?.GetAddress() ? ` · ${shortAddress(activeAccount.GetAddress()!)}` : ''}
      </Typography>

      {/* ── Error ──────────────────────────────────────────────── */}
      {error && (
        <Alert
          severity="error"
          onClose={() => setError(null)}
          sx={{ mb: 2, borderRadius: '0px', fontSize: '0.78rem' }}
        >
          {error}
        </Alert>
      )}

      {/* ── Scanning ───────────────────────────────────────────── */}
      {loading && (
        <Paper elevation={0} sx={{ ...cardSx, mb: 2 }}>
          <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1 }}>
            <SearchRounded sx={{ fontSize: 18, color: 'primary.main' }} />
            <Typography variant="subtitle2" fontWeight={700} sx={{ flex: 1 }}>
              {t('revoke.scanning')}
            </Typography>
            <Typography variant="caption" color="text.secondary" fontWeight={700}>
              {scanProgress}%
            </Typography>
          </Stack>
          <LinearProgress
            variant="determinate"
            value={scanProgress}
            sx={{
              height: 4,
              borderRadius: 0,
              bgcolor: alpha(theme.palette.text.primary, 0.08),
              '& .MuiLinearProgress-bar': { bgcolor: 'primary.main', borderRadius: 0 },
            }}
          />
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }} noWrap>
            {scanMessage || t('revoke.scanningDetail')}
          </Typography>
        </Paper>
      )}

      {/* ── Connected sites (injected provider) ─────────────────
          A grant made through `window.ethereum` is standing access to the user's address
          and a standing right to ask for signatures, so it belongs on the page whose whole
          job is taking such access back — not only buried in Settings. */}
      {sites.length > 0 && (
        <Box sx={{ mb: 2 }}>
          <Stack direction="row" alignItems="center" sx={{ mb: 1 }}>
            <SectionTitle>{t('revoke.connectedSites', { count: sites.length })}</SectionTitle>
            <Box sx={{ flex: 1 }} />
            {sites.length > 1 && (
              <Button
                size="small"
                color="error"
                startIcon={<LinkOffRounded sx={{ fontSize: 14 }} />}
                onClick={handleDisconnectAllSites}
                sx={{ borderRadius: '0px', fontWeight: 700, textTransform: 'none', fontSize: '0.7rem' }}
              >
                {t('revoke.disconnectAll')}
              </Button>
            )}
          </Stack>

          <Stack spacing={1}>
            {sites.map((site) => (
              <Paper key={site.origin} elevation={0} sx={cardSx}>
                <Stack direction="row" alignItems="center" spacing={1.5}>
                  <Avatar
                    variant="square"
                    sx={{
                      width: 32, height: 32,
                      bgcolor: alpha(theme.palette.secondary.main, 0.12),
                      color: 'secondary.main',
                    }}
                  >
                    <LanguageRounded sx={{ fontSize: 17 }} />
                  </Avatar>

                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Typography variant="body2" fontWeight={700} noWrap>
                      {site.origin.replace(/^https?:\/\//, '')}
                    </Typography>
                    <Typography variant="caption" color="text.secondary" noWrap sx={{ fontSize: '0.65rem' }}>
                      {site.accounts.map(shortAddress).join(', ')}
                    </Typography>
                    <Stack direction="row" gap={0.5} sx={{ mt: 0.5 }} flexWrap="wrap">
                      <Chip
                        size="small"
                        label={t('revoke.viaBrowser')}
                        sx={{ ...chipSx, bgcolor: 'action.hover', color: 'text.secondary' }}
                      />
                      {site.lastUsedAt && (
                        <Tooltip title={t('revoke.lastUsed', { when: new Date(site.lastUsedAt).toLocaleString() })} arrow>
                          <Chip
                            size="small"
                            icon={<AccessTimeRounded sx={{ fontSize: 10 }} />}
                            label={new Date(site.lastUsedAt).toLocaleDateString()}
                            sx={{ ...chipSx, color: 'text.secondary', '& .MuiChip-icon': { color: 'inherit' } }}
                          />
                        </Tooltip>
                      )}
                    </Stack>
                  </Box>

                  <Button
                    size="small"
                    color="error"
                    variant="outlined"
                    onClick={() => handleDisconnectSite(site.origin)}
                    sx={{ borderRadius: '0px', fontWeight: 700, textTransform: 'none', fontSize: '0.7rem', flexShrink: 0 }}
                  >
                    {t('revoke.disconnect')}
                  </Button>
                </Stack>
              </Paper>
            ))}
          </Stack>
        </Box>
      )}

      {/* ── Grants that belong to another account ───────────────
          Not actionable as this account, and that is the point: the site is refusing to
          work here precisely because it is connected over there. Shown so the state is
          legible and escapable, rather than a site that neither works nor appears. */}
      {otherSites.length > 0 && (
        <Box sx={{ mb: 2 }}>
          <SectionTitle>{t('revoke.otherAccountSites', { count: otherSites.length })}</SectionTitle>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
            {t('revoke.otherAccountSitesHint')}
          </Typography>

          <Stack spacing={1}>
            {otherSites.map((site) => (
              <Paper key={site.origin} elevation={0} sx={{ ...cardSx, opacity: 0.85 }}>
                <Stack direction="row" alignItems="center" spacing={1.5}>
                  <Avatar
                    variant="square"
                    sx={{ width: 32, height: 32, bgcolor: 'action.hover', color: 'text.secondary' }}
                  >
                    <LanguageRounded sx={{ fontSize: 17 }} />
                  </Avatar>

                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Typography variant="body2" fontWeight={700} noWrap>
                      {site.origin.replace(/^https?:\/\//, '')}
                    </Typography>
                    <Typography variant="caption" color="text.secondary" noWrap sx={{ fontSize: '0.65rem' }}>
                      {t('revoke.connectedAs', { accounts: site.accounts.map(shortAddress).join(', ') })}
                    </Typography>
                  </Box>

                  <Button
                    size="small"
                    color="error"
                    variant="outlined"
                    onClick={() => void handleDisconnectOther(site)}
                    sx={{ borderRadius: '0px', fontWeight: 700, textTransform: 'none', fontSize: '0.7rem', flexShrink: 0 }}
                  >
                    {t('revoke.disconnect')}
                  </Button>
                </Stack>
              </Paper>
            ))}
          </Stack>
        </Box>
      )}

      {/* ── WalletConnect sessions ──────────────────────────────
          These used to be duplicated on the home screen. They are a standing record, not
          something to glance at, so they live here with everything else that grants access. */}
      {sessions.length > 0 && (
        <Box sx={{ mb: 2 }}>
          <Stack direction="row" alignItems="center" sx={{ mb: 1 }}>
            <SectionTitle>{t('revoke.connectedDapps', { count: sessions.length })}</SectionTitle>
            <Box sx={{ flex: 1 }} />
            {sessions.length > 1 && (
              <Button
                size="small"
                color="error"
                startIcon={disconnectingAll ? <CircularProgress size={12} /> : <LinkOffRounded sx={{ fontSize: 14 }} />}
                onClick={handleDisconnectAll}
                disabled={disconnectingAll}
                sx={{ borderRadius: '0px', fontWeight: 700, textTransform: 'none', fontSize: '0.7rem' }}
              >
                {t('revoke.disconnectAll')}
              </Button>
            )}
          </Stack>

          <Stack spacing={1}>
            {sessions.map((s: WCSessionInfo) => {
              const peerMeta = s.peer?.metadata || {};
              const chains = Object.values(s.namespaces || {}).flatMap((ns: WCNamespace) => ns.chains || ns.accounts?.map((a: string) => a.split(':').slice(0, 2).join(':')) || []);
              const uniqueChains = [...new Set(chains)];
              const expiryDate = s.expiry ? new Date(s.expiry * 1000) : null;
              const isExpired = expiryDate ? expiryDate < new Date() : false;

              return (
                <Paper
                  key={s.topic}
                  elevation={0}
                  sx={{
                    ...cardSx,
                    // An expired session is still listed — it is still in the store, and a
                    // row that vanishes leaves nothing to disconnect — but it should not
                    // look like a live one.
                    borderColor: isExpired ? 'error.main' : 'divider',
                  }}
                >
                  <Stack direction="row" alignItems="center" spacing={1.5}>
                    <Avatar
                      variant="square"
                      src={peerMeta.icons?.[0]}
                      sx={{
                        width: 32, height: 32,
                        bgcolor: alpha(theme.palette.primary.main, 0.12),
                        color: 'primary.main',
                        fontSize: '0.8rem',
                        fontWeight: 700,
                      }}
                    >
                      {peerMeta.name?.[0]?.toUpperCase() || '?'}
                    </Avatar>

                    <Box sx={{ flex: 1, minWidth: 0 }}>
                      <Typography variant="body2" fontWeight={700} noWrap>
                        {peerMeta.name || t('revoke.unknownDapp')}
                      </Typography>
                      <Typography variant="caption" color="text.secondary" noWrap sx={{ fontSize: '0.65rem' }} component="div">
                        {peerMeta.url || t('revoke.noUrl')}
                      </Typography>
                      <Stack direction="row" gap={0.5} sx={{ mt: 0.5 }} flexWrap="wrap">
                        {uniqueChains.map((chain: string) => {
                          const label = CHAIN_LABELS[chain];
                          return (
                            <Chip
                              key={chain}
                              size="small"
                              label={label?.name || chain}
                              sx={{
                                ...chipSx,
                                bgcolor: label ? `${label.color}14` : 'action.hover',
                                color: label?.color || 'text.secondary',
                              }}
                            />
                          );
                        })}
                        {expiryDate && (
                          <Tooltip title={t('revoke.expires', { when: expiryDate.toLocaleString() })} arrow>
                            <Chip
                              size="small"
                              icon={<AccessTimeRounded sx={{ fontSize: 10 }} />}
                              label={isExpired ? t('revoke.expired') : expiryDate.toLocaleDateString()}
                              sx={{
                                ...chipSx,
                                color: isExpired ? 'error.main' : 'text.secondary',
                                '& .MuiChip-icon': { color: 'inherit' },
                              }}
                            />
                          </Tooltip>
                        )}
                      </Stack>
                    </Box>

                    <Button
                      size="small"
                      variant="outlined"
                      color="error"
                      onClick={() => handleDisconnectSession(s.topic)}
                      sx={{ borderRadius: '0px', fontWeight: 700, textTransform: 'none', fontSize: '0.7rem', flexShrink: 0 }}
                    >
                      {t('revoke.disconnect')}
                    </Button>
                  </Stack>
                </Paper>
              );
            })}
          </Stack>
        </Box>
      )}

      {/* ── Risk summary ───────────────────────────────────────── */}
      {!loading && approvals.length > 0 && (() => {
        const avgScore = Math.round(approvals.reduce((sum, a) => sum + a.riskScore, 0) / approvals.length);
        const overallLevel: RiskLevel = avgScore >= 75 ? 'critical' : avgScore >= 50 ? 'high' : avgScore >= 30 ? 'medium' : 'low';
        const cfg = RISK_CONFIG[overallLevel];
        const unlimitedCount = approvals.filter((a) => a.isUnlimited).length;
        const highRiskCount = approvals.filter((a) => a.riskLevel === 'critical' || a.riskLevel === 'high').length;

        return (
          <Paper elevation={0} sx={{ ...cardSx, mb: 2 }}>
            <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1 }}>
              <ShieldRounded sx={{ fontSize: 18, color: cfg.color }} />
              <Typography variant="subtitle2" fontWeight={700} sx={{ flex: 1 }}>
                {t('revoke.riskSummary')}
              </Typography>
              <Typography variant="h6" fontWeight={800} sx={{ color: cfg.color }}>
                {avgScore}
              </Typography>
            </Stack>

            <LinearProgress
              variant="determinate"
              value={avgScore}
              sx={{
                height: 8,
                borderRadius: 0,
                bgcolor: alpha(theme.palette.text.primary, 0.08),
                '& .MuiLinearProgress-bar': { bgcolor: cfg.color, borderRadius: 0 },
              }}
            />

            <Stack direction="row" spacing={2} sx={{ mt: 1 }} divider={<Divider orientation="vertical" flexItem />}>
              <Box sx={{ flex: 1 }}>
                <Typography variant="subtitle2" fontWeight={800}>{approvals.length}</Typography>
                <Typography variant="caption" color="text.secondary">{t('revoke.approvalsLabel')}</Typography>
              </Box>
              <Box sx={{ flex: 1 }}>
                <Typography variant="subtitle2" fontWeight={800} color={unlimitedCount > 0 ? 'error.main' : 'text.primary'}>
                  {unlimitedCount}
                </Typography>
                <Typography variant="caption" color="text.secondary">{t('revoke.unlimited')}</Typography>
              </Box>
              <Box sx={{ flex: 1 }}>
                <Typography variant="subtitle2" fontWeight={800} color={highRiskCount > 0 ? 'error.main' : 'text.primary'}>
                  {highRiskCount}
                </Typography>
                <Typography variant="caption" color="text.secondary">{t('revoke.highRisk')}</Typography>
              </Box>
            </Stack>
          </Paper>
        );
      })()}

      {/* ── Token approvals ────────────────────────────────────── */}
      {approvals.length > 0 && (
        <Box sx={{ mb: 2 }}>
          <SectionTitle>{t('revoke.tokenPermissions', { count: approvals.length })}</SectionTitle>

          <Stack spacing={1}>
            {[...approvals].sort((a, b) => b.riskScore - a.riskScore).map((a, i) => {
              const riskCfg = RISK_CONFIG[a.riskLevel];
              const RiskIcon = riskCfg.icon;

              return (
                <Paper key={i} elevation={0} sx={{ ...cardSx, p: 0 }}>
                  {/* The one place this page keeps a colour of its own: the bar says how bad
                      this approval is at a glance, which no amount of divider grey can. */}
                  <LinearProgress
                    variant="determinate"
                    value={a.riskScore}
                    sx={{
                      height: 3,
                      bgcolor: 'transparent',
                      '& .MuiLinearProgress-bar': { bgcolor: riskCfg.color, borderRadius: 0 },
                    }}
                  />

                  <Box sx={{ p: 2 }}>
                    <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1 }} flexWrap="wrap" useFlexGap>
                      <Typography variant="body2" fontWeight={800}>{a.tokenSymbol}</Typography>
                      <Typography variant="caption" color="text.secondary" sx={{ flex: 1, minWidth: 0 }} noWrap>
                        {a.tokenName}
                      </Typography>
                      <Chip
                        icon={<RiskIcon sx={{ fontSize: 12 }} />}
                        label={t(`revoke.risk.${a.riskLevel}`)}
                        size="small"
                        sx={{
                          ...chipSx,
                          bgcolor: `${riskCfg.color}14`,
                          color: riskCfg.color,
                          '& .MuiChip-icon': { color: riskCfg.color },
                        }}
                      />
                      {a.isUnlimited && (
                        <Chip
                          label={t('revoke.unlimited')}
                          size="small"
                          sx={{ ...chipSx, bgcolor: alpha(theme.palette.error.main, 0.12), color: 'error.main' }}
                        />
                      )}
                    </Stack>

                    <Box sx={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '2px 12px', mb: 1.5 }}>
                      <Typography variant="caption" color="text.secondary" fontWeight={600}>{t('revoke.spender')}</Typography>
                      <Typography variant="caption" fontWeight={700} noWrap>{a.spenderName}</Typography>

                      <Typography variant="caption" color="text.secondary" fontWeight={600}>{t('revoke.address')}</Typography>
                      <Typography variant="caption" sx={{ fontFamily: 'monospace', fontSize: '0.65rem' }} noWrap>
                        {shortAddress(a.spenderAddress)}
                      </Typography>

                      <Typography variant="caption" color="text.secondary" fontWeight={600}>{t('revoke.allowance')}</Typography>
                      <Typography variant="caption" fontWeight={700} color={a.isUnlimited ? 'error.main' : 'text.primary'}>
                        {a.isUnlimited ? `∞ ${t('revoke.unlimited')}` : a.allowance}
                      </Typography>
                    </Box>

                    <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mb: 1.5 }}>
                      {a.riskReasons.map((reason, ri) => (
                        <Typography
                          key={ri}
                          variant="caption"
                          sx={{
                            fontSize: '0.6rem',
                            fontWeight: 600,
                            color: 'text.secondary',
                            bgcolor: alpha(theme.palette.text.primary, 0.05),
                            px: 1,
                            py: 0.25,
                          }}
                        >
                          {reason}
                        </Typography>
                      ))}
                    </Stack>

                    <Button
                      fullWidth
                      size="small"
                      variant="contained"
                      color={a.riskLevel === 'critical' || a.riskLevel === 'high' ? 'error' : 'primary'}
                      onClick={() => handleRevoke(a)}
                      startIcon={<LinkOffRounded sx={{ fontSize: 16 }} />}
                      sx={{ borderRadius: '0px', fontWeight: 700, fontSize: '0.75rem', py: 0.75, textTransform: 'none', boxShadow: 'none' }}
                    >
                      {t('revoke.revokeApproval')}
                    </Button>
                  </Box>
                </Paper>
              );
            })}
          </Stack>
        </Box>
      )}

      {/* ── Nothing to revoke ──────────────────────────────────── */}
      {!loading && approvals.length === 0 && sessions.length === 0 && sites.length === 0 && (
        <Paper elevation={0} sx={{ ...cardSx, p: 3, textAlign: 'center' }}>
          <CheckCircleOutlineRounded sx={{ fontSize: 32, color: 'secondary.main', mb: 1 }} />
          <Typography variant="subtitle2" fontWeight={800} sx={{ mb: 0.5 }}>
            {t('revoke.secureTitle')}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {t('revoke.secureBody')}
          </Typography>
        </Paper>
      )}

      {/* Re-reads the session list on close: a pairing that just succeeded should appear
          without the user having to press Rescan. */}
      <ScanDialog open={scanOpen} onClose={() => { setScanOpen(false); fetchSessions(); }} />

      <Snackbar
        open={!!success}
        autoHideDuration={4000}
        onClose={() => setSuccess(null)}
        message={success}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
        sx={{ mb: 10, '& .MuiSnackbarContent-root': { borderRadius: '0px', fontWeight: 600, fontSize: '0.8rem' } }}
      />
    </Box>
  );
};

export default RevokeAlchemyPage;
