/**
 * Arfhe hunt server — hands out phrase fragments to people who earned them.
 *
 * The whole reason this exists: the previous fragments were literals in the extension's
 * bundle, and someone fed that bundle to a language model and had every word inside a
 * minute. Nothing about that was a mistake in how well they were hidden — a bundle is a
 * recipe for producing what it displays, and anything that can read the recipe can cook it.
 * Obfuscation buys time against a person and nothing at all against a machine.
 *
 * So the words are not in the bundle. They are here, on a machine the finder does not
 * control, and they are only handed over to a caller who can prove they did something the
 * bundle cannot fake on their behalf: hold a key, or spend gas, or touch a contract.
 *
 * There is no passphrase in this design (the wallet is testnet-only and a passphrase the
 * winner could not use in MetaMask would be worse than none), which means these gates are
 * the entire protection. That is worth stating plainly: brute-forcing the last four words
 * of a 24-word phrase takes days on an ordinary machine and hours on rented hardware, so if
 * twenty fragments can be collected easily, the hunt is over regardless of what the last
 * four are. The gates are not decoration.
 */

import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomBytes, createHash } from "node:crypto";
import { verifyMessage } from "ethers";

const PORT = Number(process.env.PORT || 8787);
const FRAGMENTS_FILE = process.env.FRAGMENTS_FILE || "./fragments.json";
const CLAIMS_FILE = process.env.CLAIMS_FILE || "./claims.json";

/** Where chain questions go. Read from env so no key is ever in this file. */
const RPC = {
  sepolia: process.env.RPC_SEPOLIA,
  "arb-sepolia": process.env.RPC_ARB_SEPOLIA,
  "base-sepolia": process.env.RPC_BASE_SEPOLIA,
};

/**
 * Origins allowed to call this.
 *
 * The extension's origin is `chrome-extension://<id>`, which is stable for an unpacked
 * build loaded from the same folder. Not a security control on its own — anyone can send
 * whatever Origin header they like from curl — but it keeps a casual web page from calling
 * this on a visitor's behalf. The signature is what actually authenticates.
 */
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);

/** A nonce is good for this long. Short, because a signature is cheap to produce. */
const NONCE_TTL_MS = 5 * 60 * 1000;
/** Per-address request ceiling, over the same window. Blunt, and enough. */
const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 60 * 1000;

// ── State ────────────────────────────────────────────────────────────────────

/** Issued nonces, in memory: losing them on restart just means one retry. */
const nonces = new Map(); // nonce -> { issuedAt }
const rate = new Map(); // address -> number[] (timestamps)

function loadJson(path, fallback) {
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : fallback;
  } catch (e) {
    console.error(`Could not read ${path}:`, e.message);
    return fallback;
  }
}

/** A fragment is only playable once its word has actually been written in. */
function hasWord(fragment) {
  return typeof fragment?.words === "string" && fragment.words.trim().length > 0;
}

/**
 * Where this word sits in the finished phrase.
 *
 * A recovery phrase is an ordered thing — the same twelve words in a different order open
 * nothing — so handing someone a bare word tells them less than half of what they found.
 * They have no way to know whether it is the third or the ninth.
 *
 * Taken from an explicit `index` when the fragments file sets one, and otherwise read off
 * the id: `f7` is the seventh. The fallback exists so a file that was already filled in and
 * deployed keeps working without being edited; set `index` explicitly if the wallet's words
 * are not positions 1..N of the final phrase.
 *
 * @returns The 1-based position, or null when neither source gives one.
 */
function wordIndex(id, fragment) {
  if (Number.isInteger(fragment?.index) && fragment.index > 0) return fragment.index;
  const derived = /^f(\d+)$/.exec(String(id));
  return derived ? Number(derived[1]) : null;
}


const config = loadJson(FRAGMENTS_FILE, null);
if (!config?.fragments) {
  console.error(`No fragments loaded from ${FRAGMENTS_FILE}. Copy fragments.example.json and fill it in.`);
  process.exit(1);
}

// Said out loud at boot, because the failure it prevents is silent: a server with unfilled
// words starts, answers, and looks healthy while handing finders nothing.
{
  const all = Object.entries(config.fragments);
  const missing = all.filter(([, f]) => !hasWord(f)).map(([id]) => id);
  console.log(`Fragments loaded: ${all.length - missing.length}/${all.length} playable.`);
  if (missing.length > 0) {
    console.warn(`No word set, so these will not appear at all: ${missing.join(", ")}`);
  }
}

/** How many words the finished phrase has, for the "3 / 24" the finder is shown. */
const TOTAL_WORDS = Number.isInteger(config.totalWords) ? config.totalWords : 24;

