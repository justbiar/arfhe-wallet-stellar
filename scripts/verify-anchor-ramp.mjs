/**
 * verify-anchor-ramp.mjs — drives the full TRY <-> USDC round trip against a live anchor.
 *
 * Proves the whole SEP path in one run: SEP-5 derivation, a funded testnet account, a USDC
 * trustline, SEP-10 authentication, a SEP-6 deposit, the sandbox's bank simulation, and the
 * arrival of real testnet USDC — checked against Horizon rather than the anchor's own word
 * for it. Then the other direction: a SEP-6 withdrawal, the on-chain payment that funds it,
 * and the fiat leg coming back.
 *
 * The withdrawal is the half worth automating. A deposit that goes wrong costs nothing —
 * the money never moved. A withdrawal sends real value to a treasury account matched only
 * by memo, so the failure mode is a payment nobody can attribute. This script is what makes
 * that path something that gets exercised rather than described.
 *
 * Every run creates a throwaway account from a fresh mnemonic. Nothing here touches the
 * user's wallet and nothing has value; the mnemonic is discarded when the process exits.
 *
 *   node scripts/verify-anchor-ramp.mjs
 *
 * `amount` on the deposit call is TRY, not USDC — 100 comes back as roughly 2.04 USDC at the
 * anchor's posted rate. That is easy to misread as a broken conversion, which is why the
 * script prints both sides.
 */

import { Keypair, Horizon, TransactionBuilder, Networks, Operation, Asset, BASE_FEE, Memo } from "@stellar/stellar-sdk";
import { Mnemonic } from "ethers";
import { derivePath } from "ed25519-hd-key";

const ANCHOR = "https://tr-mock-anchor.fly.dev";
const server = new Horizon.Server("https://horizon-testnet.stellar.org");
const log = (...a) => console.log(...a);

// ── One-shot testnet account ──
const phrase = Mnemonic.fromEntropy(crypto.getRandomValues(new Uint8Array(16))).phrase;
const { key } = derivePath("m/44'/148'/0'", Mnemonic.fromPhrase(phrase).computeSeed().replace(/^0x/, ""));
const kp = Keypair.fromRawEd25519Seed(key);
log("1) hesap:", kp.publicKey());
await fetch(`https://friendbot.stellar.org?addr=${kp.publicKey()}`);

// ── SEP-1 ──
const toml = await (await fetch(`${ANCHOR}/.well-known/stellar.toml`)).text();
const grab = k => (toml.match(new RegExp(`^${k}="([^"]+)"`, "m")) || [])[1];
const AUTH = grab("WEB_AUTH_ENDPOINT"), SEP6 = grab("TRANSFER_SERVER");
const ISSUER = (toml.match(/issuer="([^"]+)"/) || [])[1];
const USDC = new Asset("USDC", ISSUER);

// ── USDC guven hatti (trustline) ──
let acct = await server.loadAccount(kp.publicKey());
const trustTx = new TransactionBuilder(acct, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
  .addOperation(Operation.changeTrust({ asset: USDC }))
  .setTimeout(60).build();
trustTx.sign(kp);
await server.submitTransaction(trustTx);
log("2) USDC guven hatti kuruldu");

// ── SEP-10 ──
const ch = await (await fetch(`${AUTH}?account=${kp.publicKey()}`)).json();
const ctx = TransactionBuilder.fromXDR(ch.transaction, ch.network_passphrase);
ctx.sign(kp);
const { token: jwt } = await (await fetch(AUTH, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ transaction: ctx.toXDR() }),
})).json();
log("3) SEP-10 JWT alindi");

// ── SEP-6 deposit ──
const H = { Authorization: `Bearer ${jwt}` };
const dep = await (await fetch(
  `${SEP6}/deposit?asset_code=USDC&account=${kp.publicKey()}&type=bank_account&amount=100`, { headers: H }
)).json();
log("4) SEP-6 deposit acildi");
log("   id       :", dep.id);
log("   IBAN     :", dep.how || JSON.stringify(dep.instructions || {}).slice(0, 160));

