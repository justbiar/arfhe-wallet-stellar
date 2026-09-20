import { pt } from "../lib/language";
import DownloadExtension from "./DownloadExtension";
import { CHROME_STORE_URL } from "../lib/product";
/**
 * The Arfhe side: the account, its balances, and the leg of the ramp the wallet owns.
 *
 * Two ways to connect, and the difference is the argument this panel is making:
 *
 *   - **Arfhe Wallet** — the extension signs. The key never reaches this page; every
 *     signature opens the wallet's own approval screen, including the trustline.
 *   - **Demo account** — a throwaway testnet key for this tab, so a visitor with nothing
 *     installed can still see the flow.
 *
 * Neither asks for a recovery phrase, and there is no field to type one into. A web page
 * that asks for twelve words is indistinguishable from the phishing page that imitates it.
 */
import React from "react";
import {
  Box, Stack, Typography, Button, Divider, Chip, Tooltip, IconButton, CircularProgress,
  Alert, Link as MuiLink, TextField, InputAdornment,
} from "@mui/material";
import ContentCopyIcon from "@mui/icons-material/ContentCopyOutlined";
import CheckIcon from "@mui/icons-material/Check";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import PaneFrame from "./PaneFrame";
import TxReceipt, { HashLine } from "./TxReceipt";
import { ANCHOR_ASSET_CODE, FIAT_CODE, WITHDRAW_MIN_USDC } from "../lib/anchor";
import { shortAddress } from "../lib/stellar";
import { waitForArfhe } from "../lib/signer";
import type { Ramp } from "../lib/useRamp";
import type { Direction } from "../pages/Bridge";

const ACCENT = "#4338CA";

/** A number the user is meant to read, not scan past. */
function Amount({ value, code }: { value: string | null; code: string }) {
  return (
    <Box>
      <Typography variant="caption" color="text.secondary">{pt(code)}</Typography>
      <Typography sx={{ fontSize: 24, fontWeight: 800, letterSpacing: "-0.02em", lineHeight: 1.2 }}>
        {pt(value === null ? "—" : trimZeros(value))}
      </Typography>
    </Box>
  );
}

/** Stellar reports seven decimals; showing 2.0396090 as-is is noise for a balance. */
function trimZeros(v: string): string {
  return v.includes(".") ? v.replace(/(\.\d*?[1-9])0+$/, "$1").replace(/\.0+$/, "") : v;
}

/** A value the user is about to send money against. Read-only, and shown in full. */
function Instruction({ label, value, help }: { label: string; value: string; help?: string }) {
  return (
    <Box>
      <Typography variant="caption" color="text.secondary">{pt(label)}</Typography>
      <Box
        sx={{
          mt: 0.5, px: 1.5, py: 1.2, border: "1px solid", borderColor: "text.primary",
          fontFamily: "var(--font-arbeit-technik)", fontSize: 12.5, wordBreak: "break-all",
        }}
      >
        {pt(value)}
      </Box>
      {pt(help && (
        <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 0.5, textTransform: "none" }}>
          {pt(help)}
        </Typography>
      ))}
    </Box>
  );
}