/** Who claimed what, and when. Written through on every claim. */
let claims = loadJson(CLAIMS_FILE, { entries: [] });

function recordClaim(entry) {
  claims.entries.push(entry);
  try {
    writeFileSync(CLAIMS_FILE, JSON.stringify(claims, null, 2));
  } catch (e) {
    // A claim that cannot be written is still a claim: answer the caller rather than
    // failing them for a disk problem that is not theirs.
    console.error("Could not persist claim:", e.message);
  }
}

// ── Per-address routing ──────────────────────────────────────────────────────

/**
 * Which screen this address finds a given fragment on.
 *
 * Every address gets its own arrangement. Without this, the first finder to map the hunt
 * could publish "the Portfolio one is fragment 5" and everyone after them would skip the
 * looking entirely — one person's work becoming everyone's answer key. With it, a shared
 * map is worth nothing to anyone but its author.
 *
 * Derived rather than stored: the same address always sees the same arrangement, across
 * restarts and without a database, and there is nothing to lose if this process dies.
 * A fragment can pin itself to one screen (`fixedRoute`) where the screen is the point —
 * the encryption overlay only exists during a confidential operation, and moving that one
 * elsewhere would throw away the best thing about it.
 */
function assignedRoute(address, fragmentId, fragment) {
  if (fragment.fixedRoute) return fragment.fixedRoute;

  const pool = fragment.routes || [];
  if (pool.length === 0) return null;
  if (pool.length === 1) return pool[0];

  const digest = createHash("sha256")
    .update(`${String(address).toLowerCase()}:${fragmentId}`)
    .digest();
  return pool[digest[0] % pool.length];
}

/** Addresses that have asked about a lot of different screens in a short time. */
const probes = new Map(); // address -> Map<route, timestamp>

function noteRouteProbe(address, route) {
  const seen = probes.get(address) || new Map();
  seen.set(route, Date.now());
  probes.set(address, seen);
  if (seen.size >= 10) {
    console.warn(`Address ${address} has asked about ${seen.size} routes — mapping, not playing.`);
  }
}

// ── Chain checks ─────────────────────────────────────────────────────────────

async function rpc(chain, method, params) {
  const url = RPC[chain];
  if (!url) throw new Error(`No RPC configured for chain "${chain}"`);
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(body.error.message);
  return body.result;
}

/** Outgoing transaction count. The cheapest possible proof of having used the wallet. */
async function txCount(chain, address) {
  return Number(await rpc(chain, "eth_getTransactionCount", [address, "latest"]));
}

/**
 * Has this address used one of these contracts at all?
 *
 * Two targeted queries, because a wrapper puts the address on different sides depending on
 * what was done. Shielding mints to you — `Transfer(0x0, you, amount)`, so you are the
 * *recipient*. Unshielding and sending burn or move from you, so you are the *sender*. A
 * query that only looked at the sender position could never see a shield, which is most of
 * what this gate is asked about.
 *
 * Errors are not caught here. An RPC that refuses is our problem, and the caller turns that
 * into "try again shortly" — swallowing it would answer "you have not done this yet", which
 * accuses the user of something the chain never said.
 */
/**
 * Transfers involving this address on these contracts, whichever side it is on.
 *
 * `eth_getLogs` is the obvious tool and is unusable here: the RPC plans these gates run
 * against cap it at a ten-block range, which would mean claiming a word within about two
 * minutes of the transaction or not at all. `alchemy_getAssetTransfers` answers the same
 * question with no range limit on the same plan.
 *
 * @param side "from" or "to" — which end of the transfer the address is on.
 * @returns The transfers, or null when the RPC does not offer this method at all.
 */
async function assetTransfers(chain, address, contracts, side) {
  const params = {
    fromBlock: "0x0",
    toBlock: "latest",
    contractAddresses: contracts,
    category: ["erc20"],
    excludeZeroValue: false,
    maxCount: "0x14",
    [side === "from" ? "fromAddress" : "toAddress"]: address,
  };

  try {
    const res = await rpc(chain, "alchemy_getAssetTransfers", [params]);
    return Array.isArray(res?.transfers) ? res.transfers : [];
  } catch (e) {
    // A node that has never heard of the method is a different situation from one that
    // refused the query, and only the first is worth falling back from.
    if (/method not found|not supported|unsupported method/i.test(e?.message ?? "")) return null;
    throw e;
  }
}

