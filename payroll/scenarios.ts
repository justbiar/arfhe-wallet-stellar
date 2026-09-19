/**
 * Dört senaryo — tek motor, dört anlatı.
 *
 * Mekanik olarak hepsi `confidential_transfer`. Ayrı ayrı durmalarının sebebi kod değil,
 * gizliliğin **neden** önemli olduğunun her birinde farklı olması. Demo'nun anlattığı şey
 * bu fark.
 */

export type ScenarioId = "bordro" | "tedarik" | "takas" | "perakende";

export interface ScenarioDef {
  id: ScenarioId;
  title: string;
  /** Kimin ne kadar aldığı neden gizlenmeli. */
  why: string;
  /** Ödeyen taraf. */
  payer: string;
  /** Alıcılar ve tutarları (USDC). */
  recipients: { label: string; amount: string }[];
  /** Zincirde açıkta kalan şey — her senaryoda dürüstçe söylenmeli. */
  stillPublic: string;
}

export const SCENARIOS: Record<ScenarioId, ScenarioDef> = {
  bordro: {
    id: "bordro",
    title: "Bordro",
    why:
      "Kimin çalışan olduğu zaten bilinir ve bilinmesi gerekir. Hassas olan ne kadar " +
      "aldığı. Açık bir defterde maaş bordrosu herkese açıktır — kimsenin ihtiyacı " +
      "olmadığı halde.",
    payer: "Şirket",
    recipients: [
      { label: "Ayşe", amount: "18" },
      { label: "Mehmet", amount: "25" },
      { label: "Zeynep", amount: "9.5" },
    ],
    stillPublic: "Şirketin bu üç adrese ödeme yaptığı — yani istihdam ilişkisi.",
  },

  tedarik: {
    id: "tedarik",
    title: "Tedarikçi ödemesi",
    why:
      "Taraflar sözleşmeyle zaten belli. Gizli olması gereken birim fiyat: rakip, " +
      "tedarikçinin sana hangi fiyatı verdiğini defterden okuyabilmemeli.",
    payer: "Alıcı firma",
    recipients: [{ label: "Tedarikçi A", amount: "42.75" }],
    stillPublic: "İki firmanın ticari ilişkisi ve ödemenin zamanı.",
  },

  perakende: {
    id: "perakende",
    title: "Perakende",
    why:
      "Mağaza müşteriyi zaten tanıyor — kargo adresi onda. Soru mağazanın bilmesi " +
      "değil, dünyanın bilmesi: açık bir defterde sepetin tutarı herkese görünür, " +
      "ve tek fiyatlı bir üründe tutar ürünün kendisini ele verir.",
    payer: "Müşteri",
    recipients: [
      { label: "Mağaza", amount: "18.4" },
      { label: "Eczane", amount: "6.25" },
      { label: "Kitapçı", amount: "4.9" },
    ],
    // Bu satır, diğer senaryolardan farklı olarak bir eksikliği de anlatıyor: bordroda
    // işveren ilişkisinin görünmesi zaten doğru, perakendede değil. CT'nin sınırı tam burada
    // bitiyor — ilişkiyi de gizlemek havuz (SPP) kulvarının işi.
    stillPublic:
      "Müşterinin bu üç mağazaya ödeme yaptığı — yani nereden alışveriş ettiği. Eczane " +
      "örneği bunun neden yetmediğini gösteriyor.",
  },

  takas: {
    id: "takas",
    title: "Kurumsal takas",
    why:
      "Karşı taraf kayıtlı ve denetime açık. Gizlenmesi gereken pozisyon büyüklüğü — " +
      "açık bir defterde kurumun maruziyeti herkes tarafından modellenebilir.",
    payer: "Kurum A",
    recipients: [{ label: "Kurum B", amount: "31.25" }],
    stillPublic: "İki kurumun karşılıklı işlem yaptığı.",
  },
};

/** Senaryonun toplam tutarı — şirketin rampadan ne kadar çekmesi gerektiğini belirler. */
export function scenarioTotal(def: ScenarioDef): number {
  return def.recipients.reduce((sum, r) => sum + Number(r.amount), 0);
}
