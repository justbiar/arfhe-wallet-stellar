/// <reference types="vitest/globals" />
import Account from '../Account';
import { getKeypair, getAddress, signTransactionXdr, forgetDerivedKeys, STELLAR_TESTNET_PASSPHRASE } from '../StellarService';

/**
 * @vitest-environment node
 *
 * StellarService — türetme, önbellek ve kilitleme davranışı.
 *
 * Buradaki asıl mesele anahtarın nerede YAŞAMADIĞI: diske yazılmıyor ve kilitlenince
 * bellekten düşüyor. İkisi de sessizce bozulabilecek özellikler, o yüzden testleri var.
 */

const PHRASE = 'illness spike retreat truth genius clock brain pass fit cave bargain toe';
// SEP-5 Test 1, m/44'/148'/0'
const EXPECTED = 'GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6';

function hdAccount(): Account {
  return Account.FromMnemonic(PHRASE, 'Test');
}

describe('StellarService', () => {
  beforeEach(() => forgetDerivedKeys());

  it('hesabın mevcut ifadesinden SEP-5 adresini türetir', async () => {
    expect(await getAddress(hdAccount())).toBe(EXPECTED);
  });

  it('aynı hesap için önbellekten aynı anahtarı verir', async () => {
    const a = hdAccount();
    const first = await getKeypair(a);
    const second = await getKeypair(a);
    expect(first).toBe(second); // aynı nesne — yeniden türetilmedi
  });

  it('kilitlendikten sonra önbellek boşalır', async () => {
    const a = hdAccount();
    const before = await getKeypair(a);
    forgetDerivedKeys();
    const after = await getKeypair(a);
    expect(after).not.toBe(before);          // yeni nesne
    expect(after!.publicKey()).toBe(before!.publicKey()); // ama aynı anahtar
  });

  it('ifadesi olmayan hesap için adres üretmez — uydurma adres vermez', async () => {
    const imported = Account.FromPrivateKey(
      '0x4c0883a69102937d6231471b5dbb6204fe512961708279f2e3b0a1f0f5b7b0b1',
      'Imported'
    );
    expect(await getAddress(imported)).toBeNull();
    expect(await getKeypair(imported)).toBeNull();
  });

  it('ifadesiz hesapla imzalamak sessizce başarısız olmaz, hata verir', async () => {
    const imported = Account.FromPrivateKey(
      '0x4c0883a69102937d6231471b5dbb6204fe512961708279f2e3b0a1f0f5b7b0b1',
      'Imported'
    );
    await expect(
      signTransactionXdr(imported, 'irrelevant', STELLAR_TESTNET_PASSPHRASE)
    ).rejects.toThrow(/kurtarma ifadesi yok/i);
  });

  it('bozuk XDR imzalanmaz', async () => {
    await expect(
      signTransactionXdr(hdAccount(), 'not-valid-xdr', STELLAR_TESTNET_PASSPHRASE)
    ).rejects.toThrow();
  });
});
