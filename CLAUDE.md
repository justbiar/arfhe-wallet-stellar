# ArfheWallet

FHE tabanlı, kendi kendine saklayan (self-custodial) Chrome cüzdanı. Chrome Web
Mağazası'nda yayında. Testnet sürümü — Ethereum Sepolia, Arbitrum Sepolia, Base Sepolia.

## Bağlam dosyaları

Bir konuya girmeden önce ilgili dosyayı oku. Hepsi Türkçe devir teslim notları ve
"neyin ölçüldüğü / neyin varsayım olduğu" ayrımını korurlar.

| Dosya | Ne zaman |
|---|---|
| `stellar.md` | **Stellar / confidential token / anchor / panel** işlerinde. Tuzaklar bölümü tekrar keşfedilmemesi gereken şeyleri içerir. |
| `CONTEXT.md` | AI agent (Arfio), VPS agent, x402 entegrasyonu. |
| `FHE_COMPLETE_GUIDE.md` | EVM tarafındaki FHE/CoFHE shield-unshield mimarisi. |
| `SECURITY.md` | Güvenlik açığı bildirimi. |
| `STORE_LISTING.md`, `STORE_FIELDS.txt` | Chrome Web Mağazası listeleme metinleri. |

## Komutlar

```bash
npm run dev            # uzantı dev sunucusu (5173)
npm run build:chrome   # geliştirme build'i — manifest'te `key` KALIR
npm run build:store    # mağaza build'i — `key` SİLİNİR, yükleme için bunu kullan
npm run dev:panel      # panel demo sitesi (5174)
npm run build:panel    # panel → dist-panel/
npx vitest run         # tüm testler
npx tsc --noEmit       # tip kontrolü
npm run verify:anchor  # Stellar fiat köprüsünü uçtan uca doğrular
```

## Bilinmesi gerekenler

**`npx tsc --noEmit` 6 hata verir ve bu baseline'dır.** X402PaymentService, ConfirmationCard
ve PortfolioHistoryChart kaynaklı, bu oturumlardan önce de vardı. Sayı 6'nın üstüne çıkarsa
sen bir şey kırmışsındır.

**Mağazaya yüklerken `build:store` kullan.** `build:chrome` manifest'te `key` bırakır ve
mağaza paketi reddeder. Ama `key` geliştirmede gerekli: olmadan uzantı kimliği her profilde
değişir, ve o kimlik WalletConnect projesinin izinli kaynak listesinde kayıtlı.

**Uzantı kimliği:** `jdihllmgakeejednibihnpclbddgfchp`. Reown panelinde izinli kaynak olarak
`chrome-extension://jdihllmgakeejednibihnpclbddgfchp` kayıtlı olmalı, yoksa WalletConnect
`3000 (Unauthorized: origin not allowed)` verir.

**Yorumlar "neden"i anlatır, "ne"yi değil.** Mevcut kod bu şekilde yazılmış; eklediklerin de
öyle olsun. Bir kararın gerekçesi, özellikle de reddedilen alternatif, yorumda yerini bulmalı.

**Kurtarma ifadesi istenmez.** Ne uzantıda gereksiz yere, ne panelde hiç. On iki kelime
isteyen bir arayüz, onu taklit eden oltalama sayfasından ayırt edilemez.

**Testnet dışına imza atılmaz.** Stellar tarafında ağ passphrase'i açıkça kontrol edilir;
`fromXDR` bunu doğrulamaz (bkz. `stellar.md` §4).

## Dil

Kullanıcı arayüzü Türkçe ve İngilizce (`src/locales/`). Kod yorumları ve commit mesajları
İngilizce. Kullanıcıyla iletişim Türkçe.
