/**
 * verify-anchor-ramp.mjs — drives the TRY -> USDC on-ramp end to end against a live anchor.
 *
 * Proves the whole SEP path in one run: SEP-5 derivation, a funded testnet account, a USDC
 * trustline, SEP-10 authentication, a SEP-6 deposit, the sandbox's bank simulation, and the
 * arrival of real testnet USDC — checked against Horizon rather than the anchor's own word
 * for it.
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

import { Keypair, Horizon, TransactionBuilder, Networks, Operation, Asset, BASE_FEE } from "@stellar/stellar-sdk";
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
