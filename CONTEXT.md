# ArfheWallet — AI Agent Entegrasyonu: Bağlam Dosyası

> Devir teslim / hatırlatma dosyası. Bir sonraki oturumda buradan devam edilecek.
> Son güncelleme: 2026-08-16 (kök proje 662 + backend-proxy 53 test yeşil; Faz 2 RAG
> tamamlandı, rewrite-omer merge edildi, tool-ismi sızıntısı + propose_send
> halüsinasyon bug'ı + dekont UI yeniden tasarımı + Alchemy multichain key sorunu
> çözüldü, Faz 3 (x402) ilk entegrasyon turu tamamlandı + gerçek facilitator
> entegrasyonu eklendi (backend-proxy, `x402FacilitatorClient.ts`, feature flag
> arkasında, Chrome'da elle uçtan uca test HÂLÂ bekliyor) VE Chrome'da elle test
> sırasında gerçek bir bug bulundu/düzeltildi: `pay_for_resource` `AGENT_TOOLS`
> listesinde hiç yoktu, model tool'u hiç göremiyordu — bkz. bölüm 14, en alttaki
> "Çözüldü" başlığı — bkz. bölüm 3, 5, 10-14).

## 1. Genel Amaç

ArfheWallet'a (FHE tabanlı Chrome extension cüzdan) AI agent entegrasyonu. Kullanıcı
sohbet ederek bakiyesini sorabilir, işlem önerisi (send/shield/unshield) alabilir,
onaylarsa gerçek işlem atılır. LLM sağlayıcısı **OpenRouter**, yalnızca ücretsiz
modeller kullanılıyor — bütçe yok. Ajanın adı **Arfio**.

## 2. Mimari Özet (güncel)

```
Extension (AgentChatPanel)
  → AgentOrchestrator
    → [RAG: retrieve-context, turn başına 1 kez]
    → Backend Proxy (Cloudflare Worker, backend-proxy/)
      → OpenRouter (model fallback zinciri)
      → Workers AI (embedding, RAG için)
      → [x402: /agent/x402/payment-required, /agent/x402/settle — şu an STUB]
        → tool_calls
          → AgentToolRunner
            → AgentPolicyEngine (propose_* onay kararı + x402 bütçe kararı)
            → Network.ts / TransactionSimulator
            → X402PaymentService (EIP-3009 imza) / X402SpendingLedger
          → ConfirmationCard (onStatusChange: pending|rejected|confirmed|failed)
            → gerçek imzalama (Network.ts fonksiyonları)
            → TransactionResultCard (dekont tasarımı, gerçek zincir verisinden)
```

## 3. Tamamlanan Fazlar

- **Faz 0** — `AgentPolicyEngine.ts`: forbidden tools listesi, öneri/bakiye ratio cap,
  oturum başına öneri sayısı cap.
- **Faz 1a/1b/1c** — Read-only + proposal tool'lar, `ConfirmationCard`, hesap-bazlı
  geçmiş ayrımı, "Arfio" kimliği. (Detaylar bölüm 9-13'te, tarihsel.)
- **Faz 2 (RAG)** — Tamamlandı. `FHE_COMPLETE_GUIDE.md`'den 6 kavram-bazlı chunk
  çıkarılıp `bge-m3` ile embed edildi (`backend-proxy/src/knowledge/`), brute-force
  cosine similarity (Vectorize gerekmedi, 6 vektör için gereksiz). Eşik 0.42, gerçek
  Türkçe sorgularla kalibre edildi (6 alakalı sorguda 0.42-0.62, 2 alakasız kontrolde
  en yüksek 0.374 — net ayrım). `AgentOrchestrator.runAgentTurn` turn başına bir kez
  `/agent/retrieve-context` çağırıyor, dönen chunk'ları statik sistem promptunun
  ardından ikinci bir system mesajı olarak ekliyor. Retrieval başarısız olursa
  (5xx/network hatası) sohbet context'siz devam ediyor, hiçbir zaman throw etmiyor.
  Prod'a deploy edildi: `arfhewallet-agent-proxy.arfhewallet.workers.dev`.
- **rewrite-omer merge** — Omer'in UI/swap/güvenlik değişiklikleri (yeni Settings
  sayfaları, SwapService, HiddenTokens, ArfTheme vb.) `mustafa` branch'ine merge
  edildi (commit `22a90f2`). Agent/RAG dosyaları çakışmadan korundu. Detaylar
  bölüm 10'da.

## 4. Önemli Teknik Kararlar

- **Agent ASLA imzalama/gönderme yapmaz.** Sadece `ConfirmationCard`'daki
  `handleApprove`, gerçek `Network.ts` fonksiyonlarını çağırır.
- **Agent asla kendi iç mekanizmasını (tool isimleri, "X aracını çağırıyorum" gibi
  mekanik ifadeler) kullanıcıya göstermez** — bkz. bölüm 11.
- **`ConfirmationCard` onay/red/hata durumları tek bir `onStatusChange` union'ından
  geçer** (`pending | rejected | confirmed | failed`) — üç ayrı callback yerine tek
  callback, yeni bir durum eklemek bu switch'e girmek zorunda, unutma riski
  yapısal olarak kapatıldı. Bkz. bölüm 12.
- **İşlem sonucu asla modelin serbest metninden gelmez** — `TransactionResultCard`
  gerçek `Network.ts`/ledger verisinden render edilir, model bu veriyi üretmez,
  sadece bilgilendirilir. Bkz. bölüm 12.
- **Model fallback zinciri**: `openrouter/free` kendi otomatik router'ıyla geniş bir
  ücretsiz model havuzundan seçim yapıyor — `modelConfig.ts`'deki isimlendirilmiş
  fallback'ler (nemotron, gemma) pratikte nadiren devreye giriyor. Fallback sırasını
  değiştirmek gerçek modeli kontrol etmiyor.
- **Adresler `ConfirmationCard`'da onay anında yeniden çözülür** — dondurulmuş preview
  verisine güvenilmez. x402 ödeme gereksinimi de aynı ilkeyle onay anında proxy'den
  yeniden çekiliyor.
- **x402 mimarisi**: HTTP 402 alışverişi + facilitator doğrulaması backend-proxy'de
  (extension'ın gelişigüzel URL'lere fetch atmasını önlemek için — SSRF riski).
  İmzalama (EIP-3009, gassiz) kesinlikle extension'da. Bütçe kararını `model` değil
  `AgentPolicyEngine` verir. Bkz. bölüm 13.

## 5. Henüz Yapılmadı / Sıradaki Adımlar

- **Faz 3 (x402)**: İlk tur (5 izole parça) + entegrasyon (tool-loop, `X402PaymentCard`,
  uçtan uca testler, gerçek facilitator client'ı) tamamlandı. Kalan: **Chrome'da elle
  uçtan uca test** — gerçek facilitator kodu mock'lu testlerle doğrulandı ama gerçek bir
  testnet settle'ının (geçerli imzayla, gerçek USDC transferi) uçtan uca başarıyla
  tamamlandığı henüz görülmedi, `X402_USE_REAL_FACILITATOR` hâlâ `"false"` (varsayılan).
  Bkz. bölüm 14 — **sıradaki oturum buradan devam etmeli.**
- **Faz 4**: MCP uyumluluğu (opsiyonel, uzak gelecek, henüz başlanmadı).
- **İngilizce başlıklar** (`TransactionResultCard`'da "Transfer successful" gibi
  bazı kalıntılar olabilir, son elle testte büyük ölçüde düzeltildi ama tam
  taranmadı) — küçük, ertelenebilir bir temizlik.
- **GitHub Dependabot uyarısı**: merge sonrası push'ta "113 vulnerabilities (1
  critical, 48 high, 55 moderate, 9 low)" bildirimi geldi, henüz incelenmedi.
- **Wrangler güncel değil** (3.114.17, 4.x mevcut) — kritik hata riski uyarısı var,
  güncellenmedi.

## 6. Geliştirme Ortamı Notları

- Backend proxy lokal test: `cd backend-proxy && pnpm exec wrangler dev`
  (localhost:8787). Prod logları: `pnpm exec wrangler tail`.
- **Mode-bazlı env dosyaları** (güncellendi): `.env.development`
  (`VITE_AGENT_PROXY_URL=http://localhost:8787`) ve `.env.production`
  (`VITE_AGENT_PROXY_URL=https://arfhewallet-agent-proxy.arfhewallet.workers.dev`).
  `pnpm dev` → local, `pnpm build` → prod. Eski tek `.env`'deki `VITE_AGENT_PROXY_URL`
  kaldırıldı. İkisi de secret içermiyor, commit edilebilir.
- **Alchemy RPC key'leri** `.env`'de `VITE_ALCHEMY_*_API_KEY` olarak tanımlı — her
  biri **tam URL** formatında olmalı (`https://{network}.g.alchemy.com/v2/{key}`),
  sadece key değil. Alchemy artık multichain: tek key'i her ağın URL'sine uygun
  şekilde yapıştırmak yeterli, ağ başına ayrı key gerekmiyor. `YOUR_ALCHEMY_KEY`
  placeholder'ı kalan bir satır varsa o ağda 401 hatası alınır (bkz. bölüm 10).
- Extension'ı build etmek için: `pnpm build` (proje kökünde, prod mode), sonra
  `chrome://extensions/`'ta **tamamen kaldırıp yeniden yükle** (sadece reload değil)
  — stale build/cache riskine karşı, özellikle büyük değişikliklerden sonra.
  `rm -rf dist && pnpm build` ile temiz build almak tercih edilmeli.
- OpenRouter key `.dev.vars`'ta (git'e girmez); production için
  `wrangler secret put OPENROUTER_API_KEY` gerekir.
