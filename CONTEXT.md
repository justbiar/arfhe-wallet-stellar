# ArfheWallet — AI Agent Entegrasyonu: Bağlam Dosyası

> Devir teslim / hatırlatma dosyası. Bir sonraki oturumda buradan devam edilecek.
> Son güncelleme: 2026-08-16 (647 test yeşil; Faz 2 RAG tamamlandı, rewrite-omer
> merge edildi, tool-ismi sızıntısı + propose_send halüsinasyon bug'ı + dekont UI
> yeniden tasarımı + Alchemy multichain key sorunu çözüldü, Faz 3 (x402) ilk
> entegrasyon turu devam ediyor — bkz. bölüm 3, 5, 10-13).

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

- **Faz 3 (x402)**: İlk tur (5 izole parça) + entegrasyonun bir kısmı tamamlandı.
  Kalan: `AgentOrchestrator` tool-loop'una `pay_for_resource`'u tanıtmak (koşullu
  döngü kırma), `X402PaymentCard` UI bileşeni, uçtan uca entegrasyon testleri,
  gerçek facilitator entegrasyonu (şu an stub). Bkz. bölüm 13 — **sıradaki oturum
  buradan devam etmeli.**
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

**647 test yeşil** (kök proje, 35 dosya) + backend-proxy ayrı paket (kendi Vitest +
`@cloudflare/vitest-pool-workers` suite'i, 30 test, 4 dosya — `pnpm exec vitest run`
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

**Yeni tool:** `pay_for_resource(resource: string)` — `AgentToolRunner`'da
`handlePayForResource`. `propose_*` isimlendirmesi bilinçli olarak kullanılmadı
(semantik farklı: bu tool bütçe içindeyse gerçekten öder, sadece önizleme üretmez).

**Test durumu:** 647 test yeşil (bu bölümün sonunda).

**KALAN İŞ — sıradaki oturum buradan devam etmeli:**
1. `AgentOrchestrator`'ın tool-loop'una `pay_for_resource`'u tanıtmak: 
   `requiresConfirmation:false` ise döngü kırılmadan otomatik devam, `true` ise
   mevcut `PROPOSAL_TOOLS` gibi döngü kırılıp `ConfirmationCard`'a düşsün.
2. `X402PaymentCard.tsx` — otomatik ödeme bilgilendirme kartı (dekont diliyle,
   onay istemez): daire ikon, başlık, tarih, tutar, servis/kaynak, kalan bütçe.
   `AgentChatPanel.buildChatItems`'a yeni bir `"x402Payment"` `ChatItem` kind'i.
3. Locale: yeni metinler `en.json`/`tr.json`'a, parity testinin yakaladığını
   doğrula.
4. Uçtan uca entegrasyon testleri: limit-içi otomatik akış (kart hiç açılmadan
   `X402PaymentCard` render edilir, ledger'a kaydedilir) + limit-dışı akış
   (`ConfirmationCard` açılır, onaylanınca doğru ödeme yapılır).
5. Bu ilk turun kapsamı dışında bırakılanlar: gerçek facilitator entegrasyonu
   (stub'ın yerini alacak), Chrome'da elle uçtan uca test (henüz hiç yapılmadı —
   önceki fazlarda elle test defalarca kod-only testlerin kaçırdığı gerçek
   bug'ları bulmuştu, bu yüzden entegrasyon bitince mutlaka yapılmalı).
