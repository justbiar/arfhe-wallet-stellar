/**
 * What the relayer will and will not carry.
 *
 * The relayer exists so a privacy-pool transfer is not signed by the person whose notes
 * move. On Stellar the transaction source pays the fee and is public, so as long as the
 * user submits their own transfer, the amount and the recipient are hidden and the sender
 * is not. Handing the payload to someone else to submit closes that gap — the pool's
 * `transact` takes a `sender` address, calls `require_auth()` on it, and then uses it only
 * when tokens are pulled in, which happens on a deposit and nowhere else.
 *
 * That last clause is why this file exists. `sender` being free is what makes relaying
 * possible, and it is also what makes relaying dangerous: submit somebody's deposit payload
 * and the contract pulls the tokens from *us*. So the rules below are not hygiene, they are
 * the difference between a service and a faucet.
 *
 * The payload itself cannot be tampered with — `ext_data_hash`, a public input of the
 * proof, binds the pool, the token, the recipient, the amount and both ciphertexts, and
 * `sender` is deliberately outside it. A relayer can refuse or delay. It cannot redirect.
 */

import { xdr, scValToNative, Address } from "@stellar/stellar-sdk";

/** Bigger than any honest payload; a guard against being made to parse rubbish. */
export const MAX_ARG_B64 = 8192;

/**
 * The most we will pay for one relay, in stroops.
 *
 * Measured transfers cost about 180,000. The cap is an order of magnitude above that: high
 * enough that ordinary fee movement never trips it, low enough that a pathological payload
 * cannot drain the relayer one submission at a time.
 */
export const MAX_FEE_STROOPS = 2_000_000;

export class RelayRefused extends Error {
  constructor(message, code = "refused") {
    super(message);
    this.name = "RelayRefused";
    this.code = code;
  }
}

/** Decodes one base64 ScVal argument, refusing anything oversized or malformed. */
function decodeArg(b64, label) {
  if (typeof b64 !== "string" || b64.length === 0) {
    throw new RelayRefused(`${label} missing`, "bad_request");
  }
  if (b64.length > MAX_ARG_B64) {
    throw new RelayRefused(`${label} too large`, "bad_request");
  }
  try {
    return xdr.ScVal.fromXDR(b64, "base64");
  } catch {
    throw new RelayRefused(`${label} is not a valid ScVal`, "bad_request");
  }
}

/**
 * Reads the parts of a payload the relayer must judge, without trusting the caller's
 * description of them. Everything here comes out of the XDR itself.
 */
export function inspectPayload({ pool, proof, extData }, { allowedPools }) {
  if (typeof pool !== "string" || !/^C[A-Z2-7]{55}$/.test(pool)) {
    throw new RelayRefused("pool is not a contract id", "bad_request");
  }
  if (!allowedPools.includes(pool)) {
    // Not a general-purpose submitter: an unknown contract could be anything, including
    // one that spends the relayer's own balance.
    throw new RelayRefused("pool is not on this relayer's list", "pool_not_allowed");
  }

  const proofScVal = decodeArg(proof, "proof");
  const extScVal = decodeArg(extData, "extData");

  let ext;
  try {
    ext = scValToNative(extScVal);
  } catch {
    throw new RelayRefused("extData does not decode", "bad_request");
  }
  if (!ext || typeof ext !== "object" || Array.isArray(ext)) {
    throw new RelayRefused("extData is not a map", "bad_request");
  }

  const { ext_amount: extAmount, recipient } = ext;
  if (typeof extAmount !== "bigint") {
    throw new RelayRefused("extData.ext_amount is missing or not an integer", "bad_request");
  }
  if (typeof recipient !== "string") {
    throw new RelayRefused("extData.recipient is missing", "bad_request");
  }
  for (const field of ["encrypted_output0", "encrypted_output1"]) {
    if (!(ext[field] instanceof Uint8Array)) {
      throw new RelayRefused(`extData.${field} is missing`, "bad_request");
    }
  }

  // THE rule. A positive ext_amount is a deposit, and `transact` funds a deposit with
  // `token.transfer(sender, pool, amount)` — where `sender` is whoever submits. Relaying
  // one would pay for a stranger's deposit out of the relayer's own balance, and the
  // deposit is public anyway, so there is no privacy to buy here even if it were free.
  if (extAmount > 0n) {
    throw new RelayRefused(
      "deposits cannot be relayed: the pool would pull the tokens from the relayer",
      "deposit_rejected"
    );
  }

  return {
    pool,
    proofScVal,
    extScVal,
    extAmount,
    recipient,
    kind: extAmount === 0n ? "transfer" : "withdraw",
  };
}

/** The relayer's own address, as the `sender` argument the contract will authorize. */
export function senderArg(publicKey) {
  return Address.fromString(publicKey).toScVal();
}

/**
 * Refuses a prepared transaction whose fee exceeds the cap.
 *
 * Checked after simulation rather than before: the fee is only known once the resource
 * footprint is, and a payload that is expensive for reasons we cannot see is exactly the
 * one worth declining.
 */
export function assertFeeWithinCap(fee) {
  const charged = BigInt(fee);
  if (charged > BigInt(MAX_FEE_STROOPS)) {
    throw new RelayRefused(
      `fee ${charged} exceeds this relayer's cap of ${MAX_FEE_STROOPS} stroops`,
      "fee_too_high"
    );
  }
  return charged;
}
