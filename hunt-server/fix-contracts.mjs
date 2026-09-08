/**
 * Point the contract gates at the contracts the wallet actually uses.
 *
 * Every gate that names a contract was pointed at the *factory* — the thing that deploys a
 * wrapper, which a user never touches. Shielding and confidential transfers go through the
 * wrappers themselves, so the logs those gates look for were never going to be there and
 * five of the twelve fragments could not be earned at all: both shield gates and all three
 * confidential-send gates, which are the hardest and the point of the whole arrangement.
 *
 * Addresses are read from the wallet's own `.env` rather than written in here, so a
 * redeploy cannot leave the two out of step. The factory is kept alongside the wrappers:
 * it emits nothing these gates match, and it costs nothing to watch.
 *
 * Touches only `contracts`. `words` is never read, written, or printed.
 *
 *   node fix-contracts.mjs [fragments.json] [../.env]
 */

import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";

const FILE = process.argv[2] || "./fragments.json";
const ENV = process.argv[3] || "../.env";

/** Which wallet variables hold the contracts for each chain the hunt gates on. */
const CHAIN_VARS = {
  sepolia: ["VITE_WRAPPED_ETH_ADDRESS", "VITE_WRAPPED_USDC_ADDRESS", "VITE_WRAPPER_FACTORY_ADDRESS"],
  "arb-sepolia": ["VITE_ARB_WRAPPED_ETH_ADDRESS", "VITE_ARB_WRAPPED_USDC_ADDRESS", "VITE_ARB_WRAPPER_FACTORY_ADDRESS"],
  "base-sepolia": ["VITE_BASE_WRAPPED_ETH_ADDRESS", "VITE_BASE_WRAPPED_USDC_ADDRESS", "VITE_BASE_WRAPPER_FACTORY_ADDRESS"],
};

function readEnv(path) {
  const out = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const at = line.indexOf("=");
    if (at < 1 || line.trimStart().startsWith("#")) continue;
    out[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return out;
}

for (const [label, path] of [["fragments", FILE], ["wallet .env", ENV]]) {
  if (!existsSync(path)) {
    console.error(`No ${label} at ${path}.`);
    process.exit(1);
  }
}

const env = readEnv(ENV);
const byChain = {};
for (const [chain, vars] of Object.entries(CHAIN_VARS)) {
  const addresses = vars.map((v) => env[v]).filter((a) => /^0x[0-9a-fA-F]{40}$/.test(a ?? ""));
  if (addresses.length === 0) {
    console.error(`No usable addresses for ${chain} in ${ENV} — deploy the wrappers first.`);
    process.exit(1);
  }
  byChain[chain] = addresses;
}

const config = JSON.parse(readFileSync(FILE, "utf8"));
if (!config?.fragments) {
  console.error("That file has no `fragments` object.");
  process.exit(1);
}

const backup = `${FILE}.before-contracts`;
copyFileSync(FILE, backup);

const report = [];
for (const [id, fragment] of Object.entries(config.fragments)) {
  if (!Array.isArray(fragment.contracts)) continue;

  const addresses = byChain[fragment.chain];
  if (!addresses) {
    report.push(`  ${fragment.index ?? id}: unknown chain "${fragment.chain}" — left alone`);
    continue;
  }

  const before = fragment.contracts.length;
  fragment.contracts = addresses;
  report.push(`  word ${fragment.index ?? id} (${fragment.gate}, ${fragment.chain}): ${before} -> ${addresses.length} contracts`);
}

writeFileSync(FILE, JSON.stringify(config, null, 2) + "\n");

console.log(`Backup: ${backup}`);
console.log(report.length ? report.join("\n") : "  no contract gates found");
console.log("\nNo word was read or printed.");
