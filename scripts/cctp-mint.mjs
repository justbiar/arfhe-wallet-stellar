/**
 * cctp-mint.mjs — the destination half of a CCTP transfer.
 *
 * The Stellar side burns and Circle attests; that much needs no EVM gas and is already
 * done. This is the last step: handing the attested message to Base Sepolia's
 * MessageTransmitter, which mints native USDC to the recipient named inside it.
 *
 * Separate from the burn because it costs gas on a different chain, with a different key.
 * In the product this is the wallet's job — the same account that will shield the USDC
 * afterwards — and doing it here first proves the message is good before any of that is
 * built.
 *
 *   PRIVATE_KEY=0x... node scripts/cctp-mint.mjs <stellar-burn-tx-hash>
 *
 * The key needs only Base Sepolia ETH for gas; it does not need to be the recipient. The
 * recipient is fixed inside the attested message and cannot be changed here — which is why
 * anyone can safely submit it.
 */

import { JsonRpcProvider, Wallet, Contract } from "ethers";

/** Circle's testnet attestation service. Source domain 27 is Stellar. */
const IRIS = "https://iris-api-sandbox.circle.com/v2/messages/27";
const BASE_SEPOLIA_RPC = "https://sepolia.base.org";

/**
 * MessageTransmitterV2 on Base Sepolia.
 * @see https://developers.circle.com/cctp/evm-smart-contracts
 */
const MESSAGE_TRANSMITTER = "0xe737e5cebeeba77efe34d4aa090756590b1ce275";
const ABI = ["function receiveMessage(bytes message, bytes attestation) external returns (bool)"];

const burnTx = process.argv[2];
if (!burnTx || !process.env.PRIVATE_KEY) {
  console.error("kullanım: PRIVATE_KEY=0x... node scripts/cctp-mint.mjs <stellar-tx-hash>");
  process.exit(1);
}

// The hash goes in unprefixed: Circle's API indexes Stellar hashes without 0x, and the
// prefixed form answers "message not found" rather than failing loudly.
const res = await fetch(`${IRIS}?transactionHash=${burnTx.replace(/^0x/, "")}`);
const body = await res.json();
const msg = body?.messages?.[0];
if (!msg) {
  console.error("attestation bulunamadı:", JSON.stringify(body).slice(0, 200));
  process.exit(1);
}
if (msg.status !== "complete") {
  // Not an error: attestation takes a moment, and minting an incomplete one just reverts.
  console.error(`attestation henüz hazır değil (status: ${msg.status}). Birazdan tekrar deneyin.`);
  process.exit(1);
}

console.log("kaynak domain :", msg.decodedMessage?.sourceDomain);
console.log("hedef domain  :", msg.decodedMessage?.destinationDomain);
console.log("alıcı         :", msg.decodedMessage?.decodedMessageBody?.mintRecipient);
console.log("tutar         :", msg.decodedMessage?.decodedMessageBody?.amount, "(6 hane)");

const wallet = new Wallet(process.env.PRIVATE_KEY, new JsonRpcProvider(BASE_SEPOLIA_RPC));
console.log("gönderen      :", wallet.address);

const transmitter = new Contract(MESSAGE_TRANSMITTER, ABI, wallet);
const tx = await transmitter.receiveMessage(msg.message, msg.attestation);
console.log("gönderildi    :", tx.hash);
const receipt = await tx.wait();
console.log(receipt.status === 1 ? "✅ basıldı" : "❌ başarısız", "blok", receipt.blockNumber);
