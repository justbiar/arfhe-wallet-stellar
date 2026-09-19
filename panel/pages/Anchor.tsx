import { pt } from "../lib/language";
/**
 * Confidential Anchor — the product page for the ramp itself.
 *
 * A normal anchor moves fiat in and out and settles on-chain in the open: anyone watching
 * the ledger reads the amount. This page argues for the version where they cannot, and is
 * careful about where that stops — the bank still sees its own transfer, and the anchor still
 * learns the figure it is paying out. Those are not hidden here, because a privacy claim that
 * overstates its boundary is the kind that gets taken apart in public.
 */
import React from "react";
import {
  Box, Stack, Typography, Paper, Chip, Divider, Button, CircularProgress, useTheme, alpha,
} from "@mui/material";
import ArrowForwardIcon from "@mui/icons-material/ArrowForward";
import VisibilityOffIcon from "@mui/icons-material/VisibilityOffOutlined";
import { Link } from "react-router";
import { FIAT_CODE, ANCHOR_ASSET_CODE, ANCHOR_HOME_DOMAIN } from "../lib/anchor";
import { readAnchorLive, type AnchorLive } from "../lib/anchorLive";

function Section({ children, sx }: { children: React.ReactNode; sx?: object }) {
  return <Box sx={{ maxWidth: 900, mx: "auto", px: { xs: 2, md: 3 }, ...sx }}>{pt(children)}</Box>;
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

/** The two directions, as the anchor itself documents them. */
const ON_RAMP = [
  "Cüzdan, Stellar anahtarıyla giriş yapar (SEP-10) — parola yok, imza var.",
  "Kur kilitlenir (SEP-38) ve yükleme açılır (SEP-6).",
  "Anchor IBAN ve bir referans verir; havale o referansla gönderilir.",
  "Havale görüldüğünde anchor zincirde ödeme yapar.",
  `Cüzdana ${ANCHOR_ASSET_CODE} geçer; durum completed olur.`,
];

const OFF_RAMP = [
  "Cüzdan giriş yapar ve çekim açar (SEP-6).",
  "Anchor hazine hesabını ve bir memo verir.",
  `${ANCHOR_ASSET_CODE} o memo ile zincirde gönderilir.`,
  "Anchor ödemeyi memodan eşleştirir.",
  `${FIAT_CODE} IBAN'a geçer (simüle FAST).`,
];

/** One reading from the anchor, or an honest dash. */
function Reading({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <Stack direction="row" justifyContent="space-between" alignItems="baseline" gap={2} sx={{ py: 0.7 }}>
      <Typography variant="caption" color="text.secondary">{pt(label)}</Typography>
      <Typography
        variant="caption"
        sx={{ fontFamily: mono ? "var(--font-arbeit-technik)" : undefined, textAlign: "right", wordBreak: "break-all" }}
      >
        {pt(value)}
      </Typography>
    </Stack>
  );
}

function Steps({ title, steps }: { title: string; steps: string[] }) {
  return (
    <Box sx={{ flex: 1, minWidth: 260 }}>
      <Typography variant="caption" color="text.secondary" fontWeight={700}>{pt(title)}</Typography>
      <Stack gap={1.2} sx={{ mt: 1.5 }}>
        {steps.map((step, i) => (
          <Stack key={i} direction="row" gap={1.2} alignItems="flex-start">
            <Box
              sx={{
                flexShrink: 0, width: 20, height: 20, mt: "1px", display: "grid", placeItems: "center",
                border: "1px solid", borderColor: "divider", fontSize: 11, fontWeight: 700,
              }}
            >
              {i + 1}
            </Box>
            <Typography variant="body2" color="text.secondary" sx={{ lineHeight: 1.6 }}>{pt(step)}</Typography>
          </Stack>
        ))}
      </Stack>
    </Box>
  );
}

export default function Anchor() {
  const theme = useTheme();
  const accent = theme.palette.primary.main;
  const [live, setLive] = React.useState<AnchorLive | null>(null);
  const [loadingLive, setLoadingLive] = React.useState(true);

  // Read on arrival. The page makes a claim about a running service; the service should be
  // on the page saying whether it is running.
  React.useEffect(() => {
    let cancelled = false;
    void readAnchorLive()
      .then((l) => { if (!cancelled) setLive(l); })
      .finally(() => { if (!cancelled) setLoadingLive(false); });
    return () => { cancelled = true; };
  }, []);

  return (
    <>
      <Section sx={{ pt: { xs: 6, md: 10 }, pb: { xs: 4, md: 6 } }}>
        <Chip
          label={pt("YAPIM AŞAMASINDA")}
          size="small"
          sx={{
            borderRadius: 3, fontWeight: 700, letterSpacing: "0.06em",
            bgcolor: alpha(accent, 0.1), color: accent, border: "1px solid", borderColor: alpha(accent, 0.3),
          }}
        />
        <Typography
          sx={{
            mt: 2.5, fontFamily: "var(--font-arbeit-contrast)", fontWeight: 800,
            fontSize: { xs: 36, md: 52 }, lineHeight: 1.05, letterSpacing: "-0.03em",
          }}
        >{pt(" Confidential Anchor ")}</Typography>
        <Typography variant="body1" color="text.secondary" sx={{ mt: 2.5, fontSize: 17, lineHeight: 1.7, maxWidth: 660 }}>{pt(" Sıradan bir anchor ")}{pt(FIAT_CODE)}{pt(" ile ")}{pt(ANCHOR_ASSET_CODE)}{pt(" arasında köprü kurar ve zincirde açık bir ödeme bırakır — tutarı okumak isteyen herkes okur. Confidential Anchor aynı işi yapar, ama ")}<strong>{pt("tutarı ağa yazmaz.")}</strong>
        </Typography>
      </Section>

      {/* ── Fark ── */}
      <Box sx={{ borderTop: "1px solid", borderBottom: "1px solid", borderColor: "divider", py: { xs: 5, md: 7 } }}>
        <Section>
          <Stack direction="row" alignItems="center" gap={1.2} sx={{ mb: 3 }}>
            <VisibilityOffIcon sx={{ fontSize: 18, color: "text.secondary" }} />
            <Typography variant="caption" color="text.secondary" fontWeight={700}>{pt("Kim neyi görür")}</Typography>
          </Stack>
          <Stack gap={1.5}>
            {VISIBILITY.map((r) => (
              <Paper
                key={r.who}
                elevation={0}
                sx={{
                  p: 2, borderRadius: 3, border: "1px solid", borderColor: "divider",
                  display: "grid", gap: 1.5,
                  gridTemplateColumns: { xs: "1fr", sm: "200px 1fr" },
                  borderLeft: "3px solid",
                  borderLeftColor: r.tone === "hidden" ? accent : "divider",
                }}
              >
                <Typography sx={{ fontWeight: 700, fontSize: 14 }}>{pt(r.who)}</Typography>
                <Typography variant="body2" color="text.secondary" sx={{ lineHeight: 1.6 }}>{pt(r.sees)}</Typography>
              </Paper>
            ))}
          </Stack>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 3, lineHeight: 1.7, maxWidth: 660 }}>{pt(" Anchor'ın tutarı öğrenmesi bir açık değil, işin gereği: karşılığında ")}{pt(FIAT_CODE)}{pt(" ödeyecek. Öğrenme şekli değişiyor — zincire yazılmış bir sayıyı okumak yerine, kullanıcının yalnızca ona verdiği bir kanıtla. Aynı bilgi, tek bir muhataba. ")}</Typography>
        </Section>
      </Box>

      {/* ── KVKK / GDPR ── */}
      <Section sx={{ py: { xs: 5, md: 7 } }}>
        <Typography variant="caption" color="text.secondary" fontWeight={700}>{pt("KVKK VE GDPR TARAFINDA")}</Typography>
        <Typography
          sx={{ mt: 1, fontFamily: "var(--font-arbeit-contrast)", fontWeight: 800, fontSize: { xs: 24, md: 30 }, letterSpacing: "-0.02em", lineHeight: 1.25 }}
        >{pt(" Yazılmayan veri, korunması gereken veri değildir ")}</Typography>

        <Stack gap={2} sx={{ mt: 3 }}>
          {KVKK.map((k) => (
            <Paper key={k.title} elevation={0} sx={{ p: 2.5, border: "1px solid", borderColor: "divider", borderRadius: 3 }}>
              <Typography sx={{ fontWeight: 700, fontSize: 15 }}>{pt(k.title)}</Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 1, lineHeight: 1.65 }}>{pt(k.body)}</Typography>
            </Paper>
          ))}
        </Stack>

        <Paper
          elevation={0}
          sx={{ mt: 3, p: 2.5, border: "1px solid", borderColor: "divider", borderRadius: 3, bgcolor: alpha(theme.palette.text.primary, 0.03) }}
        >
          <Typography variant="caption" color="text.secondary" fontWeight={700}>{pt("NE İDDİA ETMİYORUZ")}</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1, lineHeight: 1.7 }}>{pt(" Bu, KVKK ve GDPR yükümlülüklerini ortadan kaldırmaz. Adresler zincirde açık kalır ve bir adres bir kişiye bağlanabiliyorsa o kişisel veridir. Değişmez bir defterde silinme hakkı hâlâ çözülmüş bir problem değildir. Ve bankanın kendi kayıtları, tam tutarıyla, her zaman yerinde durur. Burada iyileşen şey ")}<strong>{pt("ağa sızan veri miktarıdır")}</strong>{pt("; uyumluluk bununla kolaylaşır, kendiliğinden gelmez. ")}</Typography>
        </Paper>
      </Section>

      <Divider />

      {/* ── Canlı ── */}
      <Section sx={{ py: { xs: 5, md: 7 } }}>
        <Stack direction="row" alignItems="center" gap={1.2} sx={{ mb: 1 }}>
          <Typography sx={{ fontFamily: "var(--font-arbeit-contrast)", fontWeight: 800, fontSize: { xs: 22, md: 26 }, letterSpacing: "-0.02em" }}>{pt(" Canlı simülasyon ")}</Typography>
          {loadingLive && <CircularProgress size={14} />}
          {!loadingLive && (
            <Chip
              size="small"
              label={pt(live?.health?.ok ? "AYAKTA" : "CEVAP YOK")}
              sx={{
                borderRadius: 3, height: 20, fontSize: 10, fontWeight: 700,
                bgcolor: live?.health?.ok ? alpha(theme.palette.success.main, 0.12) : "action.hover",
                color: live?.health?.ok ? "success.main" : "text.secondary",
              }}
            />
          )}
        </Stack>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2, maxWidth: 660 }}>{pt(" Aşağıdaki sayılar ")}<b>{pt(ANCHOR_HOME_DOMAIN)}</b>{pt("'in şu an yayınladığı değerler — sayfa açılırken okundu. Banka ve KYC simüle, ")}<b>{pt("Stellar ayağı gerçek")}</b>{pt(". ")}</Typography>

        {/* Whose anchor this is, because "the anchor is down" and "our service is down" are
            different sentences and the page should not blur them. */}
        <Paper elevation={0} sx={{ p: 2.5, mb: 3, border: "1px solid", borderColor: "divider", borderRadius: 3, maxWidth: 660 }}>
          <Typography variant="caption" color="text.secondary" fontWeight={700}>{pt("BU ANCHOR BİZİM")}</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>{pt("Mock anchor — depoda duruyor ve npm run anchor ile çalışıyor. Kendimiz yazdık, çünkü daha önce kullandığımız sandbox HTTP'ye cevap verirken ödeme yapmayı bırakmıştı: yatırma pending_anchor'da kalıyor, kayda talep açıldıktan 60 ms sonra bir daha dokunulmuyordu. Kimsenin yeniden başlatamadığı bir servise demo bağlanmaz.")}</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5 }}>{pt("Bir farkı daha var: çekimde verdiğiniz IBAN'ı gerçekten kullanıyor. Öncekine üç ayrı IBAN gönderildi, üçünde de kendi hesabını döndürdü — ölçüldü.")}</Typography>
        </Paper>

        <Stack direction={{ xs: "column", md: "row" }} gap={2}>
          <Paper elevation={0} sx={{ flex: 1, p: 2.5, border: "1px solid", borderColor: "divider", borderRadius: 3 }}>
            <Typography variant="caption" color="text.secondary" fontWeight={700}>{pt("KUR (CANLI)")}</Typography>
            <Box sx={{ mt: 1.5 }}>
              <Reading
                label={pt(`1 ${ANCHOR_ASSET_CODE} alış`)}
                value={live?.rates.buy ? `${Number(live.rates.buy).toFixed(4)} ${FIAT_CODE}` : "—"}
                mono
              />
              <Reading
                label={pt(`1 ${ANCHOR_ASSET_CODE} satış`)}
                value={live?.rates.sell ? `${Number(live.rates.sell).toFixed(4)} ${FIAT_CODE}` : "—"}
                mono
              />
              <Reading
                label={pt("Komisyon")}
                value={live?.limits.feePercent != null ? `%${live.limits.feePercent}` : "—"}
              />
            </Box>
            <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 1.5, textTransform: "none", lineHeight: 1.6 }}>{pt(" İki yön ayrı soruluyor; aradaki fark anchor'ın makasıdır ve tek bir kur göstermek onu gizlerdi. ")}</Typography>
          </Paper>

          <Paper elevation={0} sx={{ flex: 1, p: 2.5, border: "1px solid", borderColor: "divider", borderRadius: 3 }}>
            <Typography variant="caption" color="text.secondary" fontWeight={700}>{pt("SERVİS")}</Typography>
            <Box sx={{ mt: 1.5 }}>
              <Reading label={pt("Ortam")} value={live?.health?.environment ?? "—"} />
              <Reading label={pt("Stellar")} value={live?.health?.stellarMode ?? "—"} />
              <Reading label={pt("Ağ")} value={live?.health?.networkPassphrase ?? "—"} mono />
              <Reading
                label={pt("İhraççı")}
                value={live?.assetIssuer ? `${live.assetIssuer.slice(0, 8)}…${live.assetIssuer.slice(-6)}` : "—"}
                mono
              />
            </Box>
          </Paper>
        </Stack>

        <Stack direction={{ xs: "column", md: "row" }} gap={4} sx={{ mt: 4 }}>
          <Steps title={pt(`YÜKLEME · ${FIAT_CODE} → ${ANCHOR_ASSET_CODE}`)} steps={ON_RAMP} />
          <Steps title={pt(`ÇEKME · ${ANCHOR_ASSET_CODE} → ${FIAT_CODE}`)} steps={OFF_RAMP} />
        </Stack>

        <Paper
          elevation={0}
          sx={{ mt: 3, p: 2.5, border: "1px dashed", borderColor: "divider", borderRadius: 3 }}
        >
          <Typography variant="body2" color="text.secondary" sx={{ lineHeight: 1.7 }}>{pt(" Bu akışın ikisi de ")}<strong>{pt("çalışıyor")}</strong>{pt(" ve köprü sayfasından baştan sona denenebilir — havale simülasyonu dahil, zincire gerçek testnet ")}{pt(ANCHOR_ASSET_CODE)}{pt(" gidip gelerek. ")}</Typography>
        </Paper>
      </Section>

      <Divider />

      <Section sx={{ py: { xs: 5, md: 7 } }}>
        <Typography variant="body1" color="text.secondary" sx={{ lineHeight: 1.7, maxWidth: 660 }}>{pt(" Confidential Anchor şu an yapım aşamasında. Köprü sayfası akışın iki ucunu — banka ve cüzdan — bugünkü haliyle gösteriyor; gizli ayak buraya bağlanacak. ")}</Typography>
        <Button
          component={Link} to="/bridge" variant="contained" size="large" endIcon={<ArrowForwardIcon />}
          sx={{ mt: 3, borderRadius: 3, px: 3, py: 1.4, fontWeight: 700 }}
        >{pt(" Köprüyü gör ")}</Button>
      </Section>
    </>
  );
}
