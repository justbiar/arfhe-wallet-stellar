import { pt } from "../lib/language";
/**
 * The testnet build of the wallet, offered as a download.
 *
 * The store version is the EVM wallet. Everything the rest of this site demonstrates — the
 * Stellar account, the bridge, the bank mode — lives in this build and nowhere else, so
 * "install from the Chrome Web Store" is an answer that does not work for a visitor who
 * came here to try the ramp.
 *
 * What it does not do is pretend to be a one-click install. Chrome will not install a zip,
 * and a page that implies otherwise produces a confused visitor and a wallet that is not
 * there. The three steps are the whole flow; they are short because the browser makes them
 * short, not because anything is being hidden.
 */
import React from "react";
import { Box, Stack, Typography, Paper, Button, useTheme, alpha } from "@mui/material";
import DownloadIcon from "@mui/icons-material/FileDownloadOutlined";
import { ANCHOR_HOME_DOMAIN } from "../lib/anchor";

interface Build {
  file: string;
  version: string;
  bytes: number;
  sha256: string;
  builtAt: string;
  anchor: string;
}

const STEPS = [
  "İndirilen zip'i bir klasöre çıkarın — içinde manifest.json görünmeli.",
  "chrome://extensions adresini açın ve sağ üstten Geliştirici modunu açın.",
  "Paketlenmemiş öğe yükle deyip o klasörü seçin.",
];

export default function DownloadExtension({ compact = false }: { compact?: boolean }) {
  const theme = useTheme();
  const accent = theme.palette.primary.main;
  const [build, setBuild] = React.useState<Build | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    fetch("download/extension.json")
      .then((r) => (r.ok ? r.json() : null))
      .then((b: Build | null) => { if (!cancelled) setBuild(b); })
      // No build packaged into this deployment. The card says so rather than offering a
      // link that 404s.
      .catch(() => { if (!cancelled) setBuild(null); });
    return () => { cancelled = true; };
  }, []);

  const size = build ? `${(build.bytes / 1024 / 1024).toFixed(1)} MB` : "—";
  const stale = build != null && build.anchor !== ANCHOR_HOME_DOMAIN;

  const button = (
    <Button
      variant="contained"
      href={build?.file ?? "#"}
      disabled={!build}
      download
      startIcon={<DownloadIcon />}
      sx={{ borderRadius: 3, px: 2.5, py: 1.2, fontWeight: 700, whiteSpace: "nowrap" }}
    >{pt(build ? `Testnet sürümünü indir · ${size}` : "Derleme henüz yüklenmedi")}</Button>
  );

  if (compact) {
    return (
      <Stack gap={0.8} alignItems="center">
        {button}
        <Typography variant="caption" color="text.secondary" sx={{ textTransform: "none", textAlign: "center", lineHeight: 1.5 }}>{pt(" Mağazadaki sürümde Stellar tarafı yok. Kurulum: zip'i çıkarın, chrome://extensions → Geliştirici modu → Paketlenmemiş öğe yükle. ")}</Typography>
      </Stack>
    );
  }

  return (
    <Paper
      elevation={0}
      sx={{ p: 3, borderRadius: 3, border: "1px solid", borderColor: alpha(accent, 0.35), bgcolor: alpha(accent, 0.04) }}
    >
      <Typography variant="caption" color="text.secondary" fontWeight={700}>{pt("TESTNET SÜRÜMÜ")}</Typography>
      <Typography sx={{ mt: 1, fontWeight: 700, fontSize: 18 }}>{pt(" Stellar tarafını denemek için bu derleme gerekiyor ")}</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 1, lineHeight: 1.7, maxWidth: 620 }}>{pt(" Chrome Web Mağazası'ndaki sürüm cüzdanın EVM tarafı. Stellar hesabı, köprü ve banka modu yalnızca bu derlemede var. Mağaza sürümünün yanına kurulabilir; ikisi ayrı uzantı olarak durmaz, aynı kimliği taşıdıkları için birini kaldırıp diğerini yüklemeniz gerekir. ")}</Typography>

      <Stack direction={{ xs: "column", sm: "row" }} gap={1.5} alignItems={{ sm: "center" }} sx={{ mt: 2.5 }}>
        {button}
        {build && (
          <Typography variant="caption" color="text.secondary" sx={{ fontFamily: "var(--font-arbeit-technik)", textTransform: "none" }}>
            v{build.version} · sha256 {build.sha256.slice(0, 12)}…
          </Typography>
        )}
      </Stack>

      <Box sx={{ mt: 2.5 }}>
        {STEPS.map((step, i) => (
          <Stack key={i} direction="row" gap={1.2} alignItems="flex-start" sx={{ mt: 1 }}>
            <Box
              sx={{
                flexShrink: 0, width: 20, height: 20, mt: "1px", display: "grid", placeItems: "center",
                border: "1px solid", borderColor: alpha(accent, 0.4), color: accent,
                fontFamily: "var(--font-arbeit-technik)", fontSize: 11, fontWeight: 700,
              }}
            >{i + 1}</Box>
            <Typography variant="body2" color="text.secondary" sx={{ lineHeight: 1.6 }}>{pt(step)}</Typography>
          </Stack>
        ))}
      </Box>

      <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 2.5, textTransform: "none", lineHeight: 1.6 }}>{pt(" Testnet. Gerçek para tutmaz, mainnet'e yönlendirilemez. Kaynak kod depoda; bu zip ")}<code style={{ fontFamily: "var(--font-arbeit-technik)" }}>{pt("npm run build:chrome")}</code>{pt(" çıktısının aynısıdır. ")}</Typography>

      {stale && (
        <Typography variant="caption" sx={{ display: "block", mt: 1.5, color: "warning.main", textTransform: "none", lineHeight: 1.6 }}>{pt(" Bu derleme ")}<code style={{ fontFamily: "var(--font-arbeit-technik)" }}>{build?.anchor}</code>{pt(" anchor'ına bakıyor, site ise ")}<code style={{ fontFamily: "var(--font-arbeit-technik)" }}>{ANCHOR_HOME_DOMAIN}</code>{pt(" kullanıyor. Köprü çalışmaz — yeni bir derleme gerekiyor. ")}</Typography>
      )}
    </Paper>
  );
}
