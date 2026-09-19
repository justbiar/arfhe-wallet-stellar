/**
 * Üç senaryo — tek motor, üç anlatı.
 *
 * Mekanik olarak hepsi `confidential_transfer`. Ayrı ayrı durmalarının sebebi kod değil,
 * gizliliğin **neden** önemli olduğunun her birinde farklı olması. Demo'nun anlattığı şey
 * bu fark.
 */

export type ScenarioId = "bordro" | "tedarik" | "takas";

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
