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
      const step = (m: string) => console.log(`  [prepare] ${m}`);

      step(`taraflar oluşturuluyor (${1 + def.recipients.length})`);
      const payer = await engine.createParty(def.payer);
      const recipients = [];
      for (const r of def.recipients) recipients.push(await engine.createParty(r.label));

      for (const p of [payer, ...recipients]) {
        step(`kayıt: ${p.label}`);
        await engine.register(p);
      }

      // Rampadan, senaryonun toplamını karşılayacak kadar TRY çek.
      const need = Math.ceil(scenarioTotal(def) * TRY_PER_USDC);
      const amountTry = String(Math.min(DEPOSIT_MAX_TRY, Math.max(DEPOSIT_MIN_TRY, need)));
      step(`rampa: ${amountTry} TRY`);
      const funded = await engine.fundFromAnchor(payer, amountTry);
      step(`gizleniyor: ${funded} USDC`);
      await engine.shield(payer, funded);
      step("hazır");

      session = { scenario: id, payer, recipients, funded, payments: [] };
      return send(res, 200, { amountTry, ...(await readState(session)) });
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
      endpoints: ["GET /health", "GET /scenarios", "GET /state", "GET /chain/:hash", "POST /prepare", "POST /pay"],
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
