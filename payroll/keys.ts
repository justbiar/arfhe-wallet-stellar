/**
 * Demo tarafları ve anahtarları.
 *
 * ── Bu bir demo, ürün değil ──
 *
 * Bu servis hem şirketin hem çalışanların anahtarlarını tutuyor. Gerçek bir üründe
 * çalışanın anahtarı cüzdanında olur ve bu servis onu hiç görmez; burada tek bir ekrandan
 * "şirket ödedi, çalışan gördü" gösterebilmek için bir arada duruyorlar.
 *
 * Anahtarlar her başlatmada yeniden üretilir ve diske yazılmaz. Testnet.
 */

import { Keypair } from "@stellar/stellar-sdk";
import { deriveKeys, type KeyPair } from "../vendor/ctd-sdk/src/crypto/keys.js";
import { randomScalar } from "../vendor/ctd-sdk/src/crypto/field.js";

export interface Party {
  label: string;
  /** Stellar hesabı — zincirde açık. */
  keypair: Keypair;
  /** Gizli katman anahtarları — tutarları bunlarla çözüyor. */
  keys: KeyPair;
}

export function makeParty(label: string, addrF: bigint): Party {
  return { label, keypair: Keypair.random(), keys: deriveKeys(randomScalar(), addrF) };
}
