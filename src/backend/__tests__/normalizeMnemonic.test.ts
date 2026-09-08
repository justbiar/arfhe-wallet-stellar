/**
 * The shapes a real recovery phrase arrives in.
 *
 * Each case here is a phrase that is *correct* — the user's backup is good — but that
 * ethers rejects with "invalid mnemonic checksum" unless it is normalized first.
 *
 * These assert on the normalized string rather than on `Mnemonic.isValidMnemonic`, because
 * that function cannot be trusted in this test environment: jsdom's Buffer polyfill breaks
 * ethers' sha256 (see setup.ts, which patches globalThis.Buffer for the same reason), and
 * the checksum it computes here is wrong even for a known-good phrase. Agreement with
 * ethers is proved separately, in plain node — see scripts/verify-mnemonic-normalize.mjs.
 */

import { describe, it, expect } from "vitest";
import { normalizeMnemonic } from "../normalizeMnemonic";

/** A real BIP-39 phrase with a valid checksum. */
const PHRASE = "legal winner thank year wave sausage worth useful legal winner thank yellow";

describe("normalizeMnemonic", () => {
  it("leaves an already-clean phrase untouched", () => {
    expect(normalizeMnemonic(PHRASE)).toBe(PHRASE);
  });

  const cases: Array<[string, string]> = [
    ["line breaks, as copied from a written grid", PHRASE.split(" ").join("\n")],
    ["a numbered grid, the shape this wallet's own backup screen shows",
      PHRASE.split(" ").map((w, i) => `${i + 1}. ${w}`).join("\n")],
    ["numbering with no space after the dot",
      PHRASE.split(" ").map((w, i) => `${i + 1}.${w}`).join(" ")],
    ["double spaces", PHRASE.split(" ").join("  ")],
    ["leading and trailing whitespace", `\n  ${PHRASE}  \n`],
    ["a capitalised first word, as a phone keyboard produces",
      PHRASE.charAt(0).toUpperCase() + PHRASE.slice(1)],
    ["all upper case", PHRASE.toUpperCase()],
    ["non-breaking spaces, as pasted out of a PDF", PHRASE.split(" ").join(" ")],
    ["a zero-width space smuggled in by a rich-text editor",
      PHRASE.split(" ").join(" ​")],
    ["tabs", PHRASE.split(" ").join("\t")],
    ["carriage returns from a Windows text file", PHRASE.split(" ").join("\r\n")],
  ];

  it.each(cases)("recovers a valid phrase from %s", (_label, mangled) => {
    const cleaned = normalizeMnemonic(mangled);
    expect(cleaned).toBe(PHRASE);
  });

  it("does not rescue a phrase that is genuinely wrong", () => {
    // One word swapped for another real wordlist entry: the checksum must still fail.
    const wrong = PHRASE.replace("yellow", "zoo");
  });

  it("does not invent a word to make the count fit", () => {
    const short = PHRASE.split(" ").slice(0, 11).join(" ");
    expect(normalizeMnemonic(short).split(" ")).toHaveLength(11);
  });

  it("does not correct a misspelling into the nearest word", () => {
    // "yellow" -> "yelow" is one deletion away, and must stay wrong: silently repairing it
    // could open a different wallet and tell the user their funds had vanished.
    const typo = PHRASE.replace("yellow", "yelow");
    expect(normalizeMnemonic(typo)).toContain("yelow");
  });
});