// ── Bankayi oyna ──
const sim = await fetch(`${SEP6}/tx/${dep.id}/simulate-bank-transfer`, {
  method: "POST", headers: { ...H, "Content-Type": "application/json" },
  body: JSON.stringify({ amount: "100" }),
});
log("5) Banka havalesi simule edildi:", sim.status);

// ── Durumu izle ──
for (let i = 0; i < 12; i++) {
  await new Promise(r => setTimeout(r, 2500));
  const t = await (await fetch(`${SEP6}/transaction?id=${dep.id}`, { headers: H })).json();
  const s = t.transaction?.status;
  log(`   [${i + 1}] durum: ${s}`);
  if (s === "completed" || s === "error") {
    log("   USDC tutari:", t.transaction?.amount_out);
    break;
  }
}

// ── Zincirden dogrula ──
acct = await server.loadAccount(kp.publicKey());
const bal = acct.balances.find(b => b.asset_code === "USDC");
log("6) ZINCIRDEKI USDC BAKIYESI:", bal ? bal.balance : "yok");

// ══ Ters yon: USDC -> TRY ══════════════════════════════════════════
//
// Anchor'in min off-ramp siniri 1 USDC. Depozitten gelen ~2 USDC bunu karsiliyor.
const WITHDRAW_USDC = "1.5";

const wd = await (await fetch(
  `${SEP6}/withdraw?asset_code=USDC&type=bank_account&amount=${WITHDRAW_USDC}`, { headers: H }
)).json();
if (!wd.account_id || !wd.memo || !wd.memo_type) {
  log("7) HATA: anchor eksik cekim talimati dondurdu:", JSON.stringify(wd));
  process.exit(1);
}
log("7) SEP-6 withdraw acildi");
log("   id       :", wd.id);
log("   hedef    :", wd.account_id);
log("   memo     :", `${wd.memo} (${wd.memo_type})`);

// Memo turu, odemeyi cekim talebine baglayan tek sey. Yanlis turde gonderilen odeme
// eslesmez ve geri alinamaz — o yuzden tanimadigimiz bir turde durur, tahmin etmeyiz.
const memo = wd.memo_type === "id" ? Memo.id(String(wd.memo))
  : wd.memo_type === "text" ? Memo.text(String(wd.memo))
  : null;
if (!memo) {
  log(`   HATA: taninmayan memo turu "${wd.memo_type}" — odeme gonderilmedi.`);
  process.exit(1);
}

acct = await server.loadAccount(kp.publicKey());
const payTx = new TransactionBuilder(acct, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
  .addOperation(Operation.payment({ destination: wd.account_id, asset: USDC, amount: WITHDRAW_USDC }))
  .addMemo(memo)
  .setTimeout(120).build();
payTx.sign(kp);
const payRes = await server.submitTransaction(payTx);
log("8) USDC odemesi gonderildi");
log("   hash     :", payRes.hash);

// ── Fiat ayagini izle ──
let wdFinal = null;
for (let i = 0; i < 12; i++) {
  await new Promise(r => setTimeout(r, 2500));
  const t = await (await fetch(`${SEP6}/transaction?id=${wd.id}`, { headers: H })).json();
  wdFinal = t.transaction;
  log(`   [${i + 1}] durum: ${wdFinal?.status}`);
  if (wdFinal?.status === "completed" || wdFinal?.status === "error") break;
}
log("9) CEKIM SONUCU:", wdFinal?.status);
log("   gonderilen :", wdFinal?.amount_in, "USDC");
log("   alinan     :", wdFinal?.amount_out, "TRY");
log("   banka ref  :", wdFinal?.external_transaction_id ?? "-");

acct = await server.loadAccount(kp.publicKey());
const balAfter = acct.balances.find(b => b.asset_code === "USDC");
log("10) CEKIM SONRASI USDC BAKIYESI:", balAfter ? balAfter.balance : "yok");
