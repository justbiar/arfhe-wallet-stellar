/**
 * agentTools.ts — OpenAI-compatible tool (function-calling) definitions for the in-wallet
 * AI Agent, sent as the `tools` array in requests to OpenRouter.
 *
 * Only READ_ONLY_TOOLS from AgentPolicyEngine.ts are defined here. State-changing tools
 * (PROPOSAL_TOOLS) get their own definitions once the proposal/confirmation UI exists —
 * until then, the agent has no way to move funds, only to read wallet state. Every
 * `function.name` below is typed as `ReadOnlyTool`, so a name that drifts from
 * AgentPolicyEngine's READ_ONLY_TOOLS set is a compile-time error, not a runtime surprise.
 *
 * This module runs only inside the extension, same as AgentPolicyEngine — the definitions
 * are shipped to OpenRouter as part of the request body, but no tool *implementation* lives
 * here or on any backend; execution happens locally against Network.ts / FheCofheService.ts.
 */

import type { ReadOnlyTool } from "./AgentPolicyEngine.js";

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
    name: ReadOnlyTool;
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
        "Kullanıcının aktif cüzdanındaki AÇIK (şifrelenmemiş) native token bakiyesini döndürür " +
        "(ör. ETH, MATIC — bağlı ağa göre değişir). Bu, zincir üzerinde herkesin görebildiği " +
        "normal bakiyedir. FHE ile şifrelenmiş (shielded/gizli) bakiyeler bu tool'a dahil " +
        "DEĞİLDİR; kullanıcı 'gizli bakiyem' veya 'şifreli bakiyem' derse bunun yerine " +
        "get_shielded_balance ya da get_shielded_portfolio kullanılmalıdır.",
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
];

export default AGENT_TOOLS;
