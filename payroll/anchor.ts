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

/**
 * Friendbot, art arda çağrıldığında bağlantıyı düşürüyor.
 *
 * Dört hesabı peş peşe fonlarken "fetch failed" ile patladı — ağ sorunu değil, servisin
 * kendisi. Tek denemede bırakmak, kurulumun rastgele başarısız olması demek; o yüzden
 * geri çekilerek tekrar deniyor.
 */
export async function fundWithFriendbot(publicKey: string, attempts = 4): Promise<void> {
  let lastError = "";
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 1500 * i));
    try {
      const res = await fetch(`https://friendbot.stellar.org?addr=${encodeURIComponent(publicKey)}`);
      // 400 genellikle "zaten fonlanmış" demek — çağıran açısından hata değil.
      if (res.ok || res.status === 400) return;
      lastError = `HTTP ${res.status}`;
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }
  throw new Error(`friendbot ${publicKey.slice(0, 8)}… fonlayamadı: ${lastError}`);
}

/**
 * Anchor'ın tek bir yatırmada kabul ettiği en yüksek TRY.
 *
 * Sorulmuyor değil, okunuyor: tavan anchor'ın kendi kurundan hesaplanıyor ve kur değişince
 * o sayı da değişiyor. Burada bir kopyasını tutmak, bir gün iki tarafın sessizce ayrışması
 * demek olurdu — nitekim bir kere oldu.
 */
async function maxPerDeposit(ep: AnchorEndpoints): Promise<number> {
  const info = await json(await fetch(`${ep.sep6}/info`));
  const ceiling = info.deposit?.USDC?.max_amount_fiat;
  return typeof ceiling === "number" && ceiling > 0 ? ceiling : Number.POSITIVE_INFINITY;
}

/** Bir yatırma açar ve havaleyi bildirir. Ödemeyi beklemez. */
async function openDeposit(
  ep: AnchorEndpoints, H: Record<string, string>, account: string, amountTry: string,
): Promise<string> {
  const dep = await json(await fetch(
    `${ep.sep6}/deposit?asset_code=USDC&account=${account}&type=bank_account&amount=${encodeURIComponent(amountTry)}`,
    { headers: H },
  ));
  if (!dep.id) throw new Error(dep.error ?? "yükleme açılamadı");

  // Sandbox: bankayı biz oynuyoruz. Cevabı okuyoruz — reddedilen bir havale sessizce
  // `pending` bırakıyordu ve hata, kırk saniye sonra "anchor sonuçlandırmadı" diye
  // görünüyordu. Sebebi anchor zaten söylüyordu, kimse bakmıyordu.
  const sim = await fetch(`${ep.sep6}/tx/${dep.id}/simulate-bank-transfer`, {
    method: "POST", headers: { ...H, "Content-Type": "application/json" },
    body: JSON.stringify({ amount: amountTry }),
  });
  if (!sim.ok) throw new Error((await json(sim)).error ?? `anchor havaleyi reddetti (HTTP ${sim.status})`);

  return dep.id as string;
}

/** Açılmış bir yatırmanın ödenmesini bekler ve gelen USDC'yi döndürür. */
async function settled(ep: AnchorEndpoints, H: Record<string, string>, id: string): Promise<number> {
  // Gözlemlenen sonuçlanma 2–4 yoklama; dar bir timeout başarılı işlemi hata sayar.
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const t = await json(await fetch(`${ep.sep6}/transaction?id=${id}`, { headers: H }));
    if (t.transaction?.status === "completed") return Number(t.transaction.amount_out);
    if (t.transaction?.status === "error") throw new Error("anchor işlemi hata ile bitirdi");
  }
  throw new Error("anchor beklenen sürede sonuçlandırmadı");
}

/**
 * TRY yatırır, USDC bekler, gelen toplamı döndürür.
 *
 * `amount` TRY cinsinden — USDC değil. Anchor'ın en kolay yanlış okunan alanı bu
 * (stellar.md §4): 100 istersen ~2 USDC gelir.
 *
 * Tavanı aşan bir senaryo tek istekte geçmiyor: anchor işlem başına 20 USDC ödüyor, bir
 * bordro ise bunun üç katını istiyor. Talep, tavanın altına bölünüp sırayla gönderiliyor —
 * gerçek bir rampada da limit böyle aşılır, ve bölmek, demoyu ayakta tutmak için herkese
 * açık tavanı yükseltmekten iyidir.
 */
export async function rampIn(kp: Keypair, amountTry: string): Promise<string> {
  const ep = await discover();
  await ensureTrustline(kp, ep.issuer);
  const jwt = await authenticate(ep, kp);
  const H = { Authorization: `Bearer ${jwt}` };

  const ceiling = await maxPerDeposit(ep);
  const slices: string[] = [];
  for (let remaining = Number(amountTry); remaining > 0; ) {
    const slice = Math.min(remaining, ceiling);
    slices.push(slice.toFixed(2));
    remaining -= slice;
  }

  // Açılışlar sırayla, ödemeler birlikte beklenir. Anchor'ın işçisi bekleyen yatırmaların
  // hepsini aynı turda ödüyor, yani her dilim için ayrı ayrı beklemek — üç dilimde otuz
  // saniye — tamamen boşa geçen bir süreydi. Açılış sırası korunuyor, çünkü hesap başına
  // tavan birikimli sayılıyor ve eşzamanlı istekler onu farklı sırayla görebilir.
  const ids: string[] = [];
  for (const slice of slices) ids.push(await openDeposit(ep, H, kp.publicKey(), slice));

  const amounts = await Promise.all(ids.map((id) => settled(ep, H, id)));
  return amounts.reduce((sum, a) => sum + a, 0).toFixed(7);
}
