# Gizli çıkış rampası — Stellar hackathon tasarımı

> 19 Eylül 2026. Tasarım önerisi, karar değil.

## 1. Kısıtlar (değiştirilemez)

1. **Stellar hackathonu.** Stellar merkezde olmak zorunda. EVM'e kaçmak proje dışı.
2. **Anchor sabit:** `tr-mock-anchor.fly.dev`, SEP-6, TRY ⇄ USDC. Değiştiremiyoruz,
   gizli ödeme kabul etmesini sağlayamıyoruz.
3. **Hedef:** bakiye gizli, harcama gizli, sonuç bir IBAN'a TRY.

## 2. Sabit anchor ne dayatıyor

Anchor gizli token kabul etmiyor. Çekim için ona **açık bir USDC ödemesi** gitmek zorunda,
memo'suyla birlikte. Bu ödemenin tutarı zincirde görünür ve bunu değiştiremeyiz.

Yani "harcamayı gizlemek" burada şu anlama **gelemez**: "anchor'a ne kadar gittiği
görünmesin."

Gelebileceği anlam şu, ve bu zayıf bir hedef değil:

> Zincire bakan biri, **o ödemeyi sana bağlayamaz**, ve **bakiyeni göremez**.

## 3. Tasarım

```
1. TRY → USDC            anchor, SEP-6            [açık — banka ayağı, kaçınılmaz]
2. USDC → gizli katman   shield / deposit          [bundan sonra bakiye gizli]
3. gizli transferler     kullanıcılar arası        [tutar gizli]
4. çıkış: gizli katmandan TAZE bir hesaba çek
5. taze hesap anchor'a öder, SEP-6 withdraw       [tutar açık, ama kimlik bağlantısız]
6. anchor IBAN'a TRY öder
```

Kilit nokta **4. adım**: çıkış, geçmişi olmayan bir hesaba yapılır. Zincirde görünen son
hareket *"tanımadığım bir adres anchor'a X dolar ödedi"* olur. Ana hesabın anchor'a hiç
dokunmaz.

Anchor yine kim olduğunu bilir — SEP-10 ile giriş yapıyorsun, KYC onda. **Bilmesi gereken
zaten o.**

### Ne gizli, ne değil

| | |
|---|---|
| **Gizli** | Bakiyen. Gizli katman içindeki transferler ve tutarları |
| **Gizli** | Çıkış yapan kişinin sen olduğun (zincire göre) |
| Açık | Anchor'a giden son ödemenin tutarı |
| Açık | TRY girişinin tutarı |
| Anchor bilir | Her şey. Tasarım gereği |

Bu, sabit bir anchor'la ulaşılabilecek en iyi nokta. Daha fazlası ancak anchor'ın kendisi
gizli ödeme kabul ederse mümkün — ve o, bu hackathonun kapsamı dışında ama **doğal devamı**
(bkz. §7).

## 4. Hangi gizli katman

İki seçenek de Stellar'da, ikisi de testnette dağıtılmış durumda, ikisi de ölçüldü
(`stellar.md` §5.1 ve §5.8).

| | **Confidential Token** | **Privacy Pools (SPP)** |
|---|---|---|
| Gizlenen | Tutar, bakiye | Tutar, bakiye, **adresler** |
| Açık kalan | Gönderen + alıcı adresi | Ücreti ödeyen |
| Şekil | Şifreli bakiye | **Mixer** |
| Uyum hikâyesi | Denetçi anahtarı | ASP listeleri / GVK |
| Kurulum riski | UltraHonk — **tören yok** | Groth16 — **"local" kurulum** |
| SDF'nin yönü | Aktif olarak bunu itiyor | Yan dal |
| USDC havuzu | Yok, kurmak gerek | Yok, kurmak gerek |

**Öneri: Confidential Token.** Üç sebep:

1. **Mixer değil.** Türkiye'de banka ile konuşacak bir üründe mixer ciddi bir yük.
2. **Tören sorunu yok.** SPP'nin Groth16 anahtarları tek makinede üretilmiş; UltraHonk
   şeffaf kurulum kullanıyor, güvenilecek kimse yok.
3. **SDF'nin kendi yönü bu.** Hackathon jürisi için önemsiz değil.

Bedeli: adresler açık kalıyor. Ama 4. adımdaki taze hesap numarası bu açığı zaten
kapatıyor — çıkışta kimlik bağlantısı kurulamıyor.

## 5. Bilinen engeller ve çözümleri

**CT'nin token'ı XLM sarmalıyor, USDC değil.** Anchor USDC ödüyor. Kendi sarmalayıcımızı
anchor'ın USDC'si için dağıtmamız gerekiyor — SAC adresi
`CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA`. Demo deposunda
`pnpm deploy:contracts` var, mekanik iş.

**7 gün event saklama.** Gizli bakiyenin açılımları event'lerde. Hackathon demosunda sorun
değil; üründe indexer şart (SDF de aynı şeyi söylüyor, `stellar.md` §5.13).

**Tarayıcıda kanıt üretimi.** Ölçüldü: izolasyon açıkken ~4,9 sn, panelde çalışıyor.

**`@ctd/sdk` npm'de yok.** Kaynaktan derlenir; e2e akışı zaten çalıştırıldı.

## 5.5 FAZ 0 SONUCU — ölçüm önerimi çürüttü

İki şey ölçüldü, ikisi de tasarımı değiştiriyor.

### Relayer deseni CT'de çalışmıyor

