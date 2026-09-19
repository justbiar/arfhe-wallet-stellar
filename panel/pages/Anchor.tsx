/**
 * Confidential Anchor — the product page for the ramp itself.
 *
 * A normal anchor moves fiat in and out and settles on-chain in the open: anyone watching
 * the ledger reads the amount. This page argues for the version where they cannot, and is
 * careful about where that stops — the bank still sees its own transfer, and the anchor still
 * learns the figure it is paying out. Those are not hidden here, because a privacy claim that
 * overstates its boundary is the kind that gets taken apart in public.
 */
import { Box, Stack, Typography, Paper, Chip, Divider, Button, useTheme, alpha } from "@mui/material";
import ArrowForwardIcon from "@mui/icons-material/ArrowForward";
import VisibilityOffIcon from "@mui/icons-material/VisibilityOffOutlined";
import { Link } from "react-router";
import { FIAT_CODE, ANCHOR_ASSET_CODE } from "../lib/anchor";

function Section({ children, sx }: { children: React.ReactNode; sx?: object }) {
  return <Box sx={{ maxWidth: 900, mx: "auto", px: { xs: 2, md: 3 }, ...sx }}>{children}</Box>;
}

/** Who sees what, stated as a table because that is the only honest way to state it. */
const VISIBILITY: { who: string; sees: string; tone: "open" | "hidden" }[] = [
  { who: "Zinciri izleyen herkes", sees: "Bir hareket olduğunu. Miktarı değil, bakiyeyi değil.", tone: "hidden" },
  { who: "Gönderen ve alıcı", sees: "Kendi işlemlerini ve kendi bakiyelerini.", tone: "open" },
  { who: "Anchor", sees: "Yalnızca kendisine kanıtlanan tek işlemin tutarını — TRY'yi ödeyebilmek için.", tone: "open" },
  { who: "Banka", sees: "Kendi havalesini, tam tutarıyla. Bu kısım zincirin dışında.", tone: "open" },
];

const KVKK: { title: string; body: string }[] = [
  {
    title: "Veri minimizasyonu",
    body:
      "KVKK ve GDPR, işlenen kişisel verinin amaçla sınırlı ve ölçülü olmasını istiyor. Açık bir defterde her tutar herkese yazılıyor — kimsenin ihtiyacı olmadığı halde. Gizli transferlerde tutar hiç yazılmıyor; ihtiyacı olan taraf onu ayrıca öğreniyor.",
  },
  {
    title: "Değişmez deftere daha az iz",
    body:
      "Blokzincire yazılan veri silinmiyor. Bu, silinme hakkıyla baş edilmesi zor bir gerilim yaratıyor. Tutarların hiç yazılmaması, sonradan silinmesi gereken veri miktarını baştan azaltıyor — sorunu ortadan kaldırmıyor ama yüzeyini küçültüyor.",
  },
  {
    title: "Finansal profil çıkarılamaz",
    body:
      "Açık bir ağda bir adresin maaşı, harcaması ve serveti herkese açıktır; bunlar birleşince kişisel veri haline gelir. Bakiyeler ve tutarlar gizlendiğinde bu profil kurulamaz, çünkü kurulacak sayı ortada yoktur.",
  },
];

