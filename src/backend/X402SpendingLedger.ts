/**
 * X402SpendingLedger — durable record of every x402 micro-payment the wallet has made (Faz 3).
 *
 * Same instance + injectable-store shape as SitePermissionService.ts, and for the same reason:
 * stored in `chrome.storage.local`, deliberately NOT the `chrome.storage.session` pattern
 * AgentProposalHistory.ts uses for the chat/proposal log. That distinction matters here more
 * than it does there — a daily spending budget has to survive the browser actually restarting
 * mid-day; a log that resets on every browser restart would silently reopen the full budget
 * every time the user closed Chrome, defeating the whole point of a periodic cap. This ledger
 * is the source of truth `AgentPolicyEngine.evaluateX402Payment()` (next step in this phase)
 * reads from to decide whether a payment is still within budget — it never makes that decision
 * itself, only answers "how much has already been spent."
 *
 * Spending is tracked PER ACCOUNT, not globally: each account has its own on-chain USDC
 * balance, so "today's budget" has to mean "today's budget for the account actually paying,"
 * the same reasoning ProposalRecord.accountAddress already applies to proposal history.
 */

export interface X402SpendingRecord {
  /** Unique per payment — the settlement tx hash once one exists, otherwise a generated id. */
  id: string;
  /** Lowercased address of the account that paid. */
  accountAddress: string;
  amountUsd: number;
  timestamp: number;
  /** Human-readable label of what was paid for (e.g. the resource server's name), if known. */
  service?: string;
  /** Settlement tx hash, once the facilitator has broadcast the payment. */
  txHash?: string;
}

const STORAGE_KEY = "arfhe_x402_spending_ledger";

/**
 * FIFO cap, applied PER ACCOUNT — mirrors AgentProposalHistory's MAX_PROPOSAL_RECORDS. Set
 * higher than that constant because x402 payments are meant to be frequent micro-transactions
 * (many small calls, not occasional transfers), so a lower cap would truncate a single day's
 * activity for a heavy user. Trimming only ever drops the OLDEST records for the account(s) a
 * write actually touched — never affects the budget math itself, which only ever looks back one
 * day (see getSpentInPeriod) and would need thousands of same-day payments to be affected by
 * this cap at all.
 */
export const MAX_X402_SPENDING_RECORDS = 500;

/** Minimal shape of the storage area, so this works in a worker, a page, and a test. */
interface LedgerStore {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

/** `chrome.storage.local` when present, otherwise an in-memory stand-in. */
function defaultStore(): LedgerStore {
  const globalChrome = (globalThis as { chrome?: { storage?: { local?: LedgerStore } } }).chrome;
  const local = globalChrome?.storage?.local;
  if (local) return local;

  // Test and non-extension contexts. Deliberately not localStorage — see SitePermissionService's
  // identical reasoning: a fallback that silently persists somewhere else would make the budget
  // gate look enforced while it is not.
  const memory = new Map<string, unknown>();
  return {
    async get(key: string) {
      return memory.has(key) ? { [key]: memory.get(key) } : {};
    },
    async set(items: Record<string, unknown>) {
      for (const [k, v] of Object.entries(items)) memory.set(k, v);
    },
  };
}

function isValidRecord(value: unknown): value is X402SpendingRecord {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.accountAddress === "string" &&
    typeof v.amountUsd === "number" &&
    Number.isFinite(v.amountUsd) &&
    typeof v.timestamp === "number"
  );
}

/** Start of the local calendar day containing `at` (00:00:00.000, the user's own clock). */
function startOfLocalDay(at: number): number {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export class X402SpendingLedger {
  private store: LedgerStore;

  constructor(store: LedgerStore = defaultStore()) {
    this.store = store;
  }

  // ─── Reads ──────────────────────────────────────────────────────

  /** Every stored record, malformed entries dropped rather than letting one corrupt the whole read. */
  async getAll(): Promise<X402SpendingRecord[]> {
    try {
      const result = await this.store.get(STORAGE_KEY);
      const raw = result?.[STORAGE_KEY];
      if (!Array.isArray(raw)) return [];
      return raw.filter(isValidRecord);
    } catch {
      return [];
    }
  }

  /** Records for one account, newest first is NOT guaranteed here — callers sort if display order matters. */
  async getRecordsForAccount(accountAddress: string): Promise<X402SpendingRecord[]> {
    const target = accountAddress.toLowerCase();
    return (await this.getAll()).filter((r) => r.accountAddress === target);
  }

  /**
   * Total spent by `accountAddress` in the half-open window [periodStart, periodEnd) — i.e.
   * periodStart is included, periodEnd is not, so consecutive periods never double-count a
   * payment that lands exactly on the boundary.
   */
  async getSpentInPeriod(accountAddress: string, periodStart: number, periodEnd: number): Promise<number> {
    const records = await this.getRecordsForAccount(accountAddress);
    return records
      .filter((r) => r.timestamp >= periodStart && r.timestamp < periodEnd)
      .reduce((sum, r) => sum + r.amountUsd, 0);
  }

  /** Total spent by `accountAddress` since the start of the local calendar day containing `now`. */
  async getSpentToday(accountAddress: string, now: number = Date.now()): Promise<number> {
    const dayStart = startOfLocalDay(now);
    return this.getSpentInPeriod(accountAddress, dayStart, dayStart + 24 * 60 * 60 * 1000);
  }

  /**
   * `dailyBudgetUsd` minus what has already been spent today, floored at 0 — never negative,
   * so a caller can use this directly as "how much room is left" without its own clamp. Pure
   * arithmetic over the ledger's own data; the actual budget number is the caller's
   * responsibility (X402SettingsService/AgentPolicyEngine), this makes no policy judgment.
   */
  async getRemainingDailyBudget(accountAddress: string, dailyBudgetUsd: number, now: number = Date.now()): Promise<number> {
    const spent = await this.getSpentToday(accountAddress, now);
    return Math.max(0, dailyBudgetUsd - spent);
  }

  // ─── Writes ─────────────────────────────────────────────────────

  /**
   * Appends a payment record and trims that account's own history to MAX_X402_SPENDING_RECORDS
   * (oldest first out) — same per-account trimming strategy as
   * AgentProposalHistory.appendProposalRecords, for the same reason: one account's heavy usage
   * must never evict another account's history just because they share one storage key.
   */
  async recordPayment(entry: Omit<X402SpendingRecord, "accountAddress"> & { accountAddress: string }): Promise<X402SpendingRecord> {
    const record: X402SpendingRecord = { ...entry, accountAddress: entry.accountAddress.toLowerCase() };

    const all = await this.getAll();
    let combined = [...all, record];

    const forAccount = combined.filter((r) => r.accountAddress === record.accountAddress);
    const excess = forAccount.length - MAX_X402_SPENDING_RECORDS;
    if (excess > 0) {
      const idsToDrop = new Set(forAccount.slice(0, excess).map((r) => r.id));
      combined = combined.filter((r) => !idsToDrop.has(r.id));
    }

    await this.store.set({ [STORAGE_KEY]: combined });
    return record;
  }

  /** Test/debug escape hatch — clears every account's history, not just one. */
  async clearAll(): Promise<void> {
    await this.store.set({ [STORAGE_KEY]: [] });
  }
}

export default X402SpendingLedger;
