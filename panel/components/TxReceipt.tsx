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

export default function TxReceipt({ status }: { status: TxStatus }) {
  const [copied, setCopied] = React.useState(false);
  if (!status.stellarTxId && !status.claimableBalanceId) return null;

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
      <Typography variant="caption" color="text.secondary" fontWeight={700}>
        ZİNCİRDEKİ İŞLEM
      </Typography>

      {status.stellarTxId && (
        <>
          <Stack direction="row" alignItems="flex-start" gap={0.5} sx={{ mt: 0.8 }}>
            <Typography
              sx={{
                fontFamily: "var(--font-arbeit-technik)", fontSize: 11.5, lineHeight: 1.5,
                wordBreak: "break-all", flex: 1,
              }}
            >
              {status.stellarTxId}
            </Typography>
            <Tooltip title={copied ? "Kopyalandı" : "Kopyala"}>
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
          >
            stellar.expert'te doğrula <OpenInNewIcon sx={{ fontSize: 12 }} />
          </MuiLink>
        </>
      )}

      {status.externalTxId && (
        <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 1.2, textTransform: "none" }}>
          Banka referansı:{" "}
          <Box component="span" sx={{ fontFamily: "var(--font-arbeit-technik)" }}>{status.externalTxId}</Box>
        </Typography>
      )}

      {/* Not an error, but the one outcome a user must act on rather than just read. */}
      {status.claimableBalanceId && (
        <Alert severity="warning" sx={{ borderRadius: 0, mt: 1.5 }}>
          Ödeme talep edilebilir bakiye olarak bekliyor — hesapta USDC güven hattı yokmuş.
          Toplamak için hattı açıp bakiyeyi talep etmeniz gerekiyor.
        </Alert>
      )}
    </Box>
  );
}
