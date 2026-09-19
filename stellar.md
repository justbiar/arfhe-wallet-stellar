# Stellar — durum ve devir teslim

> Son güncelleme: 2026-09-19, `arfhe-stellar` branch.
> Bu dosya Stellar tarafının nerede olduğunu anlatır. İddiaların hangisinin **ölçülmüş**,
> hangisinin **varsayım** olduğu açıkça ayrılmıştır.

---

## 1. Özet

Cüzdana Stellar desteği ekleniyor. Nihai hedef **confidential transfer**: zincirde bir
hareket olduğu görünsün, **miktar görünmesin**. Bugün gelinen yer, o hedefin altyapısı —
hesap türetme, bakiye, imzalama ve fiat köprüsü çalışıyor; gizlilik katmanı henüz yok.

Bağımlılıklar: `@stellar/stellar-sdk` 17.1.0, `ed25519-hd-key` 2.0.0.
Ağ: **yalnızca Stellar testnet**. Mainnet passphrase'i kod tarafından reddediliyor.

---

## 2. Çalışan ve doğrulanmış olanlar

### 2.1 Hesap türetme — `src/backend/StellarAccount.ts`

Cüzdanın **mevcut kurtarma ifadesinden** SEP-5 yoluyla (`m/44'/148'/n'`) Stellar hesabı
türetiyor. Kullanıcıya ikinci bir 12 kelime yazdırılmıyor.

- BIP-39 `ethers`'tan geliyor (cüzdan zaten bağımlı), ed25519 SLIP-10 türetmesi
  `ed25519-hd-key`'den. `bip39` paketi **bilerek kurulmadı** — aynı işi yapan iki kütüphane,
  "geçerli ifade nedir" konusunda anlaşmazlık için iki şans demek.
- **SEP-5'in resmi test vektörleriyle doğrulandı** (hem açık hem gizli anahtar, iki indeks).
  Bu test şart: yanlış türetme hata vermez, geçerli görünen ama başka hiçbir cüzdanın
  açamayacağı bir hesap üretir.

### 2.2 Cüzdan servisi — `src/backend/StellarService.ts`

- Anahtar **diske yazılmıyor**. Mnemonic'ten anlık türetiliyor, yalnızca bellekte
  önbelleğe alınıyor. Saklamak ikinci bir sır, bir migration ve `wipeKeys`'in unutmaması
  gereken bir şey daha demekti.
- **Kilitlenince önbellek boşalıyor** (`StorageManager.onLock` → `forgetDerivedKeys`).
  Olmasaydı ed25519 anahtarı kilidin ömrünü aşardı. Testi var.
- **Özel anahtarla içe aktarılmış hesapların Stellar adresi yok** (`null`). Türetecek ifade
  yok; ilgisiz bir anahtar üretmek kullanıcının yedeğinin geri getiremeyeceği bir adres
  vermek olurdu.
- `signTransactionXdr` **sadece imzalar, göndermez**.

### 2.3 İşlem çözümleyici — `src/backend/StellarTxDecoder.ts`

XDR → okunabilir özet. Onay ekranının üç sorusunu cevaplar: kime ne gidiyor, hangi
hesaptan, olağandışı bir şey ekli mi.

- Anlamadığı operasyonu **özetlemiyor** — ham tipini gösterip `unknownCount`'a sayıyor.
- `accountMerge`, `setOptions`, `changeTrust`, Soroban çağrıları **yükseltilmiş** işaretli:
  tek seferlik değer hareketi değil, kalıcı yetki.

### 2.4 Sayfaya açılan API

```js
await window.arfheWallet.stellar.getAddress();
await window.arfheWallet.stellar.signTransaction(xdr, networkPassphrase);
```

- `stellar_getAddress` — **istem açmaz**, yalnızca bağlı siteye cevap verir
  (`eth_accounts` kuralı). Adres `WalletProvider`'da türetilip worker'a cüzdan durumuyla
  gönderilir; **worker hiç anahtar tutmaz**, bu sınır korunuyor.
