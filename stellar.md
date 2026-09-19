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

### 2.5 Onay ekranı — `src/pages/Approve.tsx`

`stellar_signTransaction` isteği geldiğinde ekran zarfı **çözümleyip** gösteriyor: kaynak
hesap, ücret (XLM), memo ve operasyon listesi. Onaylanınca `signTransactionXdr` imzalıyor;
imzalı XDR siteye dönüyor, **gönderilmiyor**.

Dal, EVM kontrollerinin **üstünde**: Stellar imzası için RPC ucu, ethers cüzdanı ve chain id
gerekmiyor; aşağıya düşseydi istek hiç kullanmadığı şeyler yüzünden reddedilirdi.

Dört kural, dördü de testli (`src/pages/__tests__/Approve.stellar.test.tsx`):

1. **Çözümlenmeyen zarf imzalanmaz.** Onay düğmesi kapalı, sebep ekranda. Desteklenmeyen ağ
   da bu yoldan gelir — `UnsupportedNetworkError` kendi cümlesini taşır.
2. **Çözümlenemeyen operasyon uyarı olarak çizilir**, gri bir satır olarak değil. İmzayı
   engellemez; engellenen şey, öyle bir operasyonun olduğundan başka türlü görünmesi.
3. **Kalıcı yetki veren operasyon** (`setOptions`, `accountMerge`, `invokeHostFunction`…)
   ayrı bir uyarı alır.
4. **Ağ rozeti "Stellar testnet" yazar.** Cüzdanın aktif EVM ağını yazmak, Stellar'da imza
   atarken kullanıcıya Sepolia'da olduğunu söylemek olurdu.

SDK ve çözümleyici **dinamik import** ile yükleniyor (`StellarService-*.js`,
`StellarTxDecoder-*.js` ayrı chunk); Stellar'la ilgisi olmayan onaylar bu yükü taşımıyor.

### 2.6 Fiat köprüsü — her iki yön

`npm run verify:anchor` artık **gidiş-dönüşün tamamını** sürüyor: SEP-1 keşif → SEP-10 auth →
SEP-6 deposit → banka simülasyonu → Horizon kontrolü → SEP-6 withdraw → zincirde ödeme →
fiat ayağı.

**Ölçülmüş — yükleme (TRY → USDC):** 100.00 TRY → 2.0396090 USDC.
Hash `4dd687757efa24c5681e2801f457321b2102e39af59796ce600ad08301d35aae`,
Horizon'da `successful: true`, ledger 4757372, tek `payment` operasyonu.

**Ölçülmüş — çekme (USDC → TRY):** 1.5000000 USDC → 72.81 TRY.
Ödeme hash'i `c144b706cf14d147a013a37e185af5944577b07a9b187e10c9853deb269f293f`,
banka referansı `FAST-P4B9NI27VW`, bakiye 2.0396090 → 0.5396090.
İki yoklamada sonuçlandı.

**Tarayıcıda da doğrulandı** (`/#/bridge`, demo imzalayıcı): yükleme hash
`f355bf27270f6ffa4b9394e34e3f9b1827d8ea2d33ad0cd80616da618cf4befe`, çekme hash
`2f5d5dd9d20316dfc58dc9f39aae55b87dead4fae310ac352bfda0ce41767540` → 72.81 TRY.

Çekme yönü yüklemeden **yapı olarak farklı** ve panel bunu ayırıyor: yüklemede önce fiat
gelir, çekmede önce kullanıcı zincirde öder. Değer geri dönmeden önce çıktığı için talep
açma ile ödeme iki ayrı düğme — anchor'ın verdiği hedef hesap ve memo, kullanıcı gönder
demeden **önce** ekranda.

Anchor: `tr-mock-anchor.fly.dev` (SEP-6 sandbox). Banka ve KYC simüle, **Stellar ayağı
gerçek**. Kodda **yalnızca ana alan adı sabit**; uçlar, passphrase ve varlık ihraççısı
`stellar.toml`'dan çalışma anında okunuyor.

### 2.7 Panel imzalayıcısı — `panel/lib/signer.ts`

