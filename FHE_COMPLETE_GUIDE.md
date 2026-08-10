# ArfheWallet — FHE (Fully Homomorphic Encryption) Tam Rehber

> Bu rehber `@cofhe/sdk` + `fhenix-confidential-contracts` mimarisini anlatır.
> Önceki `cofhejs` + elle yazılmış `WrappedETH_V4` mimarisi terk edilmiştir;
> eski sözleşmeler `contracts/legacy/` altında yalnızca referans olarak durur ve
> yeni koprosesörle **uyumlu değildir**.

---

## İÇİNDEKİLER

1. [Genel Mimari](#1-genel-mimari)
2. [Kütüphaneler ve Versiyonlar](#2-kütüphaneler-ve-versiyonlar)
3. [Dosya Haritası](#3-dosya-haritası)
4. [Akıllı Kontratlar](#4-akıllı-kontratlar)
5. [İstemci Servisi (FheCofheService)](#5-istemci-servisi-fhecofheservice)
6. [Network.ts — FHE Fonksiyonları](#6-networkts--fhe-fonksiyonları)
7. [Birim Sistemi ve Ondalıklar](#7-birim-sistemi-ve-ondalıklar)
8. [Deploy](#8-deploy)
9. [Sık Karşılaşılan Hatalar](#9-sık-karşılaşılan-hatalar)
10. [Doğrulama](#10-doğrulama)

---

## 1. Genel Mimari

CoFHE bir **koprosesör** mimarisidir. Şifreli veri zincirde tutulmaz; zincirde yalnızca
`ctHash` denen bir **tutamaç (handle)** bulunur. Gerçek şifreli metin ve FHE hesaplaması
zincir dışındaki CoFHE ağındadır.

```
┌────────────┐   encryptInputs    ┌──────────────┐
│  Cüzdan    │ ─────────────────► │  ZK Verifier │  (imzalı InEuint64 döner)
│ (@cofhe/   │                    └──────────────┘
│   sdk)     │                            │
│            │   tx (InEuint64)           ▼
│            │ ─────────────────► ┌──────────────┐    ┌───────────────┐
│            │                    │  FHERC20     │───►│  TaskManager  │
│            │                    │  Wrapper     │    │  (koprosesör) │
│            │ ◄───────────────── │  (euint64    │    └───────────────┘
│            │   ctHash (bytes32) │   handle)    │            │
│            │                    └──────────────┘            ▼
│            │   decryptForView / decryptForTx      ┌───────────────────┐
│            │ ◄───────────────────────────────────►│ Threshold Network │
└────────────┘                                      └───────────────────┘
```

**Üç temel işlem:**

| İşlem | Adım sayısı | Neden |
|---|---|---|
| **Shield** (açık → şifreli) | 1 tx | Senkron; miktar zaten açıkta |
| **Confidential transfer** | 1 tx | Miktar istemcide şifrelenir |
| **Unshield** (şifreli → açık) | **2 tx** | Şifre çözme zincir dışında olduğu için asenkron |

### Unshield neden iki aşamalı?

```
unshield(from, to, amount)
   └─► şifreli bakiye yakılır
   └─► FHE.allowPublic(burned)   → yakılan tutamaç herkese açık çözülebilir olur
   └─► claim (talep) kaydı açılır ; tokenlar HENÜZ serbest DEĞİL

        ▼ zincir dışı
decryptForTx(ctHash).withoutPermit()
   └─► { decryptedValue, signature }   (Threshold Network imzası)

        ▼
claimUnshielded(ctHash, decryptedValue, signature)
   └─► kontrat imzayı FHE.verifyDecryptResult ile doğrular
   └─► underlying tokenlar serbest bırakılır
```

Kullanıcı ilk tx'i atıp ikinciyi atmazsa bakiyesi yanmış ama tokenları kilitli kalır.
Bu yüzden hem `ShieldPanel` hem `Privacy` sayfası **bekleyen talepleri** listeler.

---

## 2. Kütüphaneler ve Versiyonlar

### Frontend (`package.json`)

| Paket | Versiyon | Rol |
|---|---|---|
| `@cofhe/sdk` | `^0.5.2` | Şifreleme, çözme, permit yönetimi |
| `viem` | `^2` | SDK'nın konuştuğu istemci tipi |
| `ethers` | `^6` | Cüzdanın kendi hesap katmanı |

`@cofhe/sdk` yalnızca viem ile çalışır. Cüzdan ethers v6 kullandığı için
`Ethers6Adapter` köprü görevi görür — hesap yönetimi olduğu yerde kalır.

### Kontrat (`deploy/package.json`)

| Paket | Versiyon | Rol |
|---|---|---|
| `@fhenixprotocol/cofhe-contracts` | `0.1.3` | `FHE.sol`, `euint64`, `InEuint64` |
| `fhenix-confidential-contracts` | `0.3.1` | `FHERC20` ve wrapper'lar |
| `@openzeppelin/contracts` | `^5.2.0` | ERC20 / SafeERC20 / SafeCast |
| Solidity | `0.8.25` | `evmVersion: cancun` |

> **Kritik:** `0.0.14` → `0.1.3` geçişinde `euint64` tipi `uint256`'dan **`bytes32`**'e
> döndü. ABI kodlaması değiştiği için eski kontratlarla yeni istemci konuşamaz.

### Desteklenen ağlar

CoFHE koprosesörü **yalnızca** şu üç ağda çalışır:

| Ağ | chainId |
|---|---|
| Sepolia | `11155111` |
| Arbitrum Sepolia | `421614` |
| Base Sepolia | `84532` |

Bu liste `FheCofheService.COFHE_CHAIN_IDS` ve `Network.isFheCapable()` içinde
zorlanır. Başka ağda FHE çağrısı yapılmaz.

---

## 3. Dosya Haritası

| Dosya | Sorumluluk |
|---|---|
| `contracts/ArfheShieldedETH.sol` | `FHERC20NativeWrapper` mirasçısı — ETH/WETH kalkanı |
| `contracts/ArfheShieldedERC20.sol` | `FHERC20ERC20Wrapper` mirasçısı — USDC vb. |
| `contracts/legacy/` | Terk edilmiş V1–V4 sözleşmeleri (yalnızca referans) |
| `deploy/scripts/deploy-shielded.js` | Üç testnet için tek deploy scripti |
| `src/backend/FheCofheService.ts` | SDK yaşam döngüsü, şifreleme, çözme, permit |
| `src/backend/Network.ts` | Zincir çağrıları (`--- FHE / CONFIDENTIAL TOKEN METHODS ---`) |
| `src/types/fhe.ts` | `ShieldedTokenMeta`, `UnshieldClaim` |
| `src/components/panels/ShieldPanel.tsx` | Shield / unshield / claim akışı |
| `src/components/panels/SendPanel.tsx` | Gizli transfer |
| `src/pages/Privacy.tsx` | Şifreli bakiye paneli ve bekleyen talepler |
| `src/components/panels/shared.tsx` | Ağ bazlı kontrat adresleri |

---

## 4. Akıllı Kontratlar

Sözleşmeler denetlenmiş `fhenix-confidential-contracts` wrapper'larını miras alır;
shield/unshield/claim/transfer mantığı elle yazılmaz.

```solidity
contract ArfheShieldedETH is FHERC20NativeWrapper {
    constructor(IWETH weth_)
        FHERC20("Arfhe Shielded ETH", "aeETH", 6, "")
        FHERC20NativeWrapper(weth_)
    {}
}
```

### Kullanılan fonksiyonlar (ABI)

| İmza | Selector | Not |
|---|---|---|
| `shieldNative(address to)` | `0x759ded8c` | payable, native wrapper |
| `shieldWrappedNative(address to, uint256 value)` | `0x49ea576e` | WETH girişi |
| `shield(address to, uint256 amount)` | `0x8f214a33` | ERC20 wrapper, önce `approve` |
| `unshield(address from, address to, uint64 amount)` | `0x4ccac778` | yakar + talep açar |
| `claimUnshielded(bytes32, uint64, bytes)` | `0xcdc75a80` | talebi kapatır |
| `confidentialTransfer(address,(uint256,uint8,uint8,bytes))` | `0xa794ee95` | `InEuint64` |
| `confidentialBalanceOf(address)` | — | `bytes32` handle döner |
| `getUserClaims(address)` | — | yalnızca **bekleyen** talepler |
| `setOperator(address, uint48)` | `0xd4febb96` | süreli tam yetki |

Bu selector'lar `TransactionSimulator` içinde kayıtlıdır; imza öncesi kullanıcıya
ne olacağı gösterilir.

### İki davranışsal tuzak

**Sıfır ile değiştirme (zero-replacement):** Bakiyeden fazlasını göndermek/unshield
etmek **revert etmez** — şifreli sıfır işlenir. Bakiye sızdırmamak için böyle
tasarlanmıştır. Sonuç: işlem başarılı görünür ama hiçbir şey taşınmamış olabilir.

Bu yüzden `Network.assertSufficientShieldedBalance` her gizli transfer ve unshield
öncesinde bakiyeyi çözüp karşılaştırır; fazla miktar işlem gönderilmeden reddedilir.
Bu kontrol isteğe bağlı değildir — kaldırılırsa kullanıcı sessizce sıfır gönderir.

**Operatör yetkisi miktar bazlı değildir:** `setOperator` süre dolana kadar bakiyenin
**tamamına** yetki verir. Kısa süre ve yalnızca güvenilen adres.

---

## 5. İstemci Servisi (FheCofheService)

Singleton. Yaşam döngüsü:

```ts
const config = createCofheConfig({
  supportedChains: [chains.sepolia, chains.arbSepolia, chains.baseSepolia],
});
const client = createCofheClient(config);

const { publicClient, walletClient } = await Ethers6Adapter(provider, signer);
await client.connect(publicClient, walletClient);
```

`connect` **hiçbir imza istemez** ve ağdan anahtar çekmez. TFHE WASM ve FHE anahtarları
ilk `encryptInputs` çağrısına kadar ertelenir. Bu yüzden `Home.tsx` açılışta bağlanabilir.

### Şifreleme

```ts
const encrypted = await service.encryptUint64(amountValue);
// { ctHash, securityZone, utype, signature }
```

Üretilen girdi **hesap + chainId** çiftine bağlıdır; başka hesapla veya ağda kullanılamaz.
Bu nedenle `isReadyForAccount(address, networkId)` uyuşmazlığında yeniden bağlanılır.

### İki farklı çözme

| | `decryptForView` | `decryptForTx` |
|---|---|---|
| Amaç | Ekranda göstermek | Zincirde kanıtlamak |
| Permit | **Zorunlu** | Genelde gerekmez (`withoutPermit`) |
| Dönüş | `bigint` | `{ decryptedValue, signature }` |
| Kullanım | Bakiye görüntüleme | `claimUnshielded` |

Bunlar birbirinin yerine kullanılamaz: `decryptForView` çıktısının zincirde doğrulanabilir
imzası yoktur.

### Permit

EIP-712 imzası, varsayılan **7 gün** geçerli, `localStorage`'da (`cofhesdk-permits`)
saklanır ve `chainId + account` ile anahtarlanır. `ensurePermit()` yalnızca gerektiğinde
imza ister.

> Saklanan permit **sealing private key** içerir. `PermitUtils.export()` bunu temizler;
> `serialize()` çıktısı asla paylaşılmamalıdır.

### Kilitlenme

`reset()` bağlantıyı, istemciyi ve permit bayrağını düşürür. Permit'ler kasıtlı olarak
diskte bırakılır — her kilit açılışında yeniden imza istemek kullanıcıya düşmanca olurdu.
Cüzdan silinirken temizlemek `StorageManager`'ın işidir.

---

## 6. Network.ts — FHE Fonksiyonları

| Metot | Girdi birimi | Açıklama |
|---|---|---|
| `getShieldedBalance(contract, user, account)` | — | `confidentialBalanceOf` → `decryptForView` |
| `shieldNative(account, contract, amount)` | ETH (18) | tek tx |
| `shieldERC20(account, underlying, contract, amount)` | underlying ondalığı | approve bekler, sonra shield |
| `unshield(account, contract, amount)` | **gizli (6)** | yakar + talep açar |
| `getPendingClaims(contract, user)` | — | permit gerektirmez, düz `eth_call` |
| `claimUnshielded(account, contract, ctHash)` | — | `decryptForTx` + tx |
| `transferConfidential(account, contract, to, amount)` | **gizli (6)** | `encryptInputs` + tx |
| `getShieldedPortfolio(account)` | — | hesabın **tüm** gizli varlıkları (aşağıya bakın) |
| `getWrapperFor` / `createWrapperFor` | — | fabrika kaydından çözme / yeni sarmalayıcı |

**Sıfır bakiye hata değildir.** Hiç shield yapmamış hesapta ciphertext yoktur;
`CiphertextNotFoundError` yakalanıp `"0.0"` döndürülür. Diğer hatalar yukarı fırlar.

`decimals()` ve `rate()` kontrattan okunup `shieldedMetaCache`'te tutulur —
adres bazlı sabit kodlanmış ondalık tahmini yoktur.

### Gizli varlık keşfi — neden zincirden okunur

`getShieldedPortfolio` cüzdanın **tek** gizli bakiye kaynağıdır; Ana Sayfa, Gönder ve
Kalkan ekranlarının üçü de onu kullanır.

Sıra:

1. `ArfheWrapperFactory.wrapperCount()` + `wrappersAt()` → kayıttaki tüm sarmalayıcılar
   (sayfalama tek bir toplu istekte gider)
2. `.env`'deki yerleşik adresler birleştirilir
3. Her biri için `confidentialBalanceOf(user)` — **tek toplu istek**
4. Tutamacı sıfır olmayanlar (+ her zaman yerleşik ETH) tutulur
5. `symbol / decimals / rate / underlying` tek toplu istekte okunur
6. Yalnızca kalanlar `decryptForView` ile çözülür

İki kural bu tasarımın sebebidir:

- **Keşif, açık bakiyeden türetilemez.** Kullanıcı bakiyesinin tamamını kalkanlarsa açık
  bakiyesi sıfır olur; "elindeki tokenlardan" yola çıkan bir liste, tam da paranın orada
  olduğu anda o sarmalayıcıyı gözden kaybeder. Eskiden bu yüzden fabrika ile kalkanlanan
  bir ERC-20'nin bakiyesi hiçbir ekranda görünmüyor, dolayısıyla gizli gönderi de
  yapılamıyordu.
- **Sabit adres listesi bayatlar.** Kontratlar yeniden dağıtıldığında eski sarmalayıcılar
  listeden düşer ve `balanceOf` göstergesini (~7984) gerçek bakiye gibi sızdırırlar.
  Tespit bu yüzden standardın kendi kancasıyla yapılır: `balanceOfIsIndicator()`.

Kayıt izinsizdir, yani boyutu sınırsız büyüyebilir. Sayfalama **baştan** okur (sondan
değil): aksi halde herhangi biri yeni sarmalayıcı üreterek kullanıcının kendi
sarmalayıcısını pencerenin dışına itebilir ve bakiyesini cüzdandan yok edebilirdi.

### Bir token = bir sarmalayıcı (ihlal edilirse para bölünür)

Her sarmalayıcı **kendi teminat havuzunu** tutar. Aynı token için iki sarmalayıcı varsa
birinden kalkanlanan bakiye yalnızca o kontrattan çıkarılabilir; ikisi de aynı sembolle
(`aeUSDC`) görünür ve kullanıcı ayırt edemez.

Kanonik sarmalayıcı **her zaman** `factory.wrapperFor(underlying)`'dir. Kurallar:

- Deploy scripti USDC sarmalayıcısını **fabrika üzerinden** üretir, elle değil. Elle
  dağıtılan sarmalayıcı kayda girmez; kalkanlamayı ilk etkinleştiren kullanıcı fabrikaya
  ikinci bir tane ürettirir.
- `shieldERC20`, hedef sarmalayıcı kanonik değilse **işlemi reddeder**. Bu, arayüz ne
  gönderirse göndersin geçerli bir kilittir.
- Aşılmış sarmalayıcılar keşifte kalır (`isLegacy: true`) — bakiye görünür ve çıkarılabilir
  olmalı, yoksa para mahsur kalır — ama asla kalkanlama hedefi olamaz.
- `npm run verify:discovery` her token için tek sarmalayıcı olduğunu doğrular ve değilse
  hangi adresin kanonik olduğunu, havuzlarda ne kadar durduğunu yazarak başarısız olur.

### Toplu talep — `claimUnshieldedBatch`

Bir kullanıcı unshield sırasında birkaç kez kesintiye uğrarsa birden fazla talep birikir.
Kütüphane bunları tek işlemde kapatır; kuyruk `drainGrouped` ile token başına gruplar ve
`claimUnshieldedMany` tek `claimUnshieldedBatch` çağrısı atar.

Zincirde toplu işlem **atomiktir**: bir kanıt geçersizse hepsi geri döner. Bu yüzden
kanıtlar gönderimden önce tek tek doğrulanır ve başarısız bir grubun **tüm** talepleri
kuyrukta kalır — biri kapanmış gibi işaretlenemez.

### RPC bayatlığı — makbuz yeterli değildir

Base Sepolia (ve zaman zaman diğerleri) makbuz düştükten sonra birkaç saniye boyunca
**işlem öncesi duruma** cevap verir. Bu, sessiz para kaybına yol açabilecek üç yerde
açıkça beklenir:

| Yer | Belirti | Çözüm |
|---|---|---|
| `shieldERC20` | approve onaylandı ama `shield` "exceeds allowance" ile döner | allowance görünene kadar bekle |
| `createWrapperFor` | Dağıtılan sarmalayıcı `address(0)` okunur, "etkin değil" denir | kayıtta görünene kadar bekle |
| `unshieldAndClaim` | Talep henüz görünmez, yakılan bakiye askıda kalır | talep listesi dolana kadar bekle |

---

## 7. Birim Sistemi ve Ondalıklar

Şifreli bakiye `euint64`'tür, taşmayı önlemek için gizli katman **en fazla 6 ondalık**
kullanır.

```
rate = 10 ^ (underlyingDecimals - 6)        // 18 ondalıklı ETH için 1e12
underlyingAmount = confidentialAmount * rate
```

| Katman | ETH | USDC |
|---|---|---|
| Underlying ondalık | 18 | 6 |
| Gizli ondalık | 6 | 6 |
| `rate()` | `1e12` | `1` |

Shield sırasında `rate`'in tam katı olmayan artık **kırpılır** (native wrapper'da iade
edilir). `1.5000005 ETH` shield edilirse yalnızca `1.5 ETH` kalkanlanır.

> Eski `WrappedETH_V4`'teki gerçek hata buydu: `uint64(msg.value)` ile 18 ondalıklı wei
> doğrudan `uint64`'e sıkıştırılıyordu ve ~18.4 ETH üzerinde taşıyordu. Wrapper'ın
> rate normalizasyonu bu sınıfı tamamen ortadan kaldırır.

---

## 8. Deploy

`.env` içine (asla commit etmeyin):

```
DEPLOYER_PRIVATE_KEY=0x...
```

```bash
cd deploy
npm install
npm run compile

npm run deploy:sepolia    # veya deploy:arb / deploy:base
```

Script underlying adresleri `.env`'den okur, dağıtır ve `.env`'e yapıştırılacak
satırları basar:

```
VITE_WRAPPED_ETH_ADDRESS=0x...
VITE_WRAPPED_USDC_ADDRESS=0x...
```

Ayrıca doğrulama için `rate()` ve `decimals()` değerlerini yazdırır.

---

## 9. Sık Karşılaşılan Hatalar

| Belirti | Sebep | Çözüm |
|---|---|---|
| `Ciphertext not found` | Hesap hiç shield yapmamış | Normal; `0.0` gösterilir |
| Permit 403 / `Permit is expired` | 7 gün dolmuş | `ensurePermit()` yeniden imzalatır |
| `InvalidSigner` | Şifreleme farklı hesap/ağ ile yapılmış | `isReadyForAccount` uyuşmazlığında reconnect |
| Unshield sonrası token gelmedi | `claimUnshielded` atılmamış | Bekleyen talebi claim'leyin |
| `Insufficient shielded balance` | Bakiyeden fazla göndermeye çalıştınız | Guard işlemi engelledi; miktarı düşürün |
| `Amount is below the confidential precision limit` | Miktar bir gizli birimden küçük | En az `rate()` kadar gönderin |
| `Decryption proof failed verification` | Kanıt zincir öncesi doğrulamayı geçemedi | Claim'i tekrar deneyin |
| FHE fonksiyonları çalışmıyor | Desteklenmeyen ağ | Sepolia / Arb Sepolia / Base Sepolia |
| Kalkanlanan ERC-20 cüzdanda görünmüyor | Keşif fabrika kaydını okumuyordu | `getShieldedPortfolio` — düzeltildi |
| Aynı sembolden iki satır (ör. iki `aeUSDC`) | Token için iki sarmalayıcı var | Kanonik olan fabrikanınki; eskisi `(eski)` etiketiyle çıkarılabilir |
| "Bu tokenın gizli kontratı değişti" | Aşılmış sarmalayıcıya kalkanlama denendi | Kalkan ekranını yeniden açın |
| `transfer amount exceeds allowance` (approve onaylıyken) | RPC işlem öncesi duruma cevap veriyor | allowance görünene kadar beklenir |

---

## 10. Doğrulama

Üçü de gerçek ağlara karşı çalışır, mock yoktur. `DEPLOYER_PRIVATE_KEY` gerektirir.

```bash
npm run verify:discovery -- all           # salt-okunur: gizli varlık keşfi
npm run verify:fhe -- sepolia             # yerel ETH: shield → transfer → unshield → claim
npm run verify:fhe:erc20 -- base          # keyfi ERC-20: aynı döngü + createWrapper
npm run audit:privacy -- <hedefAdres>     # üçüncü taraf gözüyle sızıntı denetimi
```

`audit:privacy` varsayılan olarak **rastgele üretilmiş, fonsuz** bir saldırgan
kullanır — permitler EIP-712 imzası olduğu için gaz gerekmez. Hedef ile saldırganın
aynı hesap olması reddedilir: hesabın kendi bakiyesini çözebilmesi sızıntı değil,
tasarımın kendisidir.

---

## Kaynaklar

- CoFHE dokümantasyonu: <https://cofhe-docs.fhenix.zone/>
- Uyumluluk matrisi: <https://cofhe-docs.fhenix.zone/get-started/introduction/compatibility>
- cofhejs → @cofhe/sdk geçişi: <https://cofhe-docs.fhenix.zone/client-sdk/introduction/migrating-from-cofhejs>
- FHERC20 wrapper'ları: <https://cofhe-docs.fhenix.zone/fhe-library/confidential-contracts/fherc20/fherc20-wrapper>
