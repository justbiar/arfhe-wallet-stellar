/// <reference types="vitest/globals" />
import {
  buildRecordFromOutcome,
  extractPolicyDenials,
  appendProposalRecords,
  findPendingConfirmation,
  MAX_PROPOSAL_RECORDS,
  type ProposalRecord,
} from '../AgentProposalHistory';
import type { ChatMessage } from '../AgentOrchestrator';
import type { ProposalPreview } from '../AgentToolRunner';

/**
 * @vitest-environment node
 *
 * AgentProposalHistory testleri
 *
 * Pure fonksiyonlar test edilir — chrome.storage/React'e bağımlılık yok. buildRecordFromOutcome
 * (ConfirmationCard'ın sonuçlandırdığı öneriler), extractPolicyDenials (AgentPolicyEngine'in
 * kart hiç oluşmadan reddettiği öneriler — bir runAgentTurn turunun yeni mesaj dilimi taranır),
 * appendProposalRecords (de-dup + hesap-başı FIFO cap) ve findPendingConfirmation (hem
 * AgentChatPanel hem pages/Agent.tsx'in kullandığı, henüz çözülmemiş öneriyi bulan yardımcı)
 * ayrı ayrı doğrulanır.
 */

const ACCOUNT_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ACCOUNT_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function makePreview(overrides: Partial<ProposalPreview> = {}): ProposalPreview {
  return {
    requiresConfirmation: true,
    toolName: 'propose_send',
    originalArgs: { to: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', amount: '0.1' },
    simulation: { success: true, balanceChanges: [], warnings: [], riskLevel: 'LOW' },
    ...overrides,
  };
}

describe('AgentProposalHistory', () => {
  // ─── buildRecordFromOutcome ─────────────────────────────────────
  describe('buildRecordFromOutcome', () => {
    it('confirmed outcome için status=approved, txHash ve accountAddress içeren kayıt üretir', () => {
      const record = buildRecordFromOutcome('call_1', makePreview(), { status: 'confirmed', txHash: '0xHASH' }, ACCOUNT_A);
      expect(record).toMatchObject({
        id: 'call_1',
        accountAddress: ACCOUNT_A,
        toolName: 'propose_send',
        amount: '0.1',
        recipient: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
        status: 'approved',
        txHash: '0xHASH',
      });
      expect(typeof record.timestamp).toBe('number');
    });

    it('rejected outcome için status=user_cancelled üretir, txHash/reason yok', () => {
      const record = buildRecordFromOutcome('call_2', makePreview(), { status: 'rejected' }, ACCOUNT_A);
      expect(record.status).toBe('user_cancelled');
      expect(record.txHash).toBeUndefined();
      expect(record.reason).toBeUndefined();
    });

    it('reason\'lı rejected outcome (örn. hesap değişimi otomatik iptali) için reason\'ı da taşır', () => {
      const record = buildRecordFromOutcome(
        'call_2b',
        makePreview(),
        { status: 'rejected', reason: 'Active account changed before approval' },
        ACCOUNT_A
      );
      expect(record.status).toBe('user_cancelled');
      expect(record.reason).toBe('Active account changed before approval');
    });

    it('failed outcome için status=failed ve reason=outcome.message üretir', () => {
      const record = buildRecordFromOutcome('call_3', makePreview(), { status: 'failed', message: 'insufficient funds' }, ACCOUNT_A);
      expect(record.status).toBe('failed');
      expect(record.reason).toBe('insufficient funds');
    });

    it('propose_shield/unshield gibi "to" argümanı olmayan araçlarda recipient set edilmez', () => {
      const record = buildRecordFromOutcome(
        'call_4',
        makePreview({ toolName: 'propose_shield', originalArgs: { amount: '0.2', tokenSymbol: 'ETH' } }),
        { status: 'confirmed', txHash: '0xHASH2' },
        ACCOUNT_A
      );
      expect(record.recipient).toBeUndefined();
      expect(record.tokenSymbol).toBe('ETH');
    });

    it('accountAddress çağıranın verdiği hesabı taşır (o an aktif olan değil)', () => {
      // AgentChatPanel/Agent.tsx her zaman doğru hesabı açıkça geçirir — bu fonksiyon "aktif
      // hesabı" kendi başına asla varsaymaz (örn. hesap-değişimi auto-cancel akışında OUTGOING
      // hesap geçirilir, o anda aktif olan INCOMING hesap değil).
      const record = buildRecordFromOutcome('call_5', makePreview(), { status: 'confirmed', txHash: '0xHASH3' }, ACCOUNT_B);
      expect(record.accountAddress).toBe(ACCOUNT_B);
    });
  });

  // ─── extractPolicyDenials ────────────────────────────────────────
  describe('extractPolicyDenials', () => {
    function makeDenialSlice(overrides: { toolName?: string; args?: Record<string, unknown>; error?: string } = {}): ChatMessage[] {
      const { toolName = 'propose_send', args = { to: '0xabc', amount: '0.9' }, error = 'Proposed amount exceeds limit.' } = overrides;
      return [
        { role: 'user', content: 'send most of my balance' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'call_x', type: 'function', function: { name: toolName, arguments: JSON.stringify(args) } }],
        },
        { role: 'tool', tool_call_id: 'call_x', name: toolName, content: JSON.stringify({ error }) },
        { role: 'assistant', content: 'Bunu öneremem.' },
      ];
    }

    it('policy tarafından reddedilen bir proposal tool çağrısını, accountAddress dahil, kayda çevirir', () => {
      const records = extractPolicyDenials(makeDenialSlice(), ACCOUNT_A);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        id: 'call_x',
        accountAddress: ACCOUNT_A,
        toolName: 'propose_send',
        amount: '0.9',
        recipient: '0xabc',
        status: 'policy_rejected',
        reason: 'Proposed amount exceeds limit.',
      });
    });

    it('başarılı bir sonuç ({result}) üretmez', () => {
      const slice = makeDenialSlice();
      // Swap the {error} tool message for a {result} one — same shape a successful preview would take.
      const withResult = slice.map((m) =>
        m.role === 'tool' ? { ...m, content: JSON.stringify({ result: { requiresConfirmation: true } }) } : m
      );
      expect(extractPolicyDenials(withResult, ACCOUNT_A)).toHaveLength(0);
    });

    it('PROPOSAL_TOOLS dışındaki bir tool adını yok sayar (örn. read-only bir hata)', () => {
      const records = extractPolicyDenials(makeDenialSlice({ toolName: 'get_balance' }), ACCOUNT_A);
      expect(records).toHaveLength(0);
    });

    it('bozuk tool_call arguments string\'ini sessizce yutar, kaydı yine de üretir', () => {
      const slice: ChatMessage[] = [
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'call_y', type: 'function', function: { name: 'propose_send', arguments: 'not json' } }],
        },
        { role: 'tool', tool_call_id: 'call_y', name: 'propose_send', content: JSON.stringify({ error: 'bad args' }) },
      ];
      const records = extractPolicyDenials(slice, ACCOUNT_A);
      expect(records).toHaveLength(1);
      expect(records[0].amount).toBeUndefined();
      expect(records[0].reason).toBe('bad args');
    });

    it('birden fazla reddedilen proposal aynı turda hepsi kayda geçer, hepsi aynı accountAddress ile', () => {
      const slice: ChatMessage[] = [
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            { id: 'call_a', type: 'function', function: { name: 'propose_send', arguments: JSON.stringify({ amount: '1' }) } },
            { id: 'call_b', type: 'function', function: { name: 'propose_shield', arguments: JSON.stringify({ amount: '2' }) } },
          ],
        },
        { role: 'tool', tool_call_id: 'call_a', name: 'propose_send', content: JSON.stringify({ error: 'e1' }) },
        { role: 'tool', tool_call_id: 'call_b', name: 'propose_shield', content: JSON.stringify({ error: 'e2' }) },
      ];
      const records = extractPolicyDenials(slice, ACCOUNT_B);
      expect(records).toHaveLength(2);
      expect(records.every((r) => r.accountAddress === ACCOUNT_B)).toBe(true);
    });
  });

  // ─── appendProposalRecords ───────────────────────────────────────
  describe('appendProposalRecords', () => {
    function makeRecord(id: string, accountAddress: string = ACCOUNT_A): ProposalRecord {
      return { id, accountAddress, toolName: 'propose_send', status: 'approved', timestamp: Date.now() };
    }

    it('yeni kayıtları sona ekler', () => {
      const result = appendProposalRecords([makeRecord('a')], [makeRecord('b')]);
      expect(result.map((r) => r.id)).toEqual(['a', 'b']);
    });

    it('aynı id\'ye sahip bir kaydı tekrar eklemez (de-dup)', () => {
      const result = appendProposalRecords([makeRecord('a')], [makeRecord('a'), makeRecord('b')]);
      expect(result.map((r) => r.id)).toEqual(['a', 'b']);
    });

    it('MAX_PROPOSAL_RECORDS bir hesap için aşıldığında o hesabın en eskilerini FIFO olarak düşürür', () => {
      const current = Array.from({ length: MAX_PROPOSAL_RECORDS }, (_, i) => makeRecord(`r${i}`));
      const result = appendProposalRecords(current, [makeRecord('new')]);
      expect(result).toHaveLength(MAX_PROPOSAL_RECORDS);
      expect(result[0].id).toBe('r1');
      expect(result[result.length - 1].id).toBe('new');
    });

    it('bir hesabın limiti dolsa bile başka bir hesabın kayıtlarına dokunmaz', () => {
      const accountAFull = Array.from({ length: MAX_PROPOSAL_RECORDS }, (_, i) => makeRecord(`a${i}`, ACCOUNT_A));
      const accountBExisting = [makeRecord('b0', ACCOUNT_B), makeRecord('b1', ACCOUNT_B)];
      const current = [...accountAFull, ...accountBExisting];

      const result = appendProposalRecords(current, [makeRecord('a-new', ACCOUNT_A)]);

      const forB = result.filter((r) => r.accountAddress === ACCOUNT_B);
      expect(forB.map((r) => r.id)).toEqual(['b0', 'b1']); // untouched
      const forA = result.filter((r) => r.accountAddress === ACCOUNT_A);
      expect(forA).toHaveLength(MAX_PROPOSAL_RECORDS); // still capped
      expect(forA[0].id).toBe('a1'); // oldest A record evicted, not a B one
      expect(forA[forA.length - 1].id).toBe('a-new');
    });

    it('eklenecek kayıt yoksa aynı referansı döner', () => {
      const current = [makeRecord('a')];
      expect(appendProposalRecords(current, [])).toBe(current);
    });
  });

  // ─── findPendingConfirmation ──────────────────────────────────────
  describe('findPendingConfirmation', () => {
    it('boş history için null döner', () => {
      expect(findPendingConfirmation([])).toBeNull();
    });

    it('bir ProposalPreview içeren tool mesajını bulur', () => {
      const preview = makePreview();
      const history: ChatMessage[] = [
        { role: 'user', content: 'send 0.1 eth' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'propose_send', arguments: '{}' } }],
        },
        { role: 'tool', tool_call_id: 'call_1', name: 'propose_send', content: JSON.stringify({ result: preview }) },
      ];
      const pending = findPendingConfirmation(history);
      expect(pending).not.toBeNull();
      expect(pending?.toolCallId).toBe('call_1');
      expect(pending?.preview.toolName).toBe('propose_send');
    });

    it('sonuçlanmış (settled marker) bir tool mesajını pending saymaz', () => {
      const history: ChatMessage[] = [
        {
          role: 'tool',
          tool_call_id: 'call_1',
          name: 'propose_send',
          content: JSON.stringify({ result: { settled: true, status: 'confirmed', toolName: 'propose_send', summary: 'ok' } }),
        },
      ];
      expect(findPendingConfirmation(history)).toBeNull();
    });
  });
});
