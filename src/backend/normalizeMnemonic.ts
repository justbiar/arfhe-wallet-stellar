/**
 * normalizeMnemonic — make a pasted recovery phrase match what BIP-39 expects.
 *
 * A phrase is twelve words separated by single spaces, lower case. Almost nothing a user
 * pastes arrives in that shape, because almost nothing they copied it from stored it that
 * way: this wallet's own backup screen lays the words out in a numbered three-column grid,
 * a phrase written into Notes comes back with line breaks, a phone keyboard capitalises the
 * first word, and a copy out of a PDF carries non-breaking spaces that look identical to
 * ordinary ones on screen.
 *
 * Every one of those produces the same result — `invalid mnemonic checksum` — for a phrase
 * that is entirely correct. The user is told their backup is wrong when it is not, which is
 * the single worst thing this screen can say to someone who is trying to recover funds.
 *
 * What this deliberately does NOT do is guess. It does not correct spelling, swap in the
 * nearest wordlist entry, or drop a word to make the count fit. A phrase that is wrong must
 * stay wrong: silently "fixing" one into a valid but different phrase would open an empty
 * wallet and tell the user their money was gone.
 */

/**
 * Characters that are whitespace to a reader but not to `split(" ")`.
 *
 * Non-breaking and narrow spaces come from PDFs and web pages; the zero-width characters
 * come from rich-text editors and are invisible even on close inspection, which is why a
 * user comparing their paste against their backup letter by letter sees no difference.
 */
const INVISIBLE = /[   -   　﻿​-‍]/g;

/** Leading list numbering: "1. word", "1) word", "1 word" as produced by a written grid. */
const WORD_NUMBERING = /^\d+[.)\]]?$/;

export function normalizeMnemonic(input: string): string {
  return input
    // NFKD is what BIP-39 specifies. It matters for accented wordlists, and costs nothing
    // for English — a phrase typed on a keyboard that composes accents differently is the
    // same phrase, and must hash to the same seed.
    .normalize("NFKD")
    .replace(INVISIBLE, " ")
    .toLowerCase()
    // Any run of whitespace — including the line breaks from a grid — is one separator.
    .split(/\s+/)
    // Strip the numbering a user pastes along with a numbered backup. A bare number is
    // never a BIP-39 word, so dropping it cannot destroy a real one.
    .filter((word) => word.length > 0 && !WORD_NUMBERING.test(word))
    // "1.word" with no space after the dot.
    .map((word) => word.replace(/^\d+[.)\]]/, ""))
    .filter((word) => word.length > 0)
    .join(" ");
}
