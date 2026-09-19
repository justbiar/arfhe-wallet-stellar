/**
 * Landing page.
 *
 * One job: make it obvious in a few seconds what this demo does — Turkish lira in one side,
 * USDC in a self-custodial wallet out the other — and that nothing here is real money.
 */
import { Box, Stack, Typography, Button, Paper, Chip, useTheme, alpha } from "@mui/material";
import ArrowForwardIcon from "@mui/icons-material/ArrowForward";
import SyncAltIcon from "@mui/icons-material/SyncAlt";
import { Link } from "react-router";
import { ANCHOR_HOME_DOMAIN, DEPOSIT_MIN_TRY, DEPOSIT_MAX_TRY } from "../lib/anchor";
import { CHROME_STORE_URL, FOUNDED_YEAR } from "../lib/product";

function Section({ children, sx }: { children: React.ReactNode; sx?: object }) {
  return <Box sx={{ maxWidth: 1180, mx: "auto", px: { xs: 2, md: 3 }, ...sx }}>{children}</Box>;
}

/** One leg of the ramp, drawn as the ordered steps it actually takes. */
function Flow({ title, steps, accent }: { title: string; steps: string[]; accent: string }) {
  return (
    <Paper elevation={0} sx={{ p: 2.5, border: "1px solid", borderColor: "divider", borderRadius: 0, height: "100%" }}>
      <Typography variant="caption" sx={{ color: accent, fontWeight: 700 }}>{title}</Typography>
      <Stack gap={1.2} sx={{ mt: 1.5 }}>
        {steps.map((s, i) => (
          <Stack key={i} direction="row" gap={1.2} alignItems="flex-start">
            <Box sx={{
              width: 20, height: 20, flexShrink: 0, mt: "1px",
              border: "1px solid", borderColor: accent, color: accent,
              display: "grid", placeItems: "center",
              fontFamily: "var(--font-arbeit-technik)", fontSize: 11, fontWeight: 700,
            }}>{i + 1}</Box>
            <Typography variant="body2" color="text.secondary" sx={{ lineHeight: 1.55 }}>{s}</Typography>
          </Stack>
        ))}
      </Stack>
    </Paper>
  );
}

