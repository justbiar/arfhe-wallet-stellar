/**
 * What Arfhe Wallet is, for someone who arrived from the demo and has not met it.
 *
 * Every claim here is one the extension can back today. Stellar appears as work in progress
 * rather than a shipped network, because the published build carries three EVM testnets and
 * a visitor can check that in one click.
 */
import { Box, Stack, Typography, Button, Paper, Chip, Divider, useTheme, alpha } from "@mui/material";
import ArrowForwardIcon from "@mui/icons-material/ArrowForward";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import { Link } from "react-router";
import { SITE_URL, CHROME_STORE_URL, FOUNDED_YEAR, LIVE_NETWORKS } from "../lib/product";

const THIS_YEAR = new Date().getFullYear();

const POINTS: { title: string; body: string }[] = [
  {
    title: "Anahtarlar sizde kalır",
    body:
      "Kendi kendine saklayan (self-custodial) bir uzantı. Özel anahtarlar cihazınızda üretilir, parolanızdan türetilen bir anahtarla şifrelenir ve cihazdan hiç çıkmaz. Sizin adınıza kimse işlem yapamaz — aynı sebeple kimse kurtaramaz da.",
  },
  {
    title: "Şifreli bakiyeler",
    body:
      "Arfhe'yi ayıran yer burası. Tam homomorfik şifreleme (FHE) ile bakiye zincirde şifreli metin olarak duruyor; ağ onun üzerinde hesap yapabiliyor ama sayıyı yalnızca siz okuyabiliyorsunuz. Açık bir cüzdanda herkesin gördüğü miktar, burada kimsenin görmediği bir şey.",
  },
  {
    title: "Arfio",
    body:
      "Cüzdanın içinde, ekibin kendi eğittiği bir ajan. Bakiyeleri okuyabilir, onayları listeleyebilir, bir işlem önerebilir — ama imzalayamaz ve zincire gönderemez. Özel anahtara erişimi yoktur; durum değiştiren her adım sizin onayladığınız bir kartta biter.",
  },
  {
    title: "Ne imzaladığınızı görürsünüz",
    body:
      "Her işlem onaydan önce simüle edilir ve bakiyenizde yaratacağı değişiklik gösterilir. Bağlantı istekleri hangi sitenin hangi ağı ve hangi izni istediğini söyler. Bilinen oltalama alan adları onay ekranında işaretlenir.",
  },
];

function LinkCard({ href, label, title, desc }: { href: string; label: string; title: string; desc: string }) {
  return (
    <Paper
      component="a"
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      elevation={0}
      sx={{
        p: 2.5, border: "1px solid", borderColor: "divider", borderRadius: 0,
        textDecoration: "none", color: "inherit", display: "block",
        transition: "border-color .15s",
        "&:hover": { borderColor: "text.primary" },
      }}
    >
      <Typography variant="caption" color="text.secondary" fontWeight={700}>{label}</Typography>
      <Stack direction="row" alignItems="center" gap={0.8} sx={{ mt: 0.6 }}>
        <Typography sx={{ fontWeight: 700, fontSize: 15 }}>{title}</Typography>
        <OpenInNewIcon sx={{ fontSize: 14, color: "text.secondary" }} />
      </Stack>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.6 }}>{desc}</Typography>
    </Paper>
  );
}

