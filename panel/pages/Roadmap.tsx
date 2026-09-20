import { pt } from "../lib/language";
/**
 * What this is, what the network gives us, where it stops, and what we are doing about it.
 *
 * The demos on the other pages each show one piece running. This page is the argument they
 * belong to — and, deliberately, the limits they run into. A privacy product that lists
 * only what it hides is the kind that gets taken apart in public; the honest version states
 * the boundary first and then says what is being done about it.
 *
 * Every line under "bugün çalışan" is something that ran on testnet and was measured. When
 * a number appears here it came from a transaction, not from a plan.
 */
import { Box, Stack, Typography, Paper, Divider, Chip, Button, useTheme, alpha } from "@mui/material";
import ArrowForwardIcon from "@mui/icons-material/ArrowForward";
import { Link } from "react-router";

interface Item { title: string; body: string }

/** Measured, on testnet. Each one has a page in this panel or a transaction behind it. */
const DONE: Item[] = [
  {
    title: "Gizli ödeme katmanı",
    body:
      "Kendi gizli USDC katmanımız Stellar testnetinde dağıtıldı ve anchor'ın gerçek Circle " +
      "USDC'sini sarmalıyor. Dört senaryonun dördü de uçtan uca ölçüldü — bordro, tedarikçi " +
      "ödemesi, perakende ve kurumsal takas: toplam sekiz gizli ödeme, her biri 5,3 ile 9,5 " +
      "saniye arasında. Ödemenin kime gittiği zincirde görünüyor, ne kadar gittiği görünmüyor: " +
      "her ödemenin zarfında 31.788 baytın 15.308'i opak ve tutarlar arandığında bulunamıyor.",
  },
  {
    title: "Türk Lirası rampası, iki yönde",
    body:
      "SEP-6 anchor üzerinden TRY → USDC ve geri. Bordro senaryosunda 2.730 TRY girdi, 55,68 " +
      "USDC çıktı, üç maaş gizli ödendi. Rampanın kendisi zincirde açık — ve bu kaçınılmaz.",
  },
  {
    title: "“Zincir bunu görüyor” kutusu",
    body:
      "Her ödemenin zincirdeki hâli sayfada duruyor: çağrılan fonksiyon, açıktaki adresler, " +
      "opak bloğun boyutu, ve tutarların zarfta aranıp bulunamaması. İddia değil, ölçüm.",
  },
  {
    title: "EVM tarafı yayında",
    body:
      "Chrome Web Mağazası'ndaki sürüm üç EVM testnetinde tam homomorfik şifreleme ile şifreli " +
      "bakiye tutuyor. Stellar tarafı burada kuruluyor; mağazadaki sürüm onu içermiyor.",
  },
];

/** What the network actually offers, named so a reader can go and check each one. */
const NETWORK: Item[] = [
  {
    title: "Confidential Token",
    body:
      "Bakiyeler ve transfer tutarları gizli, gönderen ve alıcı adresleri açık. Tarafların zaten " +
      "bilindiği, tutarınsa bilinmemesi gereken ödemeler için tasarlanmış.",
  },
  {
    title: "Gizlilik havuzu",
    body:
      "Havuza giriş ve çıkış açık, havuzun içindeki hareket gizli: kimin kime ne kadar gönderdiği " +
      "zincire yazılmıyor. Kimlik bağlantısını kıran tek katman bu.",
  },
  {
    title: "Zincirdeki ZK ilkelleri",
    body:
      "Protokol 22, 25 ve 26 ile gelen BLS12-381, BN254 ve Poseidon2 host fonksiyonları kanıt " +
      "doğrulamayı zincirde ucuz hâle getiriyor. Bu katmanların ikisi de onların üstünde duruyor.",
  },
  {
    title: "Anchor standartları",
    body:
      "SEP-1, 6, 10, 12 ve 38 bir fiat rayını protokol seviyesinde tarif ediyor. Gizli ödemenin " +
      "bir gösteriden ibaret kalmamasını sağlayan şey bu: para bir IBAN'a kadar gidebiliyor.",
  },
];