Panel iki şekilde imzalayabiliyor ve fark, panelin savunduğu şeyin ta kendisi:

| Mod | Anahtar nerede | Ne oluyor |
|---|---|---|
| `arfhe` | Uzantıda | Zarf gider, imzalı zarf döner; arada bir insan onaylar |
| `demo` | Bu sekmede (sessionStorage) | Hiçbir şey kurulu olmayan ziyaretçi de akışı görebilsin |

SEP çağrıları, güven hattı ve çekim ödemesi `PanelSigner` arayüzüne yazılı — yani demo yolu,
gerçek yoldan **sapabilecek ayrı bir uygulama değil**, aynı yolun farklı imzalayıcısı.

**Uzantı yolu kodda tam ama gerçek tarayıcıda uçtan uca denenmedi** — test edilen ortamda
uzantı yüklü değildi. Sayfa uzantıyı bulamadığında düğme kapanıyor ve bunu söylüyor; o kısım
görüldü.

---

## 3. Yapılmayanlar

| Konu | Durum |
|---|---|
| Confidential token katmanının cüzdana girmesi | Protokol testnet'te çalıştırıldı (§5.1), cüzdana **hiçbir kod eklenmedi** |
| Denetçi ciphertext'inin çözülmesi | Denenmedi — dağıtımın denetçi gizli anahtarı elimizde yok |
| Panel'in uzantı ile uçtan uca denenmesi | Kod tam, gerçek tarayıcıda çalıştırılmadı |

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

**Anchor'ın sonuçlanma süresi değişken** — gözlemlenen: yüklemede 2–4, çekmede 2 yoklama.
Dar timeout, başarılı olacak bir işlemi hata diye raporlar.

**`/sep6/info`'daki min/max yanıltıcı.** Deposit için `0.5 – 300` yazıyor, gerçek sınır
**50 – 3000 TRY** (uçtan doğrulandı: 10 → "amount below minimum (50.00 TRY)", 4000 → "above
maximum (3000 TRY)"). `info` varlık birimini, `deposit?amount=` TRY'yi konuşuyor. Panel'in
sabitleri doğru; `info`'ya bakıp "düzeltmek" onları bozar.

**Çekme memo'su tahmin edilmez.** `memo_type` tanınmıyorsa işlem **kurulmaz** (`buildMemo`
fırlatır). Yanlış türde memo ile hazine hesabına giden ödeme eşleşmez ve geri gelmez —
burada "makul bir varsayılana düşmek" parayı kaybetmenin adı.

**Panel kök `tsconfig.json`'a dahil değil.** `include` yalnızca `src` ve `extension`, Vite de
tip kontrolü yapmaz — yani `panel/` dosyalarını tipler açısından ilk okuyan şey tarayıcıydı.
`npm run typecheck:panel` bunun için var; kök baseline'ı (6) bozmasın diye ayrı config.

**Tema başlıkları Türkçe büyütüyor.** `variant="caption"` üstünde `text-transform: uppercase`
var ve Türkçe'de `"id"` → `"İD"`. Protokol değerlerini (memo türü, varlık kodu) başlığa
koymayın; alt açıklama satırı dönüştürmüyor.

---

## 5. Confidential Tokens — artık okunan değil, çalıştırılan

Kaynak: Stellar Developer Preview (OpenZeppelin kontratları + Nethermind UltraHonk
doğrulayıcı). **Denetlenmemiş, yalnızca testnet.**

### 5.1 Testnet'te gerçek bir gizli transfer yapıldı

19 Eylül 2026, `brozorec/stellar-confidential-token-demo` reposunun `e2e` akışı canlı
testnet'e karşı çalıştırıldı. Cüzdana **hiçbir şey eklenmedi** — ölçülen şey protokolün
kendisi.

| Adım | Sonuç |
|---|---|
| register (alice) | `f582124c3173118d9f73aebe5bc5cd7ad54cf0991d111e2ffffd305750e2b256` |
| register (bob) | `a54cee41658a7fb017f1ce6830373891fc9d3c2cdbffbff4b63c71bd7e6ce101` |
| deposit 1000 + merge | `501ba389…`, `d6931c25…` |
| **confidential_transfer 400** | `9c9015c00d56e22f6d90d11a0a917db95293c939548efd5ff831a75ea4703366` |
| withdraw 400 | `cc5b3303a16dddc5ac5ded9f57f059bae6b7d059b5beb907d37a62111f8a2eff` |

