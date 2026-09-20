/**
 * Bizim dağıttığımız gizli USDC katmanı.
 *
 * Referans demo XLM sarmalıyordu; bu kontratlar **anchor'ın kendi Circle USDC'sini**
 * sarmalıyor, çünkü rampadan çıkan varlık ile gizli katmanın tuttuğu varlık aynı olmazsa
 * araya bir takas girer ve bütün hikâye dağılır.
 *
 * `deployedAtLedger`, olay taramasının nereden başlayacağı. Gerçek dağıtım ledger'ı —
 * RPC'nin ~7 günlük penceresi içinde kaldığı sürece kullanılabilir; dışına çıkarsa taze
 * hesaplar için "şimdi eksi biraz" yazmak gerekir (bkz. stellar.md §4).
 */
export const CT_DEPLOYMENT = {
  token: "CCR235ZHRQ6PVGLAJ4AUZLDWJLVRILSDAUP7EKW563SWZNAQY6C3EL4C",
  verifier: "CACOFUE7ROIR23VNSISE672CNUU4LMKUQ4LQDK3RPAGOLLF6J7SD7V65",
  auditor: "CAV7XOZQIJBQ4GJFLMHWGHAVOVN5UROJL7WLJK4ADK3O5FPVLAFPSKZA",
  /** Anchor'ın ödediği Circle testnet USDC'sinin SAC adresi. */
  underlying: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  /**
   * Aynı varlığın klasik ihraççısı.
   *
   * SAC adresi kontrat çağrıları için, bu ise güven hattı için — bir hesap `C…` adresine
   * hat açamaz. İkisi aynı varlığın iki adı; ayrışırlarsa gizli katman bir varlığı sarmalar,
   * hesaplar başkasına hat açar ve çekim "trustline entry is missing" ile düşer.
   */
  underlyingIssuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  deployedAtLedger: 4761744,
} as const;

export const RPC_URL = "https://soroban-testnet.stellar.org";
export const HORIZON_URL = "https://horizon-testnet.stellar.org";
export const PASSPHRASE = "Test SDF Network ; September 2015";
/**
 * Rampanın bağlandığı anchor — artık kendi yazdığımız (`anchor/`, `npm run anchor`).
 *
 * Önceki adres `tr-mock-anchor.fly.dev`'di ve sessizce bozuldu: HTTP'ye cevap vermeye devam
 * ederken ödeme yapmayı bıraktı, yani yatırma `pending_anchor`'da kalıp zaman aşımına düştü.
 * Hata mesajı "anchor sonuçlandırmadı" olduğu için, ölü bir bağımlılık gibi değil, bizim
 * tarafımızdaki bir yavaşlık gibi okunuyordu.
 *
 * `ANCHOR_URL` ile taşınabiliyor; varsayılan, aynı makinede çalışan anchor.
 */
export const ANCHOR = process.env.ANCHOR_URL ?? "http://localhost:8790";

/** Tek denetçi kaydı. Dağıtımda id 0 olarak kaydedildi. */
export const AUDITOR_ID = 0;

/** Sarmalanan varlığın ondalığı — Stellar SAC'ları yedi hane kullanır. */
export const DECIMALS = 7;

export function toUnits(amount: string): bigint {
  const n = Number(amount);
  if (!Number.isFinite(n)) throw new Error(`geçersiz tutar: ${amount}`);
  return BigInt(Math.round(n * 10 ** DECIMALS));
}

export function fromUnits(units: bigint): string {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const whole = abs / 10n ** BigInt(DECIMALS);
  const frac = (abs % 10n ** BigInt(DECIMALS)).toString().padStart(DECIMALS, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}
