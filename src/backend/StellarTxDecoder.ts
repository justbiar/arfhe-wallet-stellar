/**
 * Turns a Stellar transaction envelope into something a person can check before signing.
 *
 * An XDR envelope is base64 — unreadable by design, and pointless to show. The approval
 * screen's job is to answer three questions: who gets what, from which account, and is
 * anything unusual attached. Everything here exists to answer those and nothing else.
 *
 * ── On the unknown ──
 *
 * Stellar has around thirty operation types. This decodes the ones that move value or
 * change what an account can do, and for anything else it says plainly that it does not
 * know rather than rendering a friendly summary it cannot justify. An approval screen that
 * paraphrases an operation it does not understand is worse than one that admits it: the
 * user reads the paraphrase and approves on the strength of it.
 */

import type { Transaction, FeeBumpTransaction } from "@stellar/stellar-sdk";

export interface DecodedOperation {
  /** The raw Stellar operation type, always shown so nothing hides behind a label. */
  type: string;
  /** One line a person can read. Null when this decoder does not understand the operation. */
  summary: string | null;
  /** Where value goes, when the operation moves any. */
  destination?: string;
  amount?: string;
  assetCode?: string;
  assetIssuer?: string | null;
  /** True for operations that hand lasting authority to someone else. */
  elevated?: boolean;
}

export interface DecodedTransaction {
  source: string;
  /** Stroops. 10,000,000 stroops = 1 XLM. */
  fee: string;
  /** XLM, for display beside the stroop figure nobody reads in their head. */
  feeXlm: string;
  memo: { type: string; value: string } | null;
  operations: DecodedOperation[];
  /** True when the envelope wraps another transaction and pays its fee. */
  isFeeBump: boolean;
  /** Operations this decoder could not explain. Non-zero means "do not trust the summary". */
  unknownCount: number;
  /** True when any operation grants lasting authority rather than moving value once. */
  hasElevatedOperation: boolean;
}

/** Operations that outlive the transaction by granting someone standing power. */
const ELEVATED = new Set(["setOptions", "allowTrust", "setTrustLineFlags", "accountMerge", "revokeSponsorship"]);

/** The only network this wallet signs Stellar transactions on. */
export const SUPPORTED_NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";

/**
 * Thrown when a caller asks for a network this wallet will not sign on.
 *
 * Its own type so the approval screen can refuse loudly instead of rendering the
 * transaction as if it were ordinary.
 */
export class UnsupportedNetworkError extends Error {
  constructor(readonly requested: string) {
    super(`Bu ağ desteklenmiyor: "${requested}". Cüzdan yalnızca Stellar testnet üzerinde imzalar.`);
    this.name = "UnsupportedNetworkError";
  }
}

/**
 * Decodes an envelope, refusing any network but testnet.
 *
 * The network check is explicit because parsing does not provide one. `fromXDR` accepts any
 * passphrase and simply records it — hand it the public network string and it returns a
 * perfectly good transaction. Nothing fails, and the only thing separating a testnet
 * signature from a mainnet one is whether somebody thought to look. So this looks.
 *
 * That matters here more than it would elsewhere: the passphrase arrives from the calling
 * page, which is the party with the least reason to be trusted about it.
 */
export async function decodeTransactionXdr(
  xdr: string,
  networkPassphrase: string
): Promise<DecodedTransaction> {
  if (networkPassphrase !== SUPPORTED_NETWORK_PASSPHRASE) {
    throw new UnsupportedNetworkError(networkPassphrase);
  }
  const { TransactionBuilder } = await import("@stellar/stellar-sdk");
  const parsed = TransactionBuilder.fromXDR(xdr, networkPassphrase) as Transaction | FeeBumpTransaction;

  // A fee bump wraps an inner transaction and pays for it. What the user is approving is
  // the inner one; showing the wrapper's empty operation list would say nothing.
  const isFeeBump = "innerTransaction" in parsed;
  const tx = (isFeeBump ? (parsed as FeeBumpTransaction).innerTransaction : parsed) as Transaction;

  const operations = tx.operations.map((op) => decodeOperation(op as unknown as Record<string, unknown>));

  return {
    source: tx.source,
    fee: parsed.fee,
    feeXlm: stroopsToXlm(parsed.fee),
    memo: readMemo(tx),
    operations,
    isFeeBump,
    unknownCount: operations.filter((o) => o.summary === null).length,
    hasElevatedOperation: operations.some((o) => o.elevated === true),
  };
}