- `stellar_signTransaction` — **üç katmanda da** onaya bağlı: `inpage.js`,
  `content-script.js`, `service-worker.js`. Üçü farklı sebeple var (zaman aşımı, port
  düşerse iptal etmeme, pencere açma); biri atlanırsa "çalışıyor gibi" görünür.

### 2.5 Fiat köprüsü — panel + `scripts/verify-anchor-ramp.mjs`

`npm run verify:anchor` — SEP-1 keşif → SEP-10 auth → SEP-6 deposit → banka simülasyonu →
Horizon'dan bakiye kontrolü.

**Ölçülmüş sonuç:** 100.00 TRY → 2.0396090 USDC.
Hash `4dd687757efa24c5681e2801f457321b2102e39af59796ce600ad08301d35aae`,
Horizon'da `successful: true`, ledger 4757372, tek `payment` operasyonu.
Tarayıcıda da uçtan uca çalıştırıldı (`/#/bridge`).

Anchor: `tr-mock-anchor.fly.dev` (SEP-6 sandbox). Banka ve KYC simüle, **Stellar ayağı
gerçek**. Kodda **yalnızca ana alan adı sabit**; uçlar, passphrase ve varlık ihraççısı
`stellar.toml`'dan çalışma anında okunuyor.

---

## 3. Yapılmayanlar

| Konu | Durum |
|---|---|
| `Approve.tsx`'te Stellar işlemi gösterimi | **Yok** — bu yüzden imzalama uçtan uca kullanılamıyor |
| Çekme (withdraw) yönü | Bağlanmadı, ekranda "yapım aşamasında" yazıyor |
| Confidential token katmanı | Hiç başlanmadı |
| Tarayıcıda kanıt üretimi (`bb.js`) ölçümü | Yapılmadı |

---

## 4. Tuzaklar — tekrar keşfedilmesin

**`TransactionBuilder.fromXDR` ağ passphrase'ini DOĞRULAMIYOR.** Mainnet string'i verirsen
zarfı sorunsuz parse eder ve passphrase'i sadece öznitelik olarak kaydeder. Testnet imzasını
mainnet imzasından ayıran tek şey birinin bakması — ve passphrase **çağıran sayfadan**
geliyor. Hem çözümleyicide hem `signTransactionXdr`'da açık kontrol var; **ikisi de kalmalı**,
ikincisi imzayı üreten yer.

**SEP-6 `deposit?amount=` TRY cinsinden**, USDC değil. 100 istersen ~2.04 USDC gelir.
Bozuk çeviri gibi okunuyor.

**Metin memo'lar byte dizisi olarak geliyor.** Hex'e çevirirsen kullanıcının tanıması gereken
anchor referansı tanınmaz hale gelir. UTF-8 çözülmeli; hash/return memo'lar hex kalmalı.

**`changeTrust` limiti `"0.0000000"` formatında.** `=== "0"` karşılaştırması operasyonun
tersini söyler — hat kaldırılırken "açılacak" yazar.

**Güven hattı olmadan anchor ödeyemez** — `pending_trust`'ta kalır ya da talep edilebilir
bakiyeye döner. Panel bunu bağlanırken açıyor.

**Anchor'ın sonuçlanma süresi değişken** — gözlemlenen: 2–4 yoklama. Dar timeout, başarılı
olacak bir işlemi hata diye raporlar.

---

## 5. Confidential Tokens — araştırma notları

Kaynak: Stellar Developer Preview (OpenZeppelin kontratları + Nethermind UltraHonk
doğrulayıcı). **Denetlenmemiş, yalnızca testnet.**

Mimari: mevcut bir SEP-41 token'ının üzerine **sarmalayıcı kontrat**. Bakiye Grumpkin
eğrisinde Pedersen taahhüdü, her geçiş Noir'da yazılmış ZK kanıtıyla doğrulanıyor.
Operasyonlar: `register`, `deposit`, `merge`, `withdraw`, `confidential_transfer`.

**Cüzdanın EVM'de yaptığının aynısı** — `shield`/`confidentialTransfer`/`unshield` ile birebir
eşleşiyor.

### Kritik: neyin gizli olduğu

