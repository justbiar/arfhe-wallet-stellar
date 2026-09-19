import { pt } from "../lib/language";
/**
 * What actually happened on-chain, once the anchor settles.
 *
 * The hash is the point. An anchor saying "completed" is the anchor's word for it; the
 * transaction id is the thing anyone can check against the ledger without trusting either
 * side of this page. It is shown in full rather than truncated, because a hash that has to
 * be un-truncated before it can be pasted into an explorer is decoration.
 */
import { Box, Stack, Typography, Link as MuiLink, Tooltip, IconButton, Alert } from "@mui/material";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import ContentCopyIcon from "@mui/icons-material/ContentCopyOutlined";
import CheckIcon from "@mui/icons-material/Check";
import React from "react";
import type { TxStatus } from "../lib/sep";

const EXPLORER = "https://stellar.expert/explorer/testnet/tx";

/**
 * One hash, in full, with a way to copy it and a way to check it.
 *
 * Shared by the anchor's payment and the user's own, because the argument is the same in
 * both directions: the hash is the only part of this page that does not require trusting
 * this page. Truncating it would make it something to look at rather than something to use.
 */
export function HashLine({ hash, label }: { hash: string; label: string }) {
  const [copied, setCopied] = React.useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(hash);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch { /* the hash is on screen to select by hand */ }
  };

  return (
    <Box sx={{ border: "1px solid", borderColor: "divider", p: 2 }}>
      <Typography variant="caption" color="text.secondary" fontWeight={700}>{pt(label)}</Typography>
      <Stack direction="row" alignItems="flex-start" gap={0.5} sx={{ mt: 0.8 }}>
        <Typography
          sx={{
            fontFamily: "var(--font-arbeit-technik)", fontSize: 11.5, lineHeight: 1.5,
            wordBreak: "break-all", flex: 1,
          }}
        >
          {pt(hash)}
        </Typography>
        <Tooltip title={pt(copied ? "Kopyalandı" : "Kopyala")}>
          <IconButton size="small" onClick={copy} sx={{ p: 0.3, mt: -0.3 }}>
            {copied ? <CheckIcon sx={{ fontSize: 13 }} /> : <ContentCopyIcon sx={{ fontSize: 13 }} />}
          </IconButton>
        </Tooltip>
      </Stack>
      <MuiLink
        href={`${EXPLORER}/${hash}`}
        target="_blank"
        rel="noopener noreferrer"
        variant="caption"
        sx={{ display: "inline-flex", alignItems: "center", gap: 0.4, mt: 1, textTransform: "none" }}
      >{pt(" stellar.expert'te doğrula ")}<OpenInNewIcon sx={{ fontSize: 12 }} />
      </MuiLink>
    </Box>
  );
}

export default function TxReceipt({ status, hideHash }: { status: TxStatus; hideHash?: string | null }) {
  const [copied, setCopied] = React.useState(false);
  // The caller may already be showing this hash. Printing it again under a second heading
  // suggests two transactions where there is one.
  const duplicate = hideHash != null && hideHash === status.stellarTxId;
  const showHash = status.stellarTxId != null && !duplicate;
  if (!showHash && !status.externalTxId && !status.claimableBalanceId) return null;

  const copy = async () => {
    if (!status.stellarTxId) return;
    try {
      await navigator.clipboard.writeText(status.stellarTxId);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch { /* the hash is on screen to select by hand */ }
  };

  return (
    <Box sx={{ border: "1px solid", borderColor: "divider", p: 2 }}>
      {showHash && (
        <Typography variant="caption" color="text.secondary" fontWeight={700}>{pt(" ZİNCİRDEKİ İŞLEM ")}</Typography>
      )}

      {pt(showHash && status.stellarTxId && (
        <>
          <Stack direction="row" alignItems="flex-start" gap={0.5} sx={{ mt: 0.8 }}>
            <Typography
              sx={{
                fontFamily: "var(--font-arbeit-technik)", fontSize: 11.5, lineHeight: 1.5,
                wordBreak: "break-all", flex: 1,
              }}
            >
              {pt(status.stellarTxId)}
            </Typography>
            <Tooltip title={pt(copied ? "Kopyalandı" : "Kopyala")}>
              <IconButton size="small" onClick={copy} sx={{ p: 0.3, mt: -0.3 }}>
                {copied ? <CheckIcon sx={{ fontSize: 13 }} /> : <ContentCopyIcon sx={{ fontSize: 13 }} />}
              </IconButton>
            </Tooltip>
          </Stack>

          <MuiLink
            href={`${EXPLORER}/${status.stellarTxId}`}
            target="_blank"
            rel="noopener noreferrer"
            variant="caption"
            sx={{ display: "inline-flex", alignItems: "center", gap: 0.4, mt: 1, textTransform: "none" }}
          >{pt(" stellar.expert'te doğrula ")}<OpenInNewIcon sx={{ fontSize: 12 }} />
          </MuiLink>
        </>
      ))}

      {pt(status.externalTxId && (
        <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 1.2, textTransform: "none" }}>{pt(" Banka referansı:")}{pt(" ")}
          <Box component="span" sx={{ fontFamily: "var(--font-arbeit-technik)" }}>{pt(status.externalTxId)}</Box>
        </Typography>
      ))}

      {/* Not an error, but the one outcome a user must act on rather than just read. */}
      {pt(status.claimableBalanceId && (
        <Alert severity="warning" sx={{ borderRadius: 3, mt: 1.5 }}>{pt(" Ödeme talep edilebilir bakiye olarak bekliyor — hesapta USDC güven hattı yokmuş. Toplamak için hattı açıp bakiyeyi talep etmeniz gerekiyor. ")}</Alert>
      ))}
    </Box>
  );
}