Simülasyon, `merge(account)` çağrısı için **hesabın kendi yetkisini** istiyor:

```
YETKİ GEREKİYOR → GCCKKXKX…  (notların sahibi)
                  kaynak hesap değil
```

Denendi: çekimi relayer imzalayıp gönderdi, zincirde **trap** ile düştü
(`d091a2a1…`, INVOKE_HOST_FUNCTION_TRAPPED). SPP'de `transact`'in `sender`'ı serbestti;
CT'de değil.

Relayer ücreti ödeyebilir, ama yetki girişi sahibin adresini **işlemin içinde açıkça
taşır**. Yani gizleme sağlamıyor.

### Ve asıl sorun: CT bağlantıyı kıramıyor

Tasarımın 4. adımı "gizli katmandan taze bir hesaba çek" idi. CT'de bu iş görmüyor:

| İşlem | Zincirde görünen |
|---|---|
| `withdraw(alice → F, N)` | alice, F, **ve N** |
| `confidential_transfer(alice → F)` | alice, F (tutar gizli) |

CT **adresleri hiçbir zaman gizlemiyor**. Hangi yoldan gidersen git, `alice → F` bağlantısı
zincirde duruyor. Sonra F anchor'a ödeyince zincir tamamlanıyor: alice → F → anchor.

**Yani CT ile "ödemeyi bana bağlayamasınlar" hedefi tutturulamıyor.** CT'nin verdiği şey
bakiyenin ve transfer tutarlarının gizliliği — kimlik bağlantısızlığı değil.

### Bu ne anlama geliyor

§4'teki önerim yanlıştı. Hedef "zincir ödemeyi bana bağlayamasın" ise **tek seçenek SPP**,
çünkü adresleri gizleyen tek katman o:

```
alice → havuza yatırır            [açık: alice N yatırdı]
alice → F havuz İÇİNDE gönderir   [görünmez: adres yok, tutar yok]
F      → havuzdan çeker           [açık: F N çekti]
F      → anchor'a öder            [açık]
```

Gözlemci "alice yatırdı, biri çekti" görür. Bağlantı, **anonimlik kümesi kadar** kopar.

Ve bedelleri duruyor: mixer şekli, "local" Groth16 kurulumu, küçük kullanıcı sayısında
zamanlama korelasyonu.

### Dürüst seçim

| Hedef | Katman |
|---|---|
| "Bakiyem ve ödeme tutarlarım görünmesin" | **CT** — çalışır, mixer değil, temiz |
| "Ödemeyi bana bağlayamasınlar" | **SPP** — tek seçenek, ama mixer ve anonimlik kümesine bağlı |

Hackathon için ikisinden birini seçmek gerekiyor, ve bu **ürün kararı**, teknik değil.

## 6. Yol haritası

### Faz 0 — Tek ölçüm, her şeyi belirler *(yarım gün)*
- [ ] CT'nin `withdraw` işlemini **üçüncü bir taraf gönderebiliyor mu?** SPP'de
      `transact`'in `sender`'ı serbestti ve relayer'ımız bunu kullandı. CT'de aynı boşluk
      varsa çıkış tamamen bağlantısız olur; yoksa taze hesap yeterli.
- [ ] Anchor'ın USDC'si için bir confidential token sarmalayıcısı dağıt

### Faz 1 — Cüzdan *(çekirdek)*
- [ ] `register` / `deposit` / `merge` akışı — USDC'yi gizli katmana al
- [ ] Gizli bakiyeyi göster (Stellar hesabı ekranının yanında)
- [ ] Gizli transfer arayüzü + onay ekranı desteği (`StellarTxDecoder` hazır)

### Faz 2 — Çıkış akışı *(hikâyenin tamamlandığı yer)*
- [ ] Gizli katmandan taze bir hesaba çekme
- [ ] Taze hesapla SEP-10 + SEP-6 withdraw (panelde iki yön de çalışıyor)
- [ ] Ekranda **ne gizlendiğini göster** — jüri için en önemli kısım bu

### Faz 3 — Anlatı
- [ ] Panelde yan yana karşılaştırma: aynı işlem, açık defterde ne görünüyor / bizde ne
- [ ] Denetçi anahtarı: uyum hikâyesi, KVKK konumlandırması

## 7. Doğal devamı (hackathon sonrası)

Gerçek hedef, anchor'ın **kendisinin** gizli ödeme kabul etmesi. O zaman 4–5. adımdaki
taze hesap numarasına gerek kalmaz ve anchor'a giden tutar da gizlenir.

Mekanizma hazır: EVM tarafında **ERC-7984**, bir transferin tutarını **yalnızca gönderen ve
alıcıya** çözdürüyor. Stellar'ın Confidential Token'ı da aynı şeyi denetçi anahtarıyla
yapıyor — yani anchor'ı denetçi olarak kaydetmek teknik olarak mümkün.

Bu, "Confidential Anchor" adının gerçekten hak edildiği nokta. Hackathonda vaat edilebilir,
teslim edilemez.

## 8. Dürüstlük notu

Kullanıcıya ve jüriye söylenecek cümle:

> Bakiyeniz ve ödemeleriniz kamuya kapalı. Anchor, yasal olarak bilmek zorunda olduğunu
> bilir. Zincire bakan biri ise paranın size ait olduğunu göremez.

"Tamamen anonim" değil. Bu ayrımı kendimiz söylemezsek, jüri soracak.
