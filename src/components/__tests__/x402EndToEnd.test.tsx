/// <reference types="vitest/globals" />
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { Wallet } from 'ethers';
import * as React from 'react';
import '../../i18n.js';
import AgentChatPanel from '../AgentChatPanel';
import { WalletContext } from '../../AppContext';
import { ActiveAccountContext } from '../../ActiveAccountProvider';
import { configureAgentOrchestrator, type ChatMessage } from '../../backend/AgentOrchestrator';
import { configureAgentToolRunner, resetAgentToolRunner } from '../../backend/AgentToolRunner';
import { configureX402ProxyClient } from '../../backend/X402ProxyClient';
import { X402SettingsService } from '../../backend/X402SettingsService';
import { X402SpendingLedger } from '../../backend/X402SpendingLedger';
import { recoverAuthorizationSigner, type Eip3009SignedAuthorization } from '../../backend/X402PaymentService';
import { NetworkId } from '../../backend/NetworkTypes';
import type { AppContext } from '../../AppContext';
import type Account from '../../backend/Account';
import type { ProposalRecord } from '../../backend/AgentProposalHistory';

/**
 * x402 UÇTAN UCA entegrasyon testleri (Faz 3, KALAN İŞ eski madde 1).
 *
 * Önceki turlarda AgentPolicyEngine, X402SpendingLedger, ConfirmationCard, X402PaymentCard hep
 * AYRI AYRI (kendi mock'ları ile) test edildi. Bu dosya HİÇBİRİNİ mock'lamıyor — AgentOrchestrator,
 * AgentToolRunner, AgentPolicyEngine, X402SettingsService, X402SpendingLedger, X402PaymentService,
 * ConfirmationCard, X402PaymentCard, AgentChatPanel'in TAMAMI gerçek. Yalnızca dış sınır
 * mock'lanıyor: `global.fetch` (OpenRouter/backend-proxy'ye giden her istek, x402 stub
 * endpoint'leri dahil — bunlar zaten backend-proxy tarafında STUB, burada da öyle simüle
 * ediliyor) ve `activeAccount.ethers_wallet` gerçek bir ethers.Wallet (test-only sabit private
 * key — gerçek imzalama, gerçek EIP-712 hash'i).
 */

const PROXY_BASE_URL = 'https://proxy.example.test';
const RESOURCE = 'https://api.example.com/weather';
const USDC_BASE_SEPOLIA = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
// Test-only anahtar (hardhat'ın herkese açık, fonsuz test hesaplarından biri) — X402PaymentService.test.ts'teki ile aynı.
const TEST_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

function proxyResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function assistantChoice(message: Record<string, unknown>) {
  return { choices: [{ message: { role: 'assistant', ...message } }] };
}

function paymentRequiredBody(maxAmountRequired: string) {
  return {
    x402Version: 1,
    error: 'STUB',
    accepts: [
      {
        scheme: 'exact',
        network: 'base-sepolia',
        maxAmountRequired,
        resource: RESOURCE,
        description: 'weather data',
        mimeType: 'application/json',
        payTo: '0x00000000000000000000000000000000000000f1',
        maxTimeoutSeconds: 60,
        asset: USDC_BASE_SEPOLIA,
        extra: { name: 'USD Coin', version: '2' },
      },
    ],
    _stub: true,
  };
}

/**
 * Tek fetch mock'u, URL'e göre yönlendirir — /agent/chat sırayla tüketilen bir kuyruk (turn
 * sırası önemli), /agent/x402/* ve /agent/retrieve-context tekrar tekrar aynı cevabı verir
 * (ConfirmationCard onay anında ödeme gereksinimini YENİDEN çektiği için payment-required
 * birden fazla kez çağrılabilir — bkz. CONTEXT.md bölüm 4).
 */
function stubFetch(chatResponses: unknown[], maxAmountRequired: string, settleTxHash: string) {
  const chatQueue = [...chatResponses];
  const fetchSpy = vi.fn(async (url: string) => {
    const u = String(url);
    if (u.includes('/agent/retrieve-context')) return proxyResponse(200, { chunks: [] });
    if (u.includes('/agent/x402/payment-required')) return proxyResponse(402, paymentRequiredBody(maxAmountRequired));
    if (u.includes('/agent/x402/settle')) return proxyResponse(200, { success: true, txHash: settleTxHash, network: 'base-sepolia', _stub: true, note: 'STUB' });
    if (u.includes('/agent/chat')) {
      const next = chatQueue.shift();
      if (!next) throw new Error('stubFetch: unexpected extra /agent/chat call');
      return next;
    }
    throw new Error(`stubFetch: unexpected URL ${u}`);
  });
  vi.stubGlobal('fetch', fetchSpy);
  return fetchSpy;
}

