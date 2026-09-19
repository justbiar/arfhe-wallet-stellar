/// <reference types="vitest/globals" />
import { Keypair, TransactionBuilder, Networks, Operation, Asset, Account, Memo, BASE_FEE } from '@stellar/stellar-sdk';
import { decodeTransactionXdr, stroopsToXlm } from '../StellarTxDecoder';

/**
 * @vitest-environment node
 *
 * Onay ekranının gördüğü şeyin doğru olduğunu doğrular.
 *
 * Buradaki testlerin çoğu "bilmediğini bilmek" üzerine: çözümleyici anlamadığı bir
 * operasyonu özetlemiyor, çünkü kullanıcı o özete bakıp imzalıyor. Yanlış bir özet,
 * özet olmamasından kötüdür.
 */

const PASS = Networks.TESTNET;
const SRC = 'GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6';
const DST = 'GBAW5XGWORWVFE2XTJYDTLDHXTY2Q2MO73HYCGB3XMFMQ562Q2W2GJQX';
const ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

function build(ops: ReturnType<typeof Operation.payment>[], memo?: Memo): string {
  let b = new TransactionBuilder(new Account(SRC, '1'), { fee: BASE_FEE, networkPassphrase: PASS });
  for (const op of ops) b = b.addOperation(op);
  if (memo) b = b.addMemo(memo);
  return b.setTimeout(60).build().toXDR();
}

describe('StellarTxDecoder', () => {
  it('ödemeyi tutar, varlık ve alıcıyla çözer', async () => {
    const xdr = build([Operation.payment({ destination: DST, asset: Asset.native(), amount: '12.5' })]);
    const d = await decodeTransactionXdr(xdr, PASS);
    expect(d.operations).toHaveLength(1);
    expect(d.operations[0].summary).toContain('12.5');
    expect(d.operations[0].summary).toContain('XLM');
    expect(d.operations[0].destination).toBe(DST);
    expect(d.unknownCount).toBe(0);
  });

  it('varlık koduyla gönderimde ihraççıyı da taşır', async () => {
    const xdr = build([Operation.payment({ destination: DST, asset: new Asset('USDC', ISSUER), amount: '5' })]);
    const d = await decodeTransactionXdr(xdr, PASS);
    expect(d.operations[0].assetCode).toBe('USDC');
    expect(d.operations[0].assetIssuer).toBe(ISSUER);
  });

  it('memo okunur — anchor akışında ödemeyi eşleştiren şey bu', async () => {
    const xdr = build(
      [Operation.payment({ destination: DST, asset: Asset.native(), amount: '1' })],
      Memo.text('TRMA-ABCD-1234')
    );
    const d = await decodeTransactionXdr(xdr, PASS);
    expect(d.memo).toEqual({ type: 'text', value: 'TRMA-ABCD-1234' });
  });

  it('memo yoksa null döner, boş string değil', async () => {
    const xdr = build([Operation.payment({ destination: DST, asset: Asset.native(), amount: '1' })]);
    expect((await decodeTransactionXdr(xdr, PASS)).memo).toBeNull();
  });

  it('hesap kapatma yükseltilmiş olarak işaretlenir ve açıkça söylenir', async () => {
    const xdr = build([Operation.accountMerge({ destination: DST }) as never]);
    const d = await decodeTransactionXdr(xdr, PASS);
    expect(d.operations[0].summary).toMatch(/HESAP KAPATILACAK/);
    expect(d.hasElevatedOperation).toBe(true);
  });

  it('hesap ayarı değişikliği yükseltilmiş sayılır', async () => {
    const xdr = build([Operation.setOptions({ homeDomain: 'evil.example' }) as never]);
    const d = await decodeTransactionXdr(xdr, PASS);
    expect(d.hasElevatedOperation).toBe(true);
  });

  it('güven hattı açmak ile kaldırmak ayrı anlatılır', async () => {
    const open = await decodeTransactionXdr(
      build([Operation.changeTrust({ asset: new Asset('USDC', ISSUER) }) as never]), PASS);
    const close = await decodeTransactionXdr(
      build([Operation.changeTrust({ asset: new Asset('USDC', ISSUER), limit: '0' }) as never]), PASS);
    expect(open.operations[0].summary).toMatch(/açılacak/);
    expect(close.operations[0].summary).toMatch(/kaldırılacak/);
  });

  it('anlaşılmayan operasyon uydurulmaz — summary null kalır ve sayılır', async () => {
    const xdr = build([Operation.bumpSequence({ bumpTo: '9999' }) as never]);
    const d = await decodeTransactionXdr(xdr, PASS);
    expect(d.operations[0].summary).toBeNull();
    expect(d.operations[0].type).toBe('bumpSequence'); // tip yine de gosterilir
    expect(d.unknownCount).toBe(1);
  });

  it('çok operasyonlu işlemde hepsi çözülür', async () => {
    const xdr = build([
      Operation.payment({ destination: DST, asset: Asset.native(), amount: '1' }),
      Operation.payment({ destination: DST, asset: new Asset('USDC', ISSUER), amount: '2' }),
    ]);
    const d = await decodeTransactionXdr(xdr, PASS);
    expect(d.operations).toHaveLength(2);
    expect(d.unknownCount).toBe(0);
  });

  it('mainnet passphrase reddedilir — parse etmek yetmez, acıkça bakmak gerekir', async () => {
    // fromXDR yanlis passphrase ile de basariyla parse ediyor; testnet imzasini mainnet
    // imzasindan ayiran tek sey birinin bakmasi. Bu yuzden kontrol acik.
    const xdr = build([Operation.payment({ destination: DST, asset: Asset.native(), amount: '1' })]);
    await expect(decodeTransactionXdr(xdr, Networks.PUBLIC)).rejects.toThrow(/desteklenmiyor/i);
  });

  it('uydurma bir passphrase de reddedilir', async () => {
    const xdr = build([Operation.payment({ destination: DST, asset: Asset.native(), amount: '1' })]);
    await expect(decodeTransactionXdr(xdr, 'Some Other Network')).rejects.toThrow(/desteklenmiyor/i);
  });

  it('ücret hem stroop hem XLM olarak verilir', async () => {
    const d = await decodeTransactionXdr(
      build([Operation.payment({ destination: DST, asset: Asset.native(), amount: '1' })]), PASS);
    expect(d.fee).toBe('100');
    expect(d.feeXlm).toBe('0.00001');
  });

  it('stroop çevrimi', () => {
    expect(stroopsToXlm('10000000')).toBe('1');
    expect(stroopsToXlm('100')).toBe('0.00001');
    expect(stroopsToXlm('abc')).toBe('0');
  });
});