/** The boundary, and what we are doing about each piece of it. */
const LIMITS: { limit: string; answer: string }[] = [
  {
    limit: "Confidential Token adresleri gizlemiyor.",
    answer:
      "Ölçtük: göndereni bir relayer arkasına almayı denedik, işlem zincirde düştü — yetki girişi " +
      "sahibin adresini taşımak zorunda. Kimlik bağlantısızlığı gerektiğinde doğru katman havuz. " +
      "Her senaryonun yanında zincirde açık kalan şeyi ayrıca yazıyoruz.",
  },
  {
    limit: "Rampanın iki ucu açık.",
    answer:
      "Anchor doğru tutarda TRY ödeyecekse tutarı bilmek zorunda; bunu gizlemeyi vaat etmiyoruz. " +
      "Gizlenen şey aradaki hareket. Toplu çeken bir işletmede tek tek ödemeler o toplamın " +
      "içinde ayrışmıyor — perakendede bu, gizliliği güçlendiren tarafı.",
  },
  {
    limit: "Zincir olay geçmişini ~7 gün tutuyor.",
    answer:
      "Gizli bakiyenin açılımı olaylarda yaşıyor; pencere kapanırsa parayı görüp harcayamazsınız. " +
      "Bugünkü cevaplar (indexer, bootnode) güvenilen bir sunucu demek. Kendi kendine saklayan bir " +
      "cüzdana yakışan dayanıklı kurtarma, sıradaki işin başında duruyor.",
  },
  {
    limit: "Stellar'da tam homomorfik şifreleme yok.",
    answer:
      "Aradık: ne protokolde ne dokümanda var; Stellar'ın gizliliği taahhüt ve sıfır bilgi " +
      "kanıtlarıyla kuruluyor. ElGamal tabanlı bir prototipi ölçtük, tek bir gizli transfer " +
      "2,85 milyar CPU talimatı istiyor — ağın işlem başına sınırı 400 milyon. Bu yüzden FHE " +
      "EVM tarafında kalıyor, Stellar tarafında Confidential Token kullanıyoruz.",
  },
  {
    limit: "Gizlilik havuzunu siteden kaldırdık.",
    answer:
      "Kanıt tarayıcıda üretiliyor ve yatırma bir kez testnette çalıştı — ama npm'deki havuz " +
      "SDK'sı (0.1.0) zincirdeki kontrattan eski: kontrat ext_data_hash'i havuz ve token " +
      "kimliğine bağladıktan sonra o istemcinin ürettiği her işlem WrongExtHash ile reddediliyor. " +
      "Depodan derlenmiş bir kopya çalışıyor, yayınlanan sürüm çalışmıyor. Ziyaretçiye 83 MB " +
      "devre indirtip sonunda reddedilen bir işlem sunmaktansa sayfayı kaldırdık; SDK sürümü " +
      "gelince geri gelir. Havuzun ne yaptığı yukarıda, ağın verdikleri arasında duruyor.",
  },
  {
    limit: "Kanıt üretmek bedava değil.",
    answer:
      "Gizli ödeme başına birkaç saniye. Kanıtlayıcı kütüphane tarayıcı paketleyicisinden " +
      "geçmediği için bordro kanıtları sunucuda üretiliyor — gerçek bir kurumda da bordro " +
      "sunucuda koşar. Bakiyeyi görmek için kanıt gerekmiyor, yalnızca çözme; o cüzdanda kalıyor.",
  },
  {
    limit: "Kullandığımız katmanlar denetlenmedi.",
    answer:
      "Confidential Token da gizlilik havuzu da referans uygulama ve ikisi de testnet için. " +
      "Buradaki tokenların değeri yok. Mainnet'ten önce denetim şart, ve bunu bir şart olarak " +
      "yazıyoruz — bir dipnot olarak değil.",
  },
];

const NEXT: Item[] = [
  {
    title: "Alıcının anahtarı cüzdanında",
    body:
      "Demo servisi bugün hem ödeyenin hem alıcıların anahtarlarını tutuyor, çünkü tek ekranda " +
      "iki tarafı göstermek gerekiyor. Sıradaki adım bunu bitirmek: alıcı kendi cüzdanında çözsün, " +
      "servis anahtarı hiç görmesin.",
  },
  {
    title: "Kurtarma",
    body:
      "Yedi günlük pencereyi aşan, güvenilen bir sunucuya bağlı olmayan bir arşiv. Kendi kendine " +
      "saklayan bir cüzdanın gizli bakiyesi, cüzdanın kendisi kadar dayanıklı olmalı.",
  },
  {
    title: "Gönderen gizliliği",
    body:
      "Ücreti başkasının ödediği, gönderenin imzasını zincire yazmayan bir akış. SDK tarafında " +
      "“hazırla ama gönderme” adımı yeni geldi; bu yolu açan şey o.",
  },
  {
    title: "Cüzdanın içine",
    body:
      "Gizli bakiye ve gizli gönderme ekranlarının uzantıya girmesi. Buradaki paneller birer " +
      "vitrin; ürün, kullanıcının her gün açtığı cüzdan.",
  },
];

