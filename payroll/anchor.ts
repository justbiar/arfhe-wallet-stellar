/**
 * Rampa ayağı: anchor'dan TRY karşılığı USDC almak.
 *
 * Bu adım **gizli değil ve olamaz** — anchor bilinen bir adrese bilinen bir tutar ödüyor.
 * Şirketin kasasına ne girdiği zincirde görünür; gizlenen, o paranın içeriden kime ne
 * kadar dağıtıldığı.
 */

import { Keypair, Horizon, TransactionBuilder, Networks, Operation, Asset, BASE_FEE } from "@stellar/stellar-sdk";
import { ANCHOR, HORIZON_URL } from "./deployment.js";

const horizon = new Horizon.Server(HORIZON_URL);

/**
 * `Response.json()` yeni tip tanımlarında `unknown` dönüyor, ki doğrusu bu: gelen şeyin
 * şekli hakkında hiçbir garanti yok. Bu yardımcı, "biliyormuş gibi yapmayı" tek bir yerde
 * toplar — her çağrı yerine dağılmış cast'lar yerine.
 */
async function json<T = Record<string, any>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

interface AnchorEndpoints { auth: string; sep6: string; issuer: string }

async function discover(): Promise<AnchorEndpoints> {
  const toml = await (await fetch(`${ANCHOR}/.well-known/stellar.toml`)).text();
  const grab = (k: string) => toml.match(new RegExp(`^${k}="([^"]+)"`, "m"))?.[1];
  const auth = grab("WEB_AUTH_ENDPOINT"), sep6 = grab("TRANSFER_SERVER");
  const issuer = toml.match(/issuer="([^"]+)"/)?.[1];
  if (!auth || !sep6 || !issuer) throw new Error("anchor stellar.toml eksik");
  return { auth, sep6, issuer };
}

async function authenticate(ep: AnchorEndpoints, kp: Keypair): Promise<string> {
  const ch = await json(await fetch(`${ep.auth}?account=${kp.publicKey()}`));
  const tx = TransactionBuilder.fromXDR(ch.transaction, ch.network_passphrase ?? Networks.TESTNET);
  tx.sign(kp);
  const body = await json(await fetch(ep.auth, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ transaction: tx.toXDR() }),
  }));
  if (!body.token) throw new Error(body.error ?? "SEP-10 reddedildi");
  return body.token;
}

/** Güven hattı yoksa açar. Hat olmadan anchor ödeyemez, `pending_trust`'ta kalır. */
async function ensureTrustline(kp: Keypair, issuer: string): Promise<void> {
  const acct = await horizon.loadAccount(kp.publicKey());
  if (acct.balances.some((b) => "asset_code" in b && b.asset_code === "USDC" && b.asset_issuer === issuer)) return;
  const tx = new TransactionBuilder(acct, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.changeTrust({ asset: new Asset("USDC", issuer) }))
    .setTimeout(60).build();
  tx.sign(kp);
  await horizon.submitTransaction(tx as Parameters<typeof horizon.submitTransaction>[0]);
}

export async function fundWithFriendbot(publicKey: string): Promise<void> {
  const res = await fetch(`https://friendbot.stellar.org?addr=${encodeURIComponent(publicKey)}`);
  // 400 genellikle "zaten fonlanmış" demek — çağıran açısından hata değil.
  if (!res.ok && res.status !== 400) throw new Error(`friendbot ${res.status}`);
}

/**
 * TRY yatırır, USDC bekler, gelen tutarı döndürür.
 *
 * `amount` TRY cinsinden — USDC değil. Anchor'ın en kolay yanlış okunan alanı bu
 * (stellar.md §4): 100 istersen ~2 USDC gelir.
 */
export async function rampIn(kp: Keypair, amountTry: string): Promise<string> {
  const ep = await discover();
  await ensureTrustline(kp, ep.issuer);
  const jwt = await authenticate(ep, kp);
  const H = { Authorization: `Bearer ${jwt}` };

  const dep = await json(await fetch(
    `${ep.sep6}/deposit?asset_code=USDC&account=${kp.publicKey()}&type=bank_account&amount=${encodeURIComponent(amountTry)}`,
    { headers: H },
  ));
  if (!dep.id) throw new Error(dep.error ?? "yükleme açılamadı");

  // Sandbox: bankayı biz oynuyoruz.
  await fetch(`${ep.sep6}/tx/${dep.id}/simulate-bank-transfer`, {
    method: "POST", headers: { ...H, "Content-Type": "application/json" },
    body: JSON.stringify({ amount: amountTry }),
  });

  // Gözlemlenen sonuçlanma 2–4 yoklama; dar bir timeout başarılı işlemi hata sayar.
  for (let i = 0; i < 16; i++) {
    await new Promise((r) => setTimeout(r, 2500));
    const t = await json(await fetch(`${ep.sep6}/transaction?id=${dep.id}`, { headers: H }));
    if (t.transaction?.status === "completed") return t.transaction.amount_out;
    if (t.transaction?.status === "error") throw new Error("anchor işlemi hata ile bitirdi");
  }
  throw new Error("anchor beklenen sürede sonuçlandırmadı");
}
