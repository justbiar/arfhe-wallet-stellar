/**
 * The Stellar face of the Web3 tab.
 *
 * Stellar is in the same network menu as the EVM chains because that is where a person
 * looks for it — but it is not in `NetworkProvider`'s list, and that difference is the
 * whole design. Everything behind that list is EVM machinery: chain ids, ethers wallets,
 * RPC clients, token lists. Putting Stellar in there would hand half the wallet a network
 * it cannot read and produce a switch that silently does nothing.
 *
 * So the menu selects a view, and this is the view — built from the same balance card and
 * the same asset rows the EVM side uses, rather than a second design that drifts away from
 * it. What differs is only what is true here: the actions, and what the headline can count.
 */

import React, { useCallback, useContext, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import {
  Box, Paper, Stack, Typography, Button, CircularProgress, IconButton, Tooltip, alpha, useTheme,
} from "@mui/material";
import {
  Visibility, VisibilityOff, ContentCopyOutlined, Check, OpenInNew, AccountBalanceOutlined,
} from "@mui/icons-material";
import { WalletContext } from "../AppContext.js";
import { MatrixBalance, AssetItem } from "../pages/Home.js";

const EXPLORER = "https://stellar.expert/explorer/testnet/account";

/** Long names for the two assets this account can hold today. */
const ASSET_NAMES: Record<string, string> = { XLM: "Stellar Lumens", USDC: "USD Coin" };

interface Row { code: string; balance: string; isNative: boolean }

export default function StellarNetworkPanel() {
  const { t } = useTranslation();
  const theme = useTheme();
  const navigate = useNavigate();
  const context = useContext(WalletContext);
  const account = context?.accountManager?.GetActive();

  const [address, setAddress] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [funded, setFunded] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [hidden, setHidden] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    if (!account) { setLoading(false); return; }
    setLoading(true);
    try {
      const stellar = await import("../backend/StellarService.js");
      const derived = await stellar.getAddress(account);
      setAddress(derived);
      if (!derived) return;

      const read = await stellar.getBalances(derived);
      setFunded(read.exists);
      // Native first: it is the one that has to be there for anything else to work.
      setRows(
        read.balances
          .slice()
          .sort((a, b) => Number(b.isNative) - Number(a.isNative))
          .map((b) => ({ code: b.code, balance: b.balance, isNative: b.isNative }))
      );
    } catch {
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [account]);

  useEffect(() => { void load(); }, [load]);

  const copy = async () => {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch { /* clipboard blocked; the address is on screen to select */ }
  };

  /**
   * Only the dollar-pegged asset is counted.
   *
   * Testnet lumens have no market price, and inventing one — or quietly leaving them out of
   * a total that claims to be everything — are both worse than a headline that counts what
   * it can and says so underneath.
   */
  const usdc = rows.find((r) => r.code === "USDC")?.balance ?? "0";
  const headline = `$${Number(usdc).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  if (loading) {
    return <Box sx={{ p: 2, pt: 1 }}><Stack alignItems="center" sx={{ py: 4 }}><CircularProgress size={20} /></Stack></Box>;
  }

  if (!address) {
    return (
      <Box sx={{ p: 2, pt: 1 }}>
        <Paper elevation={0} sx={{ borderRadius: "20px", border: "1px solid", borderColor: "divider", p: 2.5 }}>
          <Typography variant="body2" color="text.secondary">{t("stellar.noMnemonic")}</Typography>
        </Paper>
      </Box>
    );
  }

  return (
    <Box sx={{ p: 2, pt: 1 }}>
      {/* Same card as the EVM side: same gradient, same radius, same privacy toggle. */}
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
        <Box sx={{ position: 'relative', zIndex: 2, p: 2.5, width: '100%', textAlign: 'center' }}>
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 0.75, mb: 0.75 }}>
            <Box sx={{ width: 6, height: 6, borderRadius: '0px', bgcolor: 'text.primary' }} />
            <Typography variant="body2" sx={{
              color: 'text.primary', fontWeight: 600, letterSpacing: '0.08em',
              textTransform: 'uppercase', fontSize: '0.7rem', opacity: 0.8,
            }}>
              {t('home.totalBalance')}
            </Typography>
          </Box>

          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 0.5, '& h3': { fontSize: 'clamp(1.6rem, 8vw, 2.6rem)', overflowWrap: 'anywhere', minWidth: 0 } }}>
            <MatrixBalance value={headline} isHidden={hidden} variant="h3" />
            <Tooltip title={hidden ? t('home.showBalance') : t('home.hideBalance')}>
              <IconButton
                size="small"
                onClick={() => setHidden(!hidden)}
                aria-label={hidden ? t('home.showBalance') : t('home.hideBalance')}
                sx={{ color: 'text.primary', opacity: 0.8, borderRadius: '0px', '&:hover': { opacity: 1, bgcolor: 'action.hover' } }}
              >
                {hidden ? <Visibility fontSize="small" /> : <VisibilityOff fontSize="small" />}
              </IconButton>
            </Tooltip>
          </Box>

          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.75 }}>
            {t('stellar.totalNote')}
          </Typography>

          {/* Two actions, in the EVM side's grid. Send is absent rather than disabled:
              on Stellar a payment is signed for a site through the approval screen, and a
              Send button here would open the EVM form for an account it cannot touch. */}
          <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 1, mt: 2.5 }}>
            <Button
              variant="contained"
              startIcon={<AccountBalanceOutlined />}
              onClick={() => navigate('/bank')}
              sx={{ minHeight: 44, borderRadius: '12px', textTransform: 'none', fontWeight: 700 }}
            >
              {t('stellar.openBank')}
            </Button>
            <Button
              variant="outlined"
              startIcon={copied ? <Check /> : <ContentCopyOutlined />}
              onClick={copy}
              sx={{ minHeight: 44, borderRadius: '12px', textTransform: 'none', fontWeight: 700 }}
            >
              {copied ? t('common.copied') : t('stellar.copyAddress')}
            </Button>
          </Box>

          <Box sx={{ display: 'flex', justifyContent: 'center', gap: 1, mt: 1, flexWrap: 'wrap' }}>
            <Button
              variant="contained"
              onClick={() => navigate('/settings/stellar')}
              sx={{
                bgcolor: 'transparent', color: 'text.primary', boxShadow: 'none',
                border: '1px solid', borderColor: 'divider', borderRadius: '10px',
                minHeight: 40, textTransform: 'none', fontWeight: 600, fontSize: '0.75rem',
                px: 2, py: 0.5,
                '&:hover': { bgcolor: 'action.hover', borderColor: 'text.primary', boxShadow: 'none' },
              }}
            >
              {t('stellar.title')}
            </Button>
            <Button
              variant="contained"
              component="a"
              href={`${EXPLORER}/${address}`}
              target="_blank"
              rel="noopener noreferrer"
              startIcon={<OpenInNew sx={{ fontSize: 14 }} />}
              sx={{
                bgcolor: 'transparent', color: 'text.primary', boxShadow: 'none',
                border: '1px solid', borderColor: 'divider', borderRadius: '10px',
                minHeight: 40, textTransform: 'none', fontWeight: 600, fontSize: '0.75rem',
                px: 2, py: 0.5,
                '&:hover': { bgcolor: 'action.hover', borderColor: 'text.primary', boxShadow: 'none' },
              }}
            >
              {t('stellar.viewOnChain')}
            </Button>
          </Box>
        </Box>
      </Paper>

      {/* Same rows as the EVM asset list, so one list does not learn tricks the other lacks. */}
      <Paper elevation={0} sx={{ borderRadius: '20px', border: '1px solid', borderColor: 'divider', overflow: 'hidden' }}>
        {funded === false ? (
          <Box sx={{ p: 2.5 }}>
            <Typography variant="body2" color="text.secondary">{t('stellar.notFunded')}</Typography>
          </Box>
        ) : rows.length === 0 ? (
          <Box sx={{ p: 2.5 }}>
            <Typography variant="body2" color="text.secondary">{t('stellar.noBalances')}</Typography>
          </Box>
        ) : (
          rows.map((row, i) => (
            <AssetItem
              key={`${row.code}-${i}`}
              symbol={row.code}
              name={ASSET_NAMES[row.code] ?? row.code}
              balance={row.balance}
              // Only the pegged asset carries a figure; a testnet lumen priced in dollars
              // would be a number with nothing behind it.
              value={row.code === "USDC" ? `$${Number(row.balance).toFixed(2)}` : ""}
              icon=""
              isLast={i === rows.length - 1}
            />
          ))
        )}
      </Paper>
    </Box>
  );
}
