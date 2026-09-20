/**
 * Gizli ödeme demosunun sunucu tarafı.
 *
 *   GET  /health                → dağıtım bilgisi
 *   GET  /scenarios             → dört senaryonun tanımı
 *   POST /prepare {scenario}    → tarafları kur, rampadan fonla, gizle  (yavaş)
 *   POST /pay                   → gizli ödemeleri yap                    (yavaş)
 *   GET  /state                 → herkesin bakiyesi
 *   GET  /chain/:hash           → zincire bakan birinin gördüğü
 *
 * ── Bu bir demo ──
 *
 * Servis hem şirketin hem çalışanların anahtarlarını tutuyor, çünkü tek ekranda "şirket
 * ödedi, çalışan gördü" göstermek gerekiyor. Gerçek bir üründe çalışanın anahtarı
 * cüzdanındadır ve bu servis onu hiç görmez. Anahtarlar diske yazılmıyor ve her
 * başlatmada yenileniyor; hepsi testnet.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { PayrollEngine, type Party, type PaymentResult } from "./engine.js";
import { SCENARIOS, scenarioTotal, type ScenarioId } from "./scenarios.js";
import { readChainView } from "./chain-view.js";
import { CT_DEPLOYMENT, toUnits } from "./deployment.js";

const PORT = Number(process.env.PORT ?? 8788);

/** Anchor TRY ister, senaryo USDC konuşur. Kur ~49 TRY/USDC, üstüne pay bırakıyoruz. */
const TRY_PER_USDC = 52;
const DEPOSIT_MIN_TRY = 50;
const DEPOSIT_MAX_TRY = 3000;

const engine = new PayrollEngine();

interface Session {
  scenario: ScenarioId;
  payer: Party;
  recipients: Party[];
  funded: string | null;
  payments: PaymentResult[];
}
let session: Session | null = null;

const CORS = {
  "access-control-allow-origin": process.env.PAYROLL_ALLOW_ORIGIN ?? "*",
  "access-control-allow-headers": "content-type",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  // İzole bir sayfa (panelde COOP/COEP açık) bu başlık olmadan cevabı kabul etmiyor.
  "cross-origin-resource-policy": "cross-origin",
};

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { ...CORS, "content-type": "application/json" });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