- `backend-proxy/package.json`'da hâlâ `test`/`test:run` scripti yok — testler
  `pnpm exec vitest run` ile çalıştırılıyor.

## 7. Test Durumu

**662 test yeşil** (kök proje, 37 dosya) + backend-proxy ayrı paket (kendi Vitest +
`@cloudflare/vitest-pool-workers` suite'i, 53 test, 6 dosya — `pnpm exec vitest run`
ile). `pnpm build` temiz.

## 8-9. (Tarihsel — Faz 0-1 hesap-ayrımı, Arfio kimliği, erken bug fix'leri)

Bkz. dosyanın önceki versiyonu / git geçmişi: hesap-bazlı chat/geçmiş ayrımı,
`ConfirmationCard` stale-preview fix'i, ratio-cap sonrası boş ekran fix'i, chat
history persistence (`chrome.storage.session`), backend-proxy non-JSON upstream
body fix'i. Bu bölümler önceki `CONTEXT.md` sürümünde eksiksiz duruyor, yer
kazanmak için burada özetlenmedi — gerekirse git log'dan `CONTEXT.md`'nin önceki
halini çekmek yeterli.

### Kısmen çözüldü → tamamen çözüldü: Model çıktı kalitesi sorunu

Önceki sürümde "çözülmedi" olarak işaretlenmişti. Kök neden bulundu: `openrouter/free`
auto-router'ı geniş bir model havuzundan seçim yapıyor, `MODEL_CHAIN`'deki
isimlendirilmiş fallback'ler nadiren devreye giriyor — yani fallback sırasını
değiştirmek gerçek modeli kontrol etmiyor. Asıl kaldıraç **sistem promptu** oldu.
`internalLeakGuard.ts` eklendi: bilinen tool isimlerini + mekanik kalıpları tespit
edip `console.warn` ile prod loglarına yazıyor (bloklamıyor, sadece izliyor).

## 10. rewrite-omer Merge (2026-08-14)

