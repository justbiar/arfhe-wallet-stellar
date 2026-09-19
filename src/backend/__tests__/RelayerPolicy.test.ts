/// <reference types="vitest/globals" />
import { nativeToScVal, Address } from '@stellar/stellar-sdk';
import {
  inspectPayload, assertFeeWithinCap, RelayRefused, MAX_ARG_B64, MAX_FEE_STROOPS,
  // Düz JS bir servis, ama `allowJs` açık olduğu için tipler çıkarımla geliyor —
  // yani bu import tip kontrolünden muaf değil, olmamalı da.
} from '../../../relayer/policy.mjs';
import realTransfer from '../../../relayer/fixtures-transfer.json';

/**
 * @vitest-environment node
 *
 * Relayer'ın neyi taşıyıp neyi reddettiği.
 *
 * Buradaki en önemli test depozito reddi. Havuzun `transact` fonksiyonu depozitoyu
 * `token.transfer(sender, pool, amount)` ile fonluyor ve `sender` gönderen kişi —
 * yani relayer. Bir depozito yükünü taşımak, başkasının parasını bizim cebimizden
 * yatırmak demek. Üstelik depozito zaten açık, yani satın alınacak bir gizlilik de yok.
 *
 * `fixtures-transfer.json` uydurma değil: gerçek `spp` CLI'ın testnet için ürettiği,
 * gönderilmemiş bir transfer yükü. Ayrıştırıcımızın gerçek istemcinin ürettiği şeyle
 * eşleştiğini uydurma veriyle kanıtlayamayız.
 */

const POOL = 'CCM5G4FCOV7PLKFMEJBCYM5R7JOTZVUXKWBDR3SWCW2IM2LKNNBO4TH5';
const OTHER_POOL = 'CBPWCM2VR6MYVN77V4BXG4YIDJOEMNFB6OU7EBGNRYXK5FORVC72Z4CY';
const G_ADDRESS = 'GCUEUEYLDCBNMJ4QWHFKZPEN5RH46NBH75NRAHOS47MQMPUBCIMNT3Y4';
const allowed = { allowedPools: [POOL] };

/** An ExtData ScVal shaped like the contract's, with a chosen amount and recipient. */
function extData(amount: bigint, recipient = POOL): string {
  return nativeToScVal(
    {
      recipient: new Address(recipient),
      ext_amount: amount,
      encrypted_output0: Buffer.alloc(120, 1),
      encrypted_output1: Buffer.alloc(120, 2),
    },
    { type: { ext_amount: ['symbol', 'i256'] } }
  ).toXDR('base64');
}

/** The proof argument is never interpreted by the policy — only decoded. */
const anyProof = nativeToScVal({ public_amount: 0n }, { type: { public_amount: ['symbol', 'i256'] } })
  .toXDR('base64');

describe('relayer policy', () => {
  it('gerçek CLI yükünü çözer ve transfer olarak tanır', () => {
    const got = inspectPayload(realTransfer, allowed);
    expect(got.kind).toBe('transfer');
    expect(got.extAmount).toBe(0n);
    // Transferde alıcı havuzun kendisi; kullanıcının adresi yükte hiç geçmiyor.
    expect(got.recipient).toBe(POOL);
  });

  it('DEPOZİTOYU REDDEDER — yoksa token relayer cebinden çekilir', () => {
    expect(() => inspectPayload({ pool: POOL, proof: anyProof, extData: extData(1n) }, allowed))
      .toThrow(RelayRefused);
    try {
      inspectPayload({ pool: POOL, proof: anyProof, extData: extData(100_000_000n) }, allowed);
      throw new Error('kabul edilmemeliydi');
    } catch (e) {
      expect((e as { code: string }).code).toBe('deposit_rejected');
    }
  });

  it('çekimi taşır — ödeme havuzdan çıkar, relayer yalnızca ücreti öder', () => {
    const got = inspectPayload(
      { pool: POOL, proof: anyProof, extData: extData(-30_000_000n, G_ADDRESS) },
      allowed
    );
    expect(got.kind).toBe('withdraw');
    expect(got.extAmount).toBe(-30_000_000n);
    expect(got.recipient).toBe(G_ADDRESS);
  });

  it('listede olmayan havuzu reddeder', () => {
    try {
      inspectPayload({ pool: OTHER_POOL, proof: anyProof, extData: extData(0n) }, allowed);
      throw new Error('kabul edilmemeliydi');
    } catch (e) {
      expect((e as { code: string }).code).toBe('pool_not_allowed');
    }
  });

  it('havuz kimliği biçimsizse çözmeye bile kalkışmaz', () => {
    expect(() => inspectPayload({ pool: 'not-a-contract', proof: anyProof, extData: extData(0n) }, allowed))
      .toThrow(/contract id/);
  });

  it('bozuk ve aşırı büyük argümanları reddeder', () => {
    expect(() => inspectPayload({ pool: POOL, proof: 'zzz!!!', extData: extData(0n) }, allowed))
      .toThrow(/valid ScVal/);
    expect(() => inspectPayload({ pool: POOL, proof: 'A'.repeat(MAX_ARG_B64 + 1), extData: extData(0n) }, allowed))
      .toThrow(/too large/);
    expect(() => inspectPayload({ pool: POOL, proof: anyProof, extData: undefined }, allowed))
      .toThrow(/missing/);
  });

  it('beklenen alanları taşımayan extData reddedilir', () => {
    const noAmount = nativeToScVal({ recipient: new Address(POOL) }).toXDR('base64');
    expect(() => inspectPayload({ pool: POOL, proof: anyProof, extData: noAmount }, allowed))
      .toThrow(/ext_amount/);

    const noCiphertexts = nativeToScVal(
      { recipient: new Address(POOL), ext_amount: 0n },
      { type: { ext_amount: ['symbol', 'i256'] } }
    ).toXDR('base64');
    expect(() => inspectPayload({ pool: POOL, proof: anyProof, extData: noCiphertexts }, allowed))
      .toThrow(/encrypted_output0/);
  });

  it('ücret tavanı: ölçülen ~180k geçer, tavanın üstü geçmez', () => {
    expect(assertFeeWithinCap('180479')).toBe(180_479n);
    expect(assertFeeWithinCap(String(MAX_FEE_STROOPS))).toBe(BigInt(MAX_FEE_STROOPS));
    try {
      assertFeeWithinCap(String(MAX_FEE_STROOPS + 1));
      throw new Error('kabul edilmemeliydi');
    } catch (e) {
      expect((e as { code: string }).code).toBe('fee_too_high');
    }
  });
});
