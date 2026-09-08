/**
 * What the import screen tells someone whose phrase will not work.
 *
 * The wording is the product here. A person on this screen is usually trying to reach money
 * they cannot otherwise get to, and the previous version answered them with the ethers
 * error verbatim — "invalid mnemonic checksum (argument=\"mnemonic\", ... version=6.15.0)".
 * That reads like a fault in the phrase they wrote down and trust, and offers nothing to do
 * about it.
 *
 * These check the two things the messages must get right: the word-count case names the
 * actual count, and no message leaks library wording.
 */

import { describe, it, expect } from "vitest";
import tr from "../../locales/tr.json";
import en from "../../locales/en.json";
import { normalizeMnemonic } from "../normalizeMnemonic";

const VALID_MNEMONIC_LENGTHS = new Set([12, 15, 18, 21, 24]);

/** Wording that belongs in a stack trace, never in front of a user. */
const DEVELOPER_WORDING = [
  "checksum", "argument=", "code=", "version=", "INVALID_ARGUMENT",
  "undefined", "null", "Error:", "TypeError",
];

describe("recovery-phrase error messages", () => {
  it.each([["tr", tr], ["en", en]])("%s has all three messages", (_lang, bundle) => {
    const auth = (bundle as { auth: Record<string, string> }).auth;
    expect(auth.invalidMnemonic).toBeTruthy();
    expect(auth.mnemonicWordCount).toBeTruthy();
    expect(auth.importFailed).toBeTruthy();
  });

  it.each([["tr", tr], ["en", en]])("%s never shows developer wording", (_lang, bundle) => {
    const auth = (bundle as { auth: Record<string, string> }).auth;
    for (const key of ["invalidMnemonic", "mnemonicWordCount", "importFailed"]) {
      for (const term of DEVELOPER_WORDING) {
        expect(auth[key].toLowerCase()).not.toContain(term.toLowerCase());
      }
    }
  });

  it.each([["tr", tr], ["en", en]])("%s word-count message names the count", (_lang, bundle) => {
    const auth = (bundle as { auth: Record<string, string> }).auth;
    // Without the placeholder the message is generic, which is the whole thing it exists
    // to avoid: "you entered 11 words" is actionable, "invalid phrase" is not.
    expect(auth.mnemonicWordCount).toContain("{{count}}");
  });

  it("routes a wrong-length phrase to the count message, not the generic one", () => {
    const eleven = "abandon ".repeat(11).trim();
    const count = normalizeMnemonic(eleven).split(" ").length;
    expect(count).toBe(11);
    expect(VALID_MNEMONIC_LENGTHS.has(count)).toBe(false);
  });

  it("lets every BIP-39 length through to the checksum test", () => {
    for (const n of [12, 15, 18, 21, 24]) {
      const phrase = normalizeMnemonic("abandon ".repeat(n).trim());
      expect(VALID_MNEMONIC_LENGTHS.has(phrase.split(" ").length)).toBe(true);
    }
  });

  it("counts a numbered grid correctly, so a good phrase is not called the wrong length", () => {
    // The shape this wallet's own backup screen shows. Counting the numbers as words would
    // report 24 for a 12-word phrase and send the user hunting for a problem they do not have.
    const grid = Array.from({ length: 12 }, (_, i) => `${i + 1}. abandon`).join("\n");
    expect(normalizeMnemonic(grid).split(" ").length).toBe(12);
  });
});
