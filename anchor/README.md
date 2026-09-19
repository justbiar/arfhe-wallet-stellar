# Mock anchor

TRY ⇄ USDC rampası, SEP-1/10/6/38. Kendi yazdığımız, çünkü öncekini kimse yeniden
başlatamıyordu.

```bash
npm run anchor     # :8790
```

## Neden bu var

`tr-mock-anchor.fly.dev` HTTP'ye cevap veriyordu ama **ödeme yapmıyordu**: yatırma
`pending_anchor`'da kalıyor, kayda talep açıldıktan 60 ms sonra bir daha dokunulmuyordu.
Kasasında 28.770 USDC dururken. 20 Eylül 2026'da ölçüldü.

İkinci sebep: çekimde verilen IBAN'ı yok sayıyordu. Üç farklı `dest` gönderildi, üçünde de
kendi hesabını döndürdü. Yani "kendi IBAN'ıma çektim" cümlesi kurulamıyordu.

## Uçlar

| Uç | Ne |
|---|---|
| `/.well-known/stellar.toml` | SEP-1 — diğer her şey buradan keşfediliyor |
| `/auth` | SEP-10 — challenge üret, imzayı doğrula, jeton ver |
| `/sep6/info` | Neyin desteklendiği. Çekimde `dest` **alan olarak ilan ediliyor**, çünkü gerçekten kullanılıyor |
| `/sep6/deposit` | Ortak IBAN + **hesap başına sabit** referans |
| `/sep6/withdraw` | `dest` zorunlu, `TR` + 24 hane doğrulanıyor |
| `/sep6/transactions`, `/sep6/transaction` | Durum |
| `/sep6/tx/:id/simulate-bank-transfer` | Sandbox: bankanın "para geldi" demesi |
| `/sep38/prices` | Tek orta kurdan iki yön |
| `/health` | Kasa, kurlar, dağıtım hesabı |

## Kasa

Anchor ödemeyi kendi hesabından yapıyor, yani içinde USDC olmalı:

1. Hesabı friendbot ile fonla (XLM), USDC güven hattını aç
2. https://faucet.circle.com → Stellar testnet → dağıtım adresi

Adresi `npm run anchor` açılışta yazıyor. Kasa boşsa yatırmalar `pending_trust`'ta bekler ve
servis bunu açılışta uyarır.

## Codespaces

Anchor'ın canlı bir demoda ulaşılabilir olması için tek yol bu (bkz. `.devcontainer/`):

1. Codespace'i aç — 8790 otomatik yönlendiriliyor
2. Port görünürlüğünü **public** yap (özel yönlendirme GitHub'ın giriş sayfasını döndürür,
   bu da cüzdanda "anchor cevap vermiyor" gibi görünür)
3. `ANCHOR_DOMAIN=<codespace>-8790.app.github.dev npm run anchor`
4. Cüzdanı ve paneli aynı alan adına çevir:
   `VITE_ANCHOR_DOMAIN=<aynısı> npm run build:chrome`

**Anahtarları secret olarak koy.** `ANCHOR_SIGNING_SECRET` ve `ANCHOR_DISTRIBUTION_SECRET`
tanımlıysa dosya hiç oluşmuyor. Tanımlı değilse `anchor/.keys.json` üretilir ve codespace
silindiğinde **kasadaki USDC'yle birlikte erişilemez olur** — anahtar gider, para hesapta
kalır.

## Bilinmesi gerekenler

**SEP-10 challenge'ı sıra numarası 0 taşımalı.** `TransactionBuilder` verdiğin sırayı
artırıyor; `"0"` verince zarfa 1 yazılıyor ve her giriş reddediliyor. `Account(key, "-1")`
ile çözülüyor.

**Gelen ödemeler imleçle okunmuyor.** `cursor("now")` her turda yeniden değerlendiği için
iki tur arasında gelen ödeme hep geçmişte kalıyordu; çekim `pending_user_transfer_start`'ta
bekliyor, para anchor'ın hesabında duruyordu. Son sayfa okunuyor, işlenen hash'ler kümede
tutuluyor.

**Defter bellekte.** Yeniden başlatınca açık işlemler gider. Sandbox için kasıtlı: yeniden
başlatılabilir olması özellik, ve bir veritabanı hiçbir iddiayı daha doğru yapmıyor.