function decodeOperation(op: Record<string, unknown>): DecodedOperation {
  const type = String(op.type);
  const base: DecodedOperation = { type, summary: null, elevated: ELEVATED.has(type) };

  switch (type) {
    case "payment": {
      const asset = op.asset as { code?: string; issuer?: string; isNative?: () => boolean } | undefined;
      const code = asset?.isNative?.() ? "XLM" : asset?.code ?? "?";
      return {
        ...base,
        summary: `${op.amount} ${code} gönderilecek`,
        destination: String(op.destination ?? ""),
        amount: String(op.amount ?? ""),
        assetCode: code,
        assetIssuer: asset?.issuer ?? null,
      };
    }

    case "createAccount":
      return {
        ...base,
        summary: `Yeni hesap oluşturulacak, ${op.startingBalance} XLM ile fonlanacak`,
        destination: String(op.destination ?? ""),
        amount: String(op.startingBalance ?? ""),
        assetCode: "XLM",
      };

    case "changeTrust": {
      const line = op.line as { code?: string; issuer?: string } | undefined;
      // The SDK formats limits to seven decimals, so removal arrives as "0.0000000" and a
      // string comparison against "0" quietly reports the opposite of what is happening.
      const removing = Number(op.limit ?? NaN) === 0;
      return {
        ...base,
        summary: removing
          ? `${line?.code ?? "?"} güven hattı kaldırılacak`
          : `${line?.code ?? "?"} için güven hattı açılacak — bu varlığı almaya izin verir`,
        assetCode: line?.code,
        assetIssuer: line?.issuer ?? null,
      };
    }

    case "pathPaymentStrictSend":
    case "pathPaymentStrictReceive": {
      const send = op.sendAsset as { code?: string; isNative?: () => boolean } | undefined;
      const dest = op.destAsset as { code?: string; isNative?: () => boolean } | undefined;
      const sendCode = send?.isNative?.() ? "XLM" : send?.code ?? "?";
      const destCode = dest?.isNative?.() ? "XLM" : dest?.code ?? "?";
      return {
        ...base,
        summary: `${sendCode} → ${destCode} takas edilerek gönderilecek`,
        destination: String(op.destination ?? ""),
      };
    }

    case "accountMerge":
      return {
        ...base,
        summary: `HESAP KAPATILACAK — tüm XLM bakiyesi ${op.destination} adresine geçecek`,
        destination: String(op.destination ?? ""),
      };

    case "setOptions":
      return {
        ...base,
        summary: "Hesap ayarları değişecek — imza yetkileri veya eşikler etkilenebilir",
      };

    case "invokeHostFunction":
      // Soroban. The call could be anything, so it is named and not described.
      return { ...base, summary: "Akıllı kontrat çağrısı", elevated: true };

    // Deliberately not guessed at. See the note at the top of the file.
    default:
      return base;
  }
}

function readMemo(tx: Transaction): { type: string; value: string } | null {
  const memo = tx.memo;
  if (!memo || memo.type === "none") return null;
  // Text memos arrive as bytes and are meant to be read as text — hex would turn the
  // anchor reference a user is supposed to recognise into an unrecognisable string. Hash
  // and return memos are genuinely binary and stay hex.
  const raw = memo.value;
  let value: string;
  if (raw instanceof Uint8Array) {
    value = memo.type === "text"
      ? new TextDecoder().decode(raw)
      : Array.from(raw).map((b) => b.toString(16).padStart(2, "0")).join("");
  } else {
    value = String(raw ?? "");
  }
  return { type: memo.type, value };
}

/** Stroops are the unit on the wire; nobody divides by ten million while reading a screen. */
export function stroopsToXlm(stroops: string): string {
  const n = Number(stroops);
  if (!Number.isFinite(n)) return "0";
  return (n / 10_000_000).toFixed(7).replace(/0+$/, "").replace(/\.$/, "");
}