export default function WalletPane({ direction, ramp }: { direction: Direction; ramp: Ramp }) {
  const [copied, setCopied] = React.useState(false);
  const [usdcAmount, setUsdcAmount] = React.useState("2");
  /** Null while the content script may still be injecting — see waitForArfhe. */
  const [arfheFound, setArfheFound] = React.useState<boolean | null>(null);

  // The provider is injected by a content script that may land after this component mounts,
  // so a single check at mount would report "not installed" for a wallet that is merely a
  // few hundred milliseconds slow.
  React.useEffect(() => {
    let cancelled = false;
    void waitForArfhe().then((found) => { if (!cancelled) setArfheFound(found); });
    return () => { cancelled = true; };
  }, []);

  const connected = ramp.address !== null && ramp.phase !== "connecting";
  const busy = ramp.phase === "connecting";
  const paying = ramp.phase === "paying";
  const settling = ramp.phase === "settling";

  const numeric = Number(usdcAmount.replace(",", "."));
  // Once the transfer is done the balance has already gone down by this amount, so the
  // field would report the completed transaction as too large — an error about something
  // that already succeeded.
  const validating = ramp.phase !== "done" && usdcAmount !== "";
  const belowMin = validating && numeric < WITHDRAW_MIN_USDC;
  const overBalance =
    validating && ramp.balances?.usdc != null && numeric > Number(ramp.balances.usdc);

  const copy = async () => {
    if (!ramp.address) return;
    try {
      await navigator.clipboard.writeText(ramp.address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch { /* clipboard blocked; the address is on screen to select by hand */ }
  };

  return (
    <PaneFrame
      label={pt("ARFHE WALLET")}
      accent={ACCENT}
      title={
        <Chip
          size="small"
          label={
            pt(!connected ? "BAĞLI DEĞİL"
              : ramp.signerKind === "arfhe" ? "UZANTI"
              : "DEMO HESAP")
          }
          sx={{
            borderRadius: 3, height: 20, fontSize: 10, fontWeight: 700,
            bgcolor: connected ? `${ACCENT}1A` : "action.hover",
            color: connected ? ACCENT : "text.secondary",
          }}
        />
      }
    >
      <Box sx={{ border: "1px solid", borderColor: "divider", p: 2 }}>
        <Stack direction="row" alignItems="center" gap={0.5}>
          <Typography variant="caption" color="text.secondary">{pt("STELLAR ADRESİ")}</Typography>
          {pt(ramp.address && (
            <Tooltip title={pt(copied ? "Kopyalandı" : "Kopyala")}>
              <IconButton size="small" onClick={copy} sx={{ p: 0.3 }}>
                {copied ? <CheckIcon sx={{ fontSize: 13 }} /> : <ContentCopyIcon sx={{ fontSize: 13 }} />}
              </IconButton>
            </Tooltip>
          ))}
        </Stack>
        <Typography
          sx={{
            fontFamily: "var(--font-arbeit-technik)", fontSize: 13, mt: 0.5,
            color: ramp.address ? "text.primary" : "text.disabled", wordBreak: "break-all",
          }}
        >
          {pt(ramp.address ? shortAddress(ramp.address, 10, 6) : "G···")}
        </Typography>

        <Stack direction="row" gap={3} sx={{ mt: 2 }}>
          <Amount value={ramp.balances?.usdc ?? null} code={ANCHOR_ASSET_CODE} />
          <Amount value={ramp.balances?.xlm ?? null} code="XLM" />
        </Stack>

        {pt(ramp.address && (
          <MuiLink
            href={`https://stellar.expert/explorer/testnet/account/${ramp.address}`}
            target="_blank" rel="noopener noreferrer"
            variant="caption"
            sx={{ display: "inline-flex", alignItems: "center", gap: 0.4, mt: 1.5, color: "text.secondary", textTransform: "none" }}
          >{pt(" Zincirde gör ")}<OpenInNewIcon sx={{ fontSize: 12 }} />
          </MuiLink>
        ))}
      </Box>

      <Divider sx={{ my: 2.5 }} />

      <Typography variant="caption" color="text.secondary" fontWeight={700}>
        {pt(direction === "deposit" ? "YÜKLEME ALACAK" : `${ANCHOR_ASSET_CODE} GÖNDER`)}
      </Typography>

      <Stack gap={2} sx={{ mt: 1.5 }}>
        {ramp.phase === "done" && (
          <Alert severity="success" sx={{ borderRadius: 3 }}>
            {pt(direction === "deposit"
              ? `${trimZeros(ramp.status?.amountOut ?? "")} ${ANCHOR_ASSET_CODE} hesabınıza geçti.`
              : `${trimZeros(ramp.status?.amountIn ?? "")} ${ANCHOR_ASSET_CODE} gönderildi, ` +
                `${ramp.status?.amountOut ?? "—"} ${FIAT_CODE} IBAN'a geçti.`)}
          </Alert>
        )}

        {pt(ramp.error && (
          <Alert severity="error" sx={{ borderRadius: 3 }}>{pt(ramp.error)}</Alert>
        ))}

        {/* The user's own payment, shown the moment it lands on the ledger — before the
            anchor has done anything. It is irreversible from that point, so the proof of
            it should not wait on the other side's word. */}
        {pt(ramp.paymentHash && <HashLine hash={ramp.paymentHash} label={pt("GÖNDERDİĞİNİZ ÖDEME")} />)}

        {/* On a withdrawal the anchor's `stellar_transaction_id` IS the payment above —
            the same hash under two headings, which reads as two transactions. The receipt
            still renders its bank reference and its claimable-balance warning. */}
        {ramp.status && <TxReceipt status={ramp.status} hideHash={ramp.paymentHash} />}

        {direction === "deposit" ? (
          <Box sx={{ border: "1px dashed", borderColor: "divider", p: 2 }}>
            <Typography variant="body2" color="text.secondary" sx={{ lineHeight: 1.6 }}>{pt(" Havale onaylandığında USDC bu hesaba geçer. Güven hattı bağlanırken açıldı, yani ödeme doğrudan düşer — bekleyen bir talep olarak kalmaz. ")}</Typography>
          </Box>
        ) : (
          <>
            <TextField
              label={pt("Gönderilecek tutar")}
              value={usdcAmount}
              onChange={(e) => setUsdcAmount(e.target.value)}
              inputMode="decimal"
              fullWidth
              disabled={!connected || ramp.withdrawOrder !== null}
              error={belowMin || overBalance}
              helperText={
                pt(belowMin ? `En az ${WITHDRAW_MIN_USDC} ${ANCHOR_ASSET_CODE}`
                  : overBalance ? "Bakiyeden fazla"
                  : `En az ${WITHDRAW_MIN_USDC} ${ANCHOR_ASSET_CODE} · bakiye ${trimZeros(ramp.balances?.usdc ?? "0")}`)
              }
              InputProps={{
                endAdornment: <InputAdornment position="end">{pt(ANCHOR_ASSET_CODE)}</InputAdornment>,
                sx: { borderRadius: 3 },
              }}
            />

            {ramp.withdrawOrder && (
              <>
                <Instruction
                  label={pt("ANCHOR HESABI")}
                  value={ramp.withdrawOrder.destination}
                  help={pt("Ödeme bu hesaba gider")}
                />
                {/* The memo type stays out of the label: captions are upper-cased by the
                    theme, and Turkish upper-case turns "id" into "İD" — a protocol value
                    rendered as something that is not it. The help line does not transform. */}
                <Instruction
                  label={pt("MEMO")}
                  value={ramp.withdrawOrder.memo}
                  help={pt(`Tür: ${ramp.withdrawOrder.memoType} · bu memo olmadan ödeme hangi çekim ` +
                    "talebine ait olduğu anlaşılamaz — geri alınamaz")}
                />
              </>
            )}

            {!connected && (
              <Alert severity="info" sx={{ borderRadius: 3 }}>{pt(" Çekim için önce bir hesap bağlayın. ")}</Alert>
            )}
          </>
        )}

        {/* ── Eylem ── */}
        {!connected ? (
          <Stack gap={1}>
            <Button
              variant="contained"
              onClick={() => ramp.connect("arfhe")}
              disabled={busy || arfheFound === false}
              startIcon={busy ? <CircularProgress size={14} color="inherit" /> : null}
              sx={{ borderRadius: 3, py: 1.2, bgcolor: ACCENT, "&:hover": { bgcolor: "#3730A3" } }}
            >
              {pt(busy ? "Bağlanılıyor…" : "Arfhe Wallet ile bağlan")}
            </Button>
            {/* The throwaway-account path is gone on purpose. It made the demo work for a
                visitor with nothing installed, and in exchange the thing being demonstrated
                — a wallet holding the keys — was the one part they never saw. Without the
                extension there is now an install link rather than a substitute for it. */}
            {arfheFound === false && (
              <Stack gap={1}>
                <Typography variant="caption" color="text.secondary" sx={{ textTransform: "none", textAlign: "center" }}>{pt(" Uzantı bu sayfada bulunamadı. Bu akış Arfhe Wallet ile çalışıyor. ")}</Typography>
                <Button
                  href={CHROME_STORE_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  variant="outlined"
                  sx={{ borderRadius: 3, py: 1.2, borderColor: "divider", color: "text.primary" }}
                >{pt(" Arfhe Wallet'ı kur ")}</Button>
                {/* The store link above installs the EVM wallet, which cannot answer this
                    page. The build that can is right underneath it. */}
                <DownloadExtension compact />
              </Stack>
            )}
            <Typography variant="caption" color="text.secondary" sx={{ textTransform: "none", textAlign: "center" }}>{pt(" Denemek için testnet USDC gerekiyor: faucet.circle.com üzerinden Stellar testnet'i seçip cüzdanınızın Stellar adresine 20 USDC isteyin. ")}</Typography>
          </Stack>
        ) : direction === "withdraw" && ramp.phase !== "done" ? (
          !ramp.withdrawOrder ? (
            <Button
              variant="contained"
              disabled={belowMin || overBalance || usdcAmount === "" || ramp.phase === "ordering"}
              onClick={() => ramp.openWithdraw(usdcAmount)}
              startIcon={ramp.phase === "ordering" ? <CircularProgress size={14} color="inherit" /> : null}
              sx={{ borderRadius: 3, py: 1.2, bgcolor: ACCENT, "&:hover": { bgcolor: "#3730A3" } }}
            >
              {pt(ramp.phase === "ordering" ? "Talep açılıyor…" : "Çekim talebi aç")}
            </Button>
          ) : (
            <Button
              variant="contained"
              disabled={paying || settling}
              onClick={() => ramp.sendWithdrawal(usdcAmount)}
              startIcon={paying || settling ? <CircularProgress size={14} color="inherit" /> : null}
              sx={{ borderRadius: 3, py: 1.2, bgcolor: ACCENT, "&:hover": { bgcolor: "#3730A3" } }}
            >
              {pt(paying
                ? (ramp.signerKind === "arfhe" ? "Cüzdanda onaylayın…" : "Gönderiliyor…")
                : settling ? "Anchor bekleniyor…"
                : `${usdcAmount} ${ANCHOR_ASSET_CODE} gönder`)}
            </Button>
          )
        ) : ramp.phase === "done" ? (
          <Button
            variant="outlined"
            onClick={ramp.reset}
            sx={{ borderRadius: 3, py: 1.2, borderColor: "divider", color: "text.primary" }}
          >{pt(" Yeni işlem ")}</Button>
        ) : (
          <Button
            variant="outlined"
            onClick={ramp.refreshBalances}
            sx={{ borderRadius: 3, py: 1.2, borderColor: "divider", color: "text.primary" }}
          >{pt(" Bakiyeleri yenile ")}</Button>
        )}

        <Typography variant="caption" color="text.secondary" sx={{ textTransform: "none", textAlign: "center", lineHeight: 1.5 }}>
          {ramp.signerKind === "arfhe"
            ? <>{pt("Anahtar uzantıda kalır; her imza cüzdanda onaylanır.")}<br />{pt("Kurtarma ifadeniz hiçbir zaman istenmez.")}</>
            : <>{pt("Bu sekme için üretilmiş tek kullanımlık testnet hesabı.")}<br />{pt("Kurtarma ifadeniz hiçbir zaman istenmez.")}</>}
        </Typography>
      </Stack>
    </PaneFrame>
  );
}
