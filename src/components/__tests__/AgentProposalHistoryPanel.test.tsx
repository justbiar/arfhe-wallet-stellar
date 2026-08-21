/// <reference types="vitest/globals" />
import { render, screen, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import { changeLanguage } from '../../i18n.js';
import AgentProposalHistoryPanel from '../AgentProposalHistoryPanel';
import { WalletContext } from '../../AppContext';
import { ActiveAccountContext } from '../../ActiveAccountProvider';
import type { AppContext } from '../../AppContext';
import type Account from '../../backend/Account';
import type { ProposalRecord } from '../../backend/AgentProposalHistory';
import { PROPOSAL_TOOLS, X402_TOOLS } from '../../backend/AgentPolicyEngine';

/**
 * AgentProposalHistoryPanel testleri
 *
 * Bu panel salt-okunur ve artık `records`'ı prop olarak alıyor (storage'ı Agent.tsx sahipleniyor
 * — tek usePersistedState örneği, bkz. Agent.tsx'in dosya başı yorumu). Panel yalnızca aktif
 * hesaba (`useActiveAccount()`) göre filtreleyip render ediyor, hiçbir yazma yapmıyor.
 */

const TEST_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const OTHER_ADDRESS = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

function makeWallet(): AppContext {
  return {
    networkProvider: {
      getActiveNetwork: () => ({ currency_symbol: 'ETH', network_id: 11155111 }),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal mock for unit tests
  } as any as AppContext;
}

// `null` (not `undefined`) signals "no active account" — a JS default parameter only kicks in
// for an explicit `undefined` argument, so `null` is the only way a caller can opt out of it.
function renderPanel(records: ProposalRecord[], address: string | null = TEST_ADDRESS) {
  const account = address ? ({ GetAddress: () => address } as unknown as Account) : undefined;
  return render(
    <WalletContext.Provider value={makeWallet()}>
      <ActiveAccountContext.Provider value={{ activeIndex: 0, activeAccount: account, setActiveIndex: vi.fn() }}>
        <AgentProposalHistoryPanel records={records} />
      </ActiveAccountContext.Provider>
    </WalletContext.Provider>
  );
}

function makeRecord(overrides: Partial<ProposalRecord> = {}): ProposalRecord {
  return {
    id: 'call_1',
    accountAddress: TEST_ADDRESS,
    toolName: 'propose_send',
    amount: '0.1',
    tokenSymbol: undefined,
    recipient: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
    status: 'approved',
    timestamp: Date.parse('2026-08-12T10:00:00Z'),
    ...overrides,
  };
}

describe('AgentProposalHistoryPanel', () => {
  it('kayıt yokken boş durum metnini gösterir', () => {
    renderPanel([]);
    expect(screen.getByText(/No proposal history yet/i)).toBeInTheDocument();
  });

  it('onaylanan bir kaydı ikon, özet ve tarihle render eder, explorer linki içerir', () => {
    renderPanel([makeRecord({ status: 'approved', txHash: '0xdeadbeef' })]);

    expect(screen.getByText(/Send — Approved/i)).toBeInTheDocument();
    expect(screen.getByText(/0\.1.*→.*7099\.\.\.79C8|0\.1/i)).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /View on Explorer/i });
    expect(link).toHaveAttribute('href', expect.stringContaining('/tx/0xdeadbeef'));
  });

  it('policy tarafından reddedilen bir kayıt reason metnini gösterir', () => {
    renderPanel([
      makeRecord({
        id: 'call_2',
        status: 'policy_rejected',
        txHash: undefined,
        reason: 'Proposed amount is 90.0% of balance, exceeding the 50% limit.',
      }),
    ]);

    expect(screen.getByText(/Send — Denied by policy/i)).toBeInTheDocument();
    expect(screen.getByText(/exceeding the 50% limit/i)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /View on Explorer/i })).not.toBeInTheDocument();
  });

  // reasonKey/reasonParams — AgentPolicyEngine'in kullanıcıya-gösterilen çeviri anahtarı (bkz.
  // AgentPolicyEngine.ts'in PolicyDecision.reasonKey'i ve AgentProposalHistory.ts'in
  // extractPolicyDenials()'ı). Model-facing `reason` (İngilizce) yerine bu anahtar varsa panel
  // artık aktif dile göre çevrilmiş metni göstermeli — İngilizce arayüzde İngilizce, Türkçe
  // arayüzde Türkçe.
  describe('reasonKey ile çevrilmiş policy reddi mesajı', () => {
    afterEach(async () => {
      await act(async () => {
        changeLanguage('en');
      });
    });

    it('dil İngilizce iken reasonKey İngilizce metne çevrilir', () => {
      renderPanel([
        makeRecord({
          id: 'call_5',
          status: 'policy_rejected',
          txHash: undefined,
          reason: 'Proposed amount is 90.0% of balance, exceeding the 50% limit.',
          reasonKey: 'agent.policyReasonExceedsBalanceRatio',
          reasonParams: { ratio: '90.0', limit: '50' },
        }),
      ]);

      expect(screen.getByText('Proposed amount is 90.0% of balance, exceeding the 50% limit.')).toBeInTheDocument();
    });

    it('dil Türkçe iken AYNI kayıt Türkçe çevrilir — ham İngilizce "reason" değil, reasonKey kullanılır', async () => {
      await act(async () => {
        changeLanguage('tr');
      });

      renderPanel([
        makeRecord({
          id: 'call_6',
          status: 'policy_rejected',
          txHash: undefined,
          reason: 'Proposed amount is 90.0% of balance, exceeding the 50% limit.',
          reasonKey: 'agent.policyReasonExceedsBalanceRatio',
          reasonParams: { ratio: '90.0', limit: '50' },
        }),
      ]);

      expect(screen.getByText("Önerilen tutar bakiyenin %90.0'i, %50 sınırını aşıyor.")).toBeInTheDocument();
      expect(screen.queryByText('Proposed amount is 90.0% of balance, exceeding the 50% limit.')).not.toBeInTheDocument();
    });

    // x402 (pay_for_resource) reddi — extractPolicyDenials() artık bunu da tarıyor (bkz.
    // DENIABLE_TOOLS), bu yüzden bu reasonKey'ler artık gerçekten bu panele ulaşabiliyor. Önceden
    // (PROPOSAL_TOOLS-only filtre varken) bir x402 reddi hiçbir zaman bir ProposalRecord'a
    // dönüşmüyordu — reasonKey/reasonParams altyapısı hazırdı ama hiç kullanılmıyordu.
    it('x402_disabled (parametresiz) İngilizce ve Türkçe doğru çevrilir', async () => {
      renderPanel([
        makeRecord({
          id: 'call_x402_a',
          toolName: 'pay_for_resource',
          status: 'policy_rejected',
          txHash: undefined,
          reason: 'x402 payments are disabled in settings.',
          reasonKey: 'agent.policyReasonX402Disabled',
        }),
      ]);
      expect(screen.getByText('x402 payments are disabled in settings.')).toBeInTheDocument();

      await act(async () => {
        changeLanguage('tr');
      });
      expect(screen.getByText('x402 ödemeleri ayarlarda devre dışı.')).toBeInTheDocument();
      expect(screen.queryByText('x402 payments are disabled in settings.')).not.toBeInTheDocument();
    });

    it('x402_invalid_amount (amount parametreli) İngilizce ve Türkçe doğru çevrilir', async () => {
      renderPanel([
        makeRecord({
          id: 'call_x402_b',
          toolName: 'pay_for_resource',
          status: 'policy_rejected',
          txHash: undefined,
          reason: 'x402 payment amount must be a positive number (got -1).',
          reasonKey: 'agent.policyReasonX402InvalidAmount',
          reasonParams: { amount: '-1' },
        }),
      ]);
      expect(screen.getByText('x402 payment amount must be a positive number (got -1).')).toBeInTheDocument();

      await act(async () => {
        changeLanguage('tr');
      });
      expect(screen.getByText('x402 ödeme tutarı pozitif bir sayı olmalı (alınan: -1).')).toBeInTheDocument();
    });

    it('reasonKey yoksa (eski kayıt) ham "reason" fallback olarak gösterilir, dil değişse de bozulmaz', async () => {
      await act(async () => {
        changeLanguage('tr');
      });

      renderPanel([
        makeRecord({
          id: 'call_7',
          status: 'policy_rejected',
          txHash: undefined,
          reason: 'Proposed amount is 90.0% of balance, exceeding the 50% limit.',
        }),
      ]);

      expect(screen.getByText('Proposed amount is 90.0% of balance, exceeding the 50% limit.')).toBeInTheDocument();
    });
  });

  it('kullanıcı tarafından iptal edilen bir kayıt için explorer linki göstermez', () => {
    renderPanel([makeRecord({ id: 'call_3', status: 'user_cancelled', txHash: undefined })]);

    expect(screen.getByText(/Send — Cancelled/i)).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  // Regresyon: ConfirmationCard'ın hesap-değişimi otomatik iptalinde `reason` artık
  // ConfirmationCard'ın kendi t()'siyle ÖNCEDEN çevrilmiş olarak geliyor (bkz.
  // ACCOUNT_CHANGED_REASON_KEY, ConfirmationCard.test.tsx'teki "dil Türkçe iken..." testi) — bu
  // panel `record.reason`'ı olduğu gibi (hiçbir t() çağrısı olmadan) gösteriyor, dolayısıyla
  // eskiden sabit İngilizce sabit her zaman sızıyordu. Burada panelin, zaten çevrilmiş metni
  // bozmadan/yeniden çevirmeye çalışmadan aynen bastığını kanıtlıyoruz.
  it('otomatik iptal reason\'ı (önceden çevrilmiş) olduğu gibi gösterilir, sabit İngilizce metne geri düşmez', () => {
    renderPanel([
      makeRecord({ id: 'call_4', status: 'user_cancelled', txHash: undefined, reason: 'Onaydan önce aktif hesap değişti' }),
    ]);

    expect(screen.getByText('Onaydan önce aktif hesap değişti')).toBeInTheDocument();
    expect(screen.queryByText('Active account changed before approval')).not.toBeInTheDocument();
  });

  it('en yeni kayıt en üstte gösterilir', () => {
    renderPanel([
      makeRecord({ id: 'older', toolName: 'propose_shield', timestamp: Date.parse('2026-08-10T10:00:00Z') }),
      makeRecord({ id: 'newer', toolName: 'propose_unshield', timestamp: Date.parse('2026-08-12T10:00:00Z') }),
    ]);

    const headings = screen.getAllByText(/— Approved/i);
    expect(headings[0]).toHaveTextContent('Unshield');
    expect(headings[1]).toHaveTextContent('Shield');
  });

  // ─── Ham tool adı sızıntısı (bkz. toolNameLabelKey, AgentProposalHistory.ts) ────────
  //
  // toolLabelKey (bu panel) ve toolActionLabel (AgentChatPanel.tsx) aynı switch'in iki bağımsız
  // kopyasıydı — biri güncellenip diğeri unutulunca (pay_for_resource CONFIRMABLE_TOOLS'a
  // eklendiğinde tam olarak bu oldu) ham fonksiyon adı burada HER durumda (approved/failed/
  // user_cancelled/policy_rejected — policy_rejected artık pay_for_resource için de üretiliyor,
  // bkz. extractPolicyDenials()'ın DENIABLE_TOOLS = PROPOSAL_TOOLS ∪ X402_TOOLS filtresi)
  // sessizce ekrana sızıyordu. İkisi artık AgentProposalHistory.ts'
  // teki tek bir toolNameLabelKey()'i paylaşıyor — bu testler hem CONFIRMABLE_TOOLS'un tamamını
  // (AgentChatPanel.test.tsx'teki it.each pattern'iyle aynı), hem de pay_for_resource'un birden
  // fazla durumda sızmadığını kanıtlıyor.
  describe('ham tool adı sızıntısı', () => {
    const CONFIRMABLE_TOOLS = [...PROPOSAL_TOOLS, ...X402_TOOLS];
    const TOOL_LABELS: Record<string, string> = {
      propose_send: 'Send',
      propose_shield: 'Shield',
      propose_unshield: 'Unshield',
      pay_for_resource: 'x402 Payment',
    };

    it.each(CONFIRMABLE_TOOLS)(
      '"%s" için doğru çevrilmiş etiket gösterilir, ham tool adı hiçbir yerde görünmez',
      (toolName) => {
        renderPanel([makeRecord({ toolName, status: 'approved', txHash: '0xdeadbeef' })]);

        expect(screen.getByText(`${TOOL_LABELS[toolName]} — Approved`)).toBeInTheDocument();
        expect(screen.queryByText(new RegExp(toolName))).not.toBeInTheDocument();
      }
    );

    // pay_for_resource'a özel: eksiklik yalnızca reject/user_cancelled'a değil, approved VE
    // failed durumlarına da sızıyordu — bu üçü ayrı ayrı kanıtlanıyor. policy_rejected de dahil:
    // extractPolicyDenials() artık pay_for_resource'u da tarıyor (bkz. DENIABLE_TOOLS), yani bir
    // x402 reddi de artık "Agent Geçmişi"nde satır olarak beliriyor.
    it.each([
      { status: 'approved' as const, extra: { txHash: '0xdeadbeef' } },
      { status: 'user_cancelled' as const, extra: { txHash: undefined } },
      { status: 'failed' as const, extra: { txHash: undefined, reason: 'settle failed' } },
      {
        status: 'policy_rejected' as const,
        extra: { txHash: undefined, reason: 'x402 payments are disabled in settings.', reasonKey: 'agent.policyReasonX402Disabled' },
      },
    ])('pay_for_resource "$status" durumunda da ham tool adı sızmaz', ({ status, extra }) => {
      renderPanel([makeRecord({ toolName: 'pay_for_resource', ...extra, status })]);

      expect(screen.getByText(/x402 Payment —/)).toBeInTheDocument();
      expect(screen.queryByText(/pay_for_resource/)).not.toBeInTheDocument();
    });
  });

  // ─── Hesap-bazlı filtreleme ───────────────────────────────────────
  describe('hesap filtreleme', () => {
    it('yalnızca aktif hesabın kayıtlarını gösterir, başka hesaba ait kayıtları gizler', () => {
      renderPanel([
        makeRecord({ id: 'mine', accountAddress: TEST_ADDRESS }),
        makeRecord({ id: 'not-mine', accountAddress: OTHER_ADDRESS, toolName: 'propose_shield' }),
      ]);

      expect(screen.getByText(/Send — Approved/i)).toBeInTheDocument();
      expect(screen.queryByText(/Shield — Approved/i)).not.toBeInTheDocument();
    });

    it('aktif hesap yoksa hiçbir kayıt göstermez (boş durum)', () => {
      renderPanel([makeRecord()], null);
      expect(screen.getByText(/No proposal history yet/i)).toBeInTheDocument();
    });
  });
});
