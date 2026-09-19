# ArfheWallet

FHE tabanlı, kendi kendine saklayan (self-custodial) Chrome cüzdanı. Chrome Web
Mağazası'nda yayında. Testnet sürümü — Ethereum Sepolia, Arbitrum Sepolia, Base Sepolia.

## Bağlam dosyaları

Bir konuya girmeden önce ilgili dosyayı oku. Hepsi Türkçe devir teslim notları ve
"neyin ölçüldüğü / neyin varsayım olduğu" ayrımını korurlar.

| Dosya | Ne zaman |
|---|---|
| `payroll/README.md` | **Gizli ödeme servisi** — üç senaryo, uçlar, ölçülmüş sonuçlar. |
| `confidential-offramp.md` | **Gizli çıkış rampası** — gizli bakiyeyi IBAN'a TRY olarak gönderme tasarımı ve yol haritası. Kararlar alınmadı, alternatifler yazılı. |
| `stellar.md` | **Stellar / confidential token / anchor / panel** işlerinde. Tuzaklar bölümü tekrar keşfedilmemesi gereken şeyleri içerir. |
| `CONTEXT.md` | AI agent (Arfio), VPS agent, x402 entegrasyonu. |
| `FHE_COMPLETE_GUIDE.md` | EVM tarafındaki FHE/CoFHE shield-unshield mimarisi. |
| `SECURITY.md` | Güvenlik açığı bildirimi. |
| `STORE_LISTING.md`, `STORE_FIELDS.txt` | Chrome Web Mağazası listeleme metinleri. |

## Nerede kalındı — 19 Eylül 2026

Hackathon hedefi: **Stellar üzerinde gizli kurumsal ödeme.** Ürün cümlesi
*"Bordro zincirde yazmaz."* Karar gerekçeleriyle `confidential-offramp.md`'de.

**Çalışan ve ölçülmüş:**

- Kendi gizli USDC katmanımız testnette dağıtıldı — anchor'ın Circle USDC'sini sarmalıyor
  (`payroll/deployment.ts`)
- Bordro / tedarik / takas motoru (`payroll/engine.ts`) ve HTTP servisi
  (`npm run payroll`, :8788). Ölçüm: 2730 TRY → 55,68 USDC → üç maaş, ödeme başına ~5 sn
- `GET /chain/:hash` zincirin gördüğünü döndürüyor: tutarların hiçbiri zarfta yok
- CT SDK depoda (`vendor/ctd-sdk/`, tek değişiklik README'de yazılı)
- Rampa iki yönlü çalışıyor, CCTP ile EVM'e geçiş de ölçüldü (`stellar.md` §5.14)

**Sıradaki iş:** panelde demo sayfası — solda ödeyen, sağda alıcılar, altta
"zincir bunu görüyor" kutusu, üstte senaryo seçici. Servis hazır, sayfa ince olacak.

**Bilinen engeller:** `bb.js` tarayıcıda paketleyiciden geçmiyor (o yüzden kanıt üretimi
sunucuda); RPC olay saklama 7 gün, üretimde indexer şart.

## Komutlar

```bash
npm run dev            # uzantı dev sunucusu (5173)
npm run build:chrome   # geliştirme build'i — manifest'te `key` KALIR
npm run build:store    # mağaza build'i — `key` SİLİNİR, yükleme için bunu kullan
npm run dev:panel      # panel demo sitesi (5174)
npm run build:panel    # panel → dist-panel/
npx vitest run         # tüm testler
npx tsc --noEmit       # tip kontrolü (src + extension)
npm run typecheck:panel # tip kontrolü (panel/ — köke dahil DEĞİL)
npm run verify:anchor  # Stellar fiat köprüsünü iki yönde de uçtan uca doğrular
npm run payroll        # gizli ödeme servisi (8788) — bordro/tedarik/takas
npm run relayer        # gizlilik havuzu relayer'ı (8787)
npx tsc --noEmit -p tsconfig.payroll.json   # payroll + vendor tip kontrolü
```

## Bilinmesi gerekenler

**`npx tsc --noEmit` 6 hata verir ve bu baseline'dır.** X402PaymentService, ConfirmationCard
ve PortfolioHistoryChart kaynaklı, bu oturumlardan önce de vardı. Sayı 6'nın üstüne çıkarsa
sen bir şey kırmışsındır.

**Panel kök tip kontrolüne dahil değil.** `tsconfig.json`'ın `include`'u `src` ve
`extension`; `panel/` için ayrı `tsconfig.panel.json` var. Panelde çalıştıysan
`npm run typecheck:panel` de çalıştır, yoksa tipleri ilk okuyan şey tarayıcı olur.

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
