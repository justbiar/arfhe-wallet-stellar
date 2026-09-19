import { pt } from "../lib/language";
/**
 * Gizlilik havuzu — the privacy pool, run from this page.
 *
 * Everything here happens in the browser: keys are derived from a signature, notes are
 * reconstructed from chain events into OPFS-backed local storage, and Groth16 proofs are
 * generated in a worker. The page's job is to make the parts that are usually invisible —
 * whether proving is even possible here, whether history can be rebuilt, what the chain
 * will show — visible before anyone presses a button.
 *
 * The account is the same throwaway testnet key the bridge uses. No recovery phrase is
 * asked for here or anywhere else in this panel.
 */
import React from "react";
import {
  Box, Stack, Typography, Button, Chip, Alert, CircularProgress, Divider, TextField,
  Link as MuiLink, LinearProgress,
} from "@mui/material";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import { demoSigner } from "../lib/signer";
import { fundWithFriendbot, shortAddress } from "../lib/stellar";
import {
  openSpp, localSigner, stroopsToXlm, SPP_DEPLOYMENT, SPP_NETWORK_PASSPHRASE,
  type SppSession, type SppAccount,
} from "../lib/spp";
import type { PrivatePool } from "stellar-private-payments";

const ACCENT = "#4338CA";
const POOL = SPP_DEPLOYMENT.pools[0].poolContractId;
const RELAYER_URL = "http://localhost:8787";

/** A labelled fact, shown whether or not it is good news. */
function Fact({ label, value, tone }: { label: string; value: React.ReactNode; tone?: "ok" | "warn" }) {
  return (
    <Stack direction="row" justifyContent="space-between" alignItems="baseline" gap={2} sx={{ py: 0.6 }}>
      <Typography variant="caption" color="text.secondary">{pt(label)}</Typography>
      <Typography
        variant="caption"
        sx={{ fontFamily: "var(--font-arbeit-technik)", textAlign: "right", wordBreak: "break-all" }}
        color={tone === "warn" ? "warning.main" : tone === "ok" ? "success.main" : "text.primary"}
      >
        {pt(value)}
      </Typography>
    </Stack>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Box sx={{ border: "1px solid", borderColor: "divider", p: 2.5, mb: 2 }}>
      <Typography variant="caption" color="text.secondary" fontWeight={700}>{pt(title)}</Typography>
      <Box sx={{ mt: 1.5 }}>{pt(children)}</Box>
    </Box>
  );
}