Omer'in `rewrite-omer` branch'i (`f7ded2d` — "ui düzenlemeleri, swap backend
düzenlenmesi, güvenlik düzeltmeleri") `mustafa` branch'ine merge edildi
(commit `22a90f2`).

**Süreç:** `git merge origin/rewrite-omer --no-commit --no-ff` ile önce gözden
geçirildi. `AgentOrchestrator.ts`, `AgentPolicyEngine.ts`, `AgentToolRunner.ts`,
`ConfirmationCard.tsx`, `backend-proxy/` — hiçbiri çakışmadı, otomatik korundu
(ortak atada bu dosyalar hiç yoktu, sadece `mustafa` tarafında eklenmişti). Eski
bir kalıntı dosya (`AgentService.ts`, Biar'ın ilk agent denemesi) `rewrite-omer`'de
hâlâ vardı ama `mustafa`'da zaten silinmişti — Git doğru şekilde "silinsin" dedi,
kayıp değil.

**Sonuç:** 504 → 541 test (omer'in yeni testleri dahil: `PhishingDetector`,
`DomainResolver`, `SpamFilter`, `TokenCache` vb.), backend-proxy 19 test korunuyor.
Chrome'da elle doğrulandı: Arfio, omer'in yeni Settings sayfalarıyla (`SettingsX402`
hariç, o sonradan eklendi) birlikte sorunsuz çalışıyor.

**Yan not:** Push sırasında GitHub 113 Dependabot güvenlik uyarısı bildirdi
(1 critical, 48 high) — henüz incelenmedi, bölüm 5'te açık madde.

## 11. Çözüldü: Tool ismi sızıntısı ("propose_send aracını çağırıyorum" gibi)

**Bulundu:** Elle testte model kullanıcıya "`propose_send` aracını çağırıyorum..."
gibi iç mekanizma detayları söylüyordu. Güvenlik açığı değil ama ciddi bir UX
sorunu.

**Fix:** `buildSystemPrompt()`'a genel bir kural eklendi: kullanıcıyla HER ZAMAN
doğal dille konuş, hiçbir zaman fonksiyon/tool ismi, "X aracını çalıştırıyorum"
gibi mekanik ifade, dosya/sınıf ismi kullanma — 3 kötü→iyi örnek çifti dahil, tüm
cevap türlerini kapsayacak şekilde (sadece tool-call anları değil). Ayrıca
`internalLeakGuard.ts` eklendi (bkz. bölüm 9) — izleme amaçlı, bloklamıyor.

## 12. Çözüldü: propose_send sonrası halüsinasyon (sahte "işlem gönderildi" mesajı + React batching sorunu)

Bu, üç ayrı ama zincirleme bug'dan oluşan bir seri halinde bulunup çözüldü. Özet:

**Bug A — Model halüsinasyonu:** `ConfirmationCard` hiç açılmadan/onaylanmadan,
model kendiliğinden "işlem gönderildi, hash: 0x..." diyordu, hash sahte/geçersiz
çıkıyordu (Etherscan'de "invalid txn hash"). **Kök neden:** Sistem promptu
"sadece read-only araçlar çağırabilirsin" diyordu ama tool şemasında `propose_*`
araçları vardı ve model bunları çağırabiliyordu — çelişkili talimat. Ayrıca
`runAgentTurn`'ün tool-loop'u, bir `PROPOSAL_TOOLS` sonucundan sonra kullanıcı
onayı beklemeden otomatik devam ediyordu.

**Fix A:** Sistem promptu netleştirildi (`propose_*` araçları önizleme üretir,
`requiresConfirmation: true` görünce görev biter, asla "gönderildi" denmez, asla
hash uydurulmaz). Tool döngüsü `PROPOSAL_TOOLS` + `requiresConfirmation: true`
sonrası **kırılıyor** (return) — ikinci bir `/agent/chat` isteği hiç atılmıyor.

**Bug B — React 18 batching:** Approve'a basınca (Fix A sonrası) hâlâ eski bir
"WAITING FOR THE SEND TRANSACTION..." breadcrumb'ı (`AgentChatPanel`'de
`handleConfirmationResolved`) görünüyordu, çünkü bu fonksiyon **hâlâ** ayrı bir
`runAgentTurn("", ...)` çağrısı yapıyordu — Fix A'nın kapsamı dışında kalmıştı.

**Fix B:** `handleConfirmationResolved`'daki otomatik `runAgentTurn` çağrısı
tamamen kaldırıldı. Ayrıca `ConfirmationCard`'ın üç ayrı callback'i
(`onApproveStarted`, `onResolved`, `onBroadcast`) tek bir `onStatusChange(status:
"pending"|"rejected"|"confirmed"|"failed")` union'ında birleştirildi — React'in
otomatik batching'inin ara state'leri (ör. "pending") ezmesini önlemek için, ve
gelecekte "birini düzeltip diğerini unutma" riskini yapısal olarak kapatmak için.

**Testler:** Kök neden reprodüklenip sonra düzeltilerek doğrulandı (önce hatalı
halde test yazılıp kırmızı görüldü, sonra düzeltilip yeşile alındı) — varsayımla
değil kanıtla ilerlendi.

## 13. Çözüldü: TransactionResultCard "dekont" tasarımı + kalan UI/build sorunları

**İstek:** Ham "PROPOSE_SEND COMPLETED" gibi etiketler ve "Transfer successful" gibi
İngilizce/teknik metinler yerine, banka dekontu tarzında, tamamen Türkçe, kullanıcı
dostu bir sonuç kartı.

**Yapılanlar:**
- Ham durum rozetleri kaldırıldı, `toolActionLabel()` üzerinden çevrilmiş isimler
  ("Gönder"/"Shield"/"Unshield") kullanılıyor.
- `TransactionResultCard` dekont formatında yeniden tasarlandı: daire ikon + başlık
  + tarih üstte, ince ayraç, altında label/value tablo satırları (Tutar, Alıcı,
  Kalan bakiye, İşlem no). Adres/hash `shortenHex()` ile kısaltılıyor, tıklanınca
  adres kopyalanıyor / hash Etherscan'e gidiyor. Failed durumunda kullanıcı dostu
  hata açıklaması + "Tekrar dene" butonu (`AgentToolRunner.executeToolCall`'ı
  doğrudan çağırıp, model turu atlayarak yeni bir preview üretiyor).
- `en.json`/`tr.json` simetri testi eklendi (`src/locales/__tests__/locales.test.ts`)
  — eksik/fazla anahtar, boş değer, `{{param}}` uyuşmazlığını otomatik yakalıyor.

**Ayrı bulunan sorunlar (aynı test turunda):**
- **Stale build**: Chrome'da eski build test ediliyordu (İngilizce metinler
  görünüyordu ama kaynak kod zaten doğru Türkçe'ydi) — `rm -rf dist && pnpm build`
  + extension'ı tamamen kaldırıp yeniden yükleme ile çözüldü. Bkz. bölüm 6.
- **Alchemy key eksikliği**: `.env`'de Arbitrum/Base Sepolia satırlarında hâlâ
  `YOUR_ALCHEMY_KEY` placeholder'ı vardı → 401 hataları. Alchemy'nin multichain
  key'i kullanılarak gerçek URL'lerle dolduruldu. Bkz. bölüm 6.
- **Yan risk**: Extension'ı "Remove" ile kaldırıp yeniden yüklemek `chrome.storage`
  verisini (cüzdan!) sıfırlayabiliyor — test cüzdanı bu şekilde sıfırlandı (test
  ETH'i, gerçek değeri yok). **Not düşülmeli:** ileride extension'ı kaldırmadan
  önce seed phrase yedeklenmeli.

**Sonuç:** 577 test yeşil (bu turun sonunda).

## 14. Faz 3 (x402) — İlerleme (devam ediyor)

**Onaylanan mimari:**
- `AgentPolicyEngine.evaluateX402Payment()`: bütçe içi → `allowed:true,
  requiresConfirmation:false` (otomatik öde); dışı → `allowed:true,
  requiresConfirmation:true` (ConfirmationCard'a düşer); kapalı/geçersiz →
  `allowed:false`.
- HTTP 402 + facilitator doğrulaması **backend-proxy'de** (SSRF riskini önlemek
  için — extension'ın keyfi URL'lere fetch atmasını engelliyor), imzalama
  (EIP-3009, gassiz) **extension'da**.
- Otomatik ödemede ayrı bir `X402PaymentCard` (onay istemeyen bilgilendirme kartı),
  limit dışında mevcut `ConfirmationCard` akışı.
- Ayrı, kalıcı bir `X402SpendingLedger` (`chrome.storage.local` — `AgentProposalHistory`'nin
  session-bazlı storage'ından bilinçli olarak ayrı, çünkü periyodik bütçe hesabı
  kalıcı veri gerektiriyor).
- Mutlak üst sınır (`X402_ABSOLUTE_CAPS`: $1/işlem, $10/gün) kod içinde sabit,
  kullanıcı ayarı her zaman `Math.min(userValue, ABSOLUTE_CAP)` ile clamp'leniyor —
  defense-in-depth: hem kayıt anında hem okuma anında hem policy kararı anında.
- **EIP-3009 (`transferWithAuthorization`) ile başlandı** (basit `sendTransaction`
  yolu değil) — gassiz, x402'nin gerçek vaadine sadık, ama daha fazla yeni kod.

**Tamamlanan parçalar (ilk tur, 5+1):**
1. `X402SettingsService.ts` + `SettingsX402.tsx` (ayarlar sayfası, `NotificationService`
   deseninde, autosave, defense-in-depth clamp).
2. `X402SpendingLedger.ts` (`SitePermissionService` deseninde, hesap-bazlı izolasyon,
   yerel takvim günü + yarım-açık pencere ile periyot hesabı, FIFO 500 kayıt).
3. `AgentPolicyEngine.evaluateX402Payment()` — mutlak tavan bypass testiyle
   doğrulandı (settings mock'lanıp tavanın 1000 katı döndürülse bile sonuç yine
   `requiresConfirmation:true`). Yan bulgu: floating-point sınır hatası
   (`5 - 4.95 !== 0.05`) bulunup `FLOAT_EPSILON_USD = 1e-9` toleransıyla düzeltildi.
4. `backend-proxy/src/x402Stub.ts` — `/agent/x402/payment-required` ve
   `/agent/x402/settle`, üç katmanlı "gerçek değil" işaretiyle (dosya başlığı
   uyarısı, `_stub: true` alanı, geçersiz hex adresler). **Gerçek facilitator
   entegrasyonu henüz yok, bu stub'ın yerini alacak.**
5. `X402PaymentService.ts` — `signTransferWithAuthorization()`, EIP-712/EIP-3009.
   Testler `ethers.verifyTypedData` ile bağımsız doğrulama yapıyor (kurcalama
   testi + cross-domain replay testi dahil).
6. **(Ek parça)** `ConfirmationCard.tsx`'e `pay_for_resource` case'i eklendi —
   onay anında ödeme gereksinimini yeniden çeker, imzalar, settle eder, ledger'a
   kaydeder (manuel onaylanan limit-dışı ödemeler de ledger'a giriyor, şeffaflık
   için). "Kalan bakiye" satırı bilinçli olarak gösterilmiyor (native/shielded
   bakiye ile USDC harcaması karışmasın diye).
7. **`AgentOrchestrator` tool-loop entegrasyonu** — bkz. "Çözüldü" alt bölümü
   aşağıda.
8. **`X402PaymentCard.tsx`** — otomatik (onaysız) x402 ödemesi için bilgilendirme
   kartı, `AgentChatPanel`'e `"x402Payment"` `ChatItem` kind'i olarak entegre
   edildi. Detaylar aşağıdaki "Çözüldü" alt bölümünde.
9. **Uçtan uca entegrasyon testleri** (limit-içi + limit-dışı, gerçek modüller
   birbirine bağlı) — bu turda gerçek bir bütçe-takibi bug'ı bulundu ve
   düzeltildi. Detaylar aşağıdaki "Çözüldü" alt bölümünde.
10. **Gerçek facilitator client'ı** (`backend-proxy/src/x402FacilitatorClient.ts`) —
    `x402Stub.ts`'in yerini `X402_USE_REAL_FACILITATOR` feature flag'i arkasında alıyor
    (varsayılan hâlâ stub). Detaylar aşağıdaki "Çözüldü" alt bölümünde.

**Yeni tool:** `pay_for_resource(resource: string)` — `AgentToolRunner`'da
`handlePayForResource`. `propose_*` isimlendirmesi bilinçli olarak kullanılmadı
(semantik farklı: bu tool bütçe içindeyse gerçekten öder, sadece önizleme üretmez).

**Test durumu:** kök proje 660 + backend-proxy 53 test yeşil (bu bölümün sonunda).

### Çözüldü: AgentOrchestrator tool-loop'u pay_for_resource'u tanımıyordu (KALAN İŞ madde 1)

**Bulundu (önce kırmızı test ile reprodüklendi, varsayımla değil):** `isAwaitingConfirmation()`
yalnızca `PROPOSAL_TOOLS` listesine bakıyordu; `pay_for_resource` bu listede DEĞİL (bilinçli
olarak, semantiği farklı olduğu için — bkz. yukarı). Sonuç: `pay_for_resource` bütçe dışı bir
ödeme için `requiresConfirmation:true` dönse bile döngü kırılmıyor, `AgentOrchestrator` ikinci
bir `/agent/chat` isteği atıyordu — tam olarak bölüm 12'deki halüsinasyon bug'ının aynı sınıfı
(model, kullanıcı henüz onaylamamış bir `ConfirmationCard`'ı görmeden devam ediyor). Yazılan
test (`pay_for_resource sonrası döngü davranışı` describe bloğu, `AgentOrchestrator.test.ts`)
önce bu hatalı davranışı reprodükledi (kırmızı: ikinci `/agent/chat` isteği gerçekten atıldı),
sonra fix sonrası yeşile alındı.

**Fix:** Kopyalanmış bir kontrol yerine tek bir birleşik liste — `CONFIRMABLE_TOOLS =
[...PROPOSAL_TOOLS, ...X402_TOOLS]` — tanımlandı, `isAwaitingConfirmation()` artık bu birleşik
listeye bakıyor (aynı `ConfirmationCard.onStatusChange` union kararındaki disiplin: "birini
düzeltip diğerini unutma" riski yapısal olarak kapatıldı — üçüncü bir onaylanabilir tool tier'ı
eklenirse tek bir yerde eklenmesi yeterli). `pay_for_resource` `PROPOSAL_TOOLS` setine
EKLENMEDİ — `CONFIRMABLE_TOOLS` ayrı, paralel bir birleşim, iki setin semantiği hâlâ ayrı
(`evaluate()` vs `evaluateX402Payment()`).

**Doğrulanan davranış (2 yeni test):**
- `requiresConfirmation:true` (bütçe dışı) → `propose_send` ile birebir aynı: ikinci
  `/agent/chat` isteği asla atılmaz, sonuç `ConfirmationCard`'a düşer.
- `autoPaid:true` (bütçe içi, `requiresConfirmation` alanı hiç yok) → döngü kırılmaz, sonuç
  modele iletilir, model normal cevabını üretir (bu yol zaten çalışıyordu, ek testle teyit
  edildi).

**Dosyalar:** `src/backend/AgentOrchestrator.ts` (`CONFIRMABLE_TOOLS` sabiti,
`isAwaitingConfirmation` güncellendi), `src/backend/__tests__/AgentOrchestrator.test.ts`
(2 yeni test). Test durumu: 647 → 649.

### Çözüldü: X402PaymentCard eksikti (eski KALAN İŞ madde 1)

**Bulundu (önce kırmızı test ile):** `pay_for_resource`'un otomatik ödeme sonucu
(`{ result: { autoPaid: true, ... } }`) `AgentOrchestrator` tarafından history'ye ekleniyordu
ama `AgentChatPanel.buildChatItems` bu şekli hiç tanımıyordu — mesaj sessizce hiçbir
`ChatItem`'a dönüşmüyordu (ne kart, ne breadcrumb, hiçbir şey). Hem yeni `X402PaymentCard`
bileşeni hem de `buildChatItems` entegrasyonu için önce component/mesaj render edilmeden
kırmızı test yazılıp doğrulandı, sonra düzeltilip yeşile alındı.

**Yapılanlar:**
- `X402PaymentCard.tsx` — `TransactionResultCard`'ın dekont dilini (daire ikon, başlık, tarih,
  ince ayraç, label/value satırlar, `shortenHex()` ile kısaltılmış+Etherscan linkli hash)
  paylaşan ama **ayrı, bağımsız** bir bileşen — `ConfirmationCard` akışının parçası değil,
  onay/red butonu hiç yok. "Kalan bakiye" yerine bilinçli olarak **"Kalan bütçe"**
  (`remainingBudgetUsd`) gösteriyor — bölüm 3'teki karar gereği native/shielded bakiye ile
  USDC harcaması hiç karışmasın diye.
- `AgentChatPanel.tsx`: yeni `isAutoPaidX402Result()` guard'ı + yeni `"x402Payment"`
  `ChatItem` kind'i. Diğer üç durumdan (`result`/`settling`/`settled`) farklı olarak, bu item
  `handleCardStatusChange`'in yeniden yazdığı bir marker DEĞİL — tool mesajının kendi ham
  içeriği doğrudan okunuyor (bu yol hiç `ConfirmationCard`/`onStatusChange`'den geçmiyor).
- Locale: yalnızca 2 yeni anahtar (`x402PaymentCardTitle`: "Otomatik ödeme yapıldı",
  `x402PaymentCardRemainingBudgetLabel`: "Kalan bütçe") — tutar/servis/işlem-no etiketleri
  mevcut anahtarlardan (`txResultAmountLabel`, `confirmationCardResource`, `txResultTxLabel`,
  `confirmationCardViewExplorer`) **yeniden kullanıldı**, kopyalanmadı. Parity testi (bölüm 13)
  doğruladı.

**Testler:** `X402PaymentCard.test.tsx` (8 test — başlık kullanıcı dili, tutar, servis, kalan
bütçe vs. kalan bakiye karışmaması, hash yokken satır hiç yok, hash varken kısaltılmış+link,
buton yok, tarih formatı) + `AgentChatPanel.test.tsx`'e 1 yeni test (autoPaid tool mesajı
`X402PaymentCard` olarak render edilir, hiçbir `ConfirmationCard` açılmaz, ham tool adı
görünmez).

**Dosyalar:** `src/components/X402PaymentCard.tsx` (yeni), `src/components/AgentChatPanel.tsx`,
`src/locales/en.json`/`tr.json`, `src/components/__tests__/X402PaymentCard.test.tsx` (yeni),
`src/components/__tests__/AgentChatPanel.test.tsx`. Test durumu: 649 → 658.

### Çözüldü: Uçtan uca entegrasyon testleri — X402SpendingLedger kayıtlarında eksik `timestamp` bulundu (eski KALAN İŞ madde 1)

**Yapılanlar:** `src/components/__tests__/x402EndToEnd.test.tsx` (yeni) — iki senaryo, gerçek
modüller birbirine bağlı (`AgentOrchestrator` + gerçek `AgentToolRunner` + gerçek
`AgentPolicyEngine` + gerçek `X402SpendingLedger` + gerçek `ConfirmationCard`/`X402PaymentCard`
render), yalnızca dış sınır (`fetch` — OpenRouter + x402 stub endpoint'leri) mock'landı:
- **Senaryo 1 (limit içi):** `pay_for_resource` çağrısından sonra tool-loop kırılmadan devam
  eder (`/agent/chat` iki kez çağrılır), `ConfirmationCard` hiç render edilmez,
  `X402PaymentCard` gerçek verilerle görünür, ledger'a gerçekten yazılır.
- **Senaryo 2 (limit dışı):** tool-loop kırılır, `ConfirmationCard` render edilir, onaylanınca
  gerçek EIP-3009 imzası üretilir + settle edilir + ledger'a kaydedilir.

**Bulundu (kırmızı, varsayımla değil — write path'i `console.log` ile adım adım izlenerek
teşhis edildi):** İlk yazımda her iki senaryo da son assertion'da (`ledger.getRecordsForAccount(...)`
→ `toHaveLength(1)`) kırmızıydı, `[]` dönüyordu. Teşhis: `chrome.storage.local` mock'unun ham
içeriği doğru kaydı içeriyordu (`{"id":...,"accountAddress":...,"amountUsd":0.01,...}`) ama
`X402SpendingLedger.getAll()` onu filtreleyip boş dizi döndürüyordu. Kök neden:
`isValidRecord()` bir `timestamp: number` alanı zorunlu tutuyor, ama hem
`AgentToolRunner.handlePayForResource` hem `ConfirmationCard`'ın `pay_for_resource` case'i
`recordPayment()`'ı **`timestamp` alanı hiç vermeden** çağırıyordu. Sonuç: her x402 ödemesi
sessizce geçersiz kayıt olarak yazılıyor, `getAll()`/`getSpentToday()`/
`getRemainingDailyBudget()` onu hiçbir zaman görmüyordu — yani otomatik-ödenen x402
harcamaları günlük bütçe hesabına **hiç girmiyordu**, bütçe tavanı fiilen işlevsizdi. Bu, kod
yazılırken fark edilmemiş gerçek bir entegrasyon bug'ıydı; önceki turlardaki testler
`recordPayment`'ı hep mock'lanmış/izole ledger ile çağırdığı için bu boşluğu hiç yakalamamıştı.

**Fix:** Her iki `recordPayment(...)` çağrısına da `timestamp: Date.now()` eklendi
(`src/backend/AgentToolRunner.ts`, `src/components/ConfirmationCard.tsx`).

**Doğrulanan davranış:** Fix sonrası her iki senaryo da yeşil; ledger kayıtları artık
`getAll()`/`getRecordsForAccount()`/`getSpentToday()` üzerinden gerçekten görünür oluyor.

**Dosyalar:** `src/backend/AgentToolRunner.ts`, `src/components/ConfirmationCard.tsx`,
`src/components/__tests__/x402EndToEnd.test.tsx` (yeni). Test durumu: 658 → 660.

### Çözüldü: x402Stub.ts'in yerini gerçek facilitator client'ı aldı (eski KALAN İŞ madde 1)

**Netleştirme (kod yazmadan önce, canlı doğrulandı):**
- **Facilitator:** Coinbase'in açık x402 protokolü, ücretsiz/genel `https://x402.org/facilitator`
  (auth/API key gerekmiyor) — `curl` ile canlı doğrulandı, şu an ayakta.
- **Ağ:** Base Sepolia — bölüm 6'daki Alchemy multichain key notuyla ve mevcut
  `VITE_BASE_SEPOLIA_USDC_ADDRESS` ile tutarlı.
- **Protokol sürümü:** Facilitator hem v1 (legacy, düz `network: "base-sepolia"` string,
  `maxAmountRequired`, `resource: string` — `x402Stub.ts`'in şekli) hem v2'yi (güncel, CAIP
  network id `eip155:84532`) aynı anda destekliyor (`GET /facilitator/supported` çıktısı canlı
  doğrulandı). **v1 hedeflendi** — kullanıcı onayıyla, mevcut koda en az değişiklik.
- **Şema karşılaştırması (canlı `curl` istekleriyle doğrulandı, coinbase/x402 repo'sundaki
  gerçek TypeScript tiplerinden okunarak):** `PaymentRequirements` alanları örtüşüyor (tek eksik:
  `outputSchema`, eklendi). EIP-3009 payload şekli (`{signature, authorization: {from,to,value,
  validAfter,validBefore,nonce}}`) `X402PaymentService.ts`'in ürettiğiyle birebir aynı — imzalama
  tarafında SIFIR değişiklik. Kritik farklar: (1) gerçek akış `/verify` + `/settle` iki ayrı
  çağrı istiyor, stub'ta `/verify` hiç yoktu; (2) settle yanıtındaki alan adı `txHash` değil
  `transaction` (canlı doğrulandı: `{"success":false,"network":"base-sepolia","transaction":"",
  "errorReason":"invalid_exact_evm_signature","payer":"0x933..."}`); (3) `validAfter`/
  `validBefore` extension'da `number`, facilitator'da `string` bekliyor.

**Yapılanlar:**
- `backend-proxy/src/x402FacilitatorClient.ts` (yeni) — `buildRealPaymentRequirements()`
  (payTo/asset env'den, deterministik), `verifyWithFacilitator()`/`settleWithFacilitator()`
  (gerçek facilitator'a `/verify` + `/settle`), `isExtensionSignedPayload()` (eski stub'ın hiç
  yapmadığı bir doğrulama — bkz. aşağıdaki kırmızı→yeşil), `settleX402PaymentReal()`
  (verify+settle orkestrasyonu, `transaction`→`txHash` çevirisi).
- `backend-proxy/src/index.ts`: `Env`'e `X402_USE_REAL_FACILITATOR`/`X402_PAYTO_ADDRESS`/
  `X402_USDC_ASSET_ADDRESS`/`X402_FACILITATOR_URL` eklendi. `handleX402PaymentRequired`/
  `handleX402Settle` artık `env.X402_USE_REAL_FACILITATOR === "true"` iken gerçek client'a,
  değilse (varsayılan) `x402Stub.ts`'e dallanıyor — **`x402Stub.ts` silinmedi**, feature flag
  ile geri dönülebiliyor.
- `backend-proxy/wrangler.toml`: `X402_USE_REAL_FACILITATOR = "false"` (varsayılan),
  `X402_PAYTO_ADDRESS = "0x9332339e54A27f9350C7Be300b4B9dEBc7D1c350"` (ArfheWallet test
  cüzdanı, kullanıcı tarafından verildi), `X402_USDC_ASSET_ADDRESS` — sabit kodlama yerine
  config/env değişkeni, bölüm 6'daki `.env.development`/`.env.production` deseniyle tutarlı.

**Kırmızı→yeşil (gerçekten uygulandı, varsayımla değil):** `buildFacilitatorPaymentPayload()`
içindeki `isExtensionSignedPayload()` kontrolü geçici olarak kaldırılıp testler koşuldu —
eski stub'ın kabul ettiği eksik bir `paymentPayload` (`{signature:"0xfake"}`, `authorization`
alanı yok) ile çağrıldığında kontrolsüz bir `TypeError` (`Cannot read properties of undefined
(reading 'from')`) fırlattığı gözlemlendi (kırmızı). Kontrol geri eklenip aynı testler tekrar
koşuldu, artık net bir hata mesajıyla reddediyor (yeşil).

**Testler:**
- `x402FacilitatorClient.test.ts` (16 test) — `buildRealPaymentRequirements`'ın deterministik
  olduğu ve eksik env'de açıkça hata verdiği; `isExtensionSignedPayload`/
  `buildFacilitatorPaymentPayload`'ın eski stub'ın kabul ettiği şekilleri reddettiği
  (kırmızı→yeşil bölümü); `verifyWithFacilitator`/`settleWithFacilitator`/
  `settleX402PaymentReal`'ın **canlı facilitator'dan gözlenen gerçek response örnekleriyle**
  (hem `unexpected_error`/`invalid_exact_evm_signature` hata örnekleri hem sentetik başarı
  örnekleri) doğru davrandığı — hiçbiri gerçek `x402.org`'a istek atmıyor, `fetch` mock'lu.
- `x402FacilitatorEndpoint.test.ts` (7 test, yeni) — `/agent/x402/payment-required` ve
  `/agent/x402/settle`'ı `env.X402_USE_REAL_FACILITATOR="true"` iken uçtan uca (SELF.fetch,
  mock'lu `fetch`) doğruluyor: gerçek v1 requirements döner (`_stub` yok), eski stub sözleşmesi
  reddedilir (kırmızı→yeşilin endpoint seviyesindeki karşılığı), verify+settle başarılı akışta
  `transaction`→`txHash` çevirisi doğru, verify başarısızsa 402 + `response.ok=false` (extension'ın
  `X402ProxyClient.settleX402Payment()`'ının throw etmesi için), facilitator'a ağ hatasında 502.
  Ayrıca bayrak `"false"` iken (varsayılan) davranışın hiç değişmediği ayrı bir describe bloğunda
  doğrulandı.
- `x402StubEndpoints.test.ts` (eski, dokunulmadı) — hâlâ 12/12 yeşil, stub yolu bozulmadı.

**Dosyalar:** `backend-proxy/src/x402FacilitatorClient.ts` (yeni), `backend-proxy/src/index.ts`,
`backend-proxy/wrangler.toml`, `backend-proxy/src/__tests__/x402FacilitatorClient.test.ts` (yeni),
`backend-proxy/src/__tests__/x402FacilitatorEndpoint.test.ts` (yeni). Test durumu (backend-proxy):
30 → **53**. Kök proje (extension tarafı): **660, değişmedi** — `X402ProxyClient.ts`/
`X402PaymentService.ts`/`ConfirmationCard.tsx`/`AgentToolRunner.ts` arayüzleri hiç değişmedi.

**⚠️ Henüz doğrulanmadı, "tamamlandı" ile karıştırılmamalı:** Bu kod gerçek facilitator'ın
şemasıyla eşleşiyor ve mock'lu testlerle doğrulandı, verify/settle endpoint'lerine bu turda
GERÇEKTEN `curl` ile istek atılıp gerçek response şekilleri gözlemlendi — ama geçerli bir
EIP-3009 imzasıyla, gerçek testnet USDC'nin uçtan uca (extension → backend-proxy → facilitator →
zincir) başarıyla taşındığı hiç görülmedi (kullanılan test imzası kasıtlı olarak geçersizdi, bkz.
`invalid_exact_evm_signature` örneği). `X402_USE_REAL_FACILITATOR` prod'da/dev'de hâlâ `"false"`.
Bu, Chrome'da elle uçtan uca test aşamasını bekliyor.

**KALAN İŞ — sıradaki oturum buradan devam etmeli:**
1. Chrome'da elle uçtan uca test — hem x402 akışının genel UI/UX'i (limit-içi otomatik ödeme,
   limit-dışı `ConfirmationCard` onayı) hem de `X402_USE_REAL_FACILITATOR="true"` yapılıp gerçek
   bir Base Sepolia test cüzdanıyla, gerçek testnet USDC ile uçtan uca bir settle'ın fiilen
   başarılı olduğu HİÇ görülmedi. Önceki fazlarda elle test defalarca kod-only testlerin
   kaçırdığı gerçek bug'ları bulmuştu (bkz. bölüm 13), bu yüzden mutlaka yapılmalı — bu madde
   "tamamlandı" olarak işaretlenmedi.

### Çözüldü: Chrome'da elle test sırasında bulunan gerçek bug — pay_for_resource AGENT_TOOLS'ta hiç yoktu

Bu, "KALAN İŞ" listesindeki planlı bir madde DEĞİL — bölüm 5/14'ün öngördüğü elle test adımı
sırasında yeni keşfedilen bir bug.

**Bulundu:** Chrome'da Arfio'ya "hangi ücretli kaynaklara erişebiliyorsun" diye sorulduğunda,
model kendi yetkisi olmadığını söyledi — `pay_for_resource`'un varlığından tamamen habersizdi.

**Kök neden:** `AgentOrchestrator.ts` LLM'e gönderilecek tool şemasını `AGENT_TOOLS`'tan
(`agentTools.ts`) alıyor. `AgentPolicyEngine.ts`'teki `X402_TOOLS` sabiti yalnızca
`CONFIRMABLE_TOOLS` (tool_call SONUCU geldiğinde döngüyü kırma kararı) içinde kullanılıyordu —
ama `agentTools.ts`'in `AGENT_TOOLS` dizisine `pay_for_resource` hiç eklenmemişti. Model bu
tool'u şemada hiç görmediği için asla çağıramıyordu; tüm önceki turlardaki testler
(`AgentOrchestrator.test.ts`, `AgentToolRunner.test.ts`, `x402EndToEnd.test.tsx`) tool_call'ı
mock response içinde ELLE simüle ettiği için (`function: { name: 'pay_for_resource', ... }`
sabit yazılmış), hiçbiri gerçek `AGENT_TOOLS` listesini okumuyordu — şemanın eksik olduğunu
yakalayamadılar. `AgentPolicyEngine.ts`'teki `X402_TOOLS`'un kendi JSDoc'u aslında
"callers (AgentToolRunner, agentTools.ts) classify a tool name by referencing this constant"
diyordu — yani niyet baştan beri buydu, uygulanmamıştı.

**Fix:** `agentTools.ts`'e `propose_*` deseniyle birebir tutarlı bir `pay_for_resource` tanımı
eklendi (`resource: string`, zorunlu; description modelin bunu NE ZAMAN çağıracağını — ücretli
kaynak erişimi, normal get_* okumalarıyla karıştırılmaması gerektiğini, otomatik/onaylı ayrımını
kullanıcıya asla varsayarak anlatmaması gerektiğini — açıkça belirtiyor). `AllowedToolName`
union'ına `X402Tool` eklendi (`ReadOnlyTool | ProposalTool | X402Tool`).

**Yapısal kilit (tekrar yaşanmasın diye):** `agentTools.test.ts`'e yeni bir invariant testi
eklendi — `X402_TOOLS` (≡ `CONFIRMABLE_TOOLS`'un x402 bacağı, `PROPOSAL_TOOLS ∪ X402_TOOLS`)
içindeki her isim için bir `AGENT_TOOLS` tanımı olduğunu doğruluyor. Bu, `AgentPolicyEngine`'e
yeni bir `X402_TOOLS`/`PROPOSAL_TOOLS` üyesi eklenip `agentTools.ts`'e eklenmesi unutulursa
kırmızı olacak — elle hatırlamaya güvenmek yerine.

**Kırmızı→yeşil (gerçekten uygulandı):** `agentTools.ts`'ten `pay_for_resource` tanımı geçici
olarak kaldırılıp testler koşuldu — yeni invariant testi dahil 3 test kırmızı oldu (`X402_TOOLS
içindeki her isim için bir AGENT_TOOLS tanımı vardır` testi tam olarak bu bug'ı yakaladı).
Tanım geri eklenip testler tekrar koşuldu, hepsi yeşil.

**Testler:** `agentTools.test.ts` — 18 → 20 test (yeni `pay_for_resource` şema testi, yeni
`X402_TOOLS` invariant testi, tool sayısı 7 → 8 güncellendi).

**Dosyalar:** `src/backend/agentTools.ts`, `src/backend/__tests__/agentTools.test.ts`. Test
durumu: 660 → **662**. Kod-only değişiklik — dev server'lara (wrangler dev/vite dev) dokunulmadı.

**Not:** Bu fix `X402_USE_REAL_FACILITATOR` bayrağından bağımsız — stub yolunda da gerçek
facilitator yolunda da geçerli, çünkü sorun modelin tool'u görüp göremediğiyle ilgiliydi, hangi
backend'e settle edildiğiyle değil.
