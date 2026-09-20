<p align="center">
  <img src="public/Arfhe-logo.png" alt="Arfhe Wallet" width="72" />
</p>

<h1 align="center">Arfhe Wallet</h1>

<p align="center">
  <strong>A self-custodial browser wallet that hides amounts — on EVM with FHE, on Stellar with commitments and zero-knowledge proofs.</strong><br/>
  <em>Tutarları gizleyen, kendi kendine saklayan bir tarayıcı cüzdanı — EVM'de FHE ile, Stellar'da taahhüt ve sıfır bilgi kanıtlarıyla.</em>
</p>

---

# English

## What this is

Arfhe Wallet is a Chrome extension (Manifest V3) that has been in development since **2023**
and is **published on the Chrome Web Store** (`jdihllmgakeejednibihnpclbddgfchp`). It is a
testnet release: Ethereum Sepolia, Arbitrum Sepolia and Base Sepolia.

Its premise has not changed in three years. Every balance and every transfer on a public
chain is readable by anyone, and most privacy tools answer that by hiding *who*. Arfhe hides
*how much* — the number that turns a payment into a salary, a supplier invoice or a medical
purchase.

For this hackathon that premise was carried onto **Stellar**, end to end: a confidential
payment layer, a fiat ramp built to Stellar's own standards, and a wallet that speaks both.

## The wallet, before Stellar

Three years of work sit under the Stellar integration, and the Stellar side reuses all of it
— the vault, the approval screens, the account model, the dApp permission gate.

| Piece | What it does |
|---|---|
| Confidential balances (EVM) | Balances live on-chain as ciphertext; the contract adds and subtracts without decrypting. Built on Fhenix CoFHE and the TFHE library. |
| Our contracts | `ArfheShieldedETH`, `ArfheShieldedERC20`, `ArfheWrapperFactory` — 237 lines of Solidity, inheriting Fhenix's audited base. The factory makes any ERC-20 shieldable; `balanceOf` and `totalSupply` deliberately return zero, because the standard's activity counter renders as a fake balance in every wallet. |
| Self-custody | Keys are generated on device, encrypted with a key derived from the password, and never leave. A locked wallet cannot sign — including for its own background work. |
| Agent | An assistant that runs against the user's own model provider and never sees balances, plus an MCP endpoint so Claude Desktop or Claude Code can read balances and preview sends. |
| Tests | 992 tests across 65 files, covering the FHE unit systems, the approval path and the relayer policy. |

## What was built on Stellar for this hackathon

### 1. Stellar has no FHE — measured, not assumed

The first finding was a negative one. FHE does not exist on Stellar: not in the protocol, not
in the documentation. The closest primitive is a twisted-ElGamal prototype that is only
*additively* homomorphic, and one confidential transfer through it costs **~2.85 billion CPU
instructions** against a testnet ceiling of **400 million**.

So the Stellar side is built the way the network actually supports privacy: **commitments and
zero-knowledge proofs**, on the BN254 / BLS12-381 and Poseidon host functions (CAP-0059,
CAP-0074, CAP-0075, CAP-0080). FHE stays on the EVM side, where the arithmetic really does
happen on ciphertext.

### 2. A confidential payment layer, deployed and measured

The confidential-token contracts are Nethermind/brozorec's reference implementation — we did
not write them. What we did was **deploy our own instance that wraps the anchor's Circle
USDC**, because if the asset coming off the ramp is not the asset the confidential layer
holds, a swap appears in the middle and the story falls apart.

On top of it, a payment service (`payroll/`) with four scenarios — payroll, supplier payment,
retail, institutional settlement. All four ran end to end on testnet: **eight confidential
payments, 5.3s to 9.5s each**. In every envelope we opened, 15,308 of 31,788 bytes are opaque
and searching for the figures finds nothing.

`GET /chain/:hash` returns what an observer sees for any of those payments — the function, the
public addresses, the size of the opaque block, and the amount search coming back empty.

