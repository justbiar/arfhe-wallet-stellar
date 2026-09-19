/**
 * Bir işlemin **herkesin gördüğü** hâli.
 *
 * Demonun en önemli parçası bu. "Tutar gizli" demek kolay; gizli olduğunu göstermek için
 * zincire bakan birinin gördüğü şeyi aynen önüne koymak gerekiyor — ve içinde tutarın
 * geçmediğini aratarak.
 */

import { xdr, scValToNative, Address } from "@stellar/stellar-sdk";
import { HORIZON_URL } from "./deployment.js";

export interface ChainView {
  hash: string;
  successful: boolean;
  /** Çağrılan fonksiyon — üç işlem türü de aynı görünsün diye önemli. */
  functionName: string;
  /** Açıkta duran adresler. */
  addresses: string[];
  /** Kanıt + ciphertext bloğunun boyutu. */
  opaqueBytes: number;
  /** Zarfın tamamının boyutu. */
  envelopeBytes: number;
  /**
   * Aranan tutarların zarf baytlarında bulunup bulunmadığı.
   * Hepsi `false` olmalı — iddia bu, ve kanıtı burada.
   */
  amountsFound: { amount: string; found: boolean }[];
}

/**
 * Tutarı sekiz baytlık big-endian olarak arar.
 *
 * Kusursuz bir arama değil ve öyle olduğunu iddia etmiyor: farklı kodlamada saklanan bir
 * sayıyı kaçırır. Ama gösterdiği şey gerçek — açıkça yazılmış bir tutar bu aramaya takılır,
 * nitekim `deposit` işleminde takılıyor.
 */
function containsAmount(buf: Buffer, units: bigint): boolean {
  if (units < 0n || units > 0xffff_ffff_ffff_ffffn) return false;
  const probe = Buffer.alloc(8);
  probe.writeBigUInt64BE(units);
  return buf.includes(probe);
}

export async function readChainView(hash: string, probeAmounts: bigint[]): Promise<ChainView> {
  const [txRes, opsRes] = await Promise.all([
    fetch(`${HORIZON_URL}/transactions/${hash}`),
    fetch(`${HORIZON_URL}/transactions/${hash}/operations`),
  ]);
  if (!txRes.ok) throw new Error(`işlem bulunamadı: ${hash}`);

  const tx = (await txRes.json()) as Record<string, string | boolean>;
  const ops = (await opsRes.json()) as { _embedded: { records: Record<string, unknown>[] } };
  const op = ops._embedded.records[0] ?? {};
  const params = (op.parameters ?? []) as { type: string; value: string }[];

  const addresses: string[] = [];
  let functionName = "—";
  let opaqueBytes = 0;

  for (const p of params) {
    const val = xdr.ScVal.fromXDR(p.value, "base64");
    if (p.type === "Address") {
      addresses.push(Address.fromScVal(val).toString());
    } else if (p.type === "Sym") {
      functionName = String(scValToNative(val));
    } else if (p.type === "Bytes") {
      const bytes = scValToNative(val) as Uint8Array;
      opaqueBytes = Math.max(opaqueBytes, bytes.length);
    }
  }

  const buf = Buffer.concat(
    ["envelope_xdr", "result_xdr", "result_meta_xdr"]
      .map((k) => (typeof tx[k] === "string" ? Buffer.from(tx[k] as string, "base64") : Buffer.alloc(0))),
  );

  return {
    hash,
    successful: tx.successful === true,
    functionName,
    addresses,
    opaqueBytes,
    envelopeBytes: buf.length,
    amountsFound: probeAmounts.map((a) => ({ amount: a.toString(), found: containsAmount(buf, a) })),
  };
}
