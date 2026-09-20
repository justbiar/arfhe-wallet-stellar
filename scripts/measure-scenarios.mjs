/**
 * Runs the payroll service's scenarios end to end and prints what each one cost.
 *
 * The site claims four confidential payment scenarios. Only payroll had ever been run;
 * the other three were the same engine call with different copy, which is an argument, not
 * a measurement. This drives the live service — ramp in, shield, pay — and reports the
 * amounts, the wall-clock time per payment and the transaction hashes, so the claim on the
 * site can be the thing that happened.
 *
 * It spends real testnet USDC out of the anchor's treasury: roughly the scenario's total
 * plus the anchor's fee. Preparing a scenario replaces the service's in-memory session, so
 * whatever the previous payer still held becomes unreachable — the keys only live in that
 * process. Pay before you prepare the next one.
 *
 *   node scripts/measure-scenarios.mjs tedarik perakende takas
 */

const PAYROLL = process.env.PAYROLL_URL ?? "http://localhost:8788";

const ids = process.argv.slice(2);
if (ids.length === 0) {
  console.error("kullanım: node scripts/measure-scenarios.mjs <senaryo> [senaryo…]");
  process.exit(1);
}

async function call(path, init) {
  const res = await fetch(`${PAYROLL}${path}`, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `${path} → ${res.status}`);
  return body;
}

const scenarios = await call("/scenarios");
const known = new Set(scenarios.map((s) => s.id));
for (const id of ids) if (!known.has(id)) throw new Error(`bilinmeyen senaryo: ${id}`);

for (const id of ids) {
  const def = scenarios.find((s) => s.id === id);
  const total = def.recipients.reduce((sum, r) => sum + Number(r.amount), 0);
  console.log(`\n── ${def.title} (${id}) · ${def.recipients.length} ödeme · ${total} USDC ──`);

  const startedPrepare = Date.now();
  const prepared = await call("/prepare", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scenario: id }),
  });
  console.log(`rampa   ${prepared.amountTry} TRY → ${prepared.funded} USDC  (${((Date.now() - startedPrepare) / 1000).toFixed(0)} sn)`);

  const state = await call("/pay", { method: "POST" });
  for (const p of state.payments) {
    console.log(`  ${p.label.padEnd(12)} ${String(p.amount).padStart(6)} USDC  ${p.seconds.toFixed(1)} sn  ${p.hash}`);
  }
  console.log(`kalan   ${state.payer.spendable} USDC`);

  // What an observer sees for the first payment of the scenario — the same view the site
  // shows, asked here so the measurement includes it rather than trusting the page.
  const first = state.payments[0];
  if (first?.hash) {
    const chain = await call(`/chain/${first.hash}`);
    const found = chain.amountsFound.filter((a) => a.found).length;
    console.log(`zincir  ${chain.functionName} · opak ${chain.opaqueBytes} bayt · zarf ${chain.envelopeBytes} bayt · zarfta bulunan tutar: ${found}/${chain.amountsFound.length}`);
  }
}
