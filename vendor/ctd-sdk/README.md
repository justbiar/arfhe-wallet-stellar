# `vendor/ctd-sdk` — Confidential Token istemcisi

Bu dizin **bizim yazdığımız kod değil.** Olduğu gibi kopyalandı:

- Kaynak: https://github.com/brozorec/stellar-confidential-token-demo
- Yol: `packages/sdk` (kaynak) ve `packages/sdk/circuits` (derlenmiş ACIR devreleri)
- Commit: `9500ed774b13b08b5fe99370b60de3479edb492b`
- Lisans: MIT (üst deponun `README.md` §License)
- Kopyalanma tarihi: 2026-09-19

## Neden kopyalandı

`@ctd/sdk` **npm'de yayınlanmıyor.** Tek dağıtım kanalı o depo. Bir bağımlılık olarak
kurulamadığı için, kullanmanın yolu kaynağı içeri almak.

Boyutu buna izin veriyor: 41 TypeScript dosyası (~228 KB) ve ACIR devreleri (~224 KB).
UltraHonk'un devre başına büyük bir kanıtlama anahtarı yok — o, SPP'nin Groth16 tarafının
sorunuydu (83 MB).

## Tek değişiklik: stellar-sdk sürümü

`src/chain/` altındaki **altı dosyada** import yolu değişti:

```
- from "@stellar/stellar-sdk"
+ from "ctd-stellar-sdk"
```

`ctd-stellar-sdk`, `package.json`'da `@stellar/stellar-sdk@14.6.1`'e takma ad. Sebep:
cüzdan 17.1.0 kullanıyor ve ScVal API'si arada değişmiş — `retval.bytes()` 17'de yok,
çalışma anında patlıyor. İki sürümü yan yana tutmak, kripto katmanını yeniden yazmaktan
iyi.

Bu değişiklik `sed` ile tekrarlanabilir:

```bash
sed -i '' 's|from "@stellar/stellar-sdk"|from "ctd-stellar-sdk"|g' vendor/ctd-sdk/src/chain/*.ts
```

**Başka hiçbir dosyaya dokunulmadı.** Bir hata bulunursa **upstream'e** bildirilmeli;
burada yamalamak, bir sonraki kopyalamada sessizce kaybolan bir düzeltme demektir.

## Sürüm kilitleri

Kripto katmanı `@noble`'ın 1.x'ine bağlı; 2.x `./abstract/weierstrass` alt yolunu artık
dışa vermiyor ve import çözülmüyor. Kök `package.json` bu yüzden `@noble/curves@1.9.7` ve
`@noble/hashes@1.8.0` sabitliyor — demo deposundaki sürümlerin aynısı.

## Doğrulandı

`payroll/smoke.ts` bu katmanın kök depodan çalıştığını gösteriyor: `addr_f` hesabı
zincirdeki kontratın değeriyle eşleşiyor (`0x1d003665…`), denetçi anahtarı okunuyor.

## Bağımlılıkları

`@aztec/bb.js`, `@noir-lang/noir_js`, `@noble/curves`, `@noble/hashes`,
`@zkpassport/poseidon2`, `@stellar/stellar-sdk` — kök `package.json`'a eklendi.

**`bb.js` paketleyiciye sokulmamalı.** Kendi Web Worker'ını `new Worker(new URL(...))`
ile açıyor; hash'lenmiş bir chunk'a gömüldüğünde worker bulunamıyor ve kanıt üretimi
sessizce asılı kalıyor (bkz. `stellar.md` §5.5).