Her kanıt **zincirde** doğrulandı; istemci bakiyeleri yalnızca event'lerden yeniden kurdu ve
zincirdeki taahhütlerle eşleştiğini doğruladı.

Zaten dağıtılmış testnet kontratları (kendi dağıtımını yapmak gerekmiyor):

```
token      CBF64DEOVQAXJFBSNGFEUT2AH4H7K5JBY3ZYJ5GVEINMNSDISWRG5N3F
verifier   CDCET36PIS44DWJM5UQSSI4ZHGRDSBIIQW4G4ALPYK3Y6FEQGY5ZWFXL
auditor    CA4II62E35TQKPGHCPBD6EBAS732GSGS6H37UUWKEDHR4YTBVMPHVY4L
underlying CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC  (native XLM SAC)
```

Repo `deployments/testnet.json` içermiyor; README'deki kimliklerle elle yazıldı.
`deployedAtLedger` **gerçek dağıtım ledger'ı olamaz** — RPC ~7 gün tutuyor (ölçülen pencere
`4637170 – 4758129`), o yüzden taze hesaplar için "şimdi eksi biraz" yazılır.

### 5.1.1 Gizlilik iddiası doğrulandı — okuyarak değil, bakarak

Transfer işlemi Horizon'dan herhangi bir gözlemcinin göreceği gibi çekildi:

| Parametre | İçerik |
|---|---|
| `[0] Address` | token kontratı |
| `[1] Sym` | `confidential_transfer` |
| `[2] Address` | **gönderen — açık** |
| `[3] Address` | **alıcı — açık** |
| `[4] Bytes` | 20.424 bayt kanıt + ciphertext |

**Miktar yok.** 400, 1000 ve 600 sayıları zarf+meta baytlarında arandı, hiçbiri yok.

Karşılaştırma: aynı hesabın `deposit` işleminde beşinci parametre bir `I128` ve içeriği
`AAAACgAAAAAAAAAAAAAAAAAAA+g=` — yani **1000, açıkça.**

Yani tablo doğru: **giriş ve çıkış miktarları açık, sarmalayıcı içi transfer gizli.**

Mimari: mevcut bir SEP-41 token'ının üzerine **sarmalayıcı kontrat**. Bakiye Grumpkin
eğrisinde Pedersen taahhüdü, her geçiş Noir'da yazılmış ZK kanıtıyla doğrulanıyor.
Operasyonlar: `register`, `deposit`, `merge`, `withdraw`, `confidential_transfer`.

**Cüzdanın EVM'de yaptığının aynısı** — `shield`/`confidentialTransfer`/`unshield` ile birebir
eşleşiyor.

### 5.2 Kritik: neyin gizli olduğu

| | Açık | Gizli |
|---|---|---|
| Confidential Token | Gönderen/alıcı adresleri; **deposit ve withdraw miktarları** | Bakiyeler; **transfer miktarları** |
| Privacy pool (SPP) | Deposit/withdraw adresleri | Adresler, bakiyeler, havuz içi miktarlar |
| Standart SEP-41 | Her şey | Hiçbir şey |

**Anchor ayağı gizlenemez.** Anchor doğru tutarda TRY ödeyecekse miktarı bilmek zorunda.
Gizlenen şey sarmalayıcı **içindeki** transferler.

### 5.3 Denetçi (auditor)

- Kayıt defteri kontratı, Grumpkin açık anahtarlarını `auditor_id` ile tutuyor.
  `register_key`/`rotate_key` **`manager` rolüne** bağlı.
- **Denetçisiz sarmalayıcı mümkün değil**: `get_key` kayıt yoksa panikliyor ve token bunu
  auditor ciphertext üreten her işlemde çağırıyor. Anahtar *olmak* zorunda, ama gizli tarafı
  imha edilerek kullanılamaz yapılabilir — bu doğrulanamaz bir güven varsayımıdır, ve
  `rotate_key` durduğu sürece kalıcı değildir (manager rolünden de vazgeçmek gerekir).