export default function Privacy() {
  const [session, setSession] = React.useState<SppSession | null>(null);
  const [account, setAccount] = React.useState<SppAccount | null>(null);
  const [pool, setPool] = React.useState<PrivatePool | null>(null);
  const [registered, setRegistered] = React.useState<boolean | null>(null);
  const [balance, setBalance] = React.useState<bigint | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState("");
  const [log, setLog] = React.useState<string[]>([]);
  const [relayer, setRelayer] = React.useState<{ publicKey: string; pools: string[] } | null>(null);
  const [amount, setAmount] = React.useState("1");
  const [recipient, setRecipient] = React.useState("");

  const note = (line: string) => setLog((l) => [...l.slice(-20), line]);

  // The relayer is a separate service and may simply not be running. Reporting that is
  // more useful than a page that silently offers a button which cannot work.
  React.useEffect(() => {
    let cancelled = false;
    void fetch(`${RELAYER_URL}/health`)
      .then((r) => r.json())
      .then((h) => { if (!cancelled && h?.ok) setRelayer({ publicKey: h.publicKey, pools: h.pools }); })
      .catch(() => { /* not running; the page says so */ });
    return () => { cancelled = true; };
  }, []);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const start = React.useCallback(() => run("Gizlilik katmanı yükleniyor", async () => {
    note("WASM, depolama işçisi ve kanıtlayıcı yükleniyor…");
    const s = await openSpp();
    setSession(s);
    note(`hazır · izolasyon ${s.crossOriginIsolated ? "var" : "YOK"} · bootnode ${s.bootnodeNeeded ? "gerekli" : "gerekmiyor"}`);
    void s.client.backgroundSync();
  }), []);

  /**
   * Loads itself.
   *
   * There was a button here that said "load the SDK", which is this page asking the
   * visitor to fetch its own dependency — a detail of how we built it, dressed up as a
   * choice. It loads on arrival now and says so while it does.
   */
  React.useEffect(() => {
    if (session || busy) return;
    void start();
    // Once, on arrival. `start` is stable and the guard above covers re-entry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const connect = () => run("Hesap bağlanıyor", async () => {
    if (!session) return;
    const signer = demoSigner();
    note(`hesap ${shortAddress(signer.publicKey)} fonlanıyor…`);
    await fundWithFriendbot(signer.publicKey);

    // The SDK asks the owner to sign a fixed derivation message and verifies that
    // signature before it will store anything. Wrong prefix, wrong key — no keys.
    note("gizlilik anahtarları türetiliyor (imza doğrulanıyor)…");
    const acct = await session.client.account(
      { networkPassphrase: SPP_NETWORK_PASSPHRASE },
      localSigner(signer.keypair)
    );
    setAccount(acct);

    const isReg = await acct.isRegistered();
    setRegistered(isReg);
    note(`bağlandı · adres defterinde ${isReg ? "kayıtlı" : "kayıtlı değil"}`);

    const p = await acct.pool({ poolContract: POOL });
    setPool(p);
    setBalance(await p.balance());

    // Dev only. The SDK's results carry more than this page shows — how many transactions
    // a spend needed, what the planner decided — and there is no way to see any of it
    // from the outside.
    if (import.meta.env.DEV) {
      (window as unknown as { __spp?: unknown }).__spp = { session, account: acct, pool: p };
    }
  });

  const register = () => run("Kaydediliyor", async () => {
    if (!account) return;
    await account.registerPublicKeys();
    setRegistered(await account.isRegistered());
    note("açık anahtarlar zincire kaydedildi");
  });

  const refresh = () => run("Yenileniyor", async () => {
    if (!session || !pool) return;
    await session.client.sync();
    setBalance(await pool.balance());
    note("senkron");
  });

  const act = (kind: "deposit" | "transfer" | "withdraw") => run(
    kind === "deposit" ? "Yatırılıyor" : kind === "transfer" ? "Gönderiliyor" : "Çekiliyor",
    async () => {
      if (!pool) return;
      const stroops = BigInt(Math.round(Number(amount.replace(",", ".")) * 10_000_000));
      note(`${kind}: kanıt üretiliyor — bu adım saniyeler sürer…`);
      const started = performance.now();
      const result = kind === "deposit" ? await pool.deposit(stroops)
        : kind === "transfer" ? await pool.transfer(recipient.trim(), stroops)
        : await pool.withdraw(stroops);

      // The SDK reports what it actually did. Reporting "done" without looking is how a
      // call that submitted nothing reads as a success — which is exactly what happened
      // the first time this page ran.
      // The hashes live on the result itself (`{status, hashes}`), not one per element.
      // Reading `txHash`/`hash` off it found nothing, so a deposit that did land on-chain
      // was reported as producing no transaction — the original bug with the sign flipped,
      // and just as misleading.
      const hashes = (Array.isArray(result) ? result : [result]).flatMap((r) => {
        const o = r as { hashes?: string[]; txHash?: string; hash?: string };
        if (Array.isArray(o?.hashes)) return o.hashes;
        return [o?.txHash ?? o?.hash].filter(Boolean) as string[];
      });
      note(
        hashes.length > 0
          ? `${kind} · ${((performance.now() - started) / 1000).toFixed(1)} sn · ${hashes.join(", ")}`
          : `${kind} HİÇBİR İŞLEM ÜRETMEDİ — ${JSON.stringify(result).slice(0, 200)}`
      );

      await session?.client.sync();
      setBalance(await pool.balance());
    }
  );

  return (
    <Box sx={{ maxWidth: 820, mx: "auto", px: { xs: 2, md: 3 }, py: { xs: 3, md: 5 } }}>
      <Typography sx={{ fontFamily: "var(--font-arbeit-contrast)", fontWeight: 800, fontSize: { xs: 28, md: 34 }, letterSpacing: "-0.02em" }}>{pt(" Gizlilik havuzu ")}</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, mb: 3 }}>{pt(" Havuz içindeki transferlerde tutar, bakiye ")}<b>{pt("ve alıcı")}</b>{pt(" gizli. Havuza giriş ve çıkış zincirde açık kalır — gizlenen, aradaki hareket. ")}</Typography>

      <Alert severity="warning" sx={{ borderRadius: 3, mb: 2 }}>{pt(" Nethermind'ın referans uygulaması: ")}<b>{pt("denetlenmemiş")}</b>{pt(", yalnızca testnet, Groth16 kurulumu törensiz. Değer taşımaz. ")}</Alert>

      {/* Where the SDK comes from, because it is not what `npm install` gives you.
          The published 0.1.0 predates the contract binding its ext-data hash to the pool
          and token, so every transaction it signs is rejected with #10 WrongExtHash. This
          panel resolves the package to a local build of the repo instead, and with it the
          pool transacts — measured on testnet, not assumed. Worth stating on the page: a
          visitor who clones this and installs from npm will see the old failure. */}
      <Alert severity="info" sx={{ borderRadius: 3, mb: 3 }}>
        <b>{pt("npm'deki SDK zincirdeki kontrattan eski")}</b>{pt(" (0.1.0, 3 Eylül). Kontrat 16 Eylül'de ")}<code>{pt("ext_data_hash")}</code>{pt("'i havuz ve token kimliğine bağladı; o istemci eski şemayla hash'liyor ve her işlem #10 ")}<code>{pt("WrongExtHash")}</code>{pt(" ile reddediliyor. Depodan derlenmiş bir kopyayla yatırma testnette çalıştı — nasıl derlendiği ")}<code>{pt("stellar.md")}</code>{pt(" §5.11'de. ")}</Alert>

      {/* ── Ortam ── */}
      <Section title={pt("ORTAM")}>
        {!session ? (
          <Stack gap={1.5}>
            <Stack direction="row" alignItems="center" gap={1.2}>
              {pt(busy && <CircularProgress size={15} />)}
              <Typography variant="body2" color="text.secondary">
                {pt(busy
                  ? "Gizlilik katmanı yükleniyor — wasm, devreler ve kanıtlayıcı işçi."
                  : "Yüklenemedi.")}
              </Typography>
            </Stack>
            {!busy && (
              <Button
                variant="contained" onClick={start}
                sx={{ borderRadius: 3, py: 1.2, bgcolor: ACCENT, "&:hover": { bgcolor: "#3730A3" }, alignSelf: "flex-start" }}
              >{pt(" Yeniden dene ")}</Button>
            )}
          </Stack>
        ) : (
          <>
            <Fact
              label={pt("Tarayıcı izolasyonu (kanıt üretimi için)")}
              value={session.crossOriginIsolated ? "var" : "YOK — kanıt yavaş ya da imkânsız"}
              tone={session.crossOriginIsolated ? "ok" : "warn"}
            />
            <Fact
              label={pt("Bootnode (7 günden eski geçmiş)")}
              value={session.bootnodeNeeded ? "gerekli — Nethermind'ın sunucusu kullanılıyor" : "gerekmiyor"}
              tone={session.bootnodeNeeded ? "warn" : "ok"}
            />
            <Fact label={pt("Havuz")} value={shortAddress(POOL, 8, 6)} />
            <Fact label={pt("Politika")} value={String(SPP_DEPLOYMENT.pools[0].policyFlags)} />
          </>
        )}
      </Section>

      {/* ── Relayer ── */}
      <Section title={pt("RELAYER")}>
        {relayer ? (
          <>
            <Fact label={pt("Durum")} value="çalışıyor" tone="ok" />
            <Fact label={pt("Ödeyen hesap")} value={shortAddress(relayer.publicKey, 8, 6)} />
            <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 1, textTransform: "none", lineHeight: 1.6 }}>{pt(" Bu sayfa şu an işlemleri ")}<b>{pt("kendi")}</b>{pt(" anahtarıyla gönderiyor, yani gönderen zincirde görünüyor. Relayer'ı devreye almak SDK'da bir \"hazırla ama gönderme\" adımı istiyor; bkz. ")}<code>{pt("stellar.md")}</code>{pt(" §5.10. ")}</Typography>
          </>
        ) : (
          <Typography variant="caption" color="text.secondary" sx={{ textTransform: "none" }}>{pt(" Çalışmıyor. ")}<code>{pt("npm run relayer")}</code>{pt(" ile başlatılır. ")}</Typography>
        )}
      </Section>

      {/* ── Hesap ── */}
      {session && (
        <Section title={pt("HESAP")}>
          {!account ? (
            <Stack gap={1.5}>
              <Typography variant="body2" color="text.secondary">{pt(" Bu sayfa kendi testnet hesabını kullanıyor ve gizlilik anahtarlarını ondan türetiyor; hesap tarayıcıda saklanıyor, her ziyarette yenisi üretilmiyor. Kurtarma ifadesi istenmez. Arfhe Wallet hesabıyla bağlanmak henüz mümkün değil: havuz SDK'sı anahtarları SEP-53 imzalı bir mesajdan türetiyor, uzantının siteye açtığı yüzeyde ise yalnızca adres okuma ve işlem imzalama var. ")}</Typography>
              <Button
                variant="contained" onClick={connect} disabled={busy !== null}
                startIcon={busy ? <CircularProgress size={14} color="inherit" /> : null}
                sx={{ borderRadius: 3, py: 1.2, bgcolor: ACCENT, "&:hover": { bgcolor: "#3730A3" }, alignSelf: "flex-start" }}
              >
                {pt(busy ?? "Hesabı bağla")}
              </Button>
            </Stack>
          ) : (
            <>
              <Fact label={pt("Adres")} value={shortAddress(account.userAddress, 10, 6)} />
              <Fact
                label={pt("Adres defteri kaydı")}
                value={registered ? "kayıtlı" : "kayıtlı değil"}
                tone={registered ? "ok" : "warn"}
              />
              <Fact
                label={pt("Havuzdaki bakiye")}
                value={balance === null ? "—" : `${stroopsToXlm(balance)} XLM`}
              />
              <MuiLink
                href={`https://stellar.expert/explorer/testnet/account/${account.userAddress}`}
                target="_blank" rel="noopener noreferrer" variant="caption"
                sx={{ display: "inline-flex", alignItems: "center", gap: 0.4, mt: 1, textTransform: "none" }}
              >{pt(" Zincirde gör ")}<OpenInNewIcon sx={{ fontSize: 12 }} />
              </MuiLink>

              <Divider sx={{ my: 2 }} />

              <Stack direction="row" gap={1} flexWrap="wrap" useFlexGap>
                {!registered && (
                  <Button variant="outlined" onClick={register} disabled={busy !== null}
                    sx={{ borderRadius: 3, borderColor: "divider", color: "text.primary" }}>{pt(" Adres defterine kaydol ")}</Button>
                )}
                <Button variant="outlined" onClick={refresh} disabled={busy !== null}
                  sx={{ borderRadius: 3, borderColor: "divider", color: "text.primary" }}>{pt(" Yenile ")}</Button>
              </Stack>
            </>
          )}
        </Section>
      )}

      {/* ── İşlemler ── */}
      {pool && (
        <Section title={pt("İŞLEMLER")}>
          <Stack gap={2}>
            <TextField
              label={pt("Tutar")} value={amount} onChange={(e) => setAmount(e.target.value)}
              size="small" inputMode="decimal" fullWidth
              InputProps={{ sx: { borderRadius: 3 } }}
              helperText={pt("XLM")}
            />
            <TextField
              label={pt("Alıcı (yalnızca transfer için)")} value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
              size="small" fullWidth placeholder={pt("G…")}
              InputProps={{ sx: { borderRadius: 3 } }}
              helperText={pt("Adres defterine kayıtlı bir Stellar adresi")}
            />
            <Stack direction="row" gap={1} flexWrap="wrap" useFlexGap>
              <Button variant="contained" disabled={busy !== null} onClick={() => act("deposit")}
                sx={{ borderRadius: 3, bgcolor: ACCENT, "&:hover": { bgcolor: "#3730A3" } }}>{pt(" Yatır ")}</Button>
              <Button variant="contained" disabled={busy !== null || recipient.trim() === ""} onClick={() => act("transfer")}
                sx={{ borderRadius: 3, bgcolor: ACCENT, "&:hover": { bgcolor: "#3730A3" } }}>{pt(" Gizli gönder ")}</Button>
              <Button variant="outlined" disabled={busy !== null} onClick={() => act("withdraw")}
                sx={{ borderRadius: 3, borderColor: "divider", color: "text.primary" }}>{pt(" Çek ")}</Button>
            </Stack>
            <Typography variant="caption" color="text.secondary" sx={{ textTransform: "none", lineHeight: 1.6 }}>{pt(" Yatırma ve çekme zincirde ")}<b>{pt("açık")}</b>{pt(": tutar ve adres görünür. Gizli olan, havuzun içindeki gönderim. ")}</Typography>
          </Stack>
        </Section>
      )}

      {pt(busy && <LinearProgress sx={{ mb: 2 }} />)}
      {pt(error && <Alert severity="error" sx={{ borderRadius: 3, mb: 2 }}>{pt(error)}</Alert>)}

      {log.length > 0 && (
        <Section title={pt("OLAN BİTEN")}>
          <Stack gap={0.4}>
            {log.map((line, i) => (
              <Typography key={i} variant="caption" sx={{ fontFamily: "var(--font-arbeit-technik)", textTransform: "none" }}>
                {pt(line)}
              </Typography>
            ))}
          </Stack>
        </Section>
      )}

      <Chip label={pt("TESTNET · DENETLENMEMİŞ")} size="small" sx={{ borderRadius: 3 }} />
    </Box>
  );
}
