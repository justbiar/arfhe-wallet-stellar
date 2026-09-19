/**
 * The privacy-pool client, as the panel uses it.
 *
 * Wraps Nethermind's `stellar-private-payments` SDK: WebAssembly, an OPFS-backed storage
 * worker, and a prover worker that generates Groth16 proofs in the browser. None of that is
 * ours; what is ours is the deployment it points at, the signer it is given, and the honest
 * reporting of what it can and cannot do here.
 *
 * ── Three things that will break if changed ──
 *
 * 1. The SDK must not be pre-bundled. It finds its workers and wasm through
 *    `import.meta.url`, so a flattened chunk leaves them unreachable and proving hangs with
 *    no error. See `optimizeDeps.exclude` in vite.panel.config.js.
 * 2. Proving wants `crossOriginIsolated`, which needs COOP/COEP on the dev server. Without
 *    it the worker falls back or fails depending on the browser, so the page reports the
 *    flag rather than letting it fail silently.
 * 3. The circuits are 83MB and are served from node_modules by a dev middleware, not copied
 *    into `public/` — that directory is shared with the extension build.
 */

import { Keypair } from "@stellar/stellar-sdk";
import type {
  ContractConfigInput, WalletSigner, Client as SppClient, Account as SppAccountApi,
} from "stellar-private-payments";

/**
 * Nethermind's testnet deployment, copied from the reference repo's
 * `deployments/testnet/deployments.json`.
 *
 * Inlined rather than fetched: it is configuration this page is built against, and a
 * deployment that changed under us should be a visible edit here, not a silent difference
 * at runtime.
 *
 * @see https://github.com/NethermindEth/stellar-private-payments
 */
export const SPP_DEPLOYMENT: ContractConfigInput = {
  network: "testnet",
  deployer: "GDZT6XVSNIGMTL34KS46RM3D26GPWM4POMCBYL7FUIQXRMSVUALSWRBE",
  admin: "GCBU2YCJGVLRSPPFK3ADYNUEH2W6ZFNNJLX6IHCEZT54VOHZZNYNHXDG",
  asp_membership: "CALQNKQ4ZW2O7L2LLJKLVKMXRFWLT5U77LKOI2CKLKZT7KX2YRQ5UMB3",
  asp_non_membership: "CAADTTZWMNAABQOOTGRYLPEKWGMQT746A4EF7JWMBY5TJTMUNQYB4UZ3",
  verifiers: {
    B: "CCHMOZQRSTWQY7I3A5J3HIASYJO7K2IU5KK2GYVGQJQ7VNQZD2PHGVI3",
    B_gvk_T: "CCMQECBF4RJRH2VSNEW4XJZRUREHGA7UK23NSV4LRLFTKRQSBWSZ3SD2",
  },
  public_key_registry: "CCQ24X7RNSMWXLLVAVZ6LOI4EGXKPWXP5QWIM4NEZYYAYHWPZSUNTR2A",
  pools: [
    {
      poolContractId: "CCM5G4FCOV7PLKFMEJBCYM5R7JOTZVUXKWBDR3SWCW2IM2LKNNBO4TH5",
      tokenContractId: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
      deploymentLedger: 4710199,
      enabled: true,
      policyFlags: ["blocklist"],
      asset: { kind: "native" },
    },
    {
      poolContractId: "CBPWCM2VR6MYVN77V4BXG4YIDJOEMNFB6OU7EBGNRYXK5FORVC72Z4CY",
      tokenContractId: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
      deploymentLedger: 4710203,
      enabled: true,
      policyFlags: ["blocklist"],
      asset: { kind: "native" },
      gvkMode: "traceable",
      gvkAuthorityPubKey: {
        x: "0x2cbbc711f33fd3b3bb4bff90154c5704564a121ac8a20baedda9e4f553c2be08",
        y: "0x01e0794e7aeef82ba1d53c14f342cea9e8777470b76f48ef6be7e98dd32ab344",
      },
    },
  ],
};

export const SPP_RPC_URL = "https://soroban-testnet.stellar.org";
export const SPP_NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";

