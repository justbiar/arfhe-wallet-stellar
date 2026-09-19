import { pt } from "../lib/language";
/**
 * Gizli ödeme — the demo the product sentence stands on: "bordro zincirde yazmaz".
 *
 * The page is thin on purpose. Everything it shows comes from the payroll service, and the
 * one thing it adds is the bottom panel: what an observer sees for a payment that just
 * happened. Saying "the amount is hidden" is cheap; putting the chain's own view of the
 * transaction on screen, with the amounts searched for and not found, is the argument.
 *
 * The scenarios differ only in why the amounts deserve hiding — mechanically all four are
 * the same `confidential_transfer`. That is why `stillPublic` sits beside every claim: in
 * payroll the visible employment link is correct, in retail it is the part confidential
 * tokens cannot fix, and a demo that hides that distinction is selling something.
 */
import React from "react";
import {
  Box, Stack, Typography, Chip, Button, Paper, Divider, CircularProgress,
  ToggleButton, ToggleButtonGroup, Alert, useTheme, alpha,
} from "@mui/material";
import PaneFrame from "../components/PaneFrame";
import { HashLine } from "../components/TxReceipt";
import { shortAddress } from "../lib/stellar";
import {
  getHealth, getScenarios, getState, getChainView, prepare, pay,
  PAYROLL_URL,
  type ChainView, type Health, type ScenarioDef, type SessionState,
} from "../lib/payroll";

function Fact({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <Stack direction="row" justifyContent="space-between" alignItems="baseline" gap={2}>
      <Typography variant="caption" color="text.secondary" sx={{ textTransform: "none" }}>
        {pt(label)}
      </Typography>
      <Typography
        sx={{
          fontSize: 12.5,
          fontWeight: 600,
          textAlign: "right",
          ...(mono ? { fontFamily: "var(--font-arbeit-technik)", fontWeight: 500 } : {}),
        }}
      >
        {pt(value)}
      </Typography>
    </Stack>
  );
}

