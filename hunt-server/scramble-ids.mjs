/**
 * Rename fragment ids to unguessable ones, keeping each word's position.
 *
 * `f1`..`f12` are the first thing anyone tries against the API, and nothing in
 * `/hunt/fragment` requires the caller to have actually found the mark — so sequential ids
 * hand over every signature-gated word to someone who never opened the wallet. The ids are
 * only ever sent *to* the wallet by `/hunt/marks`, never written in the bundle, so making
 * them random costs nothing.
 *
 * Writes `index` from the old id first, because the server reads a word's place in the
 * phrase off `fN` when no explicit index is set — and after this there is no `fN` to read.
 *
 * Never prints a word. Run it on the machine that holds fragments.json.
 *
 *   node scramble-ids.mjs
 */

import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";

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

const backup = `${FILE}.before-scramble`;
copyFileSync(FILE, backup);

const renamed = {};
const report = [];

for (const [oldId, fragment] of Object.entries(config.fragments)) {
  const derived = /^f(\d+)$/.exec(oldId);
  const index = Number.isInteger(fragment.index) && fragment.index > 0
    ? fragment.index
    : derived
      ? Number(derived[1])
      : null;

  if (index === null) {
    console.error(`Cannot tell what position "${oldId}" is. Set "index" on it by hand and re-run.`);
    process.exit(1);
  }

  // 16 hex characters. Guessing one is not a thing anybody does by hand or by script.
  const newId = randomBytes(8).toString("hex");
  renamed[newId] = { ...fragment, index };
  report.push(`  ${oldId.padEnd(4)} -> ${newId}   (word ${index})`);
}

config.fragments = renamed;
writeFileSync(FILE, JSON.stringify(config, null, 2) + "\n");

console.log(`Backup: ${backup}`);
console.log(report.join("\n"));
console.log(`\n${report.length} fragments renamed. No word was read or printed.`);
