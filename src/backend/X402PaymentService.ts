/**
 * X402PaymentService.ts — EIP-3009 `transferWithAuthorization` signing for x402 payments (Faz 3).
 *
 * SECURITY: This is the ONLY new signing surface Faz 3 introduces, and it follows the exact
 * rule every other signing path in this wallet already follows (ConfirmationCard's approve
 * flow, Approve.tsx's eth_signTypedData handler): the model/agent never touches a signer.
 * AgentPolicyEngine.evaluateX402Payment() decides WHETHER a payment happens; this module only
 * ever gets called AFTER that decision, and only produces a signature — it never broadcasts
 * anything itself and never calls a facilitator. What happens with the signature (posting it
 * to backend-proxy's `/agent/x402/settle` — currently a stub, see x402Stub.ts) is the caller's
 * job, not this module's.
 *
 * EIP-3009 (`transferWithAuthorization`) rather than a normal ERC-20 `transfer` + broadcast:
 * this is a GASLESS authorization — the wallet signs an EIP-712 typed message, and the x402
 * facilitator is the one that submits it on-chain and pays gas. The extension therefore never
 * calls Network.sendTransaction for an x402 payment; the signature IS the payment until a
 * facilitator settles it.
 *
 * The typed-data shape below matches Circle's USDC `FiatTokenV2` `TransferWithAuthorization`
 * struct exactly (field names, order, and types) — deviating from any of these three changes
 * the EIP-712 struct hash, which means the token contract will reject the signature outright.
 */

import { randomBytes, hexlify, verifyTypedData } from "ethers";

/** Minimal signer shape this module needs — HDNodeWallet/Wallet (Account.ethers_wallet) both satisfy it. */
export interface Eip712Signer {
  signTypedData(
    domain: Record<string, unknown>,
    types: Record<string, Array<{ name: string; type: string }>>,
    value: Record<string, unknown>
  ): Promise<string>;
}

/**
 * The EIP-3009 `TransferWithAuthorization` struct, as sent to `transferWithAuthorization` on
 * the token contract (by the facilitator, not this wallet) alongside the signature.
 */
export interface Eip3009Authorization {
  from: string;
  to: string;
  /** Atomic units of the token (USDC has 6 decimals) — a decimal string, matching x402's own `maxAmountRequired`. */
  value: string;
  /** Unix seconds — authorization is invalid before this time. 0 means "valid immediately". */
  validAfter: number;
  /** Unix seconds — authorization is invalid at or after this time. */
  validBefore: number;
  /** Random bytes32 — prevents the same authorization from being replayed/settled twice. */
  nonce: string;
}

export interface Eip3009SignedAuthorization {
  authorization: Eip3009Authorization;
  /** 65-byte (r,s,v) signature, 0x-prefixed hex — what `transferWithAuthorization` verifies on-chain. */
  signature: string;
}

/** Token contract identity needed to build the correct EIP-712 domain — see this module's own JSDoc. */
export interface Eip3009TokenIdentity {
  address: string;
  /** The token's EIP-712 domain name, e.g. "USD Coin" for USDC — must match the contract exactly. */
  name: string;
  /** The token's EIP-712 domain version, e.g. "2" for USDC — must match the contract exactly. */
  version: string;
  chainId: number;
}

const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

/** A fresh random bytes32 nonce — every authorization must use its own, or the contract treats a repeat as a replay. */
export function generateAuthorizationNonce(): string {
  return hexlify(randomBytes(32));
}

/**
 * Signs an EIP-3009 `transferWithAuthorization` message with `signer` — gasless, no
 * transaction is sent. `token` identifies which contract's domain to sign against (must be the
 * exact token the facilitator will call `transferWithAuthorization` on); `authorization` is the
 * full struct (nonce included — use generateAuthorizationNonce() to produce one, this function
 * never generates its own, so a caller replaying the exact same authorization always produces
 * the exact same signature deterministically, which matters for testing).
 */
export async function signTransferWithAuthorization(
  signer: Eip712Signer,
  token: Eip3009TokenIdentity,
  authorization: Eip3009Authorization
): Promise<Eip3009SignedAuthorization> {
  const domain = {
    name: token.name,
    version: token.version,
    chainId: token.chainId,
    verifyingContract: token.address,
  };

  const signature = await signer.signTypedData(domain, TRANSFER_WITH_AUTHORIZATION_TYPES, {
    from: authorization.from,
    to: authorization.to,
    value: authorization.value,
    validAfter: authorization.validAfter,
    validBefore: authorization.validBefore,
    nonce: authorization.nonce,
  });

  return { authorization, signature };
}

/**
 * Recovers the address that produced `signed.signature` over `token`'s domain + the
 * TransferWithAuthorization struct — the same verification a facilitator (or the token
 * contract itself, via `ecrecover`) would perform. Exists mainly for tests to prove a produced
 * signature is not just well-formed but actually verifies against the claimed signer, without
 * needing a live facilitator — see X402PaymentService.test.ts.
 */
export function recoverAuthorizationSigner(token: Eip3009TokenIdentity, signed: Eip3009SignedAuthorization): string {
  const domain = {
    name: token.name,
    version: token.version,
    chainId: token.chainId,
    verifyingContract: token.address,
  };
  const { authorization } = signed;
  return verifyTypedData(
    domain,
    TRANSFER_WITH_AUTHORIZATION_TYPES,
    {
      from: authorization.from,
      to: authorization.to,
      value: authorization.value,
      validAfter: authorization.validAfter,
      validBefore: authorization.validBefore,
      nonce: authorization.nonce,
    },
    signed.signature
  );
}
