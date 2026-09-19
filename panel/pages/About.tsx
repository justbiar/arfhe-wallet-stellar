/**
 * What Arfhe Wallet is, for someone who arrived from the demo and has not met it.
 *
 * Short on purpose: the claims here are the ones the wallet can actually back, stated once
 * each, with no feature list padded out to look substantial.
 */
import { Box, Stack, Typography, Button, Paper } from "@mui/material";
import ArrowForwardIcon from "@mui/icons-material/ArrowForward";
import { Link } from "react-router";

const POINTS: { title: string; body: string }[] = [
  {
    title: "Anahtarlar sizde kalır",
    body:
      "Cüzdan kendi kendine saklayan (self-custodial) bir uzantı. Özel anahtarlar cihazınızda üretilir, parolanızdan türetilen bir anahtarla şifrelenir ve hiçbir zaman cihazdan çıkmaz. Sizin adınıza kimse işlem yapamaz — aynı sebeple kimse kurtaramaz da.",
  },
  {
    title: "Şifreli bakiyeler",
    body:
      "Arfhe'yi ayıran yer burası: tam homomorfik şifreleme (FHE) ile bakiyeyi zincirde şifreli tutabiliyor. Miktar zincirde şifreli metin olarak duruyor, ağ onun üzerinde hesap yapabiliyor, ama sayıyı yalnızca siz okuyabiliyorsunuz.",
  },
  {
    title: "Ne imzaladığınızı görürsünüz",
    body:
      "Her işlem onaydan önce simüle edilir ve bakiyenizde yaratacağı değişiklik gösterilir. Bağlantı istekleri hangi sitenin, hangi ağı ve hangi izni istediğini söyler. Bilinen oltalama alan adları onay ekranında işaretlenir.",
  },
  {
    title: "İmzalayamayan bir asistan",
    body:
      "Gömülü yapay zekâ asistanı bakiyeleri okuyabilir ve bir işlem önerebilir — ama imzalayamaz ve zincire gönderemez. Özel anahtara erişimi yoktur; durum değiştiren her adım sizin onayladığınız bir kartta biter.",
  },
];

export default function About() {
  return (
    <Box sx={{ maxWidth: 860, mx: "auto", px: { xs: 2, md: 3 }, py: { xs: 6, md: 9 } }}>
      <Typography
        sx={{
          fontFamily: "var(--font-arbeit-contrast)", fontWeight: 800,
          fontSize: { xs: 34, md: 46 }, lineHeight: 1.08, letterSpacing: "-0.03em",
        }}
      >
        Arfhe Wallet
      </Typography>
      <Typography variant="body1" color="text.secondary" sx={{ mt: 2.5, fontSize: 17, lineHeight: 1.65, maxWidth: 620 }}>
        Ethereum için kendi kendine saklayan bir tarayıcı cüzdanı. Her cüzdanın gösterdiği
        açık bakiyenin yanında, yalnızca sizin okuyabildiğiniz şifreli bakiyeler de tutabiliyor.
      </Typography>

      <Stack gap={2} sx={{ mt: 5 }}>
        {POINTS.map((p) => (
          <Paper key={p.title} elevation={0} sx={{ p: 2.5, border: "1px solid", borderColor: "divider", borderRadius: 0 }}>
            <Typography sx={{ fontWeight: 700, fontSize: 15 }}>{p.title}</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1, lineHeight: 1.65 }}>
              {p.body}
            </Typography>
          </Paper>
        ))}
      </Stack>

      <Paper
        elevation={0}
        sx={{ mt: 4, p: 2.5, border: "1px solid", borderColor: "warning.main", borderRadius: 0, bgcolor: "warning.main" + "0A" }}
      >
        <Typography variant="caption" fontWeight={700} color="warning.main">TESTNET SÜRÜMÜ</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.8, lineHeight: 1.6 }}>
          Cüzdan şu an Sepolia, Base Sepolia ve Arbitrum Sepolia üzerinde çalışıyor ve
          mainnet'e yönlendirilemiyor. Buradaki tokenların gerçek bir değeri yok.
        </Typography>
      </Paper>

      <Button
        component={Link} to="/bridge" variant="contained" size="large" endIcon={<ArrowForwardIcon />}
        sx={{ mt: 4, borderRadius: 0, px: 3, py: 1.4, fontWeight: 700 }}
      >
        Köprüyü gör
      </Button>
    </Box>
  );
}
