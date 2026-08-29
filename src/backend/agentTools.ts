/**
 * agentTools.ts — OpenAI-compatible tool (function-calling) definitions for the in-wallet
 * AI Agent, sent as the `tools` array in requests to OpenRouter.
 *
 * Covers three tool tiers from AgentPolicyEngine.ts:
 *  - READ_ONLY_TOOLS  — data reads, executed directly (see AgentToolRunner.ts).
 *  - PROPOSAL_TOOLS   — the `propose_*` tools below. Calling one only produces a preview
 *                        for the wallet UI to show the user; the agent has no signing
 *                        authority and never broadcasts anything itself. Executing the
 *                        preview (once a confirmation UI exists) is a separate, explicit
 *                        user action outside this tool-calling loop.
 *  - X402_TOOLS       — `pay_for_resource`. Executes for real (possibly with no confirmation
 *                        at all, if within budget) — see AgentPolicyEngine.evaluateX402Payment()
 *                        and AgentToolRunner.handlePayForResource().
 * FORBIDDEN_TOOLS are never defined here — they're excluded at the AgentPolicyEngine level
 * and must never be offered to the model at all.
 *
 * Every `function.name` below is typed as `ReadOnlyTool | ProposalTool | X402Tool`, so a name
 * that drifts from AgentPolicyEngine's sets is a compile-time error, not a runtime surprise.
 * That compile-time check only catches a RENAMED tool, not a MISSING one, though — a tool that
 * exists in AgentPolicyEngine but was simply never added here compiles just fine (its name is
 * still a valid member of the union). That's exactly how `pay_for_resource` shipped without an
 * AGENT_TOOLS entry for a full Faz 3 turn: AgentOrchestrator.ts sends AGENT_TOOLS verbatim as
 * the model's tool schema, so the model could never call it, and every test up to that point
 * hand-simulated the tool_call in a mock response instead of exercising this list — found only
 * by manual testing in Chrome (see CONTEXT.md bölüm 14, "AGENT_TOOLS'ta pay_for_resource
 * eksikti"). agentTools.test.ts now has a structural invariant test guarding against a repeat.
 *
 * This module runs only inside the extension, same as AgentPolicyEngine — the definitions
 * are shipped to OpenRouter as part of the request body, but no tool *implementation* lives
 * here or on any backend; execution happens locally against Network.ts / FheCofheService.ts.
 */

import type { ReadOnlyTool, ProposalTool, X402Tool } from "./AgentPolicyEngine.js";

type AllowedToolName = ReadOnlyTool | ProposalTool | X402Tool;

/** A JSON Schema object, restricted to what OpenAI-style tool parameters actually use. */
interface ToolParameterSchema {
  type: "object";
  properties: Record<
    string,
    {
      type: "string" | "number" | "boolean";
      description: string;
      enum?: string[];
    }
  >;
  required: string[];
  additionalProperties: false;
}

export interface AgentToolDefinition {
  type: "function";
  function: {
    name: AllowedToolName;
    description: string;
    parameters: ToolParameterSchema;
  };
}