### 3. Our own SEP-6 anchor

The sandbox anchor we first built against kept answering HTTP after it had stopped paying, and
it ignored the destination a withdrawal named — three different IBANs came back with the same
payout account. A demo cannot depend on a service nobody can restart, so we wrote one
(`anchor/`).

It speaks **SEP-1, SEP-6, SEP-10 and SEP-38**, and deliberately not SEP-12: it asks for no
identity documents, so it advertises no KYC server.

- **It pays out to the IBAN a withdrawal names.** That is the whole reason it exists.
- **The IBAN is derived from the Stellar account** — mod-97 valid, the same number every time,
  stored nowhere.
- **The caps are counted in dollars**: 20 USDC per transfer, 60 per account. The treasury pays
  USDC, so a lira ceiling would protect a different amount every time the rate moved.
- **The rate is fixed** — one mid price with a 50bp spread — so a measurement made twice gives
  the same answer.

### 4. The wallet learned Stellar

- A Stellar account derived from the **same recovery phrase** (SEP-5), so one backup restores
  both sides.
- Stellar in the network menu, without pretending it is an EVM chain — a different curve, a
  different address format, a different ledger.
- **Bank mode**: a TRY balance and an IBAN beside the Web3 side, the way a Turkish exchange
  presents it, with every transaction row carrying the on-chain hash that settled it.
- **SEP-53** signed messages and Stellar transaction signing on the approval screen, where the
  network passphrase is checked explicitly — `fromXDR` does not verify it.

### 5. The full circle: a salary that becomes lira

The demo used to end where the money was least useful. It now closes:

```
TRY → anchor → USDC → confidential layer → confidential salary
                                              ↓
                          merge → withdraw → anchor → TRY in an IBAN
```

Measured: **2,730 TRY became 55.40 USDC**, paid three salaries confidentially, and one
employee cashed **18 USDC into 869.46 TRY** in 38.2 seconds, proof included.

## What is hidden, and what is not

Stated plainly, because a privacy product that overstates itself is worse than one that does
not.

| | Visible on-chain |
|---|---|
| The amount of a confidential transfer | **No.** Not encrypted-but-present: the number is not in the envelope at all. |
| A recipient's balance | **No.** It lives in the contract as curve points; the recipient's own account shows no USDC line. |
| Who paid whom, and when | **Yes.** Repeated monthly, that is an employment relationship. |
| The payroll total | **Yes.** The ramp is public, so the budget is known — only its split is not. |
| The moment money leaves | **Yes.** `withdraw` returns value to the open ledger, and the ledger stores numbers. |
| The designated auditor's view | Every payment carries an auditor ciphertext. The holder of that key reads every amount — by design: not "nobody can see", but "only the authorised party can". |

Also true: the bank and the identity checks are a sandbox — no institution issues these IBANs
and no lira moves. Everything on the Stellar side is real testnet. The confidential-token and
privacy-pool implementations are references and **unaudited**; the tokens here have no value.

## Where this goes

The panels on the demo site are a shop window. The product is the wallet someone opens every
day, and the plan is a wallet that is **fully at home on Stellar** — not a demo bolted to the
side of an EVM extension.

1. **Recipient keys in the wallet.** The demo service holds both sides' keys so one screen can
   show a payment and its receipt. In the product the recipient decrypts in their own wallet
   and the service never sees a key.
2. **Durable recovery.** Confidential balances are reconstructed from events, and RPC keeps
   about seven days. A self-custodial wallet's private balance must be as durable as the
   wallet itself.
3. **Sender privacy.** We measured it once in the privacy pool — the relayer submitted and the
   sender appears nowhere on-chain — but producing the payload meant patching the pool's CLI
   ourselves. The product path runs through a prepare-without-sending step in the published
   client.
4. **Confidential balance and send screens inside the extension**, for Stellar as they exist
   for EVM.