- **Geriye dönük denetçi atamak işe yaramıyor**: ciphertext işlem anındaki anahtara göre
  üretiliyor, sonradan kaydedilen anahtar geçmişi okuyamaz.

### 5.4 Riskler

**~7 gün olay saklama.** Harcanabilir sırlar (`v`, `r`) yalnızca event'lerde yaşıyor, zincir
taahhütleri tutuyor, Soroban RPC ~7 günlük geçmiş sunuyor. İstemci yerel kalıcılığa bel
bağlıyor. Demo için kabul edilebilir; **cüzdan için veri kaybı riski** — kullanıcı 7 gün
açmazsa gelen transferin açılımı kurtarılamaz. Indexer ya da başka bir dayanıklılık planı
gerekiyor.

### 5.5 Kanıt maliyeti — ölçüldü

Node 20, 10 çekirdek, transfer devresi:

| İş parçacığı | İlk | Isınmış |
|---|---|---|
| 1 | 1513 ms | 1318 ms |
| 4 | 690 ms | 458 ms |
| 10 | 645 ms | 391 ms |

Kanıt boyutu her devrede **14.592 bayt**. register ~0,7 s, transfer/withdraw ~1,3 s
(tek iş parçacığı).

**Bu, açık duran soruyu kapatıyor.** Tarayıcıda kanıt üretimi `crossOriginIsolated === true`
istiyor (bb.js SharedArrayBuffer ile çok iş parçacıklı çalışıyor) — ama izolasyon yoksa bb.js
tek iş parçacığına düşüyor, **çalışmayı bırakmıyor**. Tek iş parçacığında transfer kanıtı
~1,5 s. Yani izolasyon bir **hız** meselesi, yapılabilirlik meselesi değil: uzantı popup'ı
izole edilemese bile kanıtı kendi üretebilir, sadece dört kat yavaş üretir.

Ölçüm Node'da yapıldı; tarayıcı wasm'ı farklı olacaktır, ama karar büyüklük mertebesine
bağlı ve o belli.

**bb.js paketleyiciye sokulmamalı.** Kendi Web Worker'ını `new Worker(new URL(...))` ile
açıyor; hash'lenmiş bir chunk'a gömüldüğünde worker bulunamıyor ve kanıt üretimi **sessizce
asılı kalıyor**. Native ESM olarak, worker/wasm kardeş dosyalarıyla birlikte sabit bir
yoldan servis edilmeli.

**`@ctd/sdk` npm'de yok** (404 — dört isim denendi). Yalnızca demo reposunda. Entegrasyon
paketi kurmak değil, **kodu içeri almak** demek.

### 5.6 Anahtar türetme — Arfhe'de daha temiz olacak

Gizli `sk`, Grumpkin üzerinde rastgele bir skaler; her şey ondan türüyor
(`vk = Poseidon2(VIEWING_KEY, sk, addr_f)`), ve **kontrata bağlı** — bir dağıtım için
üretilen anahtar başka dağıtımda anlamsız.

Demo uygulaması `sk`'yi Freighter'ın `signMessage` imzasından türetiyor (Ed25519 imzaları
deterministik olduğu için geri getirilebilir) ve `localStorage`'a yazıyor. **Arfhe'nin buna
ihtiyacı yok:** kurtarma ifadesi zaten elimizde, `sk` doğrudan tohumdan kendi yolu boyunca
türetilebilir — imza turu yok, ve yedek gerçekten kurtarıyor. Stellar anahtarında yapılanın
aynısı (bkz. §2.1).

---

## 5.7 İkinci seçenek: Privacy Pools (SPP) — ve Zama düzeltmesi