/** Herkesin bakiyesi — çalışanlar kendi tutarlarını zincirden çözerek buluyor. */
async function readState(s: Session) {
  const payer = await engine.balance(s.payer);
  const recipients = [];
  for (const r of s.recipients) {
    const b = await engine.balance(r);
    recipients.push({ label: r.label, address: r.address, ...b });
  }
  return {
    scenario: s.scenario,
    payer: { label: s.payer.label, address: s.payer.address, ...payer },
    recipients,
    funded: s.funded,
    payments: s.payments,
  };
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") { res.writeHead(204, CORS); return res.end(); }

    if (req.method === "GET" && req.url === "/health") {
      return send(res, 200, { ok: true, contracts: CT_DEPLOYMENT, hasSession: session !== null });
    }
    if (req.method === "GET" && req.url === "/scenarios") {
      return send(res, 200, Object.values(SCENARIOS));
    }
    if (req.method === "GET" && req.url === "/state") {
      if (!session) return send(res, 404, { error: "önce /prepare çağırın" });
      return send(res, 200, await readState(session));
    }
    if (req.method === "GET" && req.url?.startsWith("/chain/")) {
      const hash = req.url.slice("/chain/".length);
      // Senaryodaki her tutarı ve ödeyenin fonunu arıyoruz: hiçbiri bulunmamalı.
      const probes = session
        ? [...session.recipients.map((r, i) => toUnits(SCENARIOS[session!.scenario].recipients[i].amount)),
           ...(session.funded ? [toUnits(session.funded)] : [])]
        : [];
      return send(res, 200, await readChainView(hash, probes));
    }

    if (req.method === "POST" && req.url === "/prepare") {
      const body = await readBody(req);
      const id = (body.scenario as ScenarioId) ?? "bordro";
      const def = SCENARIOS[id];
      if (!def) return send(res, 400, { error: `bilinmeyen senaryo: ${id}` });

      // Adım adım loglanıyor: /prepare dakikalarca sürebiliyor ve bir yerde takılırsa
      // hangi adımda olduğunu bilmek, tek satırlık bir timeout mesajından çok daha fazlasını
      // söylüyor.
      // Timed, because "why is this slow" is a question about a specific step and the log
      // could not answer it: proof generation, friendbot and the ramp all look the same
      // from outside, and they are not the same at all.
      const startedAt = Date.now();
      let lastAt = startedAt;
      const step = (m: string) => {
        const now = Date.now();
        console.log(`  [prepare +${((now - startedAt) / 1000).toFixed(1)}s] ${m} (${((now - lastAt) / 1000).toFixed(1)}s)`);
        lastAt = now;
      };

      // Hesapları friendbot fonluyor ve her çağrı ~5 saniye sürüyor; dördünü sırayla
      // beklemek yirmi saniyeydi. Birlikte isteniyorlar — friendbot art arda çağrıldığında
      // bağlantı düşürüyor, ama `fundWithFriendbot` zaten geri çekilerek tekrar deniyor.
      const [payer, ...recipients] = await Promise.all(
        [def.payer, ...def.recipients.map((r) => r.label)].map((label) => engine.createParty(label)),
      );
      step(`taraflar hazır (${1 + recipients.length})`);

      // Ödeyen önce kaydolmalı: gizleme onun kaydına bağlı.
      await engine.register(payer);
      step(`kayıt: ${payer.label}`);

      // Rampadan, senaryonun toplamını karşılayacak kadar TRY çek.
      const need = Math.ceil(scenarioTotal(def) * TRY_PER_USDC);
      const amountTry = String(Math.min(DEPOSIT_MAX_TRY, Math.max(DEPOSIT_MIN_TRY, need)));

      // Rampa ile alıcı kayıtları birbirini beklemiyor: biri anchor'ı ve zinciri bekliyor,
      // diğeri kanıt üretiyor. Sırayla koşturmak ikisinin toplamı kadar sürüyordu.
      const ramp = engine.fundFromAnchor(payer, amountTry);
      for (const p of recipients) {
        await engine.register(p);
        step(`kayıt: ${p.label}`);
      }

      const funded = await ramp;
      step(`rampa: ${amountTry} TRY → ${funded} USDC`);
      await engine.shield(payer, funded);
      step("gizlendi · hazır");

      session = { scenario: id, payer, recipients, funded, payments: [] };
      return send(res, 200, { amountTry, ...(await readState(session)) });
    }

    /**
     * "Çalışan maaşını bozar" — demonun eksik olan son adımı.
     *
     * Ödeme gizli, ama bir maaşın işe yaraması için bir noktada paraya dönmesi gerekiyor.
     * Bu uç o dönüşü yapıyor ve yaparken ne sızdırdığını da söylüyor: `withdraw` tutarı
     * açık deftere yazıyor, anchor da ödediği lirayı biliyor. Gizli kalan şey o paranın
     * hangi maaş olduğu ve alıcının geri kalan bakiyesi.
     */
    if (req.method === "POST" && req.url === "/cash-out") {
      if (!session) return send(res, 404, { error: "önce /prepare çağırın" });
      const body = await readBody(req);
      const index = Number(body.recipient ?? 0);
      const party = session.recipients[index];
      if (!party) return send(res, 400, { error: `alıcı yok: ${index}` });

      const iban = String(body.iban ?? "").replace(/\s+/g, "").toUpperCase();
      if (!/^TR\d{24}$/.test(iban)) return send(res, 400, { error: "dest bir Türk IBAN'ı olmalı" });

      const started = Date.now();
      const out = await engine.cashOut(party, iban);
      console.log(
        `  [cash-out] ${party.label}: ${out.unshielded.amount} USDC → ${out.ramp.amountTry} TRY ` +
        `(${((Date.now() - started) / 1000).toFixed(1)}s)`,
      );
      return send(res, 200, { label: party.label, ...out, state: await readState(session) });
    }

    if (req.method === "POST" && req.url === "/pay") {
      if (!session) return send(res, 404, { error: "önce /prepare çağırın" });
      const def = SCENARIOS[session.scenario];
      session.payments = await engine.pay(
        session.payer,
        def.recipients.map((r, i) => ({ to: session!.recipients[i], amount: r.amount })),
      );
      return send(res, 200, await readState(session));
    }

    return send(res, 404, {
      error: "not found",
      endpoints: [
        "GET /health", "GET /scenarios", "GET /state", "GET /chain/:hash",
        "POST /prepare", "POST /pay", "POST /cash-out",
      ],
    });
  } catch (e) {
    // Yük içeriği loglanmıyor; sadece ne olduğu.
    console.error("hata:", e instanceof Error ? e.message : "bilinmeyen");
    return send(res, 500, { error: e instanceof Error ? e.message : "bilinmeyen hata" });
  }
});

server.listen(PORT, () => {
  console.log(`payroll servisi :${PORT}`);
  console.log(`gizli token: ${CT_DEPLOYMENT.token}`);
});
