# ArfheWallet — AI Agent Entegrasyonu: Bağlam Dosyası

> Devir teslim / hatırlatma dosyası. Bir sonraki oturumda buradan devam edilecek.
> Son güncelleme: 2026-08-11 (461 test yeşil, `tsc --noEmit` temiz).

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

- Testnet ETH ile gerçek uçtan uca onay testi (faucet'ten Sepolia ETH alınacak).
- **Faz 2**: RAG eğitim katmanı — `FHE_COMPLETE_GUIDE.md`/README'den statik sistem
  promptu yerine gerçek retrieval.
- **Faz 3**: x402 mikro-ödemeler (opsiyonel, uzak gelecek).
- **Faz 4**: MCP uyumluluğu (opsiyonel).

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
