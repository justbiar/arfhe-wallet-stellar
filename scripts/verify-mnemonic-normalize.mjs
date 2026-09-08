/**
 * Proves that normalizeMnemonic produces phrases ethers actually accepts.
 *
 * This lives outside the vitest suite because `Mnemonic.isValidMnemonic` is unreliable
 * under jsdom here — the Buffer polyfill breaks ethers' sha256, so the checksum it computes
 * is wrong even for a known-good phrase. The unit tests therefore assert on the normalized
 * string; this asserts on the thing that actually matters, in an environment where the
 * cryptography works: can the wallet be recovered from what the user pasted.
 *
 *   node scripts/verify-mnemonic-normalize.mjs
 */
import { Mnemonic, HDNodeWallet } from "ethers";

const INVISIBLE = /[   -   　﻿​-‍]/g;
const WORD_NUMBERING = /^\d+[.)\]]?$/;
function normalizeMnemonic(input) {
  return input.normalize("NFKD").replace(INVISIBLE, " ").toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 0 && !WORD_NUMBERING.test(w))
    .map((w) => w.replace(/^\d+[.)\]]/, ""))
    .filter((w) => w.length > 0)
    .join(" ");
}

const reference = HDNodeWallet.createRandom();
const PHRASE = reference.mnemonic.phrase;
const expectedAddress = reference.address;

const cases = {
  "clean": PHRASE,
  "line breaks": PHRASE.split(" ").join("\n"),
  "numbered grid": PHRASE.split(" ").map((w, i) => `${i + 1}. ${w}`).join("\n"),
  "numbering, no space": PHRASE.split(" ").map((w, i) => `${i + 1}.${w}`).join(" "),
  "double spaces": PHRASE.split(" ").join("  "),
  "surrounding whitespace": `\n  ${PHRASE}  \n`,
  "capitalised first word": PHRASE.charAt(0).toUpperCase() + PHRASE.slice(1),
  "all upper case": PHRASE.toUpperCase(),
  "non-breaking spaces": PHRASE.split(" ").join(" "),
  "zero-width space": PHRASE.split(" ").join(" ​"),
  "tabs": PHRASE.split(" ").join("\t"),
  "CRLF": PHRASE.split(" ").join("\r\n"),
};

let failures = 0;
console.log("şekil".padEnd(26) + "ham  temizlenmiş  aynı cüzdan");
for (const [label, mangled] of Object.entries(cases)) {
  const rawOk = Mnemonic.isValidMnemonic(mangled);
  const cleaned = normalizeMnemonic(mangled);
  const cleanOk = Mnemonic.isValidMnemonic(cleaned);
  const sameWallet = cleanOk && HDNodeWallet.fromPhrase(cleaned).address === expectedAddress;
  if (!cleanOk || !sameWallet) failures++;
  console.log(
    label.padEnd(26) +
    (rawOk ? "  ✓  " : "  ✗  ") + "     " +
    (cleanOk ? "✓" : "✗") + "          " +
    (sameWallet ? "✓" : "✗"),
  );
}

// A wrong phrase must stay wrong.
const wrongWord = PHRASE.split(" ").slice(0, 11).concat("zoo").join(" ");
const wrongStaysWrong = !Mnemonic.isValidMnemonic(normalizeMnemonic(wrongWord));
console.log("\nyanlış ifade yanlış kalıyor: " + (wrongStaysWrong ? "✓" : "✗ — TEHLİKELİ"));
if (!wrongStaysWrong) failures++;

console.log(failures === 0 ? "\nTÜMÜ GEÇTİ" : `\n${failures} BAŞARISIZ`);
process.exit(failures === 0 ? 0 : 1);
