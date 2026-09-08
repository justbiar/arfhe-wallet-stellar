/**
 * Spread the three easy chain gates across the three networks.
 *
 * They all ask for one Sepolia transaction today, so a single transaction pays out three
 * words. Raising the count would not fix that: the brute-force maths does not move at all —
 * every gated fragment already requires using the wallet — and a script can send twenty
 * testnet transactions in a minute, so a higher threshold tires an honest finder and barely
 * touches anyone automating.
 *
 * Requiring a different network for each is the thing a script cannot shortcut: separate
 * faucets, separate transactions, and the wallet's own network switching. It is also what
 * "make them use all three chains" actually means.
 *
 * Touches only the gate fields. `words` is never read, written, or printed.
 *
 *   node spread-gates.mjs
 */

import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";

const FILE = process.argv[2] || "./fragments.json";

/** Which word position gets which chain. Keyed by position so scrambled ids still match. */
const SPREAD = {
  2: "sepolia",
  4: "arb-sepolia",
  5: "base-sepolia",
};

if (!existsSync(FILE)) {
  console.error(`No ${FILE} here. Run this where the file is.`);
  process.exit(1);
}

const config = JSON.parse(readFileSync(FILE, "utf8"));
if (!config?.fragments) {
  console.error("That file has no `fragments` object.");
  process.exit(1);
}

const backup = `${FILE}.before-spread`;
copyFileSync(FILE, backup);

const changed = [];
for (const [id, fragment] of Object.entries(config.fragments)) {
  if (fragment.gate !== "tx_count") continue;

  const index = Number.isInteger(fragment.index)
    ? fragment.index
    : Number(/^f(\d+)$/.exec(id)?.[1]);
  const chain = SPREAD[index];
  if (!chain) continue;

  const before = fragment.chain;
  fragment.chain = chain;
  fragment.minTxCount = 1;
  if (before !== chain) changed.push(`  word ${index}: ${before} -> ${chain}`);
}

writeFileSync(FILE, JSON.stringify(config, null, 2) + "\n");

console.log(`Backup: ${backup}`);
console.log(changed.length ? changed.join("\n") : "  nothing to change");
console.log("\nNo word was read or printed.");
