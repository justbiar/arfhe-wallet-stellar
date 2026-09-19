/// <reference types="vitest/globals" />
import {
  keypairFromMnemonic,
  stellarPathForIndex,
  isStellarAddress,
  normalizeMnemonicPhrase,
  STELLAR_DERIVATION_PATH,
} from '../StellarAccount';

/**
 * @vitest-environment node
 *
 * SEP-5 türetmesi, spec'in kendi test vektörlerine karşı doğrulanır.
 *
 * Bu testin varlık sebebi: yanlış bir türetme hata vermez. Geçerli görünen, başka bir
 * cüzdanla açılamayan bir hesap üretir ve oraya gönderilen para erişilemez hale gelir.
 * Vektörler SEP-5'in kendisinden alınmıştır.
 *
 * @see https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0005.md
 */

// SEP-5 "Test 1"
const PHRASE = 'illness spike retreat truth genius clock brain pass fit cave bargain toe';
const EXPECTED = [
  { index: 0, pub: 'GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6', sec: 'SBGWSG6BTNCKCOB3DIFBGCVMUPQFYPA2G4O34RMTB343OYPXU5DJDVMN' },
  { index: 1, pub: 'GBAW5XGWORWVFE2XTJYDTLDHXTY2Q2MO73HYCGB3XMFMQ562Q2W2GJQX', sec: 'SCEPFFWGAG5P2VX5DHIYK3XEMZYLTYWIPWYEKXFHSK25RVMIUNJ7CTIS' },
];

describe('StellarAccount — SEP-5 türetmesi', () => {
  for (const { index, pub, sec } of EXPECTED) {
    it(`m/44'/148'/${index}' resmi vektörle eşleşir`, async () => {
      const kp = await keypairFromMnemonic(PHRASE, index);
      expect(kp.publicKey()).toBe(pub);
      expect(kp.secret()).toBe(sec);
    });
  }

  it('aynı ifade her çağrıda aynı anahtarı verir', async () => {
    const a = await keypairFromMnemonic(PHRASE, 0);
    const b = await keypairFromMnemonic(PHRASE, 0);
    expect(a.publicKey()).toBe(b.publicKey());
  });

  it('farklı indeks farklı hesap üretir', async () => {
    const a = await keypairFromMnemonic(PHRASE, 0);
    const b = await keypairFromMnemonic(PHRASE, 1);
    expect(a.publicKey()).not.toBe(b.publicKey());
  });

  it('BIP-39 passphrase farklı bir hesap üretir — cüzdan parolasıyla karıştırılmamalı', async () => {
    const plain = await keypairFromMnemonic(PHRASE, 0);
    const withPass = await keypairFromMnemonic(PHRASE, 0, 'p4ssphrase');
    expect(withPass.publicKey()).not.toBe(plain.publicKey());
  });

  it('geçersiz ifade sessizce bir hesap üretmez, hata verir', async () => {
    await expect(keypairFromMnemonic('bunlar gecerli bip39 kelimeleri degil')).rejects.toThrow(/geçersiz/i);
  });

  it('kopyalanan ifadedeki fazla boşluk ve satır sonu tolere edilir', async () => {
    const messy = `  ${PHRASE.replace(/ /g, '  ')}\n`;
    const kp = await keypairFromMnemonic(messy, 0);
    expect(kp.publicKey()).toBe(EXPECTED[0].pub);
  });
});

describe('StellarAccount — yardımcılar', () => {
  it('varsayılan yol SEP-5 ile aynı', () => {
    expect(STELLAR_DERIVATION_PATH).toBe("m/44'/148'/0'");
    expect(stellarPathForIndex(0)).toBe(STELLAR_DERIVATION_PATH);
  });

  it('her seviye hardened — kesme işareti düşerse başka anahtar türer', () => {
    expect(stellarPathForIndex(3)).toBe("m/44'/148'/3'");
  });

  it('negatif veya ondalık indeks reddedilir', () => {
    expect(() => stellarPathForIndex(-1)).toThrow();
    expect(() => stellarPathForIndex(1.5)).toThrow();
  });

  it('adres doğrulaması sağlamayı da kontrol eder', () => {
    expect(isStellarAddress(EXPECTED[0].pub)).toBe(true);
    // Son karakteri değiştirmek sağlamayı bozar; uzunluk ve alfabe hâlâ doğru.
    const corrupted = EXPECTED[0].pub.slice(0, -1) + (EXPECTED[0].pub.endsWith('6') ? '7' : '6');
    expect(isStellarAddress(corrupted)).toBe(false);
  });

  it('gizli anahtar adres sanılmaz', () => {
    expect(isStellarAddress(EXPECTED[0].sec)).toBe(false);
    expect(isStellarAddress('')).toBe(false);
    expect(isStellarAddress('0x742d35Cc6634C0532925a3b844Bc454e4438f44e')).toBe(false);
  });

  it('normalize yalnızca boşluğa dokunur, harf durumuna dokunmaz', () => {
    expect(normalizeMnemonicPhrase('  a   b \n c ')).toBe('a b c');
    expect(normalizeMnemonicPhrase('Abandon About')).toBe('Abandon About');
  });
});
