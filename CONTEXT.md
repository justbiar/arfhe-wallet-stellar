# ArfheWallet — AI Agent Entegrasyonu: Bağlam Dosyası

> Devir teslim / hatırlatma dosyası. Bir sonraki oturumda buradan devam edilecek.
> Son güncelleme: 2026-08-12 (461 test yeşil, `tsc --noEmit` temiz, Sepolia testnet
> üzerinde gerçek uçtan uca onay testi tamamlandı).

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

- ~~Testnet ETH ile gerçek uçtan uca onay testi~~ — **tamamlandı (2026-08-12)**, bkz.
  bölüm 8.
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

461 test yeşil, `tsc --noEmit` temiz (bu commit itibarıyla).

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
