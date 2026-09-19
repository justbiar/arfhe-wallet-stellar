/**
 * Client for the confidential payment service (`npm run payroll`, :8788).
 *
 * The page asks, the service proves. That split is not a demo shortcut: every confidential
 * transfer needs an UltraHonk proof and bb.js opens its own worker through
 * `new Worker(new URL(...))` — bundled into a hashed chunk the worker is never found and
 * proving hangs silently. Node's default loader runs it unchanged. In a real deployment
 * payroll runs on a server too, so the shape here is the shape of the product.
 *
 * Reading a balance needs only decryption, not proving, so a wallet can show a salary
 * without this service ever being involved. Only paying needs it.
 */

/** Same-machine demo, like the relayer on :8787. A deployed panel has no service to call. */
export const PAYROLL_URL = "http://localhost:8788";

export interface ScenarioDef {
  id: string;
  title: string;
  /** Why the amounts in this scenario deserve hiding. */
  why: string;
  payer: string;
  recipients: { label: string; amount: string }[];
  /** What stays visible on-chain — printed next to the claim, not under it. */
  stillPublic: string;
}

export interface PartyState {
  label: string;
  address: string;
  spendable: string;
  /** Received but not yet merged into the spendable balance. */
  receiving: string;
}

export interface Payment {
  to: string;
  label: string;
  amount: string;
  hash: string;
  seconds: number;
}

export interface SessionState {
  scenario: string;
  payer: PartyState;
  recipients: PartyState[];
  /** USDC the ramp paid out, in the open. Null before the ramp leg runs. */
  funded: string | null;
  payments: Payment[];
  /** Only present in the `/prepare` reply: the fiat the ramp was given. */
  amountTry?: string;
}

export interface ChainView {
  hash: string;
  successful: boolean;
  functionName: string;
  addresses: string[];
  opaqueBytes: number;
  envelopeBytes: number;
  /** Every `found` must be false. That is the whole claim, and its proof. */
  amountsFound: { amount: string; found: boolean }[];
}

export interface Health {
  ok: boolean;
  contracts: {
    token: string;
    verifier: string;
    auditor: string;
    underlying: string;
    deployedAtLedger: number;
  };
  hasSession: boolean;
}

/**
 * One fetch shape for every endpoint.
 *
 * The service answers errors as `{error}` with a real status, so the message it chose is
 * worth more than a generic one built from the status code.
 */
async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${PAYROLL_URL}${path}`, {
    ...init,
    headers: init?.body ? { "content-type": "application/json" } : undefined,
  });
  const body = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `servis ${res.status}`);
  return body;
}

export const getHealth = () => call<Health>("/health");
export const getScenarios = () => call<ScenarioDef[]>("/scenarios");
export const getState = () => call<SessionState>("/state");
export const getChainView = (hash: string) => call<ChainView>(`/chain/${hash}`);

/** Slow (~1-2 min): parties are created, registered, and funded through the live anchor. */
export const prepare = (scenario: string) =>
  call<SessionState>("/prepare", { method: "POST", body: JSON.stringify({ scenario }) });

export const pay = () => call<SessionState>("/pay", { method: "POST", body: "{}" });