Kaynak: [Privacy on Stellar](https://developers.stellar.org/docs/build/apps/privacy).

**Düzeltme:** "Zama'nın Stellar'la ilgisi yok" **yanlıştı**. Zama, Confidential Token
Association'ın üyesi (SDF, Nethermind, OpenZeppelin ile birlikte). Teknolojisi hâlâ EVM'de —
Stellar'daki uygulama taahhüt+ZK, FHE değil — ama standardı yazan masada oturuyor.

### 7 gün bir uygulama kusuru değil, ekosistem sınırı

Nethermind'ın SPP README'sinin "Limitations" listesindeki **ilk madde**:

> RPC düğümleri event'leri yalnızca 7 gün tutuyor. Kontrat dağıtımından 7 gün sonra katılan
> kullanıcılar için demo çalışmaz, çünkü event geçmişini yeniden oynatamazlar.

İki bağımsız ekip, iki farklı kriptografi, aynı duvar. **Sırrı event'le taşıyan her Stellar
gizlilik şeması** buna çarpıyor. Confidential Token'ın SDK'sı en azından hibrit (RPC + Goldsky
indexer) bir event kaynağı tasarlamış; SPP bunu çözülmemiş sınır olarak listeliyor.

### Karşılaştırma

| | Confidential Token | Privacy Pools (SPP) |
|---|---|---|
| Gizlenen | Miktar, bakiye | **Miktar, bakiye ve adresler** |
| Açık kalan | Gönderen + alıcı adresi | Havuza giriş/çıkış |
| Uyum | Denetçi (miktarları çözer) | ASP allowlist/blocklist **+** isteğe bağlı GVK "traceable" havuz |
| Kanıt sistemi | UltraHonk (Noir) — **şeffaf kurulum** | Groth16/BN254 (Circom) — **devre başına güvenilir kurulum** |
| SDK | `@ctd/sdk`, npm'de **yok** | `stellar-private-payments` 0.1.0, npm'de **var** |
| Cüzdan arayüzü | — | **SEP-43** |
| Testnet dağıtımı | var (§5.1) | var — 2 havuz, `deployments/testnet/deployments.json` |
| Varlık | XLM SAC sarmalayıcısı | XLM havuzları (**USDC havuzu yok**) |

### SPP'nin en büyük riski: kurulum "local"

`deployments/testnet/circuits.json` her devre için `"setup": "local"` diyor. Yani Groth16
anahtarları **çok taraflı bir törenle değil**, tek makinede üretilmiş. Toksik atığı elinde
tutan taraf geçerli görünen sahte kanıt üretebilir — bir havuzda bu, yoktan para basmak
demektir. Referans uygulama için normal; **değer taşıyan hiçbir şey için kabul edilemez**,
ve düzelmesi bir tören gerektiriyor.

UltraHonk'ta böyle bir tören yok. Bu, Confidential Token'ın lehine olan tek büyük teknik fark.

### Vizyona uyum

"Tüm insanlar görmesin, banka görsün" cümlesine SPP daha yakın: Confidential Token'da
**kimin kime ödediği herkese açık**, sadece tutar gizli. Maaş ödemesinde tutarı gizlemek,
tarafları gizlemeden pek bir şey ifade etmiyor. SPP'nin `gvkMode: "traceable"` havuzu ise
tam olarak "yetkili görebilir" demek — testnet'te dağıtılmış ikinci havuz böyle.

**Henüz seçim yapılmadı.** Doğru sıradaki adım, SPP'yi de §5.1'deki gibi testnet'te
çalıştırıp ölçmek — karşılaştırma README'lere değil, iki ölçüme dayansın.

---

## 5.8 SPP de testnet'te ölçüldü

19 Eylül 2026. Kaynaktan derlenen `spp` CLI ile, zaten dağıtılmış testnet havuzuna karşı.
Cüzdana yine hiçbir şey eklenmedi.

Havuz `CCM5G4FCOV7PLKFMEJBCYM5R7JOTZVUXKWBDR3SWCW2IM2LKNNBO4TH5` (XLM, blocklist politikası).

| Adım | Hash | Sonuç |
|---|---|---|
| alice kayıt | `4a9d7e56c4262a244c8c2a06e36c6a97cf42b4d53ed3b852af337824fa76baab` | |
| bob kayıt | `590c1da8eddb50e6c96379a0963735fa8318089456546c1b557f6f117bbf2103` | |
| alice deposit 10 XLM | `18ee5b760c9aaedf6021a83fbfe86b51440405780cc7e8af08cf52bd46af49ad` | havuz 10 |
| **alice → bob 4 XLM (gizli)** | `2a91684c6a36bcccd1896a7198cba82fdefa0c3558ceb46686ae75e8b6ef3bdb` | alice 6, bob 4 |
| bob withdraw 3 XLM | `fbd4aa7dc20851ce886fa1e3e9433e7cab41913fe3c244db2b9d99403271a8cb` | bob havuzda 1, zincirde +3 |

### Zincirde ne görünüyor

Üç işlem de **aynı fonksiyonu** çağırıyor (`transact`), aynı parametre şeklinde. Fark
içeride, ve çözülünce şu çıkıyor:

| | `public_amount` | `ext_amount` | `recipient` |
|---|---|---|---|
| deposit | `100000000` | `100000000` | havuz kontratı |
| **transfer** | **`0`** | **`0`** | **havuz kontratı — Bob'un adresi yok** |
| withdraw | negatif alan öğesi | `-30000000` | **Bob'un `G…` adresi** |

Transfer işleminde taşınan her şey: iki `input_nullifier`, iki `output_commitment`, iki
120 baytlık `encrypted_output`, bir Merkle kökü ve 256 baytlık Groth16 kanıtı. **Ne tutar
var ne alıcı.**

**Dürüst kısım:** gönderen tamamen gizli değil. Alice işlemin kaynağı ve ücreti ödeyen
hesap, yani imzası görünüyor. Gizlenen şey *kime* ve *ne kadar*. Tam gönderen gizliliği
ücreti başkasının ödemesini (relayer) gerektirir. Deponun `docs/src/privacy-tradeoffs.md`
dosyası bu korelasyon yüzeylerini kendisi de sayıyor.

### CT ile ölçülmüş karşılaştırma

| | Confidential Token | Privacy Pools |
|---|---|---|
| Transfer'de açık olan | **Gönderen + alıcı adresi** | Yalnızca ücreti ödeyen |
| Kanıt boyutu | 14.592 bayt | **256 bayt** (a 64 + b 128 + c 64) |
| Transfer ücreti | 513.216 stroop | **180.479 stroop** (~2,8× ucuz) |
| Kanıt üretimi | ~1,3 s (tek iş parçacığı, Node/wasm) | işlem başına ~19–23 s duvar, ~15,4 s CPU (yerel Rust release) |

Süre ölçümleri **aynı cinsten değil**: CT'de saf kanıt süresi ölçüldü, SPP'de CLI'ın tüm
işi (senkron + tanık + kanıt + gönderim). Yine de mertebe farkı açık ve ters yönde:
SPP'nin kanıtı çok daha küçük ve ucuz, üretmesi çok daha yavaş. Tarayıcıda WASM ile daha
da yavaş olacaktır — cüzdan popup'ında 15+ saniye ciddi bir tasarım sorunu.

### Bootnode gerçek ve varsayılan açık

Onboarding, saklama penceresini aşmak için `https://bootnode.dev-nethermind.xyz` adresini
**varsayılan** öneriyor ve CLI trust varsayımlarını ekrana yazıyor: bütünlük (geçmişi
çarpıtabilir), erişilebilirlik, IP/zamanlama mahremiyeti, ve hatalı `fromLedger` ile
senkronu yanlış aralığa yönlendirme.

Yani 7 gün sorununun cevabı SPP'de **zaten var ve çalışıyor** — ama cevabın adı "güvenilen
bir sunucu". CT'nin indexer'ı ile aynı kategori. Kendi kendine saklayan bir cüzdan için
ikisinde de aynı soru: **o sunucuyu kim çalıştırıyor.**

### Kurulum

`deployments/testnet/circuits.json` → her devre `"setup": "local"`. Tören yok. Bu, §5.7'de
yazılan riski doğruluyor: anahtarları üreten taraf sahte kanıt üretebilir, havuzda bunun
adı yoktan para basmak. Devre yapıtları (107 MB) GitHub Releases'ten indirildi ve **48
dosyanın hash'i repoda commit'li manifest'e karşı doğrulandı** — sıfır uyuşmazlık.

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
