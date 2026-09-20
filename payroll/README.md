# Gizli ödeme servisi

Bordro, tedarikçi ödemesi ve kurumsal takas — üçü de tek motor, üç anlatı.

```bash
npm run payroll     # :8788
```

| Uç | İş |
|---|---|
| `GET /health` | Dağıtım bilgisi |
| `GET /scenarios` | Dört senaryonun tanımı ve gerekçesi |
| `POST /prepare {scenario}` | Tarafları kur, rampadan fonla, gizle **(yavaş, ~2 dk)** |
| `POST /pay` | Gizli ödemeleri yap **(ödeme başına ~5 sn)** |
| `GET /state` | Herkesin bakiyesi |
| `GET /chain/:hash` | **Zincire bakan birinin gördüğü** |

## Neden sunucu

Her gizli transfer bir UltraHonk kanıtı istiyor ve onu `bb.js` üretiyor. bb.js kendi Web
Worker'ını `new Worker(new URL(...))` ile açtığı için paketleyiciden geçemiyor — hash'lenmiş
bir chunk'a gömüldüğünde worker bulunamıyor ve kanıt üretimi **sessizce asılı kalıyor**.
Node'da varsayılan yükleyici sorunsuz çalışıyor.

Bu bir demo kolaylığı değil: gerçekte de bordro sunucuda koşar, tarayıcıda değil.

**Çalışan tarafı buraya bağımlı değil.** Bakiyeyi görmek için yalnızca *çözme* gerekiyor,
kanıt değil — yani cüzdan bu servisi hiç çağırmadan maaşı gösterebilir.

## Bu bir demo

Servis hem ödeyenin hem alıcıların anahtarlarını tutuyor, çünkü tek ekranda "şirket ödedi,
çalışan gördü" göstermek gerekiyor. Gerçek üründe alıcının anahtarı cüzdanındadır ve bu
servis onu hiç görmez. Anahtarlar diske yazılmıyor, her başlatmada yenileniyor, hepsi
testnet.

## Ölçülmüş sonuç

Bordro senaryosu, 19 Eylül 2026:

```
2730 TRY → 55.6813280 USDC   (rampa, zincirde AÇIK)
  Ayşe     18   USDC  5.4 sn  5f178181e81e0ffc925fedf71674b696732a3b77058ea3ad5ba454278d77bdc0
  Mehmet   25   USDC  5.3 sn  f6d09a939cff609884143efad79a8d3d607d57d5d9273acbbdbcd8e2a42747ef
  Zeynep    9.5 USDC  9.7 sn  7782d966ae345f7156f1241bf0cfc2926807baddccf173aae6d4796cf72a0f60
şirket kalan: 3.181328
```

Üç çalışan da kendi tutarını **yalnızca zincirden** çözdü.

### Diğer üç senaryo, 20 Eylül 2026

Aynı motor, aynı çağrı; değişen tek şey tutarların neden gizlenmesi gerektiği. Hepsi kendi
anchor'ımızdan fonlandı:

```
tedarik    2223 TRY → 45.1092559 USDC   (rampa 47 sn)
  Tedarikçi A  42.75 USDC  7.4 sn  ecf7797878774fa5e6e067e123c93a52850bd31674a2287c84248dfed82fbe8a

perakende  1537 TRY → 31.1889008 USDC   (rampa 60 sn)
  Mağaza       18.4  USDC  7.6 sn  e1c6000c8cea8130653652d048a460995f3ee461495c0c37bfcdac0be6a065ea
  Eczane        6.25 USDC  5.5 sn  81949e8fb9098635a2de0c0b32f6dcec61cc6af9de9eeaef2b44b8d4a863bc5e
  Kitapçı       4.9  USDC  9.5 sn  27dd8066c40e774cee3f5def73917a9df3ce39d05b01d9ed654757f937ef6495

takas      1625 TRY → 32.9746023 USDC   (rampa 57 sn)
  Kurum B      31.25 USDC  9.3 sn  6508e67214c838b7b9fbb37f17e48fafbfafce894d1d8fccd3858ae42f6b61e4
```

Üçünde de zincir görünümü aynı: `confidential_transfer`, 15.308 baytlık opak blok, 31.788
baytlık zarf, ve aranan tutarların hiçbiri zarfta yok.

Ölçüm tek komutla tekrarlanıyor:

```bash
node scripts/measure-scenarios.mjs tedarik perakende takas
```

Anchor'ın sandbox tavanı (işlem başına 20 USDC) bu tutarların altında kaldığı için ölçüm
sırasında `ANCHOR_MAX_DEPOSIT_USDC=60 ANCHOR_MAX_TOTAL_USDC=60` ile başlatılıyor, sonra
varsayılana dönülüyor. Tavan, havalenin geldiğini kanıtsız söyleyebilen bir uçta kasayı
koruyan şey.

### Zincir ne görüyor

`GET /chain/f6d09a93…` — Mehmet'in 25 USDC'lik maaşı:

```
fonksiyon : confidential_transfer
adresler  : token kontratı, ŞİRKET, MEHMET
opak blok : 15.308 bayt
zarf      : 31.788 bayt
tutar araması:
  180000000  yok
  250000000  yok
   95000000  yok
  556813280  yok
```

Hiçbir maaş, hatta şirketin toplam fonu bile zarfta geçmiyor.

**Kimin kime ödediği açık. Ne kadar ödediği yok.**

## Dürüstlük sınırı

Zincirde açık kalan: istihdam ilişkisi (şirket bu adreslere ödüyor), rampa girişi, ve bir
çalışan parasını bozdurduğunda o çekimin tutarı. Gizlenen: her maaş, toplam bordro, ve
herkesin bakiyesi.