5. **Audit before mainnet.** Written as a condition, not a footnote.

## Running it

```bash
npm install
npm run anchor        # the SEP-6 anchor          :8790
npm run payroll       # confidential payments     :8788
npm run dev:panel     # the demo site             :5174
npm run build:chrome  # the extension → dist/
npx vitest run        # 992 tests
```

Deeper notes, with the traps worth not rediscovering: [`stellar.md`](stellar.md),
[`payroll/README.md`](payroll/README.md), [`anchor/README.md`](anchor/README.md),
[`confidential-offramp.md`](confidential-offramp.md), [`README.md`](README.md).

---

# Türkçe

## Bu nedir

Arfhe Wallet, **2023'ten beri** geliştirilen ve **Chrome Web Mağazası'nda yayında** olan bir
Chrome uzantısı (`jdihllmgakeejednibihnpclbddgfchp`). Testnet sürümü: Ethereum Sepolia,
Arbitrum Sepolia ve Base Sepolia.

Üç yıldır değişmeyen çıkış noktası şu: açık bir zincirde her bakiye ve her transfer herkese
okunabiliyor, ve çoğu gizlilik aracı buna *kimin* sorusunu gizleyerek cevap veriyor. Arfhe
*ne kadar* sorusunu gizliyor — bir ödemeyi maaşa, tedarikçi faturasına ya da eczane alışverişine
çeviren sayıyı.

Bu yarışmada aynı çıkış noktası **Stellar'a** uçtan uca taşındı: gizli bir ödeme katmanı,
Stellar'ın kendi standartlarıyla kurulmuş bir fiat rampası, ve ikisini de konuşan bir cüzdan.

## Stellar'dan önceki cüzdan

Stellar entegrasyonunun altında üç yıllık iş duruyor ve Stellar tarafı bunların hepsini
yeniden kullanıyor — kasa, onay ekranları, hesap modeli, dApp izin kapısı.

| Parça | Ne yapıyor |
|---|---|
| Gizli bakiyeler (EVM) | Bakiyeler zincirde şifreli metin olarak duruyor; kontrat çözmeden toplayıp çıkarıyor. Fhenix CoFHE ve TFHE üzerine kurulu. |
| Bizim kontratlarımız | `ArfheShieldedETH`, `ArfheShieldedERC20`, `ArfheWrapperFactory` — 237 satır Solidity, Fhenix'in denetlenmiş temelinden miras. Fabrika herhangi bir ERC-20'yi gizlenebilir yapıyor; `balanceOf` ve `totalSupply` bilerek sıfır dönüyor, çünkü standardın aktivite sayacı her cüzdanda sahte bakiye gibi görünüyor. |
| Kendi kendine saklama | Anahtarlar cihazda üretiliyor, paroladan türetilen bir anahtarla şifreleniyor ve dışarı çıkmıyor. Kilitli bir cüzdan imza atamaz — kendi arka plan işi için bile. |
| Ajan | Kullanıcının kendi model sağlayıcısıyla çalışan, bakiyeleri hiç görmeyen bir asistan; ayrıca Claude Desktop/Code'un bakiye okuyup gönderim önizleyebildiği bir MCP ucu. |
| Testler | 65 dosyada 992 test — FHE birim sistemleri, onay yolu ve relayer politikası dahil. |

## Bu yarışmada Stellar üzerinde yapılanlar

### 1. Stellar'da FHE yok — varsayım değil, ölçüm

İlk bulgu olumsuzdu. Stellar'da FHE yok: ne protokolde ne dokümanda. En yakın ilkel, yalnızca
*toplamsal* homomorfik bir twisted-ElGamal prototipi ve oradan geçen tek bir gizli transfer
**~2,85 milyar CPU talimatı** istiyor — ağın işlem başına sınırı **400 milyon**.

