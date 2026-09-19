/**
 * Submitting someone else's privacy-pool payload.
 *
 * The relayer signs and pays; the payload decides what happens. See policy.mjs for what is
 * refused and why.
 */

import {
  Contract, TransactionBuilder, Networks, BASE_FEE, Keypair, rpc,
} from "@stellar/stellar-sdk";
import { inspectPayload, senderArg, assertFeeWithinCap, RelayRefused } from "./policy.mjs";

export const TESTNET_RPC = "https://soroban-testnet.stellar.org";

/** How long to wait for the network to reach a verdict before giving up on watching. */
const CONFIRM_ATTEMPTS = 20;
const CONFIRM_INTERVAL_MS = 1500;

export function createRelayer({
  secret,
  rpcUrl = TESTNET_RPC,
  networkPassphrase = Networks.TESTNET,
  allowedPools,
}) {
  if (!secret) throw new Error("relayer secret is required");
  if (!Array.isArray(allowedPools) || allowedPools.length === 0) {
    throw new Error("at least one allowed pool is required");
  }

  const keypair = Keypair.fromSecret(secret);
  const server = new rpc.Server(rpcUrl);

  return {
    publicKey: keypair.publicKey(),
    allowedPools,

    /**
     * Relays one payload and returns the hash.
     *
     * Deliberately returns the hash and nothing else. The relayer knows the recipient and
     * the amount only for a withdrawal, where both are public on the ledger anyway; for a
     * transfer it knows neither, and there is nothing to report that the caller does not
     * already have.
     */
    async relay(payload) {
      const { pool, proofScVal, extScVal, extAmount, kind } = inspectPayload(payload, { allowedPools });

      const account = await server.getAccount(keypair.publicKey());
      const contract = new Contract(pool);

      const raw = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase })
        .addOperation(contract.call("transact", proofScVal, extScVal, senderArg(keypair.publicKey())))
        .setTimeout(120)
        .build();

      let prepared;
      try {
        prepared = await server.prepareTransaction(raw);
      } catch (e) {
        // A simulation failure is usually the payload's fault, not the relayer's: a spent
        // nullifier, a stale Merkle root, a proof that does not verify. Saying so beats a
        // 500 that looks like the service is broken.
        throw new RelayRefused(`simulation failed: ${e?.message ?? e}`, "simulation_failed");
      }

      const fee = assertFeeWithinCap(prepared.fee);
      prepared.sign(keypair);

      const sent = await server.sendTransaction(prepared);
      if (sent.status === "ERROR") {
        throw new RelayRefused(`network rejected the transaction: ${sent.status}`, "rejected");
      }

      return { hash: sent.hash, kind, extAmount: extAmount.toString(), fee: fee.toString() };
    },

    /** Watches a submitted hash until the ledger decides. */
    async confirm(hash) {
      for (let attempt = 0; attempt < CONFIRM_ATTEMPTS; attempt++) {
        await new Promise((r) => setTimeout(r, CONFIRM_INTERVAL_MS));
        const got = await server.getTransaction(hash);
        if (got.status !== "NOT_FOUND") return got.status;
      }
      // Not a failure: the transaction may still be included. Saying "pending" is honest
      // where saying "failed" would invite the caller to spend the same notes twice.
      return "PENDING";
    },
  };
}