async function touchedContract(chain, address, contracts, blockWindow = 50_000) {
  // Both directions, because a wrapper puts the address on different sides depending on
  // what was done: shielding mints *to* you, unshielding and sending move *from* you.
  const sent = await assetTransfers(chain, address, contracts, "from");
  if (sent !== null) {
    if (sent.length > 0) return true;
    const received = await assetTransfers(chain, address, contracts, "to");
    return (received?.length ?? 0) > 0;
  }

  return touchedContractByLogs(chain, address, contracts, blockWindow);
}

/** The plain-RPC route, for nodes without Alchemy's transfer index. */
async function touchedContractByLogs(chain, address, contracts, blockWindow) {
  const latest = Number(await rpc(chain, "eth_blockNumber", []));
  const from = "0x" + Math.max(0, latest - blockWindow).toString(16);
  const self = asTopic(address);

  // Sender, then recipient. Both filtered on the address so the node returns a handful of
  // logs rather than every event these contracts have ever emitted — an unfiltered range
  // this wide is what providers reject outright.
  for (const topics of [[null, self], [null, null, self]]) {
    const logs = await rpc(chain, "eth_getLogs", [{
      fromBlock: from,
      toBlock: "latest",
      address: contracts,
      topics,
    }]);
    if (Array.isArray(logs) && logs.length > 0) return true;
  }

  return false;
}

/** `Transfer(address,address,uint256)` — what a confidential wrapper emits on every move. */
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ZERO_TOPIC = "0x" + "0".repeat(64);

/** An address as a 32-byte log topic. */
function asTopic(address) {
  return "0x" + String(address).slice(2).toLowerCase().padStart(64, "0");
}

/**
 * Has this address sent a *confidential transfer* — not merely shielded?
 *
 * The wrapper emits an ordinary `Transfer` for all three of its operations, so the contract
 * alone cannot tell them apart. The participants can:
 *
 *   shield  → from is the zero address (tokens are minted into the confidential ledger)
 *   unshield→ to is the zero address (burned back out)
 *   send    → both ends are real addresses
 *
 * So this asks for a Transfer whose sender is this address and whose recipient is somebody,
 * which is exactly "you moved value while it was encrypted" and nothing else. Someone who
 * only wrapped tokens has not done it.
 *
 * The value in that event is a fixed indicator (~7984.0001), not the real amount — the whole
 * point of the wrapper — so nothing here reads or needs it.
 */
async function sentConfidentially(chain, address, contracts, blockWindow = 50_000) {
  // Same reason as `touchedContract`: `eth_getLogs` is capped at ten blocks on the plans
  // this runs against, which would make this gate answerable only for two minutes.
  const transfers = await assetTransfers(chain, address, contracts, "from");
  if (transfers !== null) {
    // Sender matched by the query; the recipient has to be somebody. A burn back out of
    // the confidential ledger goes to the zero address and is an unshield, not a send.
    return transfers.some((t) => {
      const to = typeof t?.to === "string" ? t.to.toLowerCase() : "";
      return to !== "" && to !== "0x0000000000000000000000000000000000000000";
    });
  }

  const latest = Number(await rpc(chain, "eth_blockNumber", []));
  const from = Math.max(0, latest - blockWindow);

  const logs = await rpc(chain, "eth_getLogs", [{
    fromBlock: "0x" + from.toString(16),
    toBlock: "latest",
    address: contracts,
    topics: [TRANSFER_TOPIC, asTopic(address)],
  }]);

  if (!Array.isArray(logs)) return false;
  // Sender matched by the filter; the recipient has to be present and has to be somebody.
  // Requiring it to exist rather than defaulting to "" matters: an RPC that answered with a
  // truncated log would otherwise read as "recipient is not the burn address", and the gate
  // would open on a malformed response. A gate has to fail shut.
  return logs.some((log) => {
    const to = log?.topics?.[2];
    return typeof to === "string" && to.length === 66 && to.toLowerCase() !== ZERO_TOPIC;
  });
}

// ── Gates ────────────────────────────────────────────────────────────────────

/**
 * Whether this address has earned this fragment.
 *
 * Every gate answers with a reason when it refuses, because a hunt that says only "no"
 * teaches nobody anything and generates support messages instead of gameplay.
 */
