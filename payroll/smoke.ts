/** Vendor edilen SDK, deponun stellar-sdk 17'siyle ÇALIŞIYOR mu? Tipler değil, runtime. */
import { ChainClient } from "../vendor/ctd-sdk/src/chain/client.js";
import { addressToField } from "../vendor/ctd-sdk/src/crypto/address.js";
import { CT_DEPLOYMENT, RPC_URL, PASSPHRASE, AUDITOR_ID } from "./deployment.js";

const client = new ChainClient({
  rpcUrl: RPC_URL, networkPassphrase: PASSPHRASE,
  contracts: { token: CT_DEPLOYMENT.token, verifier: CT_DEPLOYMENT.verifier, auditor: CT_DEPLOYMENT.auditor },
});
console.log("addr_f :", "0x" + addressToField(CT_DEPLOYMENT.token).toString(16));
const k = await client.auditorKey(AUDITOR_ID);
console.log("denetçi anahtarı okundu:", typeof k === "object" ? "✓ nokta" : k);
console.log("son ledger:", await client.latestLedger());