function Block({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Box sx={{ mt: 6 }}>
      <Typography variant="caption" color="text.secondary" fontWeight={700}>{pt(label)}</Typography>
      <Box sx={{ mt: 2 }}>{children}</Box>
    </Box>
  );
}

function Card({ item }: { item: Item }) {
  return (
    <Paper elevation={0} sx={{ border: "1px solid", borderColor: "divider", borderRadius: 3, p: 2.5 }}>
      <Typography sx={{ fontWeight: 700, fontSize: 15 }}>{pt(item.title)}</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>{pt(item.body)}</Typography>
    </Paper>
  );
}

export default function Roadmap() {
  const theme = useTheme();

  return (
    <Box sx={{ maxWidth: 900, mx: "auto", px: { xs: 2, md: 3 }, py: { xs: 4, md: 6 } }}>
      <Chip
        size="small"
        label={pt("TESTNET · YAPIM AŞAMASINDA")}
        sx={{
          borderRadius: 1, fontWeight: 700,
          bgcolor: alpha(theme.palette.primary.main, 0.1),
          color: theme.palette.primary.main,
          border: "1px solid", borderColor: alpha(theme.palette.primary.main, 0.3),
        }}
      />

      <Typography
        sx={{ fontFamily: "var(--font-arbeit-contrast)", fontWeight: 800, fontSize: { xs: 30, md: 40 }, letterSpacing: "-0.02em", mt: 2 }}
      >{pt("Ne yaptık, ne yapacağız")}</Typography>

      <Typography variant="body1" color="text.secondary" sx={{ mt: 2.5, fontSize: 17, maxWidth: 660 }}>{pt(
        "Arfhe Wallet, kendi kendine saklayan bir tarayıcı cüzdanı ve üstüne kurulmuş bir ödeme " +
        "sistemi. Amacı tek cümleyle: bir insan ya da bir şirket ödeme yaparken, kimin ödediği " +
        "denetlenebilir kalsın ama ne kadar ödediği herkesin defterine yazılmasın."
      )}</Typography>

      <Typography variant="body2" color="text.secondary" sx={{ mt: 2, maxWidth: 660 }}>{pt(
        "Aşağısı bunun bugünkü hâli: neyi ölçtük, ağ bize neyi veriyor, nerede duruyor, ve o " +
        "duvarlara karşı ne yapıyoruz. Buradaki her sayı bir işlemden geldi."
      )}</Typography>

      <Block label="BUGÜN ÇALIŞAN — ÖLÇÜLDÜ">
        <Stack gap={1.5}>
          {DONE.map((item) => <Card key={item.title} item={item} />)}
        </Stack>
      </Block>

      <Block label="AĞIN VERDİKLERİ">
        <Box sx={{ display: "grid", gap: 1.5, gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr" } }}>
          {NETWORK.map((item) => <Card key={item.title} item={item} />)}
        </Box>
      </Block>

      {/* The section that decides whether the rest is believable. Limits first, answer second,
          and no limit listed without one. */}
      <Block label="SINIRLAR — VE NE YAPIYORUZ">
        <Stack divider={<Divider />} gap={2.5}>
          {LIMITS.map((row) => (
            <Box key={row.limit}>
              <Typography sx={{ fontWeight: 700, fontSize: 14.5 }}>{pt(row.limit)}</Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.8 }}>{pt(row.answer)}</Typography>
            </Box>
          ))}
        </Stack>
      </Block>

      <Block label="SIRADAKİ">
        <Box sx={{ display: "grid", gap: 1.5, gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr" } }}>
          {NEXT.map((item) => <Card key={item.title} item={item} />)}
        </Box>
      </Block>

      <Stack direction={{ xs: "column", sm: "row" }} gap={1.5} sx={{ mt: 5 }}>
        <Button component={Link} to="/payroll" variant="contained" endIcon={<ArrowForwardIcon />}>{pt("Gizli ödemeyi gör")}</Button>
        <Button component={Link} to="/bridge" variant="outlined">{pt("Rampayı gör")}</Button>
      </Stack>

      <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 4, textTransform: "none" }}>{pt(
        "Her şey Stellar testnetinde. Gerçek para, gerçek banka ve gerçek KYC yoktur; buradaki " +
        "tokenlar bir değer taşımaz."
      )}</Typography>
    </Box>
  );
}