Bu yüzden Stellar tarafı, ağın gizliliği gerçekten desteklediği biçimde kuruldu: **taahhütler
ve sıfır bilgi kanıtları**, BN254 / BLS12-381 ve Poseidon host fonksiyonları üzerinde
(CAP-0059, CAP-0074, CAP-0075, CAP-0080). FHE, aritmetiğin gerçekten şifreli metin üzerinde
koştuğu EVM tarafında kalıyor.

### 2. Dağıtılmış ve ölçülmüş bir gizli ödeme katmanı

Gizli token kontratları Nethermind/brozorec referans uygulaması — onları biz yazmadık. Bizim
yaptığımız, **anchor'ın Circle USDC'sini sarmalayan kendi dağıtımımızı yapmak**: rampadan çıkan
varlıkla gizli katmanın tuttuğu varlık aynı olmazsa araya bir takas girer ve bütün hikâye
dağılır.

Üstünde dört senaryolu bir ödeme servisi (`payroll/`) — bordro, tedarikçi ödemesi, perakende,
kurumsal takas. Dördü de testnette uçtan uca çalıştı: **sekiz gizli ödeme, her biri 5,3 ile 9,5
saniye arasında**. Açtığımız her zarfta 31.788 baytın 15.308'i opak ve aranan tutarlar bulunamıyor.

`GET /chain/:hash`, o ödemelerden herhangi biri için zincire bakan birinin gördüğünü döndürüyor:
fonksiyon, açık adresler, opak bloğun boyutu, ve tutar aramasının boş dönmesi.

### 3. Kendi SEP-6 anchor'ımız

İlk bağlandığımız sandbox anchor, ödemeyi bıraktıktan sonra da HTTP'ye cevap vermeye devam
ediyordu ve çekimde verilen adresi yok sayıyordu — üç farklı IBAN'a aynı hesap döndü. Kimsenin
yeniden başlatamadığı bir servise demo bağlanmaz; kendimiz yazdık (`anchor/`).

**SEP-1, SEP-6, SEP-10 ve SEP-38** konuşuyor, SEP-12'yi bilerek konuşmuyor: kimlik belgesi
istemediği için bir KYC sunucusu da ilan etmiyor.

- **Çekimde verilen IBAN'a ödeme yapıyor.** Var olma sebebi bu.
- **IBAN, Stellar hesabından türetiliyor** — mod-97 geçerli, her seferinde aynı, hiçbir yerde
  saklanmıyor.
- **Tavanlar dolar cinsinden**: işlem başına 20 USDC, hesap başına 60. Kasadan çıkan dolar
  olduğu için lira cinsinden bir tavan, kur her oynadığında farklı bir tutarı korurdu.
- **Kur sabit** — tek bir orta fiyat ve 50 baz puan makas — ki aynı ölçüm iki kere aynı sonucu
  versin.

### 4. Cüzdan Stellar'ı öğrendi

- **Aynı kurtarma ifadesinden** türetilen bir Stellar hesabı (SEP-5); tek yedek iki tarafı da
  geri getiriyor.
- Ağ menüsünde Stellar, ama EVM zinciriymiş gibi davranmadan — farklı eğri, farklı adres
  biçimi, farklı defter.
- **Banka modu**: Web3 tarafının yanında TRY bakiyesi ve bir IBAN, tıpkı bir Türk borsasındaki
  gibi; her işlem satırı onu sonuçlandıran zincir hash'ini taşıyor.
- **SEP-53** imzalı mesajlar ve onay ekranında Stellar işlem imzalama — ağ passphrase'i açıkça
  kontrol ediliyor, çünkü `fromXDR` bunu doğrulamıyor.

### 5. Halkanın kapanması: maaşın liraya dönmesi

Demo, paranın en işe yaramaz olduğu yerde bitiyordu. Artık kapanıyor:

```
TRY → anchor → USDC → gizli katman → gizli maaş
                                        ↓
                    merge → withdraw → anchor → IBAN'a TRY
```

