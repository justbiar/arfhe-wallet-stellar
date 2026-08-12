# ArfheWallet — AI Agent Entegrasyonu: Bağlam Dosyası

> Devir teslim / hatırlatma dosyası. Bir sonraki oturumda buradan devam edilecek.
> Son güncelleme: 2026-08-12 (504 test yeşil, build temiz; Sepolia testnet üzerinde
> gerçek uçtan uca onay testi, AgentChatPanel chat history persistence fix'i,
> backend-proxy'nin non-JSON upstream body fix'i, ConfirmationCard'ın aktif hesap
> değişiminde otomatik iptal fix'i, hesap-bazlı sohbet/öneri geçmişi ayrımı ve
> agent'a "Arfio" kimliği tamamlandı — bkz. bölüm 3, 8-9).

## 1. Genel Amaç

ArfheWallet'a (FHE tabanlı Chrome extension cüzdan) AI agent entegrasyonu. Kullanıcı
sohbet ederek bakiyesini sorabilir, işlem önerisi (send/shield/unshield) alabilir,
onaylarsa gerçek işlem atılır. LLM sağlayıcısı **OpenRouter**, yalnızca ücretsiz
modeller kullanılıyor — bütçe yok.

## 2. Mimari Özet

```
Extension (AgentChatPanel)
  → AgentOrchestrator
    → Backend Proxy (Cloudflare Worker, backend-proxy/)
      → OpenRouter
        → tool_calls
          → AgentToolRunner
            → AgentPolicyEngine
            → Network.ts / TransactionSimulator
          → ConfirmationCard
            → gerçek imzalama (SendPanel/ShieldPanel akışıyla aynı Network.ts fonksiyonları)
```

## 3. Tamamlanan Fazlar

- **Faz 0** — `AgentPolicyEngine.ts`: forbidden tools listesi, öneri/bakiye ratio cap,
  oturum başına öneri sayısı cap.
- **Faz 1a** — Read-only tool'lar (`get_balance`, `get_shielded_balance`,
  `get_shielded_portfolio`, `get_pending_claims`). `backend-proxy/` kuruldu ve
  OpenRouter'a bağlandı. Eski `AgentService.ts`/`Agent.tsx` (Biar'ın sistemi) kaldırılıp
  yeni sistemle değiştirildi.
- **Faz 1b** — Proposal tool'lar (`propose_send`, `propose_shield`, `propose_unshield`),
  `ConfirmationCard`, `AgentChatPanel`'e tam entegrasyon (kart render, onay/red akışı,
  input kilidi, tek seferde tek kart garantisi).
- **Faz 1c** — UX/hesap-ayrımı geçişi: chat history + Agent Geçmişi artık hesap bazlı
  (bkz. bölüm 9), "Yeni Sohbet" butonu, hazır soru butonları, agent'a "Arfio" kimliği
  (sistem promptu + UI metinleri + 🤖 emoji avatar — bkz. bölüm 4).

## 4. Önemli Teknik Kararlar

- **Agent ASLA imzalama/gönderme yapmaz.** Sadece `ConfirmationCard`'daki
  `handleApprove`, gerçek `Network.ts` fonksiyonlarını (`sendTransaction`,
  `shieldNative`, `unshieldAndClaim`) çağırır. `AgentToolRunner`/`AgentOrchestrator`
  yalnızca önizleme üretir.
- **Model fallback zinciri** (`backend-proxy/src/modelConfig.ts`):
  `openrouter/free` → `nvidia/nemotron-3-ultra-550b-a55b:free` →
  `google/gemma-4-31b-it:free`. Ücretsiz model listesi rotasyona tabi; model
  404/429/5xx dönerse otomatik sıradakine geçilir.
- **Adresler `ConfirmationCard`'da onay anında yeniden çözülür** — dondurulmuş preview
  verisine güvenilmez (wrapper/alıcı adresi canlı zincir durumundan taze okunur).
- **Arbitrary ERC-20 sembol desteği proposal tool'larda yok** — symbol→contract-address
  registry'ye (TokenCache) erişim yok, sadece native token destekleniyor.

## 5. Henüz Yapılmadı / Sıradaki Adımlar

- **Faz 2**: RAG eğitim katmanı — `FHE_COMPLETE_GUIDE.md`/README'den statik sistem
  promptu yerine gerçek retrieval.