function chatCalls(fetchSpy: ReturnType<typeof vi.fn>) {
  return fetchSpy.mock.calls.filter(([url]) => String(url).includes('/agent/chat'));
}

function settleCalls(fetchSpy: ReturnType<typeof vi.fn>) {
  return fetchSpy.mock.calls.filter(([url]) => String(url).includes('/agent/x402/settle'));
}

describe('x402 uçtan uca entegrasyon (gerçek modüller, yalnızca fetch mock)', () => {
  const testWallet = new Wallet(TEST_PRIVATE_KEY);
  const ACCOUNT_ADDRESS = testWallet.address;
  const mockAccount = { GetAddress: () => ACCOUNT_ADDRESS, ethers_wallet: testWallet } as unknown as Account;

  function makeWallet(): AppContext {
    const network = { network_id: NetworkId.Base_Sepolia, currency_symbol: 'ETH' };
    return {
      networkProvider: {
        getActiveNetworkId: () => NetworkId.Base_Sepolia,
        getActiveNetwork: () => network,
      },
      pendingClaimQueue: {},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal mock for integration test
    } as any as AppContext;
  }

  function Harness() {
    const [conversationHistory, setConversationHistory] = React.useState<ChatMessage[]>([]);
    const [, setProposalHistory] = React.useState<ProposalRecord[]>([]);
    return (
      <WalletContext.Provider value={makeWallet()}>
        <ActiveAccountContext.Provider value={{ activeIndex: 0, activeAccount: mockAccount, setActiveIndex: vi.fn() }}>
          <AgentChatPanel
            conversationHistory={conversationHistory}
            setConversationHistory={setConversationHistory}
            setProposalHistory={setProposalHistory}
          />
        </ActiveAccountContext.Provider>
      </WalletContext.Provider>
    );
  }

  beforeEach(async () => {
    resetAgentToolRunner();
    configureAgentOrchestrator({ proxyBaseUrl: PROXY_BASE_URL });
    configureX402ProxyClient({ proxyBaseUrl: PROXY_BASE_URL });
    configureAgentToolRunner({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal Network stand-in, x402 never touches Network.ts
      getNetwork: () => ({ network_id: NetworkId.Base_Sepolia }) as any,
      getAccount: () => mockAccount,
      getUsdcTokenIdentity: (networkId) =>
        Number(networkId) === NetworkId.Base_Sepolia
          ? { address: USDC_BASE_SEPOLIA, name: 'USD Coin', version: '2', chainId: NetworkId.Base_Sepolia }
          : undefined,
    });
    await new X402SpendingLedger().clearAll();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetAgentToolRunner();
  });

  // ─── Senaryo 1: limit içi — tam otomatik akış ────────────────────
  it('limit içindeyse: tool-loop kırılmadan devam eder, ConfirmationCard HİÇ render edilmez, X402PaymentCard görünür, ledger\'a gerçekten kaydedilir', async () => {
    await X402SettingsService.saveSettings({ enabled: true, perTransactionCapUsd: 0.5, dailyBudgetCapUsd: 5 });

    const toolCallResponse = proxyResponse(
      200,
      assistantChoice({
        content: '',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'pay_for_resource', arguments: JSON.stringify({ resource: RESOURCE }) } }],
      })
    );
    const finalResponse = proxyResponse(200, assistantChoice({ content: 'Ödeme otomatik olarak yapıldı, işte hava durumu verisi.' }));
    const fetchSpy = stubFetch([toolCallResponse, finalResponse], '10000', '0xE2ESETTLED1');

    render(<Harness />);
    fireEvent.change(screen.getByPlaceholderText(/Ask Arfio about your balance/i), { target: { value: 'şu servise eriş' } });
    fireEvent.click(screen.getByRole('button', { name: /send message/i }));

    await waitFor(() => expect(screen.getByText('Ödeme otomatik olarak yapıldı, işte hava durumu verisi.')).toBeInTheDocument());

    // Tool-loop kırılmadan devam etti: /agent/chat İKİ kez çağrıldı (tool_call turu + final tur).
    expect(chatCalls(fetchSpy)).toHaveLength(2);

    // X402PaymentCard render edildi, ConfirmationCard'ın "Approve" butonu HİÇ görünmedi.
    expect(screen.getByText('Automatic payment made')).toBeInTheDocument();
    expect(screen.getByText('0.01 USDC')).toBeInTheDocument();
    expect(screen.getByText(RESOURCE)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /approve/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/pay_for_resource/)).not.toBeInTheDocument();

    // Ledger'a GERÇEKTEN kaydedildi — mock değil, aynı chrome.storage.local'ı okuyan taze bir instance.
    const ledger = new X402SpendingLedger();
    const records = await ledger.getRecordsForAccount(ACCOUNT_ADDRESS);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ amountUsd: 0.01, service: RESOURCE, txHash: '0xE2ESETTLED1' });
  });

  // ─── Senaryo 2: limit dışı — ConfirmationCard'a düşer, onaylanınca gerçekten ödenir ──
  it('limit dışındaysa: tool-loop kırılır, ConfirmationCard render edilir, onaylanınca GERÇEKTEN imzalanır+settle edilir+ledger\'a kaydedilir', async () => {
    // perTransactionCapUsd, payment-required'ın döneceği $0.01'in altında — bütçe dışı.
    await X402SettingsService.saveSettings({ enabled: true, perTransactionCapUsd: 0.005, dailyBudgetCapUsd: 5 });

    const proposalResponse = proxyResponse(
      200,
      assistantChoice({
        content: 'Bu servise erişim için onayınız gerekiyor.',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'pay_for_resource', arguments: JSON.stringify({ resource: RESOURCE }) } }],
      })
    );
    // Kuyrukta TEK yanıt var — tool-loop kırılmazsa (bug varsa) stubFetch ikinci çağrıda patlar.
    const fetchSpy = stubFetch([proposalResponse], '10000', '0xE2ESETTLED2');

    render(<Harness />);
    fireEvent.change(screen.getByPlaceholderText(/Ask Arfio about your balance/i), { target: { value: 'şu servise eriş' } });
    fireEvent.click(screen.getByRole('button', { name: /send message/i }));

    // ConfirmationCard gerçekten render edildi (Approve butonu var).
    const approveButton = await screen.findByRole('button', { name: /approve/i });
    expect(chatCalls(fetchSpy)).toHaveLength(1); // tool-loop kırıldı, ikinci /agent/chat asla atılmadı

    // Onayla — gerçek handleApprove: gereksinimi yeniden çeker, GERÇEK EIP-712 imzalar, settle eder.
    fireEvent.click(approveButton);

    await waitFor(() => expect(screen.getByText('x402 Payment successful')).toBeInTheDocument());

    // Onay sonrası da HİÇBİR ikinci /agent/chat isteği atılmadı (bölüm 12'deki "proaktif değil" ilkesi).
    expect(chatCalls(fetchSpy)).toHaveLength(1);

    // Ledger'a GERÇEKTEN kaydedildi — bölüm 3 madde 6'daki "manuel onaylanan limit-dışı ödemeler
    // de ledger'a giriyor" kararının uçtan uca kanıtı.
    const ledger = new X402SpendingLedger();
    const records = await ledger.getRecordsForAccount(ACCOUNT_ADDRESS);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ amountUsd: 0.01, service: RESOURCE, txHash: '0xE2ESETTLED2' });

    // Üretilen imza GERÇEKTEN geçerli — settle isteğinin gövdesinden çıkarılıp ethers.verifyTypedData
    // (recoverAuthorizationSigner üzerinden) ile bağımsız doğrulanıyor, "imza gönderildi" değil
    // "bu imza gerçekten bu cüzdana ait" kanıtlanıyor (Faz 3 Parça 5'teki disiplinin aynısı).
    const settleCall = settleCalls(fetchSpy)[0];
    const settleBody = JSON.parse(String(settleCall[1]?.body)) as { paymentPayload: Eip3009SignedAuthorization };
    const recovered = recoverAuthorizationSigner(
      { address: USDC_BASE_SEPOLIA, name: 'USD Coin', version: '2', chainId: NetworkId.Base_Sepolia },
      settleBody.paymentPayload
    );
    expect(recovered.toLowerCase()).toBe(ACCOUNT_ADDRESS.toLowerCase());
  });
});
