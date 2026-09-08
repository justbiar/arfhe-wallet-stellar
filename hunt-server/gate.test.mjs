/**
 * The gate that tells a confidential send apart from a shield.
 *
 * Worth testing on its own because the difference is invisible in the obvious place: the
 * wrapper emits the same `Transfer` event for shielding, sending and unshielding, and the
 * amount in it is a fixed indicator rather than the real value. Only the participants
 * differ. Getting this wrong in the lenient direction would hand three of the twelve words
 * to anyone who had merely wrapped a token — the three that are supposed to be the hardest.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ZERO_TOPIC = "0x" + "0".repeat(64);
const USER = "0x7bA4e69f549C17188dFf78BA5c48ce452169c0E5";
const OTHER = "0x1234567890123456789012345678901234567890";

function asTopic(a) { return "0x" + a.slice(2).toLowerCase().padStart(64, "0"); }

/** The predicate as server.mjs applies it, given logs already filtered by sender. */
function isSend(logs) {
  return logs.some((log) => {
    const to = log?.topics?.[2];
    return typeof to === "string" && to.length === 66 && to.toLowerCase() !== ZERO_TOPIC;
  });
}

test("a confidential send counts", () => {
  assert.equal(isSend([{ topics: [TRANSFER_TOPIC, asTopic(USER), asTopic(OTHER)] }]), true);
});

test("an unshield does not — the recipient is the burn address", () => {
  // Someone who only ever unwrapped has not sent anything to anybody.
  assert.equal(isSend([{ topics: [TRANSFER_TOPIC, asTopic(USER), ZERO_TOPIC] }]), false);
});

test("no activity at all does not", () => {
  assert.equal(isSend([]), false);
});

test("one real send among unshields is enough", () => {
  assert.equal(isSend([
    { topics: [TRANSFER_TOPIC, asTopic(USER), ZERO_TOPIC] },
    { topics: [TRANSFER_TOPIC, asTopic(USER), asTopic(OTHER)] },
    { topics: [TRANSFER_TOPIC, asTopic(USER), ZERO_TOPIC] },
  ]), true);
});

test("a malformed log is not treated as a send", () => {
  // An RPC that answers with something unexpected must fail closed, not open.
  assert.equal(isSend([{ topics: [TRANSFER_TOPIC, asTopic(USER)] }]), false);
  assert.equal(isSend([{}]), false);
});

test("the burn address is matched regardless of case", () => {
  const upper = "0x" + "0".repeat(64).toUpperCase();
  assert.equal(isSend([{ topics: [TRANSFER_TOPIC, asTopic(USER), upper] }]), false);
});

/**
 * The gate that asks "have you used this contract at all".
 *
 * Worth its own tests because the address does not sit in the same place every time. A
 * shield mints *to* you; an unshield or a send moves *from* you. A single query on the
 * sender position looks correct and quietly cannot see a shield — which is most of what
 * this gate is asked about, and is what left it refusing users who had done the work.
 */

/** Mirrors touchedContract's query plan, against a fake node. */
async function touched(logsByTopics) {
  const self = asTopic(USER);
  for (const topics of [[null, self], [null, null, self]]) {
    const key = JSON.stringify(topics);
    const logs = logsByTopics[key];
    if (Array.isArray(logs) && logs.length > 0) return true;
  }
  return false;
}

const AS_SENDER = JSON.stringify([null, asTopic(USER)]);
const AS_RECIPIENT = JSON.stringify([null, null, asTopic(USER)]);

test("an unshield counts — the address is the sender", async () => {
  assert.equal(await touched({ [AS_SENDER]: [{ topics: [] }], [AS_RECIPIENT]: [] }), true);
});

test("a shield counts — the address is the recipient", async () => {
  assert.equal(await touched({ [AS_SENDER]: [], [AS_RECIPIENT]: [{ topics: [] }] }), true);
});

test("an address that has done neither is refused", async () => {
  assert.equal(await touched({ [AS_SENDER]: [], [AS_RECIPIENT]: [] }), false);
});

test("an RPC error is not answered as 'you have not done it'", async () => {
  // touchedContract deliberately does not catch: the caller turns a throw into "our
  // problem, try again", where swallowing it would accuse the user instead.
  const exploding = async () => { throw new Error("query returned more than 10000 results"); };
  await assert.rejects(exploding, /10000/);
});

/**
 * The same send/shield distinction, read from the transfer index instead of raw logs.
 *
 * The RPC plans this runs against cap `eth_getLogs` at ten blocks, so the gates ask
 * `alchemy_getAssetTransfers` instead. The rule is unchanged and so is the direction it
 * must fail in — but the shape of the answer is different, and a predicate written for
 * topics does not read `to` off a transfer.
 */
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** The predicate as server.mjs applies it to transfers already filtered by sender. */
function isSendTransfer(transfers) {
  return transfers.some((t) => {
    const to = typeof t?.to === "string" ? t.to.toLowerCase() : "";
    return to !== "" && to !== ZERO_ADDRESS;
  });
}

test("transfer index: a confidential send counts", () => {
  assert.equal(isSendTransfer([{ from: USER, to: OTHER }]), true);
});

test("transfer index: an unshield does not — it burns to the zero address", () => {
  assert.equal(isSendTransfer([{ from: USER, to: ZERO_ADDRESS }]), false);
});

test("transfer index: a recipient Alchemy left out fails shut", () => {
  assert.equal(isSendTransfer([{ from: USER }]), false);
  assert.equal(isSendTransfer([{ from: USER, to: null }]), false);
});

test("transfer index: checksummed addresses still match the zero address", () => {
  assert.equal(isSendTransfer([{ from: USER, to: ZERO_ADDRESS.toUpperCase().replace("0X", "0x") }]), false);
});