export default function Landing() {
  const theme = useTheme();
  const accent = theme.palette.primary.main;

  return (
    <>
      {/* ── Hero ── */}
      <Section sx={{ pt: { xs: 7, md: 11 }, pb: { xs: 6, md: 9 } }}>
        <Chip
          label="STELLAR TESTNET · DEMO"
          size="small"
          sx={{
            borderRadius: 0, fontWeight: 700, letterSpacing: "0.08em",
            bgcolor: alpha(accent, 0.1), color: accent, border: "1px solid", borderColor: alpha(accent, 0.3),
          }}
        />

        <Typography
          sx={{
            mt: 2.5, fontFamily: "var(--font-arbeit-contrast)", fontWeight: 800,
            fontSize: { xs: 38, sm: 52, md: 64 }, lineHeight: 1.03, letterSpacing: "-0.03em", maxWidth: 880,
          }}
        >
          Türk Lirası girer,<br />kendi cüzdanınızda USDC çıkar.
        </Typography>

        <Typography variant="body1" color="text.secondary" sx={{ mt: 3, maxWidth: 620, fontSize: 17, lineHeight: 1.65 }}>
          Bir tarafta tanıdık bir banka ekranı, diğer tarafta Arfhe Wallet. Aradaki yol
          Stellar'ın standart on/off-ramp protokolleri üzerinden kuruluyor — yani aynı
          entegrasyon, ileride gerçek bir kuruma da bağlanabiliyor.
        </Typography>

        <Stack direction={{ xs: "column", sm: "row" }} gap={1.5} sx={{ mt: 4.5 }}>
          <Button
            component={Link} to="/bridge" variant="contained" size="large"
            endIcon={<ArrowForwardIcon />}
            sx={{ borderRadius: 0, px: 3, py: 1.4, fontSize: 14, fontWeight: 700 }}
          >
            Köprüyü aç
          </Button>
          <Button
            href={CHROME_STORE_URL} target="_blank" rel="noopener noreferrer"
            variant="outlined" size="large"
            sx={{ borderRadius: 0, px: 3, py: 1.4, fontSize: 14, fontWeight: 700, borderColor: "divider", color: "text.primary" }}
          >
            Chrome'a ekle
          </Button>
        </Stack>

        <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 2.5, textTransform: "none" }}>
          Arfhe Wallet {FOUNDED_YEAR}'ten beri geliştiriliyor ve Chrome Web Mağazası'nda yayında.{" "}
          <Box component={Link} to="/about" sx={{ color: "text.primary", textUnderlineOffset: 3 }}>
            Cüzdan hakkında →
          </Box>
        </Typography>
      </Section>

      {/* ── İki yön ── */}
      <Box sx={{ borderTop: "1px solid", borderBottom: "1px solid", borderColor: "divider", py: { xs: 5, md: 7 } }}>
        <Section>
          <Stack direction="row" alignItems="center" gap={1.2} sx={{ mb: 3 }}>
            <SyncAltIcon sx={{ fontSize: 18, color: "text.secondary" }} />
            <Typography variant="caption" color="text.secondary" fontWeight={700}>
              Köprü iki yönlü çalışır
            </Typography>
          </Stack>

          <Box sx={{ display: "grid", gap: 2, gridTemplateColumns: { xs: "1fr", md: "1fr 1fr" } }}>
            <Flow
              title="TRY → USDC  ·  YÜKLEME"
              accent={accent}
              steps={[
                "Cüzdanınızın anahtarıyla giriş yaparsınız — şifre yok, hesap açmak yok. Anahtar kimliğinizdir.",
                "Karşı taraf bir IBAN ve açıklamaya yazılacak bir referans verir.",
                "Havale “gelir” ve TRY bakiyeniz görünür. Bu demoda bankayı siz oynarsınız.",
                "Kur o an kilitlenir, karşılığı kadar testnet USDC cüzdanınıza geçer.",
              ]}
            />
            <Flow
              title="USDC → TRY  ·  ÇEKME"
              accent={accent}
              steps={[
                "Çekim başlatırsınız; size bir hazine adresi ve bir memo verilir.",
                "Cüzdan, USDC'yi o memo ile Stellar üzerinden gönderir.",
                "Ödeme zincirde görülür ve kur kilitli fiyattan bozulur.",
                "TRY, IBAN'ınıza geçer — bu demoda simüle edilmiş bir FAST transferi olarak.",
              ]}
            />
          </Box>
        </Section>
      </Box>

      {/* ── Şeffaflık ── */}
      <Section sx={{ py: { xs: 5, md: 7 } }}>
        <Box sx={{ display: "grid", gap: { xs: 3, md: 5 }, gridTemplateColumns: { xs: "1fr", md: "1fr 1fr 1fr" } }}>
          <Box>
            <Typography variant="caption" color="text.secondary" fontWeight={700}>NE GERÇEK</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1, lineHeight: 1.65 }}>
              Stellar ayağı gerçek. USDC gerçekten testnet üzerinde hareket ediyor, bakiyeler
              zincirden okunuyor, işlemler Horizon'da görülebiliyor.
            </Typography>
          </Box>
          <Box>
            <Typography variant="caption" color="text.secondary" fontWeight={700}>NE SİMÜLE</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1, lineHeight: 1.65 }}>
              Banka ve kimlik doğrulama. Gerçek para yok, gerçek IBAN yok, kişisel veri
              istenmiyor ve saklanmıyor. Havalenin geldiğini siz söylüyorsunuz.
            </Typography>
          </Box>
          <Box>
            <Typography variant="caption" color="text.secondary" fontWeight={700}>SINIRLAR</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1, lineHeight: 1.65 }}>
              Yükleme başına {DEPOSIT_MIN_TRY}–{DEPOSIT_MAX_TRY} TRY. Kur, bir fiyat
              oracle'ından geliyor ve üzerine sabit bir marj biniyor.
            </Typography>
          </Box>
        </Box>

        <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 4, textTransform: "none" }}>
          Karşı taraf: <Box component="code" sx={{ fontFamily: "var(--font-arbeit-technik)" }}>{ANCHOR_HOME_DOMAIN}</Box>
        </Typography>
      </Section>
    </>
  );
}