export default function About() {
  const theme = useTheme();
  const accent = theme.palette.primary.main;

  return (
    <Box sx={{ maxWidth: 860, mx: "auto", px: { xs: 2, md: 3 }, py: { xs: 6, md: 9 } }}>
      <Chip
        label="CHROME WEB MAĞAZASINDA YAYINDA"
        size="small"
        sx={{
          borderRadius: 0, fontWeight: 700, letterSpacing: "0.06em",
          bgcolor: alpha(accent, 0.1), color: accent, border: "1px solid", borderColor: alpha(accent, 0.3),
        }}
      />

      <Typography
        sx={{
          mt: 2.5, fontFamily: "var(--font-arbeit-contrast)", fontWeight: 800,
          fontSize: { xs: 34, md: 46 }, lineHeight: 1.08, letterSpacing: "-0.03em",
        }}
      >
        Arfhe Wallet
      </Typography>

      <Typography variant="body1" color="text.secondary" sx={{ mt: 2.5, fontSize: 17, lineHeight: 1.65, maxWidth: 640 }}>
        {FOUNDED_YEAR}'te kuruldu, {THIS_YEAR - FOUNDED_YEAR} yıldır aralıksız geliştiriliyor.
        Kendi kendine saklayan bir tarayıcı cüzdanı — ve her cüzdanın gösterdiği açık bakiyenin
        yanında, yalnızca sizin okuyabildiğiniz şifreli bakiyeler tutabiliyor. Mahremiyet
        sonradan eklenen bir özellik değil, ürünün kurulduğu zemin.
      </Typography>

      {/* ── Linkler ── */}
      <Box sx={{ display: "grid", gap: 2, gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr" }, mt: 4 }}>
        <LinkCard
          href={CHROME_STORE_URL}
          label="KUR"
          title="Chrome Web Mağazası"
          desc="Uzantıyı doğrudan tarayıcınıza ekleyin."
        />
        <LinkCard
          href={SITE_URL}
          label="WEB SİTESİ"
          title="arfhewallet.dev"
          desc="Ürünün kendi sayfası."
        />
      </Box>

      {/* ── Özellikler ── */}
      <Stack gap={2} sx={{ mt: 5 }}>
        {POINTS.map((p) => (
          <Paper key={p.title} elevation={0} sx={{ p: 2.5, border: "1px solid", borderColor: "divider", borderRadius: 0 }}>
            <Typography sx={{ fontWeight: 700, fontSize: 15 }}>{p.title}</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1, lineHeight: 1.65 }}>{p.body}</Typography>
          </Paper>
        ))}
      </Stack>

      <Divider sx={{ my: 5 }} />

      {/* ── Stellar ── */}
      <Typography variant="caption" color="text.secondary" fontWeight={700}>SIRADAKİ · STELLAR</Typography>
      <Typography
        sx={{ mt: 1, fontFamily: "var(--font-arbeit-contrast)", fontWeight: 800, fontSize: { xs: 24, md: 30 }, letterSpacing: "-0.02em", lineHeight: 1.2 }}
      >
        Gönderdiğiniz miktar sizinle kalsın
      </Typography>
      <Typography variant="body1" color="text.secondary" sx={{ mt: 2, fontSize: 16, lineHeight: 1.7, maxWidth: 640 }}>
        Stellar tarafındaki hedef, cüzdanın EVM'de yaptığının aynısı: gizli işlemler. Bir ödeme
        yapıldığında zincirde bir hareket olduğu görünür, ama <strong>ne kadar</strong> gönderildiği
        görünmez. Bugün açık bir ağda maaş ödemek, bir tedarikçiye fatura kapatmak ya da birine
        yardım göndermek, o tutarı herkese ilan etmek demek. Asıl mesele budur.
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 2, lineHeight: 1.65, maxWidth: 640 }}>
        Bu iş yapım aşamasında. Buradaki köprü demosu onun ilk parçası: önce Türk Lirası ile
        Stellar arasındaki yol, ardından o yolun üzerinden geçen gizli transferler.
      </Typography>

      <Divider sx={{ my: 5 }} />

      {/* ── Aglar ── */}
      <Typography variant="caption" color="text.secondary" fontWeight={700}>BUGÜN ÇALIŞTIĞI AĞLAR</Typography>
      <Stack direction="row" gap={1} flexWrap="wrap" sx={{ mt: 1.5 }}>
        {LIVE_NETWORKS.map((n) => (
          <Chip key={n} label={n} size="small" sx={{ borderRadius: 0, border: "1px solid", borderColor: "divider", bgcolor: "transparent" }} />
        ))}
      </Stack>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 2, lineHeight: 1.65 }}>
        Yayındaki sürüm testnet sürümüdür ve mainnet'e yönlendirilemez — buradaki tokenların
        gerçek bir değeri yok. Gizli bakiyeler bu üç ağda çalışıyor, çünkü FHE yardımcı
        işlemcisinin koştuğu ağlar bunlar.
      </Typography>

      <Button
        component={Link} to="/bridge" variant="contained" size="large" endIcon={<ArrowForwardIcon />}
        sx={{ mt: 5, borderRadius: 0, px: 3, py: 1.4, fontWeight: 700 }}
      >
        Köprüyü gör
      </Button>
    </Box>
  );
}
