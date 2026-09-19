/**
 * SEP-10 — proving the wallet holds the account it claims.
 *
 * The anchor builds a transaction that can never be submitted (sequence 0), the wallet
 * signs it, and the signature proves the key. Three checks decide whether that proof is
 * worth anything, and skipping any of them turns this into a formality:
 *
 *   - the challenge must be the one we issued (our signature is still on it),
 *   - the operation naming the account must be sourced BY that account,
 *   - the wallet's signature must verify against that same account.
 *
 * The token that comes out is signed with a key only this process knows. Nothing in the
 * wallet reads it; it exists so a later request can prove it already passed through here.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Account, Keypair, Transaction, TransactionBuilder, Operation, BASE_FEE } from "@stellar/stellar-sdk";
import { HOME_DOMAIN, NETWORK_PASSPHRASE, ORIGIN, SIGNING_KEYPAIR } from "./config.js";

const TOKEN_SECRET = randomBytes(32);
const TOKEN_TTL_SECONDS = 15 * 60;

const b64url = (input: Buffer | string): string =>
  Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function sign(payload: string): string {
  return b64url(createHmac("sha256", TOKEN_SECRET).update(payload).digest());
}


/**
 * The 64 signature bytes, whichever shape the SDK hands them in.
 *
 * Measured against the version this repo pins: `signature` is an XDR wrapper whose `value`
 * holds the bytes. Older and newer releases have exposed it as a method and as the bytes
 * themselves, and a wrong guess here does not throw — it silently fails verification, which
 * would let every challenge through or none.
 */
function rawSignature(decorated: { signature: unknown }): Buffer {
  const held = decorated.signature as
    | { value?: Uint8Array }
    | (() => Uint8Array)
    | Uint8Array;

  if (typeof held === "function") return Buffer.from(held());
  if (held instanceof Uint8Array) return Buffer.from(held);
  if (held && typeof held === "object" && held.value) return Buffer.from(held.value);
  throw new Error("signature bytes are not where this SDK version keeps them");
}

export function challenge(account: string): { transaction: string; network_passphrase: string } {
  // "-1", not "0": the builder increments the sequence it is given, and SEP-10 requires the
  // challenge to carry sequence 0 — which is what makes it unsubmittable. Handing it "0"
  // produced envelopes numbered 1 that every verifier, including this file's own, refused.
  const server = new Account(SIGNING_KEYPAIR.publicKey(), "-1");

  const tx = new TransactionBuilder(server, {
    fee: String(Number(BASE_FEE) * 2),
    networkPassphrase: NETWORK_PASSPHRASE,
    timebounds: { minTime: Math.floor(Date.now() / 1000), maxTime: Math.floor(Date.now() / 1000) + 300 },
  })
    // Sourced by the client: this is the operation whose signature proves the account.
    .addOperation(Operation.manageData({
      name: `${HOME_DOMAIN} auth`,
      value: randomBytes(48).toString("base64"),
      source: account,
    }))
    .addOperation(Operation.manageData({
      name: "web_auth_domain",
      value: HOME_DOMAIN,
      source: SIGNING_KEYPAIR.publicKey(),
    }))
    .build();

  tx.sign(SIGNING_KEYPAIR);
  return { transaction: tx.toXDR(), network_passphrase: NETWORK_PASSPHRASE };
}

export function verify(xdr: string): { token: string; account: string } {
  const tx = TransactionBuilder.fromXDR(xdr, NETWORK_PASSPHRASE);
  // A fee-bump wraps another transaction and has neither operations nor a sequence of its
  // own. A challenge is never one, so this is a rejection rather than an unwrapping.
  if (!(tx instanceof Transaction)) throw new Error("challenge must be a plain transaction");

  if (tx.source !== SIGNING_KEYPAIR.publicKey()) throw new Error("challenge was not issued here");
  if (tx.sequence !== "0") throw new Error("challenge sequence must be 0");

  const first = tx.operations[0];
  if (!first || first.type !== "manageData" || !first.source) throw new Error("malformed challenge");
  const account = first.source;

  const hash = tx.hash();
  const serverSigned = tx.signatures.some((s) => SIGNING_KEYPAIR.verify(hash, rawSignature(s)));
  if (!serverSigned) throw new Error("challenge is not ours");

  const client = Keypair.fromPublicKey(account);
  const clientSigned = tx.signatures.some((s) => client.verify(hash, rawSignature(s)));
  if (!clientSigned) throw new Error("the account did not sign the challenge");

  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify({
    iss: ORIGIN,
    sub: account,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS,
  }));
  return { token: `${header}.${body}.${sign(`${header}.${body}`)}`, account };
}

/** The account a request is acting as, or null when the token is missing or not ours. */
export function accountFromToken(header: string | undefined): string | null {
  const raw = header?.replace(/^Bearer /i, "").trim();
  if (!raw) return null;

  const [h, b, signature] = raw.split(".");
  if (!h || !b || !signature) return null;

  const expected = Buffer.from(sign(`${h}.${b}`));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;

  try {
    const payload = JSON.parse(Buffer.from(b.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    if (typeof payload.exp === "number" && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return typeof payload.sub === "string" ? payload.sub : null;
  } catch {
    return null;
  }
}