export default function Payroll() {
  const theme = useTheme();
  const [health, setHealth] = React.useState<Health | null>(null);
  const [offline, setOffline] = React.useState(false);
  const [scenarios, setScenarios] = React.useState<ScenarioDef[]>([]);
  const [selected, setSelected] = React.useState<string>("bordro");
  const [session, setSession] = React.useState<SessionState | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [openHash, setOpenHash] = React.useState<string | null>(null);
  const [chain, setChain] = React.useState<ChainView | null>(null);

  const def = scenarios.find((s) => s.id === selected) ?? null;

  React.useEffect(() => {
    // A prepared session survives a page reload, so the demo can be set up before anyone
    // is watching and the page picked up cold.
    (async () => {
      try {
        const [h, list] = await Promise.all([getHealth(), getScenarios()]);
        setHealth(h);
        setScenarios(list);
        if (h.hasSession) {
          const s = await getState();
          setSession(s);
          setSelected(s.scenario);
        }
      } catch {
        setOffline(true);
      }
    })();
  }, []);

  const run = async (what: string, fn: () => Promise<SessionState>) => {
    setBusy(what);
    setError(null);
    try {
      const s = await fn();
      setSession(s);
      setOpenHash(null);
      setChain(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const openChain = async (hash: string) => {
    setOpenHash(hash);
    setChain(null);
    try {
      setChain(await getChainView(hash));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const paid = (session?.payments.length ?? 0) > 0;
  const ready = session !== null && session.scenario === selected;

  if (offline) {
    return (
      <Box sx={{ maxWidth: 780, mx: "auto", px: { xs: 2, md: 3 }, py: { xs: 4, md: 7 } }}>
        <Typography sx={{ fontFamily: "var(--font-arbeit-contrast)", fontWeight: 800, fontSize: 30 }}>{pt(" Gizli Ödeme ")}</Typography>
        <Alert severity="info" sx={{ borderRadius: 0, mt: 2 }}>{pt(" Ödeme servisi çalışmıyor. ")}<code>{pt("npm run payroll")}</code>{pt(" ile başlatılır; sayfa")}{pt(" ")}
          <code>{pt(PAYROLL_URL)}</code>{pt(" adresine bakıyor. ")}</Alert>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>{pt(" Servis ayrı duruyor çünkü her gizli transfer bir UltraHonk kanıtı istiyor ve onu üreten ")}<code>{pt("bb.js")}</code>{pt(" tarayıcı paketleyicisinden geçmiyor. Gerçek üründe de bordro sunucuda koşar. ")}</Typography>
      </Box>
    );
  }

  return (
    <Box sx={{ maxWidth: 1180, mx: "auto", px: { xs: 2, md: 3 }, py: { xs: 3, md: 5 } }}>
      <Stack direction={{ xs: "column", sm: "row" }} alignItems={{ sm: "flex-end" }} gap={1.5} sx={{ mb: 2.5 }}>
        <Box sx={{ flex: 1 }}>
          <Typography sx={{ fontFamily: "var(--font-arbeit-contrast)", fontWeight: 800, fontSize: { xs: 28, md: 34 }, letterSpacing: "-0.02em" }}>{pt(" Gizli Ödeme ")}</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>{pt(" Şirket ödüyor, alıcılar tutarını zincirden çözüyor, defteri okuyan kimse göremiyor. ")}</Typography>
        </Box>
        {health && (
          <Chip
            size="small"
            label={pt(`gizli token ${shortAddress(health.contracts.token, 4, 4)} · TESTNET`)}
            sx={{
              borderRadius: 0, fontWeight: 700,
              bgcolor: alpha(theme.palette.primary.main, 0.1),
              color: theme.palette.primary.main,
              border: "1px solid", borderColor: alpha(theme.palette.primary.main, 0.3),
            }}
          />
        )}
      </Stack>

      <ToggleButtonGroup
        exclusive
        size="small"
        value={selected}
        onChange={(_, v) => { if (v) setSelected(v as string); }}
        aria-label={pt("Senaryo")}
        sx={{
          flexWrap: "wrap",
          "& .MuiToggleButton-root": {
            borderRadius: 0, px: 1.8, py: 0.6, fontSize: 11, fontWeight: 700, borderColor: "divider",
          },
        }}
      >
        {scenarios.map((s) => (
          <ToggleButton key={s.id} value={s.id}>{pt(s.title)}</ToggleButton>
        ))}
      </ToggleButtonGroup>

      {def && (
        <Stack gap={1} sx={{ mt: 2, mb: 3, maxWidth: 820 }}>
          <Typography variant="body2" color="text.secondary">{pt(def.why)}</Typography>
          <Typography variant="caption" color="text.secondary" sx={{ textTransform: "none" }}>
            <Box component="span" sx={{ fontWeight: 700 }}>{pt("Zincirde açık kalan: ")}</Box>
            {pt(def.stillPublic)}
          </Typography>
        </Stack>
      )}

      <Box sx={{ display: "grid", gap: 2, gridTemplateColumns: { xs: "1fr", md: "1fr 1fr" } }}>
        <PaneFrame label={pt("ÖDEYEN")} accent={theme.palette.primary.main} title={
          <Typography variant="caption" sx={{ fontWeight: 700 }}>{pt(def?.payer ?? "—")}</Typography>
        }>
          {ready && session ? (
            <Stack gap={1.2}>
              <Fact label={pt("Hesap")} value={shortAddress(session.payer.address, 6, 6)} mono />
              <Fact label={pt("Rampadan gelen (zincirde açık)")} value={`${session.funded ?? "—"} USDC`} mono />
              <Divider />
              <Fact label={pt("Gizli bakiye")} value={`${session.payer.spendable} USDC`} mono />
              <Typography variant="caption" color="text.secondary" sx={{ textTransform: "none", mt: 0.5 }}>{pt(" Bu sayı zincirde yok — sahibi kendi anahtarıyla çözdü. ")}</Typography>
            </Stack>
          ) : (
            <Typography variant="body2" color="text.secondary">
              {pt(def ? `${def.payer}, rampadan ${def.recipients.length} ödemeyi karşılayacak kadar TRY yatıracak.` : "")}
            </Typography>
          )}
        </PaneFrame>

        <PaneFrame label={pt("ALICILAR")} accent={theme.palette.text.primary} title={
          <Typography variant="caption" sx={{ fontWeight: 700 }}>
            {pt(def ? `${def.recipients.length} kişi` : "—")}
          </Typography>
        }>
          <Stack gap={1.5} divider={<Divider />}>
            {(def?.recipients ?? []).map((r, i) => {
              const live = ready && session ? session.recipients[i] : null;
              const got = live ? (Number(live.receiving) + Number(live.spendable)).toString() : null;
              return (
                <Stack key={r.label} gap={0.6}>
                  <Stack direction="row" justifyContent="space-between" alignItems="baseline">
                    <Typography sx={{ fontWeight: 700, fontSize: 13 }}>{pt(r.label)}</Typography>
                    <Typography sx={{ fontFamily: "var(--font-arbeit-technik)", fontSize: 12.5 }}>
                      {pt(got !== null ? `${got} USDC` : `${r.amount} USDC`)}
                    </Typography>
                  </Stack>
                  {live && (
                    <Typography variant="caption" color="text.secondary" sx={{ fontFamily: "var(--font-arbeit-technik)", textTransform: "none" }}>
                      {pt(shortAddress(live.address, 6, 6))}
                    </Typography>
                  )}
                </Stack>
              );
            })}
          </Stack>
          {paid && (
            <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 2, textTransform: "none" }}>{pt(" Her tutar yalnızca zincirden, alıcının kendi anahtarıyla çözüldü. ")}</Typography>
          )}
        </PaneFrame>
      </Box>

      <Stack direction="row" alignItems="center" gap={1.5} sx={{ mt: 2.5, flexWrap: "wrap" }}>
        <Button
          variant="outlined"
          disableRipple
          disabled={busy !== null}
          onClick={() => run("Hazırlanıyor", () => prepare(selected))}
          sx={{ borderRadius: 0, fontWeight: 700 }}
        >{pt(" Hazırla ")}</Button>
        <Button
          variant="contained"
          disableRipple
          disabled={busy !== null || !ready || paid}
          onClick={() => run("Ödeniyor", () => pay())}
          sx={{ borderRadius: 0, fontWeight: 700 }}
        >{pt(" Gizli öde ")}</Button>
        {pt(busy && (
          <Stack direction="row" alignItems="center" gap={1}>
            <CircularProgress size={14} />
            <Typography variant="caption" color="text.secondary" sx={{ textTransform: "none" }}>
              {pt(busy)}
              {pt(busy === "Hazırlanıyor" && " — taraflar kuruluyor ve rampadan fon çekiliyor, 1-2 dakika")}
            </Typography>
          </Stack>
        ))}
      </Stack>

      {pt(error && <Alert severity="error" sx={{ borderRadius: 0, mt: 2 }}>{pt(error)}</Alert>)}

      {/* ── Zincir bunu görüyor ── */}
      {paid && session && (
        <Paper elevation={0} sx={{ border: "1px solid", borderColor: "divider", borderRadius: 0, mt: 3 }}>
          <Stack direction="row" alignItems="center" gap={1.2} sx={{ px: 2, py: 1.5, borderBottom: "1px solid", borderColor: "divider" }}>
            <Box sx={{ width: 8, height: 8, bgcolor: "text.primary" }} />
            <Typography variant="caption" sx={{ fontWeight: 700, color: "text.secondary" }}>{pt(" ZİNCİR BUNU GÖRÜYOR ")}</Typography>
          </Stack>

          <Box sx={{ p: { xs: 2, md: 2.5 } }}>
            <Stack direction="row" gap={1} sx={{ flexWrap: "wrap", mb: 2 }}>
              {session.payments.map((p) => (
                <Button
                  key={p.hash}
                  size="small"
                  disableRipple
                  variant={openHash === p.hash ? "contained" : "outlined"}
                  onClick={() => openChain(p.hash)}
                  sx={{ borderRadius: 0, fontWeight: 700, fontSize: 11 }}
                >
                  {pt(p.label)}{pt(" · ")}{p.seconds}{pt(" sn ")}</Button>
              ))}
            </Stack>

            {openHash === null && (
              <Typography variant="body2" color="text.secondary">{pt(" Bir ödemeyi seçin: o işlemin zincirdeki hâli, tutarların zarfta aranmasıyla birlikte. ")}</Typography>
            )}

            {/*
              * The hash sits above the decoded view, in full, with a link out.
              *
              * Everything below it is this page's reading of the transaction; the hash is the
              * one part that does not require trusting this page. A visitor who doubts the
              * claim can open the explorer and look at the same envelope themselves.
              */}
            {openHash !== null && (
              <Box sx={{ mb: 2 }}>
                <HashLine hash={openHash} label={pt("İŞLEM")} />
              </Box>
            )}

            {openHash !== null && chain === null && (
              <Stack direction="row" alignItems="center" gap={1}>
                <CircularProgress size={14} />
                <Typography variant="caption" color="text.secondary" sx={{ textTransform: "none" }}>{pt(" İşlem zincirden okunuyor ")}</Typography>
              </Stack>
            )}

            {chain && (
              <Stack gap={1.2}>
                <Fact label={pt("Fonksiyon")} value={chain.functionName} mono />
                <Fact label={pt("Açıktaki adresler")} value={`${chain.addresses.length} adet`} />
                <Stack gap={0.4} sx={{ pl: 0.5 }}>
                  {chain.addresses.map((a) => (
                    <Typography key={a} variant="caption" color="text.secondary"
                      sx={{ fontFamily: "var(--font-arbeit-technik)", textTransform: "none" }}>
                      {pt(shortAddress(a, 8, 8))}
                    </Typography>
                  ))}
                </Stack>
                <Fact label={pt("Opak blok (kanıt + ciphertext)")} value={`${chain.opaqueBytes.toLocaleString("tr")} bayt`} mono />
                <Fact label={pt("Zarfın tamamı")} value={`${chain.envelopeBytes.toLocaleString("tr")} bayt`} mono />

                <Divider sx={{ my: 0.5 }} />
                <Typography variant="caption" sx={{ fontWeight: 700 }}>{pt(" ZARFTA TUTAR ARAMASI ")}</Typography>
                <Stack gap={0.5}>
                  {chain.amountsFound.map((a) => (
                    <Stack key={a.amount} direction="row" justifyContent="space-between">
                      <Typography sx={{ fontFamily: "var(--font-arbeit-technik)", fontSize: 12 }}>
                        {pt(a.amount)}
                      </Typography>
                      <Typography
                        sx={{ fontSize: 12, fontWeight: 700 }}
                        color={a.found ? "error.main" : "text.secondary"}
                      >
                        {pt(a.found ? "BULUNDU" : "yok")}
                      </Typography>
                    </Stack>
                  ))}
                </Stack>
                {/*
                  * The search is eight-byte big-endian and says so: a number stored in some
                  * other encoding would slip past it. What it does show is real — an amount
                  * written in the open does get caught, which is exactly what happens on the
                  * ramp's own deposit transaction.
                  */}
                <Typography variant="caption" color="text.secondary" sx={{ textTransform: "none", mt: 0.5 }}>{pt(" Arama sekiz baytlık big-endian. Kusursuz değil — farklı kodlamadaki bir sayıyı kaçırır. Ama açıkça yazılmış bir tutar takılır: rampanın kendi yatırma işleminde takılıyor. ")}</Typography>
              </Stack>
            )}
          </Box>
        </Paper>
      )}

      <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 3, textTransform: "none" }}>{pt(" Bu bir demo: servis hem ödeyenin hem alıcıların anahtarlarını tutuyor, çünkü tek ekranda \"şirket ödedi, çalışan gördü\" göstermek gerekiyor. Gerçek üründe alıcının anahtarı cüzdanındadır ve servis onu hiç görmez. Anahtarlar diske yazılmıyor, hepsi testnet. ")}</Typography>
    </Box>
  );
}