export default function Anchor() {
  const theme = useTheme();
  const accent = theme.palette.primary.main;

  return (
    <>
      <Section sx={{ pt: { xs: 6, md: 10 }, pb: { xs: 4, md: 6 } }}>
        <Chip
          label="YAPIM AŞAMASINDA"
          size="small"
          sx={{
            borderRadius: 0, fontWeight: 700, letterSpacing: "0.06em",
            bgcolor: alpha(accent, 0.1), color: accent, border: "1px solid", borderColor: alpha(accent, 0.3),
          }}
        />
        <Typography
          sx={{
            mt: 2.5, fontFamily: "var(--font-arbeit-contrast)", fontWeight: 800,
            fontSize: { xs: 36, md: 52 }, lineHeight: 1.05, letterSpacing: "-0.03em",
          }}
        >
          Confidential Anchor
        </Typography>
        <Typography variant="body1" color="text.secondary" sx={{ mt: 2.5, fontSize: 17, lineHeight: 1.7, maxWidth: 660 }}>
          Sıradan bir anchor {FIAT_CODE} ile {ANCHOR_ASSET_CODE} arasında köprü kurar ve zincirde
          açık bir ödeme bırakır — tutarı okumak isteyen herkes okur. Confidential Anchor aynı
          işi yapar, ama <strong>tutarı ağa yazmaz.</strong>
        </Typography>
      </Section>

      {/* ── Fark ── */}
      <Box sx={{ borderTop: "1px solid", borderBottom: "1px solid", borderColor: "divider", py: { xs: 5, md: 7 } }}>
        <Section>
          <Stack direction="row" alignItems="center" gap={1.2} sx={{ mb: 3 }}>
            <VisibilityOffIcon sx={{ fontSize: 18, color: "text.secondary" }} />
            <Typography variant="caption" color="text.secondary" fontWeight={700}>Kim neyi görür</Typography>
          </Stack>
          <Stack gap={1.5}>
            {VISIBILITY.map((r) => (
              <Paper
                key={r.who}
                elevation={0}
                sx={{
                  p: 2, borderRadius: 0, border: "1px solid", borderColor: "divider",
                  display: "grid", gap: 1.5,
                  gridTemplateColumns: { xs: "1fr", sm: "200px 1fr" },
                  borderLeft: "3px solid",
                  borderLeftColor: r.tone === "hidden" ? accent : "divider",
                }}
              >
                <Typography sx={{ fontWeight: 700, fontSize: 14 }}>{r.who}</Typography>
                <Typography variant="body2" color="text.secondary" sx={{ lineHeight: 1.6 }}>{r.sees}</Typography>
              </Paper>
            ))}
          </Stack>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 3, lineHeight: 1.7, maxWidth: 660 }}>
            Anchor'ın tutarı öğrenmesi bir açık değil, işin gereği: karşılığında {FIAT_CODE} ödeyecek.
            Öğrenme şekli değişiyor — zincire yazılmış bir sayıyı okumak yerine, kullanıcının
            yalnızca ona verdiği bir kanıtla. Aynı bilgi, tek bir muhataba.
          </Typography>
        </Section>
      </Box>

      {/* ── KVKK / GDPR ── */}
      <Section sx={{ py: { xs: 5, md: 7 } }}>
        <Typography variant="caption" color="text.secondary" fontWeight={700}>KVKK VE GDPR TARAFINDA</Typography>
        <Typography
          sx={{ mt: 1, fontFamily: "var(--font-arbeit-contrast)", fontWeight: 800, fontSize: { xs: 24, md: 30 }, letterSpacing: "-0.02em", lineHeight: 1.25 }}
        >
          Yazılmayan veri, korunması gereken veri değildir
        </Typography>

        <Stack gap={2} sx={{ mt: 3 }}>
          {KVKK.map((k) => (
            <Paper key={k.title} elevation={0} sx={{ p: 2.5, border: "1px solid", borderColor: "divider", borderRadius: 0 }}>
              <Typography sx={{ fontWeight: 700, fontSize: 15 }}>{k.title}</Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 1, lineHeight: 1.65 }}>{k.body}</Typography>
            </Paper>
          ))}
        </Stack>

        <Paper
          elevation={0}
          sx={{ mt: 3, p: 2.5, border: "1px solid", borderColor: "divider", borderRadius: 0, bgcolor: alpha(theme.palette.text.primary, 0.03) }}
        >
          <Typography variant="caption" color="text.secondary" fontWeight={700}>NE İDDİA ETMİYORUZ</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1, lineHeight: 1.7 }}>
            Bu, KVKK ve GDPR yükümlülüklerini ortadan kaldırmaz. Adresler zincirde açık kalır ve
            bir adres bir kişiye bağlanabiliyorsa o kişisel veridir. Değişmez bir defterde silinme
            hakkı hâlâ çözülmüş bir problem değildir. Ve bankanın kendi kayıtları, tam tutarıyla,
            her zaman yerinde durur. Burada iyileşen şey <strong>ağa sızan veri miktarıdır</strong>;
            uyumluluk bununla kolaylaşır, kendiliğinden gelmez.
          </Typography>
        </Paper>
      </Section>

      <Divider />

      <Section sx={{ py: { xs: 5, md: 7 } }}>
        <Typography variant="body1" color="text.secondary" sx={{ lineHeight: 1.7, maxWidth: 660 }}>
          Confidential Anchor şu an yapım aşamasında. Köprü sayfası akışın iki ucunu — banka ve
          cüzdan — bugünkü haliyle gösteriyor; gizli ayak buraya bağlanacak.
        </Typography>
        <Button
          component={Link} to="/bridge" variant="contained" size="large" endIcon={<ArrowForwardIcon />}
          sx={{ mt: 3, borderRadius: 0, px: 3, py: 1.4, fontWeight: 700 }}
        >
          Köprüyü gör
        </Button>
      </Section>
    </>
  );
}
