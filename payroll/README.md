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