/** Served by the dev middleware in vite.panel.config.js. */
export const SPP_CIRCUITS_BASE_URL = "/spp-circuits/";

/**
 * The bootnode that serves event history older than the RPC's ~7-day window.
 *
 * Optional, and named here rather than hidden: without it a client that joined late cannot
 * rebuild its notes at all, and with it the operator can see request timing and IP, and
 * could in principle serve a false history. The SDK's own onboarding says as much.
 */
export const SPP_BOOTNODE_URL = "https://bootnode.dev-nethermind.xyz";

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/**
 * The digest to sign, typed as whatever `Keypair.sign` accepts.
 *
 * That parameter is a Node `Buffer` in the SDK's types, which this app has no reason to
 * pull in — the value is a plain Uint8Array at runtime and the SDK is happy with it.
 */
async function signable(bytes: Uint8Array): Promise<Parameters<Keypair["sign"]>[0]> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
  return digest as unknown as Parameters<Keypair["sign"]>[0];
}

/**
 * A signer backed by a key this page holds.
 *
 * Only correct for the panel's throwaway demo account. The extension's key never reaches
 * this page, so when Arfhe signs it will be through the provider, not through this.
 */
export function localSigner(keypair: Keypair): WalletSigner {
  return {
    async getPublicKey() {
      return keypair.publicKey();
    },

    /**
     * SEP-53: the signature is over the SHA-256 digest of
     * `"Stellar Signed Message:\n" + message`, not over the message itself.
     *
     * The SDK verifies this against the owner's address before it will derive or store
     * privacy keys, and rejects anything that does not check out — so getting the prefix
     * or the digest wrong fails at `account()` rather than producing unusable keys.
     */
    async signMessage(message: string) {
      const payload = new TextEncoder().encode(`Stellar Signed Message:\n${message}`);
      return {
        signedMessage: toBase64(keypair.sign(await signable(payload))),
        signerAddress: keypair.publicKey(),
      };
    },

    async signTransaction(xdr: string) {
      const { TransactionBuilder } = await import("@stellar/stellar-sdk");
      const tx = TransactionBuilder.fromXDR(xdr, SPP_NETWORK_PASSPHRASE);
      tx.sign(keypair);
      return { signedTxXdr: tx.toXDR(), signerAddress: keypair.publicKey() };
    },

    async signAuthEntry(xdr: string) {
      return {
        signedAuthEntry: toBase64(keypair.sign(await signable(fromBase64(xdr)))),
        signerAddress: keypair.publicKey(),
      };
    },
  };
}

export interface SppSession {
  client: SppClient;
  bootnodeNeeded: boolean;
  crossOriginIsolated: boolean;
}

export type SppAccount = SppAccountApi;

/**
 * Boots the SDK and reports what the environment allows.
 *
 * Dynamic import: 90MB of wasm and circuits has no business loading for a visitor who came
 * to read the landing page.
 */
export async function openSpp(): Promise<SppSession> {
  const sdk = await import("stellar-private-payments");
  await sdk.default();

  const storage = await sdk.Storage.open();
  const contractConfig = SPP_DEPLOYMENT;

  const bootnodeNeeded = await sdk.bootnodeRequired(SPP_RPC_URL, storage, { contractConfig });

  const client = await sdk.Client.new({
    rpcUrl: SPP_RPC_URL,
    storage,
    contractConfig,
    circuitsBaseUrl: new URL(SPP_CIRCUITS_BASE_URL, window.location.origin).href,
    ...(bootnodeNeeded ? { bootnodeUrl: SPP_BOOTNODE_URL } : {}),
  });

  return {
    client,
    bootnodeNeeded,
    // Reported, not assumed. Proving needs it, and a page that quietly cannot prove is
    // worse than one that says so before anybody presses a button.
    crossOriginIsolated: window.crossOriginIsolated === true,
  };
}

/** Stroops are the unit on the wire; nobody divides by ten million while reading a screen. */
export function stroopsToXlm(stroops: bigint): string {
  const negative = stroops < 0n;
  const abs = negative ? -stroops : stroops;
  const whole = abs / 10_000_000n;
  const frac = (abs % 10_000_000n).toString().padStart(7, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}
