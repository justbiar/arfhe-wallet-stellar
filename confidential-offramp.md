# Gizli çıkış rampası — tasarım ve yol haritası

> 19 Eylül 2026. Bu dosya bir bulgu kaydı değil, bir **tasarım önerisi**. Kararlar
> alınmadı; alternatifler ve gerekçeleri yazılı.

## 1. İstenen

> Base'deki gizli USDC bakiyemi bir IBAN'a TRY olarak göndermek istiyorum.
> **Bakiye gizli olsun, harcama da gizli olsun.**

Bunun kesin sınırı şu: **anchor tutarı ve IBAN'ı bilmek zorunda.** Bankaya para
gönderiyor. Yani "gizli harcama" ancak şu anlama gelebilir:

> Anchor görür. **Başka kimse görmez.**

Bu, en baştan beri söylenen vizyonun aynısı — ve ulaşılabilir bir hedef.

## 2. Bugün ne sızıyor

Mevcut çıkış yolu:

| Adım | Zincirde görünen |
|---|---|
| Unshield N USDC | Adresin, **tutar** |
| Anchor hazinesine gönder | Adresin → **bilinen hazine adresi**, **tutar** |

Gözlemci şunu okur: *"X adresi, tanınan bir anchor'a N dolar bozdurdu."* Anchor'ın
KYC'siyle birleşince kimlik de belli. **İstenen şeyin tam tersi.**

## 3. Mekanizma: ERC-7984

Aranan özellik bir standartta zaten var.

**ERC-7984** — gizli fungible token standardı. Bakiyeler ve transfer tutarları `euint64`
şifreli tutamaçlar. Kritik davranış:

> Bir transfer gerçekleştiğinde kontrat, tutar tutamacının **çözme hakkını gönderene ve
> alıcıya** verir. Başka kimse okuyamaz.

Yani **alıcı olarak anchor tutarı çözebilir, zincir çözemez.** İhtiyaç duyulan şey tam
olarak bu ve uydurmaya gerek yok — OpenZeppelin'in `openzeppelin-confidential-contracts`
deposunda uygulaması var (v0.4.0).

## 4. Önerilen akış

```
[Arfhe · Base]                      [Confidential Anchor]        [Banka]
 cUSDC (ERC-7984)
   │ 1. çekim isteği: tutar + IBAN (HTTPS, SEP-6 şeklinde)
   │───────────────────────────────────►
   │ 2. anchor TAZE bir alıcı adresi döner
   │◄───────────────────────────────────
   │ 3. confidentialTransfer(tazeAdres, sifreliTutar)
   │══ zincir: "X → bir adres, tutar gizli" ══►
   │                                     4. anchor alıcı olarak
   │                                        tutarı çözer (ACL hakkı)
   │                                     5. IBAN'a TRY ──────────────►
   │ 6. durum: completed
```

### Ne sızar, ne sızmaz

| | |
|---|---|
| **Gizli** | Tutar. Bakiyen. Ödemenin büyüklüğü |
| **Gizli** | Karşı tarafın anchor olduğu — **her çekimde taze adres** kullanılırsa |
| Açık | Bir gizli transfer yaptığın, ve zamanı |
| Anchor bilir | Tutar, IBAN, kimlik. **Tasarım gereği** |

Taze adres detayı önemsiz görünür ama akışın yarısı odur: sabit bir hazine adresine
gönderirsen, tutar gizli olsa bile *"bu kişi anchor'a bir şey gönderdi"* herkese açıktır.
SEP-6'nın memo'yla yaptığı ayrımın EVM karşılığı.

## 5. Hangi FHE?

Üçü de "alıcı çözebilir" özelliğini veriyor. Fark, bizim için pratikte:

| | Zama | **Fhenix CoFHE** | Inco |
|---|---|---|---|
| Ağlar | Ethereum mainnet + Sepolia | **Sepolia, Base, Arbitrum Sepolia** | Base, Solana devnet, Celo |
| Arfhe'de durumu | — | **Zaten kurulu ve çalışıyor** | — |
| Standart | ERC-7984 (OZ uygulaması) | FHERC-20 | ERC-7984'e katkıda bulunuyor |
| Olgunluk | Mainnet, cUSDC canlı, ~$40M TVL | Koprosesör canlı | Lightning canlı (TEE), tam FHE geliştirmede |