async function checkGate(fragment, address) {
  switch (fragment.gate) {
    case "signature":
      // Holding the key is the whole requirement. The signature was already verified.
      return { ok: true };

    case "tx_count": {
      const need = fragment.minTxCount ?? 1;
      const have = await txCount(fragment.chain, address);
      return have >= need
        ? { ok: true }
        : { ok: false, reason: `needs ${need} transaction(s) on ${fragment.chain}, this address has ${have}` };
    }

    case "contract_interaction": {
      const touched = await touchedContract(fragment.chain, address, fragment.contracts);
      return touched
        ? { ok: true }
        : { ok: false, reason: `this address has not used the confidential contracts on ${fragment.chain} yet` };
    }

    case "confidential_send": {
      const sent = await sentConfidentially(fragment.chain, address, fragment.contracts);
      return sent
        ? { ok: true }
        : { ok: false, reason: `this address has not sent a confidential transfer on ${fragment.chain} yet — shielding alone is not enough` };
    }

    case "first_n": {
      // Compared lower-case throughout. Claims are stored lower-case and `address` arrives
      // checksummed from `verifyMessage`, so comparing them raw never matched — which meant
      // someone who had already earned this fragment was refused it the moment they closed
      // the wallet and came back. In a hunt run over days, that is the difference between a
      // reward and a bug report.
      const key = String(address).toLowerCase();
      const already = new Set(
        claims.entries
          .filter((c) => c.fragmentId === fragment.id)
          .map((c) => String(c.address).toLowerCase()),
      );
      if (already.has(key)) return { ok: true }; // already earned it; let them see it again
      return already.size < (fragment.limit ?? 0)
        ? { ok: true }
        : { ok: false, reason: `the first ${fragment.limit} finders have already claimed this one` };
    }

    default:
      return { ok: false, reason: `unknown gate "${fragment.gate}"` };
  }
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

function cors(req, res) {
  const origin = req.headers.origin;
  if (origin && (ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin))) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
}

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      // A body this size is already not a real request.
      if (data.length > 8192) reject(new Error("body too large"));
    });
    req.on("end", () => {
      try { resolve(JSON.parse(data || "{}")); } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

function rateLimited(address) {
  const now = Date.now();
  const hits = (rate.get(address) || []).filter((t) => now - t < RATE_WINDOW_MS);
  hits.push(now);
  rate.set(address, hits);
  return hits.length > RATE_LIMIT;
}

/** The text the wallet asks the user's key to sign. Human-readable on purpose. */
function challengeText(nonce, fragmentId) {
  return `Arfhe treasure hunt\nFragment: ${fragmentId}\nNonce: ${nonce}`;
}

const server = createServer(async (req, res) => {
  cors(req, res);
  if (req.method === "OPTIONS") return send(res, 204, {});

  try {
    if (req.method === "POST" && req.url === "/hunt/nonce") {
      const nonce = randomBytes(16).toString("hex");
      nonces.set(nonce, { issuedAt: Date.now() });
      return send(res, 200, { nonce });
    }

    if (req.method === "POST" && req.url === "/hunt/fragment") {
      const { fragmentId, address, signature, nonce } = await readBody(req);

      if (!fragmentId || !address || !signature || !nonce) {
        return send(res, 400, { error: "fragmentId, address, signature and nonce are required" });
      }

      const issued = nonces.get(nonce);
      if (!issued) return send(res, 400, { error: "unknown or already-used nonce" });
      if (Date.now() - issued.issuedAt > NONCE_TTL_MS) {
        nonces.delete(nonce);
        return send(res, 400, { error: "nonce expired" });
      }
      // Single use: a signature that could be replayed is a fragment that can be farmed.
      nonces.delete(nonce);

      let recovered;
      try {
        recovered = verifyMessage(challengeText(nonce, fragmentId), signature);
      } catch {
        return send(res, 401, { error: "signature could not be verified" });
      }
      if (recovered.toLowerCase() !== String(address).toLowerCase()) {
        return send(res, 401, { error: "signature does not match the address" });
      }

      if (rateLimited(recovered.toLowerCase())) {
        return send(res, 429, { error: "too many requests" });
      }

      const fragment = config.fragments[fragmentId];
      if (!fragment) return send(res, 404, { error: "no such fragment" });

      let verdict;
      try {
        verdict = await checkGate({ ...fragment, id: fragmentId }, recovered);
      } catch (e) {
        // A gate that cannot be evaluated — RPC down, chain not configured — must never
        // fall through to handing the fragment over. It also must not read as "you have
        // not earned this", which would send an honest finder away thinking they had
        // failed. Say what it is: our problem, try again.
        console.error(`Gate check failed for ${fragmentId}:`, e.message);
        return send(res, 503, {
          error: "could not verify this one right now",
          reason: "the chain lookup failed on our side — please try again shortly",
        });
      }
      if (!verdict.ok) return send(res, 403, { error: "not earned yet", reason: verdict.reason });

      // A fragment whose word was never filled in must not be handed over as an empty
      // string. The finder would have passed a real gate and received nothing, with no way
      // to tell that apart from a bug in the wallet — and the claim would be recorded, so
      // filling the word in later would not give it back to them.
      if (!hasWord(fragment)) {
        console.error(`Fragment ${fragmentId} passed its gate but has no word set.`);
        return send(res, 503, {
          error: "could not verify this one right now",
          reason: "this one is not ready yet — please try again shortly",
        });
      }

      recordClaim({
        fragmentId,
        address: recovered.toLowerCase(),
        at: new Date().toISOString(),
      });

      return send(res, 200, {
        words: fragment.words,
        index: wordIndex(fragmentId, fragment),
        total: TOTAL_WORDS,
      });
    }


    /**
     * Which marks exist on the screen the wallet is currently showing.
     *
     * The map lives here, not in the extension. The bundle used to say "put a mark on the
     * Portfolio screen" in plain code, so reading the bundle told you the whole layout of
     * the hunt; now it says only "ask whether this screen has one". What comes back is
     * scoped to the caller's own address, so one finder's route is not a walkthrough for
     * everyone else.
     *
     * Enumeration is still possible — the wallet's own route list is public, and someone
     * can sign once and ask about every screen in turn. That is a deliberate limit rather
     * than an oversight: knowing where a mark is does not produce the on-chain work its
     * gate requires. What this removes is reading the answers straight out of the folder.
     */
    if (req.method === "POST" && req.url === "/hunt/marks") {
      const { route, theme, chain, states, address, signature, nonce } = await readBody(req);
      if (!route || !address || !signature || !nonce) {
        return send(res, 400, { error: "route, address, signature and nonce are required" });
      }

      const issued = nonces.get(nonce);
      if (!issued || Date.now() - issued.issuedAt > NONCE_TTL_MS) {
        nonces.delete(nonce);
        return send(res, 400, { error: "unknown or expired nonce" });
      }
      nonces.delete(nonce);

      let recovered;
      try {
        recovered = verifyMessage(challengeText(nonce, `marks:${route}`), signature);
      } catch {
        return send(res, 401, { error: "signature could not be verified" });
      }
      if (recovered.toLowerCase() !== String(address).toLowerCase()) {
        return send(res, 401, { error: "signature does not match the address" });
      }
      if (rateLimited(recovered.toLowerCase())) {
        return send(res, 429, { error: "too many requests" });
      }

      // Someone walking every route in order is sounding out the map rather than playing.
      // Recorded rather than blocked: it is useful to know it happened, and a legitimate
      // finder exploring the wallet looks similar enough that refusing would catch them too.
      noteRouteProbe(recovered.toLowerCase(), route);

      const marks = [];
      for (const [id, fragment] of Object.entries(config.fragments)) {
        // No word, no mark. A bird that cannot pay out is worse than no bird: it sends a
        // finder to satisfy a hard condition for nothing.
        if (!hasWord(fragment)) continue;
        if (assignedRoute(recovered, id, fragment) !== route) continue;

        // Theme and chain are part of the hiding place, not decoration. Thirteen reachable
        // screens against twelve words would put one on nearly every screen, which is a
        // checklist rather than a hunt; requiring a particular theme and network turns the
        // same thirteen screens into dozens of distinct moments.
        //
        // Neither can be verified — the wallet is reporting on itself and could lie. That
        // is fine, because neither is protecting anything: the gate is what protects the
        // word, and the gate reads the chain. These only decide whether the mark is *shown*.
        if (fragment.theme && fragment.theme !== theme) continue;
        if (fragment.onChain && String(fragment.onChain) !== String(chain)) continue;
        // A required moment: a dialog open, a claim pending, ten messages sent. Reported by
        // the wallet and taken at its word — see the note above on why that is safe here.
        if (fragment.state && !(Array.isArray(states) && states.includes(fragment.state))) continue;

        marks.push({ id, show: null, size: fragment.size || null });
      }
      return send(res, 200, { marks });
    }

    if (req.method === "POST" && req.url === "/hunt/stats") {
      // Deliberately aggregate only: who found what is yours to see in claims.json, not
      // something to publish while the hunt is running.
      const perFragment = {};
      for (const c of claims.entries) {
        perFragment[c.fragmentId] = (perFragment[c.fragmentId] || 0) + 1;
      }
      return send(res, 200, { perFragment, total: claims.entries.length });
    }

    return send(res, 404, { error: "not found" });
  } catch (e) {
    console.error("Request failed:", e);
    return send(res, 500, { error: "server error" });
  }
});

server.listen(PORT, () => {
  console.log(`Arfhe hunt server on :${PORT}`);
  console.log(`  fragments: ${Object.keys(config.fragments).length}`);
  console.log(`  chains configured: ${Object.entries(RPC).filter(([, v]) => v).map(([k]) => k).join(", ") || "none"}`);
});