- **Faz 3**: x402 mikro-ödemeler (opsiyonel, uzak gelecek).
- **Faz 4**: MCP uyumluluğu (opsiyonel).
- Model çıktı kalitesi sorunu henüz çözülmedi — bkz. bölüm 9.

## 6. Geliştirme Ortamı Notları

- Backend proxy lokal test: `cd backend-proxy && pnpm exec wrangler dev`
  (localhost:8787).
- `.env`'de `VITE_AGENT_PROXY_URL=http://localhost:8787` tanımlı olmalı.
- Extension'ı build etmek için: `pnpm build` (proje kökünde), sonra
  `chrome://extensions/`'ta yenile.
- Test cüzdanı ID: `ajfpejolnhgeflhgjmboikiffpdlhngi` (unpacked yükleme, kalıcı
  olmayabilir).
- OpenRouter key `.dev.vars`'ta (git'e girmez); production için
  `wrangler secret put OPENROUTER_API_KEY` gerekir.

## 7. Test Durumu

504 test yeşil, `pnpm build` (vite, tip kontrolü dahil) temiz (bu commit itibarıyla).
`backend-proxy/` ayrı bir paket — kendi test suite'i yok, `tsc --noEmit` (`npm run
typecheck`) ile doğrulanıyor.

## 8. Sepolia Testnet Uçtan Uca Onay Testi (2026-08-12)

Backend proxy lokal (`wrangler dev`, localhost:8787) + build edilmiş extension
(`ajfpejolnhgeflhgjmboikiffpdlhngi`, unpacked) ile gerçek Sepolia testnet üzerinde
uçtan uca akış doğrulandı:

- **Read-only tool**: `get_balance` çağrısı doğru bakiyeyi döndürdü (0.05 ETH,
  Google Cloud Web3 faucet'ten alındı).
- **Proposal + onay + gerçek tx**: `propose_send` (0.001 ETH →ikinci test adresi)
  ConfirmationCard'da doğru gönderen/alıcı/miktar/gas ile göründü; onaydan sonra
  gerçek `Network.ts` `sendTransaction` çağrısı tetiklendi. Zincirde doğrulandı:
  - Tx hash: `0xfcc1b3fa37899c83da132d03c2307420e966194f1273b2aac615fd82310b4bb2`
  - Status: `0x1` (success), chainId `11155111` (Sepolia), block `11472598`,
    gasUsed `21000`.
  - Bakiye 0.05 → ~0.04898 ETH'ye düştü (miktar + gas ile tutarlı).
- **AgentPolicyEngine ratio cap**: Kalan bakiyenin ~%82'sini (0.04 ETH / ~0.049 ETH,
  `maxProposalRatio` varsayılanı %50'nin üzerinde) gönderme isteği reddedildi;
  red mesajı kullanıcıya göründü ("%81.7'sini oluşturuyor... %50'den fazla gönderme
  limitine takıldınız."). `exceeds_balance_ratio` kararının UI'a kadar doğru
  ulaştığı doğrulandı (bkz. bölüm 9 — bu test sırasında bir UI bug'ı bulunup
  düzeltildi).

## 9. Bilinen Sorunlar / Çözülenler

### Çözüldü: Hesap-bazlı ayrım eksikliği — sohbet/Agent Geçmişi tüm hesaplar arasında paylaşılıyordu, agent kimliksizdi

**Bulundu:** `agent_chat_history` ve `agent_proposal_history` tek, hesaptan bağımsız
bir liste olarak tutuluyordu — hesap değiştirmek chat'i/geçmişi hiç etkilemiyordu
(hepsi karışık görünüyordu). Ayrıca agent'ın bir kimliği/ismi yoktu ("Wallet
Assistant" + jenerik robot ikonu).

**Mimari karar — state `pages/Agent.tsx`'e taşındı:** `usePersistedState`
örnekleri birbiriyle senkron değil (her biri chrome.storage.session'ı yalnızca
mount anında okuyor, yazmalar tek yönlü) — hem `AgentChatPanel` hem `Agent.tsx`
aynı key için ayrı birer örnek tutsaydı, biri diğerinin yazdığını görmeden üstüne
yazabilirdi (kaybolan güncelleme). Çözüm: `agent_chat_history`
(`Record<accountAddress, ChatMessage[]>`) ve `agent_proposal_history`
(`ProposalRecord[]`, her kayıtta `accountAddress` alanı) artık yalnızca
`Agent.tsx`'te (`/agent` route'unun her zaman mount'lu olan üst bileşeni)
tutuluyor; `AgentChatPanel`/`AgentProposalHistoryPanel` bunları prop olarak alıyor.
Bu aynı zamanda hesap-değişimi orkestrasyonunun (aşağıda) hangi sekmede olursa
olsun çalışmasını garanti ediyor — mantık `AgentChatPanel` içinde olsaydı,
kullanıcı "Agent Geçmişi" sekmesindeyken hesap değiştirdiğinde hiç tetiklenmezdi.

**Depolama şeması — neden `Record<address, ChatMessage[]>` (hesaba göre değişen
bir storage key değil):** `usePersistedState`'in `useState` initializer'ı yalnızca
ilk mount'ta çalışıyor — `agent_chat_history:<address>` gibi hesaba göre değişen
bir key kullansaydık, hesap değiştiğinde bir an için eski hesabın mesajları
ekranda kalır, async okuma bitince değişirdi ("flash of stale content"). Tek key
altında tek bir map tutmak bunu tamamen ortadan kaldırdı — hesap değiştirmek artık
senkron bir map indexleme.

**Hesap değişimi orkestrasyonu (`Agent.tsx`, `previousAddressRef` ile):**
1. OUTGOING hesabın bekleyen bir önerisi varsa (`findPendingConfirmation`, artık
   `AgentProposalHistory.ts`'te — hem `AgentChatPanel` hem `Agent.tsx` kullanıyor)
   otomatik iptal edilir: `settled`/`rejected` marker'ı yazılır, `ProposalRecord`
   (`status: "user_cancelled"`, `reason: "Active account changed before approval"`
   — `ConfirmationCard.tsx`'in kendi auto-cancel effect'iyle **aynı sabit metin**,
   oradan export edildi: `ACCOUNT_CHANGED_REASON`) eklenir. `ConfirmationCard`'ın
   kendi effect'i artık pratikte hiç tetiklenmiyor (hesap değişince
   `conversationHistory` zaten aynı render'da yeni hesabınkine döndüğü için kart
   unmount oluyor, re-render değil) ama kod hâlâ orada — zararsız defense-in-depth.
2. INCOMING hesabın sohbetine bir sistem notu eklenir (`role:"system"`,
   `AgentChatPanel.tsx`'te yeni bir `"divider"` `ChatItem` kind'i olarak render
   edilir — modele de gönderiliyor, bilinçli bir basitlik tercihi, filtrelenmedi).
3. `ToastProvider`'ın `useToast()`'u ile toast gösterilir (uygulama kökünde
   render edildiği için hangi sekmede olunursa olsun görünür).
Kilitli→açık geçişi (`undefined` → adres) ve ilk mount bilinçli olarak "gerçek
hesap değişimi" sayılmıyor — bildirim/iptal tetiklenmiyor.

**Agent Geçmişi FIFO limiti artık hesap başına (global değil):**
`appendProposalRecords` yalnızca eklenen kayıtların ait olduğu hesabı trim ediyor
— az kullanılan bir hesaba geçip yeni bir öneri üretmek, yoğun kullanılan başka
bir hesabın eski kayıtlarını artık silmiyor.

**"Arfio" kimliği:** `AgentOrchestrator.buildSystemPrompt()` artık modele "Senin
adın Arfio" diyor (bu, `backend-proxy/` değil `src/backend/` içinde — proxy sadece
mesajları OpenRouter'a iletiyor, sistem promptunu extension oluşturuyor).
`panelTitle`/`panelEmptyState`/`panelPlaceholder`/`panelThinking`/`panelNoAccount`
Arfio'ya referans veriyor (en.json/tr.json). Gerçek bir illüstrasyon yok — 🤖 emoji
geçici avatar olarak `AgentChatPanel.tsx`'te `AGENT_AVATAR` sabiti üzerinden
kullanılıyor (boş ekran ikonu, mesaj/kart avatarları). Alt navigasyon barındaki
"Agent" sekme etiketi de "Arfio" oldu (`agent.navTabLabel`) — bunu yaparken fark
edildi: `ArfBottomBar.tsx` hiç i18n kullanmıyordu (Home/Explore/History etiketleri
hâlâ düz İngilizce literal string), bu tek etiket için `useTranslation` eklendi,
diğerleri bilinçli olarak dokunulmadan bırakıldı (kapsam dışı, ayrı bir iş).

**Test:** `AgentProposalHistory.test.ts` (19), `AgentChatPanel.test.tsx` (20, artık
prop-tabanlı bir test-harness'le), `AgentProposalHistoryPanel.test.tsx` (7, artık
`records` prop'uyla, storage'a dokunmadan), yeni `pages/__tests__/Agent.test.tsx`
(7 — hesap-değişim orkestrasyonu izole test ediliyor, `AgentChatPanel`/
`AgentProposalHistoryPanel` mock'lanarak). `ArfBottomBar.tsx` için önceden test
yoktu, hâlâ yok. 504 test yeşil, build temiz.

### Çözüldü: ConfirmationCard, aktif hesap değişince stale önizlemeyi onaylatabiliyordu

**Bulundu:** Sorulan bir soru üzerine kod incelemesiyle ortaya çıktı (henüz bir
testte gözlemlenmiş bir bug değildi): `ConfirmationCard` kendi `useActiveAccount()`'ını
çağırıyor, `AgentChatPanel`'inkinden bağımsız. Bir öneri kartı ekranda beklerken
kullanıcı başka bir hesaba geçip sonra Approve'a basarsa, imzalama **yeni aktif
hesapla** yapılıyordu — ama kartta gösterilen önizleme (simülasyon, risk seviyesi,
to/amount) `AgentToolRunner`'ın **eski hesap** için ürettiği veriydi, yeniden simüle
edilmiyordu. Güvenlik açığı değildi (gerçek `Network.ts` çağrıları hâlâ taze state
okuyordu) ama yanlış hesap/bakiye varsayımıyla onaylamaya açık bir UX riski.

**Fix:** `ConfirmationCard.tsx`'e `originalAddressRef` eklendi — kartın hangi hesap
için üretildiğini mount anında sabitliyor. İki katman koruma:
- Bir `useEffect([activeAccount, cardPhase])`, yalnızca `cardPhase === "review"`
  iken çalışıp güncel adresi `originalAddressRef`'le karşılaştırıyor; farklıysa
  kart yeni bir `"cancelled"` faza geçiyor (Approve/Reject butonları otomatik
  kayboluyor, zaten sadece `"review"`'de render ediliyorlardı) ve
  `onResolved({status:"rejected", toolName, reason:"Active account changed before
  approval"})` çağrılıyor.
- `handleApprove`'un en başına aynı karşılaştırma eklendi (defense-in-depth) —
  effect'in henüz yetişemediği bir race'i yakalamak için, imzalamaya geçmeden önce.

`ConfirmationOutcome`'un `rejected` varyantına opsiyonel `reason?: string` eklendi
(manuel red hâlâ `reason` taşımıyor, sadece otomatik iptal taşıyor).
`buildConfirmationOutcomeSummary` reason varsa modele ayrı bir mesaj
(`confirmationCardOutcomeCancelled`) üretiyor. `AgentProposalHistory.ts`'teki
`buildRecordFromOutcome` bu `reason`'ı `ProposalRecord.reason`'a taşıyor, yani
Agent Geçmişi sekmesinde "Cancelled — Active account changed before approval"
olarak görünüyor, normal kullanıcı redlerinden ayırt edilebiliyor.

489 test yeşil (4 yeni `ConfirmationCard` testi + 1 yeni `AgentProposalHistory`
testi dahil), `pnpm build` temiz. Not: `handleApprove`'daki defense-in-depth dalı,
React Testing Library'nin effect'leri her `act()`'te senkron flush etmesi nedeniyle
izole test edilemedi (efekt pratikte her zaman tıklamadan önce yetişiyor) — yine de
savunma amaçlı kodda duruyor.

### Çözüldü: Ratio-cap reddi / turn-limit sonrası boş chat ekranı

**Bulundu:** Adım 6 testi sırasında (ratio cap'i bilinçli aşan bir `propose_send`
isteği) AgentChatPanel hiçbir şey göstermedi — ne ConfirmationCard, ne red mesajı,
ne düz metin.

**Kök neden:** `AgentOrchestrator.runAgentTurn()`'ün erken-dönüş yolları (proxy
hatası → `RATE_LIMIT_REPLY`/`UPSTREAM_UNAVAILABLE_REPLY`/`GENERIC_ERROR_REPLY`/
`NOT_CONFIGURED_REPLY`, ve `MAX_TOOL_TURNS` (5) aşımı → `MAX_TURNS_EXCEEDED_REPLY`)
`reply` metnini dönüş değerinde taşıyordu ama bunu `updatedHistory`'ye bir mesaj
olarak hiç eklemiyordu. `AgentChatPanel.tsx` ise `reply`'yi kullanmıyor, sadece
`updatedHistory`'yi render ediyor (`buildChatItems`) — bu yüzden bu yollarda ekrana
hiçbir şey düşmüyordu. Ratio-cap reddi model'e `{error: ...}` tool mesajı olarak
gidiyor, model bunu görüp `propose_send`'i farklı miktarlarla tekrar deniyor, 5
tur limitine çarpıyor ve üretilen `MAX_TURNS_EXCEEDED_REPLY` hiçbir yere
yazılmadığı için kayboluyordu.

**Fix:** `AgentOrchestrator.ts`'e `finishTurn()` helper'ı eklendi — dönülen
`reply`, `updatedHistory`'nin son mesajı olarak zaten görünür değilse, orchestrator
onu bir `assistant` mesajı olarak ekliyor. Üç erken-dönüş noktası da (proxy hatası,
turn-limit, normal düz-metin cevabı) bu helper'dan geçirildi. `AgentChatPanel.tsx`
tarafında değişiklik gerekmedi — `buildChatItems` zaten dolu içerikli `assistant`
mesajlarını render ediyordu.

Testnet'te doğrulandı: aynı senaryo tekrarlandığında red mesajı artık kullanıcıya
görünüyor. 461 test hâlâ yeşil, `tsc --noEmit` temiz.

### Çözüldü: Chat history persistence eksikliği (popup kapanınca sohbet siliniyordu)

**Bulundu:** `AgentChatPanel.tsx`'te `conversationHistory` düz `React.useState<ChatMessage[]>([])`
ile tutuluyordu — hiçbir persistence mekanizması yoktu (ne `localStorage`, ne
`chrome.storage`). MV3 popup'ları kapanınca ayrı document context'i tamamen unmount
olduğundan, kullanıcı popup'ı her kapatıp açtığında sohbet sıfırdan başlıyordu.

**Fix:** `conversationHistory` state'i, projede zaten var olan
`usePersistedState` hook'una (`src/hooks/usePersistedState.ts`, `chrome.storage.session`
üzerinden — `ThemeContext`/`Home.tsx`'te aynı patern kullanılıyor) taşındı:
`usePersistedState<ChatMessage[]>("agent_chat_history", [])`. Sohbet artık popup
kapat/aç arasında korunuyor (tarayıcı yeniden başlatılınca veya extension reload
olunca temizleniyor — bilinçli tercih, `chrome.storage.local`'a değil `.session`'a
bağlandı). Temizleme zaten var olan "clear" ikonuyla (`DeleteSweep`) elle yapılıyor;
ayrı "yeni sohbet" / çoklu oturum kavramı eklenmedi, mesaj sayısı da sınırlanmadı.

Ek olarak bir double-submit riski bulunup aynı işte kapatıldı: kullanıcı
`ConfirmationCard`'da "Approve"ye bastıktan sonra ama gerçek tx broadcast/settle
olmadan popup kapanırsa, persist edilen history'de ilgili tool mesajı hâlâ
"pending preview" olarak duruyordu — popup yeniden açılınca kart tekrar
onaylanabilir görünüp aynı işlemin ikinci kez gönderilmesine yol açabilirdi.
`ConfirmationCard`'a `onApproveStarted` callback'i eklendi (approve anında, tx
broadcast edilmeden hemen önce tetiklenir); `AgentChatPanel` bunu görünce ilgili
tool mesajını `{ pendingSettlement: true, toolName }` ile işaretliyor —
`buildChatItems` bunu artık actionable bir kart değil, salt bilgilendirici
"işlem tamamlanması bekleniyor" satırı (`agent.panelSettlingNote`) olarak
render ediyor. Gerçek sonuç (`handleConfirmationResolved`) geldiğinde bu işaret
normal outcome mesajıyla eziliyor.

461 test hâlâ yeşil (mevcut `AgentChatPanel`/`ConfirmationCard` testleri değişiklik
olmadan geçti), `pnpm build` temiz.

### Çözüldü: backend-proxy, non-JSON upstream body'yi geçerli cevap sanıp zinciri erken kesiyordu

**Bulundu:** Manuel testte agent sürekli "Şu anda isteğinizi işleyemedim..."
(`GENERIC_ERROR_REPLY`) döndürdü. Extension console'unda gerçek hata görüldü:
`[AgentOrchestrator] proxy response missing a valid assistant message: {error:
'Upstream returned a non-JSON response.'}`.

**Kök neden:** `backend-proxy/src/index.ts`'teki `callModelChain()`, bir modelin
cevabı 429/404/5xx değilse (yani "başarılı" bir status'sa) onu doğrudan geçerli
cevap sayıp döndürüyordu — body'nin gerçekten JSON parse edilip edilmediğine
bakmadan. Body JSON değilse (`response.json()` reddediliyorsa) kod bunu sessizce
`{error: "Upstream returned a non-JSON response."}`'a çeviriyor ve **status 200
ile birlikte client'a bir "cevap" olarak** forward ediyordu — zincirdeki bir
sonraki modele hiç geçmeden. `AgentOrchestrator.ts` bunu 200 gördüğü için
`extractAssistantMessage`'a sokuyor, `choices` alanı olmadığından `null`
dönüyor, `GENERIC_ERROR_REPLY` tetikleniyordu. Yani fallback zincirinin asıl
amacı (tek bir modelin geçici bir hıçkırığına karşı dayanıklılık) tam da bu
senaryoda devre dışı kalıyordu, üstelik ham body hiçbir yerde loglanmadığı için
hangi modelin/ne tür bir cevabın buna yol açtığı da görünmüyordu.

**Fix:** `callModelChain()`'de non-JSON body artık 429/404/5xx ile aynı
retry-worthy kategoriye taşındı (`sawUnreachable = true; continue;`) — zincirdeki
bir sonraki modele geçiliyor, tek bir modelin bozuk cevabı artık tüm isteği
düşürmüyor. Ayrıca hangi modelin (`model` adı) ve hangi status'la bozuk body
döndürdüğü, body'nin kesilmiş bir örneğiyle (ilk 500 karakter) birlikte
`console.error` ile loglanıyor — bir sonraki oluşumda `wrangler tail` / dev
console'dan doğrudan teşhis edilebilir. İstemci tarafında ayrı bir mesaj
eklenmedi: zincir artık bu durumu retry ediyor, tamamen tükenirse zaten var olan
`unreachable` (502, "yapay zeka servisine ulaşılamıyor") yoluna düşüyor — ki bu
GENERIC_ERROR_REPLY'den daha doğru bir mesaj.

484 test hâlâ yeşil, `backend-proxy`'nin kendi `tsc --noEmit` kontrolü temiz.

### Çözülmedi: Model çıktı kalitesi sorunu (fallback modellerden dil/tutarlılık sızıntısı)

Testler sırasında iki kez gözlemlendi:
- Bakiye sorgusu cevabında anlamsız yabancı karakter/kelime sızıntısı ("です").
- Propose_send cevabında anlamsız kelime ("Petici") ve onay-sonrası akışın yanlış
  anlatılması (sanki onaydan sonra ayrı bir "transaction sirküle etme" adımı
  gerekiyormuş gibi — oysa tasarımda onay = otomatik gerçek `Network.ts` çağrısı).

Muhtemel neden: `modelConfig.ts`'deki ücretsiz model fallback zincirindeki
modellerin (örn. `nvidia/nemotron-3-ultra-550b-a55b:free`,
`google/gemma-4-31b-it:free`) çıktı kalitesi/talimat takibi tutarsız. Şu an bir
fix uygulanmadı — sıradaki oturumda ele alınmalı. Olası yönler: sistem promptuna
daha katı dil/format kısıtları eklemek, fallback zincirindeki model sırasını/
seçimini gözden geçirmek, ya da yanıtı post-process ederek anomali tespiti
yapmak.
