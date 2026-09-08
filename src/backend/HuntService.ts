/**
 * HuntService — asks the hunt server for a phrase fragment this account has earned.
 *
 * Nothing about the fragments lives in this bundle. That is the entire point: the previous
 * version wrote the words into the source as literals, and someone handed the built folder
 * to a language model and had all of them in under a minute. A bundle is a recipe for what
 * it displays, and obfuscating the recipe only costs a machine a few extra seconds.
 *
 * So the words are on a server, and the wallet proves who it is before asking. The proof is
 * a signature over a server-issued nonce: it shows the caller holds the key, it cannot be
 * replayed, and it cannot be manufactured by reading this file.
 */

import Account from "./Account";

/** Where the fragments live. No fragment content is ever compiled into the bundle. */
const HUNT_API = import.meta.env.VITE_HUNT_API_URL || "";

export type FragmentResult =
  /**
   * `index` is the word's 1-based place in the finished phrase, and `total` how long that
   * phrase is. A recovery phrase is an ordered thing — the same words in a different order
   * open nothing — so a bare word is less than half of what the finder has actually found.
   *
   * Both optional: an older server does not send them, and a word with no position is still
   * worth showing.
   */
  | { status: "revealed"; words: string; index?: number; total?: number }
  | { status: "locked"; reason: string }
  | { status: "unavailable"; reason: string };

/** The text the server expects to have been signed. Must match the server exactly. */
function challengeText(nonce: string, fragmentId: string): string {
  return `Arfhe treasure hunt\nFragment: ${fragmentId}\nNonce: ${nonce}`;
}

async function postJson(path: string, body: unknown): Promise<{ status: number; data: any }> {
  const res = await fetch(`${HUNT_API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let data: any = null;
  try { data = await res.json(); } catch { /* an empty or non-JSON body is handled by status */ }
  return { status: res.status, data };
}

/**
 * Try to collect one fragment.
 *
 * Never throws. Every outcome the user could hit — no network, no account, a gate they have
 * not passed yet — comes back as a result they can read, because this runs behind a small
 * mark in the corner of a screen and a rejected promise there would surface as a crash on a
 * page that has nothing to do with the hunt.
 */
export async function claimFragment(
  fragmentId: string,
  account: Account | undefined,
): Promise<FragmentResult> {
  if (!HUNT_API) {
    return { status: "unavailable", reason: "The hunt is not running." };
  }

  const wallet = account?.ethers_wallet;
  const address = account?.GetAddress();
  if (!wallet || !address) {
    return { status: "locked", reason: "Unlock a wallet first." };
  }

  try {
    const nonceRes = await postJson("/hunt/nonce", {});
    const nonce = nonceRes.data?.nonce;
    if (!nonce) {
      return { status: "unavailable", reason: "Could not reach the hunt right now." };
    }

    // `signMessage` on the in-memory wallet: this is the account's own key proving itself,
    // not a transaction — nothing is sent, nothing is spent, no approval is needed.
    const signature = await wallet.signMessage(challengeText(nonce, fragmentId));

    const res = await postJson("/hunt/fragment", { fragmentId, address, signature, nonce });

    if (res.status === 200 && typeof res.data?.words === "string") {
      return {
        status: "revealed",
        words: res.data.words,
        index: Number.isInteger(res.data.index) ? res.data.index : undefined,
        total: Number.isInteger(res.data.total) ? res.data.total : undefined,
      };
    }
    if (res.status === 403) {
      // The interesting case: they exist, they signed, they have not earned it yet. The
      // server's reason is the hint — it is what turns a locked mark into a puzzle.
      return { status: "locked", reason: res.data?.reason || "Not yet." };
    }
    if (res.status === 429) {
      return { status: "unavailable", reason: "Too many tries. Wait a moment." };
    }
    return {
      status: "unavailable",
      reason: res.data?.reason || res.data?.error || "Could not reach the hunt right now.",
    };
  } catch {
    // Offline, blocked, DNS — all the same to the user standing in front of it.
    return { status: "unavailable", reason: "Could not reach the hunt right now." };
  }
}

/** A mark the server says belongs on the screen currently showing. */
export interface HuntMarkSpec {
  id: string;
  /** A display condition the wallet honours: "dark", "light", or null. Flavour, not a lock. */
  show: string | null;
  size: number | null;
}

/**
 * The wallet's own description of the moment it is in.
 *
 * A screen alone is too coarse a hiding place. There are thirteen screens someone can
 * actually reach and twelve words to hide, so putting one word on each makes the hunt a
 * checklist: open the wallet, visit every tab, done. Reporting the *state* as well turns
 * thirteen places into dozens — the same screen in dark mode on Base is not the same
 * hiding place as that screen in light mode on Sepolia.
 *
 * The wallet reports facts about itself and draws no conclusions. Which combination hides
 * something is decided on the server, so the bundle still contains no map — only the
 * vocabulary the two ends use to describe where the user is.
 */
export interface HuntContext {
  route: string;
  theme: "dark" | "light";
  /** Active chain id, as a decimal string. */
  chain: string;
  /**
   * Things that are true of this moment: a dialog is open, a claim is pending, the user has
   * sent ten messages to the agent.
   *
   * The wallet reports and draws no conclusion. Which combination hides something is decided
   * on the server, so the bundle carries the vocabulary and none of the meaning — knowing
   * that "has-shielded" is a word the two ends use says nothing about where it matters.
   *
   * None of this is verifiable. A caller who read the bundle can claim any state they like,
   * which is exactly why these only decide whether a mark is *drawn*: the word behind it is
   * still gated on something the server checks against the chain itself.
   */
  states?: string[];
}

/**
 * Ask whether the moment now showing carries a mark.
 *
 * The wallet does not know where the marks are. It knows how to ask. That is the whole
 * difference from the version before: the bundle used to name the screens, so reading it
 * handed over the map, and no amount of encrypting that list would have helped — a bundle
 * that can decrypt something carries the key to decrypt it.
 *
 * Returns nothing at all on any failure. A hunt that breaks a screen is worse than a hunt
 * nobody finds.
 */
export async function marksForRoute(
  context: HuntContext,
  account: Account | undefined,
): Promise<HuntMarkSpec[]> {
  const route = context.route;
  if (!HUNT_API) return [];

  const wallet = account?.ethers_wallet;
  const address = account?.GetAddress();
  if (!wallet || !address) return [];

  try {
    const nonceRes = await postJson("/hunt/nonce", {});
    const nonce = nonceRes.data?.nonce;
    if (!nonce) return [];

    const signature = await wallet.signMessage(challengeText(nonce, `marks:${route}`));
    const res = await postJson("/hunt/marks", {
      route,
      theme: context.theme,
      chain: context.chain,
      states: context.states ?? [],
      address,
      signature,
      nonce,
    });

    return res.status === 200 && Array.isArray(res.data?.marks) ? res.data.marks : [];
  } catch {
    return [];
  }
}