Ölçüldü: **2.730 TRY, 55,40 USDC oldu**, üç maaş gizli ödendi, ve bir çalışan **18 USDC'yi
869,46 TRY'ye** çevirip IBAN'ına aldı — kanıt üretimi dahil 38,2 saniye.

## Ne gizli, ne değil

Açıkça yazıyoruz, çünkü kendini olduğundan fazla anlatan bir gizlilik ürünü, hiç anlatmayandan
kötüdür.

| | Zincirde görünüyor mu |
|---|---|
| Gizli transferin tutarı | **Hayır.** Şifreli ama orada değil — sayı zarfta hiçbir biçimde yok. |
| Alıcının bakiyesi | **Hayır.** Kontratta eğri noktaları olarak duruyor; alıcının hesabında USDC satırı bile görünmüyor. |
| Kimin kime, ne zaman ödediği | **Evet.** Her ay tekrarlandığında bu bir istihdam ilişkisidir. |
| Bordronun toplamı | **Evet.** Rampa açık, yani bütçe biliniyor — bilinmeyen tek şey dağılımı. |
| Paranın çıktığı an | **Evet.** `withdraw` değeri açık deftere döndürüyor, defterin tuttuğu şey ise bir sayı. |
| Yetkili denetçinin gördüğü | Her ödeme bir denetçi şifresi taşıyor. O anahtarı tutan taraf bütün tutarları okur — tasarım gereği: "kimse göremez" değil, "yalnızca yetkili görür". |

Şunlar da doğru: banka ve kimlik doğrulama bir sandbox — bu IBAN'ları hiçbir kurum vermiyor ve
ortada lira hareket etmiyor. Stellar tarafındaki her şey gerçek testnet. Gizli token ve gizlilik
havuzu uygulamaları referans ve **denetlenmemiş**; buradaki tokenların değeri yok.

## Bundan sonrası

Demo sitesindeki paneller birer vitrin. Ürün, kullanıcının her gün açtığı cüzdan; hedef de
**Stellar'da tamamen evinde olan** bir cüzdan — bir EVM uzantısının yanına iliştirilmiş bir demo
değil.

1. **Alıcının anahtarı cüzdanında.** Demo servisi tek ekranda hem ödemeyi hem makbuzu
   gösterebilmek için iki tarafın da anahtarını tutuyor. Üründe alıcı kendi cüzdanında çözer ve
   servis hiçbir anahtarı görmez.
2. **Dayanıklı kurtarma.** Gizli bakiyeler olaylardan yeniden kuruluyor ve RPC bunları yaklaşık
   yedi gün tutuyor. Kendi kendine saklayan bir cüzdanın gizli bakiyesi, cüzdanın kendisi kadar
   dayanıklı olmalı.
3. **Gönderen gizliliği.** Havuzda bir kez ölçtük — relayer gönderdi, gönderen zincirde hiçbir
   yerde görünmedi — ama yükü üretmek için havuzun CLI'ını kendimiz yamamak gerekti. Ürün yolu,
   yayınlanan istemcide "hazırla ama gönderme" adımının gelmesinden geçiyor.
4. **Uzantının içinde gizli bakiye ve gizli gönderme ekranları** — EVM'de olduğu gibi Stellar
   için de.
5. **Mainnet'ten önce denetim.** Bir dipnot olarak değil, bir şart olarak yazıyoruz.

## Çalıştırma

```bash
npm install
npm run anchor        # SEP-6 anchor              :8790
npm run payroll       # gizli ödeme servisi       :8788
npm run dev:panel     # demo sitesi               :5174
npm run build:chrome  # uzantı → dist/
npx vitest run        # 992 test
```

Daha derin notlar ve tekrar keşfedilmemesi gereken tuzaklar: [`stellar.md`](stellar.md),
[`payroll/README.md`](payroll/README.md), [`anchor/README.md`](anchor/README.md),
[`confidential-offramp.md`](confidential-offramp.md), [`README.md`](README.md).
