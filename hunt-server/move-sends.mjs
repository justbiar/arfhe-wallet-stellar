/**
 * Move the three confidential-send marks to the screen shown after a confidential send.
 *
 * They sat on the Privacy page behind a dark-theme requirement, which asked the finder to
 * do the work in one place and then go looking for the reward in another, in a particular
 * colour. The moment itself is a better hiding place than a page: it can only be reached by
 * doing the thing, and the wallet is already showing a screen when it happens.
 *
 * The theme condition goes with it. It was there to multiply hiding places when everything
 * lived on a handful of routes; a moment is its own place and does not need padding out.
 *
 * The chain requirement stays — that is the point of having three of these.
 *
 * Touches only placement. `words` is never read, written, or printed.
 *
 *   node move-sends.mjs
 */

import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";

const FILE = process.argv[2] || "./fragments.json";

if (!existsSync(FILE)) {
  console.error(`No ${FILE} here. Run this where the file is.`);
  process.exit(1);
}

const config = JSON.parse(readFileSync(FILE, "utf8"));
if (!config?.fragments) {
  console.error("That file has no `fragments` object.");
  process.exit(1);
}

const backup = `${FILE}.before-move`;
copyFileSync(FILE, backup);

const moved = [];
for (const [id, fragment] of Object.entries(config.fragments)) {
  if (fragment.gate !== "confidential_send") continue;

  const from = `${fragment.fixedRoute ?? "?"}${fragment.theme ? ` (${fragment.theme})` : ""}`;
  fragment.fixedRoute = "/send";
  delete fragment.theme;
  moved.push(`  word ${fragment.index ?? id}: ${from} -> /send, any theme, still ${fragment.chain}`);
}

writeFileSync(FILE, JSON.stringify(config, null, 2) + "\n");

console.log(`Backup: ${backup}`);
console.log(moved.length ? moved.join("\n") : "  no confidential-send fragments found");
console.log("\nNo word was read or printed.");
