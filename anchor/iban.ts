/**
 * A sandbox IBAN, derived from the Stellar account it belongs to.
 *
 * ── What this is not ──
 *
 * No bank issued it. It is shaped like a Turkish IBAN and passes the mod-97 check, which is
 * exactly enough to behave like one inside this demo and not one digit more: money sent to
 * it in the real world goes nowhere. The screens say so; this file is the reason they can.
 *
 * ── Why derived rather than random ──
 *
 * The same account must get the same number on every request and after every restart. The
 * anchor keeps no database, so the account id is the only stable input there is — and it is
 * public, so nothing is leaked by using it. A random one would change under the user while
 * they were copying it into their banking app.
 */

import { createHash } from "node:crypto";

/** Our fictional bank's code, and the reserved digit Turkish IBANs carry. */
const BANK_CODE = "00009";
const RESERVED = "0";

/** Letters count as 10 + their alphabet position: T = 29, R = 27. */
const COUNTRY_NUMERIC = "2927";

/**
 * mod 97 over a number too long for a JS integer, taken digit by digit.
 *
 * `Number(bban)` silently loses precision past 2^53 and the check digits it produces look
 * plausible and fail everywhere — the kind of bug that only shows up when someone validates
 * the IBAN in a real form.
 */
function mod97(digits: string): number {
  let remainder = 0;
  for (const ch of digits) remainder = (remainder * 10 + Number(ch)) % 97;
  return remainder;
}

export function ibanFor(stellarAccount: string): string {
  const hash = createHash("sha256").update(stellarAccount).digest("hex");
  // 16 digits of account number, from the hash rather than a counter: no state to keep.
  const account = BigInt("0x" + hash.slice(0, 20)).toString().padStart(16, "0").slice(-16);

  const bban = `${BANK_CODE}${RESERVED}${account}`;
  // "00" stands in for the check digits while they are being computed; the real ones
  // take their place in the validation below.
  const check = String(98 - mod97(`${bban}${COUNTRY_NUMERIC}00`)).padStart(2, "0");
  return `TR${check}${bban}`;
}

/** True when `iban` passes the mod-97 check — the test a real form would run. */
export function isValidIban(iban: string): boolean {
  const bare = iban.replace(/\s+/g, "").toUpperCase();
  if (!/^TR\d{24}$/.test(bare)) return false;
  // Country code and the IBAN's own check digits move to the end, in that order.
  return mod97(`${bare.slice(4)}${COUNTRY_NUMERIC}${bare.slice(2, 4)}`) === 1;
}