**Öneri: Fhenix CoFHE ile başla.** Sebep mühendislik: cüzdanda zaten var, tam bizim üç
ağımızda çalışıyor, shield/unshield akışı yazılmış durumda. Zama daha olgun ve standardı
o taşıyor, ama Arfhe'yi başka bir zincire taşımak gerekir.

**Faz 0'da cevaplanacak soru:** Fhenix ERC-7984 uyumlu bir token destekliyor mu, yoksa
kendi FHERC-20'si mi? Standarda uymak, yarın Zama'ya geçmeyi ucuzlatır.

## 6. Ciddi bir risk: ihraççı dondurması

Mayıs 2026'da **Circle, Zama'nın cUSDC kontratını kara listeye aldı ve ~12,6 milyon
dolar donduruldu** (basına yansıdığı kadarıyla).

Ders açık: **USDC'yi gizli bir sarmalayıcıya koymak, ihraççının dondurma yetkisini ortadan
kaldırmıyor — tam tersine dikkat çekiyor.** Bizim tasarımda da gizli token'ın altında
gerçek USDC yatacak.

Hafifletme seçenekleri, hiçbiri bedava:
- Testnet'te kalmak (bugünkü durum)
- USDC yerine ihraççısı daha esnek bir varlık
- İhraççıyla önceden konuşmak
- Riski kabul edip kullanıcıya **açıkça** söylemek

Bu, teknik değil kurumsal bir risk ve yol haritasının en başında karara bağlanmalı.

## 7. Yol haritası

### Faz 0 — Karar ve ölçüm (küçük)
- [ ] Fhenix ERC-7984 destekliyor mu, yoksa FHERC-20 mü? Standarda uymanın maliyeti ne?
- [ ] Base Sepolia'da bir ERC-7984 (ya da FHERC-20) token deploy et, **alıcı tarafın
      tutarı çözebildiğini ölç** — tüm tasarım bu tek davranışa dayanıyor
- [ ] İhraççı riski kararı: hangi varlık, hangi ağ, kime söylüyoruz

### Faz 1 — Cüzdan tarafı
- [ ] Mevcut shield/unshield akışını ERC-7984'e taşı (ya da yanına ekle)
- [ ] **Gizli transfer** arayüzü: alıcı adres + şifreli tutar
- [ ] Onay ekranında gizli transferi anlamlı göster — tutar kullanıcıya açık, zincire değil

### Faz 2 — Anchor (asıl eksik parça)
- [ ] HTTP servisi, SEP-6 şeklinde: `/info`, `/withdraw`, `/transaction`
- [ ] **Çekim başına taze alıcı adresi** üretimi ve eşleştirme
- [ ] Çözme istemcisi: gelen gizli transferin tutarını alıcı olarak çöz
- [ ] Tutar ↔ çekim talebi eşleştirme, tutarsızlıkta reddetme
- [ ] TRY ödemesi: önce simüle, sonra gerçek banka entegrasyonu
- [ ] Anahtar yönetimi: çözme anahtarı anchor'ın en kritik sırrı

### Faz 3 — Giriş yönü
- [ ] TRY → cUSDC: anchor gizli token'ı **doğrudan mint edebilir**, böylece giriş bile
      tutar açığa çıkarmadan yapılabilir. Çıkıştan daha kolay, sonraya bırakılabilir.

### Faz 4 — Uyum
- [ ] Denetçi/görüntüleme anahtarı: ERC-7984 ACL'i buna uygun
- [ ] Kayıt tutma, MASAK beklentileri, KVKK konumlandırması

## 8. Stellar bu tabloda nerede

**Bu akışta yok.** Çıkış rampası baştan sona EVM: gizli token EVM'de, FHE EVM'de, anchor
EVM'de dinliyor.

Stellar yalnızca **giriş** yönünde, ve yalnızca gerçek bir Türk SEP-6 anchor'ı çıkarsa
anlamlı. Bugün için: cüzdandaki Stellar desteği ucuz, dursun; gizlilik ondan beklenmesin.

CCTP zinciri (§5.14, `stellar.md`) yine de değerli — Stellar'dan EVM'e para taşımanın
ölçülmüş, güvenilir bir yolu olduğunu gösteriyor.

## 9. Bu tasarımın dürüst sınırı

Gizlenen: **ne kadar**.
Gizlenmeyen: **bir şey yaptığın**, ve anchor'a karşı **kim olduğun**.

Kullanıcıya bu cümleyle anlatılmalı. "Tamamen anonim" değil; **"bakiyeniz ve ödemeleriniz
kamuya kapalı, anchor yasal olarak bilmek zorunda olduğunu bilir."**