| | Açık | Gizli |
|---|---|---|
| Confidential Token | Gönderen/alıcı adresleri; **deposit ve withdraw miktarları** | Bakiyeler; **transfer miktarları** |
| Privacy pool (SPP) | Deposit/withdraw adresleri | Adresler, bakiyeler, havuz içi miktarlar |
| Standart SEP-41 | Her şey | Hiçbir şey |

**Anchor ayağı gizlenemez.** Anchor doğru tutarda TRY ödeyecekse miktarı bilmek zorunda.
Gizlenen şey sarmalayıcı **içindeki** transferler.

### Denetçi (auditor)

- Kayıt defteri kontratı, Grumpkin açık anahtarlarını `auditor_id` ile tutuyor.
  `register_key`/`rotate_key` **`manager` rolüne** bağlı.
- **Denetçisiz sarmalayıcı mümkün değil**: `get_key` kayıt yoksa panikliyor ve token bunu
  auditor ciphertext üreten her işlemde çağırıyor. Anahtar *olmak* zorunda, ama gizli tarafı
  imha edilerek kullanılamaz yapılabilir — bu doğrulanamaz bir güven varsayımıdır, ve
  `rotate_key` durduğu sürece kalıcı değildir (manager rolünden de vazgeçmek gerekir).
- **Geriye dönük denetçi atamak işe yaramıyor**: ciphertext işlem anındaki anahtara göre
  üretiliyor, sonradan kaydedilen anahtar geçmişi okuyamaz.

### Riskler

**~7 gün olay saklama.** Harcanabilir sırlar (`v`, `r`) yalnızca event'lerde yaşıyor, zincir
taahhütleri tutuyor, Soroban RPC ~7 günlük geçmiş sunuyor. İstemci yerel kalıcılığa bel
bağlıyor. Demo için kabul edilebilir; **cüzdan için veri kaybı riski** — kullanıcı 7 gün
açmazsa gelen transferin açılımı kurtarılamaz. Indexer ya da başka bir dayanıklılık planı
gerekiyor.

**`@ctd/sdk` npm'de yok** (404). Yalnızca demo reposunda: `brozorec/stellar-confidential-token-demo`.

**Tarayıcıda kanıt üretimi cross-origin isolation istiyor** (SharedArrayBuffer). Uzantı
popup'ında çalışıp çalışmadığı **ölçülmedi** — sonuç mimariyi belirler (kanıt cüzdanda mı
panelde mi üretilecek).

---

## 6. Panel (demo sitesi)

`panel/`, kökün bağımlılıklarını paylaşan ikinci bir Vite girişi (`vite.panel.config.js`).
Ayrı `package.json` yok; uzantının temasını doğrudan import ediyor.

```bash
npm run dev:panel     # 5174
npm run build:panel   # dist-panel/
```

Sayfalar: `/` (ana), `/bridge` (iki pano), `/anchor` (Confidential Anchor + KVKK/GDPR),
`/about` (cüzdan tanıtımı).

**Panel kurtarma ifadesi istemiyor** ve isteyecek alanı yok. Kendi tek kullanımlık testnet
hesabını üretiyor (`sessionStorage`). On iki kelime isteyen bir web sayfası, onu taklit eden
oltalama sayfasından ayırt edilemez.

`resolve.dedupe` şart: Vite kökü `panel/`, bağımlılıklar üst dizinde, `@wallet` alias'ı
`src/`'ye uzanıyor — dedupe olmadan React iki kez yükleniyor ve her hook "Invalid hook call"
atıyor.

---

## 7. İlgili dosyalar

```
src/backend/StellarAccount.ts       SEP-5 türetme
src/backend/StellarService.ts       anahtar/bakiye/imza, kilitlemede temizlik
src/backend/StellarTxDecoder.ts     XDR → okunur, ağ koruması
src/WalletProvider.tsx              stellarAddress'i worker'a iter
extension/inpage.js                 window.arfheWallet.stellar
extension/content-script.js         onay listesi
service-worker.js                   stellar_getAddress, yönlendirme
scripts/verify-anchor-ramp.mjs      uçtan uca köprü doğrulaması
panel/                              demo sitesi
```