export const AGENT_TOOLS: AgentToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "get_balance",
      description:
        "Kullanıcının cüzdanındaki AÇIK (şifrelenmemiş) native token bakiyesini döndürür " +
        "(ör. ETH — bağlı ağa göre değişir). Bu, zincir üzerinde herkesin görebildiği normal " +
        "bakiyedir. FHE ile şifrelenmiş (shielded/gizli) bakiyeler bu tool'a dahil DEĞİLDİR; " +
        "kullanıcı 'gizli bakiyem' veya 'şifreli bakiyem' derse bunun yerine get_shielded_balance " +
        "ya da get_shielded_portfolio kullanılmalıdır. `network` parametresi verilmezse cüzdanın " +
        "O AN bağlı olduğu ağ kullanılır — kullanıcı ağ değiştirmeden 'Base'de bakiyem ne kadar' " +
        "gibi bir soru sorarsa `network` alanını doldurarak sorabilirsin.",
      parameters: {
        type: "object",
        properties: {
          network: {
            type: "string",
            description:
              "Opsiyonel. 'ethereum', 'arbitrum' veya 'base' — cüzdanın aktif ağından FARKLI " +
              "bir ağdaki bakiyeyi sormak için. Belirtilmezse aktif ağ kullanılır.",
            enum: ["ethereum", "arbitrum", "base"],
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_shielded_balance",
      description:
        "Belirtilen shielded token sembolü için kullanıcının FHE ile şifrelenmiş (gizli) " +
        "bakiyesini döndürür. Bu miktar zincir üzerinde hiçbir zaman açık metin olarak " +
        "görünmez — yalnızca kullanıcının kendi imzaladığı bir izinle (permit) yerel olarak " +
        "çözülür ve kullanıcıya gösterilir. tokenSymbol, shielded wrapper'ın sembolüdür " +
        "(ör. 'aeETH', 'aeUSDC'); kullanıcı 'ETH'imin gizli bakiyesi ne kadar' derse büyük " +
        "olasılıkla native shielded wrapper'ı (aeETH) kastediyordur.",
      parameters: {
        type: "object",
        properties: {
          tokenSymbol: {
            type: "string",
            description: "Bakiyesi sorulan shielded token'ın sembolü, ör. 'aeETH' veya 'aeUSDC'.",
          },
        },
        required: ["tokenSymbol"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_shielded_portfolio",
      description:
        "Kullanıcının sahip olduğu TÜM shielded (gizli) varlıkları tek seferde listeler — her " +
        "biri için sembol, temel alınan (underlying) açık token, shielded/underlying oranı ve " +
        "güncel şifreli bakiye dahildir. Kullanıcı 'gizli varlıklarım neler', 'shielded " +
        "portföyüm ne durumda' gibi genel bir soru sorduğunda, her token için ayrı ayrı " +
        "get_shielded_balance çağırmak yerine bu tool tercih edilmelidir.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_pending_claims",
      description:
        "Kullanıcının BEKLEYEN (henüz tamamlanmamış) unshield taleplerini listeler. ÖNEMLİ " +
        "BAĞLAM: Unshield (gizli bakiyeyi açığa çıkarma) işlemi iki ayrı zincir işlemi " +
        "gerektirir: (1) unshield çağrısı şifreli bakiyeyi yakar ve bir talep (claim) kaydı " +
        "açar — bu anda tokenlar HENÜZ kullanıcının eline geçmemiştir; (2) ayrı bir " +
        "claimUnshielded çağrısı çözülen miktarı doğrulayıp tokenları serbest bırakır. " +
        "Kullanıcı yalnızca ilk adımı atıp ikincisini atmazsa bakiyesi yanmış olur ama " +
        "tokenlar kilitli kalır. Bu tool boş olmayan bir sonuç döndürürse, kullanıcıya " +
        "bekleyen talebini tamamlamak için claim adımını atması gerektiğini hatırlat.",
      parameters: {
        type: "object",
        properties: {
          tokenSymbol: {
            type: "string",
            description:
              "Bekleyen talepleri belirli bir shielded token ile filtrelemek için opsiyonel " +
              "sembol, ör. 'aeETH'. Belirtilmezse kullanıcının tüm shielded tokenları için " +
              "bekleyen talepler döner.",
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_faucet_info",
      description:
        "Aktif ağ bilinen bir testnet ise (Sepolia, Base Sepolia, Arbitrum Sepolia, Avalanche " +
        "Fuji, Monad Testnet), o ağın resmi faucet sayfasının linkini ve kullanıcının adresini " +
        "döndürür. ÖNEMLİ: Bu araç test tokenlarını OTOMATİK OLARAK ÇEKMEZ ya da TALEP ETMEZ — " +
        "faucet'ler bunu engellemek için CAPTCHA istiyor, bu yüzden böyle bir şey mümkün değil. " +
        "Sadece linki ver ve kullanıcının formu kendisinin tamamlaması gerektiğini söyle; asla " +
        "'test tokenlarınızı gönderdim' gibi bir şey söyleme. supported:false dönerse aktif ağın " +
        "bilinen bir faucet'i olmadığını (ör. bir mainnet olduğunu) söyle.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_send",
      description:
        "Açık (şifrelenmemiş) bir token transferi ÖNERİSİ oluşturur. ÖNEMLİ: Bu tool hiçbir " +
        "işlemi imzalamaz veya zincire göndermez — yalnızca kullanıcının onaylaması için bir " +
        "önizleme üretir. Kullanıcı önizlemeyi gördükten sonra işlemi kendisi onaylamalı ve " +
        "göndermelidir; agent'ın işlem imzalama yetkisi yoktur. tokenSymbol belirtilmezse " +
        "önerinin native token (ör. ETH) için olduğu varsayılır.",
      parameters: {
        type: "object",
        properties: {
          to: {
            type: "string",
            description: "Alıcının adresi (0x... formatında) veya bilinen bir ENS/UD alan adı.",
          },
          amount: {
            type: "string",
            description: "Gönderilecek miktar, ondalıklı string olarak (ör. '0.5'). Wei/en küçük birim değil.",
          },
          tokenSymbol: {
            type: "string",
            description:
              "Gönderilecek token'ın sembolü, ör. 'USDC'. Belirtilmezse native token (ör. ETH) " +
              "kullanılır. Bu, şifreli (shielded) bir token değildir — gizli transfer için " +
              "kullanıcıyı ilgili ekrana yönlendir, bu tool'u kullanma.",
          },
        },
        required: ["to", "amount"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_shield",
      description:
        "Açık bir bakiyeyi FHE ile şifrelemek (shield) için bir ÖNERİ oluşturur — gerçek " +
        "işlemi göndermez, yalnızca kullanıcının onaylayacağı bir önizleme üretir. ÖNEMLİ " +
        "BAĞLAM: Şifreli katman en fazla 6 ondalık basamak kullanır; miktarın bu birimin tam " +
        "katı olmayan kısmı KIRPILIR (native ETH wrapper'ında kırpılan kısım kullanıcıya iade " +
        "edilir). Örneğin 1.5000005 ETH shield edilmek istenirse yalnızca 1.5 ETH " +
        "kalkanlanır — bunu kullanıcıya önceden belirt, sürpriz olmasın.",
      parameters: {
        type: "object",
        properties: {
          amount: {
            type: "string",
            description: "Şifrelenecek miktar, underlying token'ın kendi ondalık birimiyle, ondalıklı string olarak (ör. '1.5').",
          },
          tokenSymbol: {
            type: "string",
            description: "Şifrelenecek açık token'ın sembolü, ör. 'ETH' veya 'USDC'.",
          },
        },
        required: ["amount", "tokenSymbol"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_unshield",
      description:
        "Şifreli bir bakiyeyi açığa çıkarmak (unshield) için bir ÖNERİ oluşturur — gerçek " +
        "işlemi göndermez, yalnızca kullanıcının onaylayacağı bir önizleme üretir. ÖNEMLİ " +
        "BAĞLAM: Unshield İKİ AYRI zincir işlemi gerektirir: (1) önce şifreli bakiye yakılır " +
        "(burn) ve bir talep (claim) kaydı açılır — tokenlar bu anda HENÜZ kullanıcının eline " +
        "geçmemiştir; (2) ayrı bir claim işlemiyle çözülen miktar doğrulanıp tokenlar serbest " +
        "bırakılır. Kullanıcıya bu önerinin yalnızca İLK adımı başlattığını ve ardından ayrıca " +
        "claim yapması gerektiğini mutlaka belirt — bekleyen talepleri kontrol etmek için " +
        "get_pending_claims kullanılabilir. Ayrıca bakiyeden fazlası istenirse işlem revert " +
        "etmez, şifreli sıfır işlenir ve değersiz bir talep açılır — bu yüzden mümkünse önce " +
        "get_shielded_balance ile bakiyeyi doğrula.",
      parameters: {
        type: "object",
        properties: {
          amount: {
            type: "string",
            description: "Açığa çıkarılacak miktar, gizli (confidential) birimde, ondalıklı string olarak (ör. '1.5').",
          },
          tokenSymbol: {
            type: "string",
            description:
              "Unshield edilecek token'ın sembolü — confidential wrapper sembolü (ör. 'aeETH') " +
              "veya açık (public) sembolü (ör. 'ETH', 'DAI') olabilir, ikisi de kabul edilir.",
          },
        },
        required: ["amount", "tokenSymbol"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "pay_for_resource",
      description:
        "Ücretli (x402 ile korunan) bir kaynağa erişmek için mikro-ödeme yapar veya ödeme " +
        "önerisi oluşturur. Kullanıcı 'şu API'ye eriş', 'şu kaynağı çek', 'ücretli veriye " +
        "bak' gibi, erişim için ödeme gerektiren bir isteği açıkça belirttiğinde kullanılır — " +
        "normal (ücretsiz) veri okumaları için (bakiye, geçmiş, shielded portföy) bu tool " +
        "DEĞİL, ilgili get_* tool'u kullanılmalıdır. ÖNEMLİ: Ödeme kullanıcının önceden " +
        "belirlediği bütçe içindeyse OTOMATİK olarak (onay istemeden) gerçekleşir; bütçe " +
        "dışındaysa kullanıcının onayı istenir ve görev burada biter — hangi durumda " +
        "olduğunu tool sonucundaki alanlardan (otomatik mi onay mı) anla, kullanıcıya asla " +
        "ödemenin gerçekleştiğini varsayarak cevap verme.",
      parameters: {
        type: "object",
        properties: {
          resource: {
            type: "string",
            description: "Erişilmek istenen ücretli kaynağın URL'si (ör. 'https://api.example.com/weather').",
          },
        },
        required: ["resource"],
        additionalProperties: false,
      },
    },
  },
];

export default AGENT_TOOLS;
