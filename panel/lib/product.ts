/**
 * Facts about the product that the site states publicly.
 *
 * Collected in one file because they appear on more than one page and because they are
 * checkable: a visitor can open the store listing, and a reviewer can read the source. A
 * claim that drifts from what the extension does is worse than a modest one that holds.
 */

export const SITE_URL = "https://www.arfhewallet.dev/";

export const CHROME_STORE_URL =
  "https://chromewebstore.google.com/detail/arfhe-wallet/jdihllmgakeejednibihnpclbddgfchp?hl=tr";

/** First line of code, per the team. */
export const FOUNDED_YEAR = 2023;

/**
 * Networks the extension actually ships with today.
 *
 * Exactly NetworkProvider.BUILT_IN_NETWORKS — the three chains the CoFHE coprocessor runs
 * on. Stellar is deliberately absent: it is being built (this panel is the first piece of
 * it) and listing it as shipped is the kind of claim a visitor can disprove in one click.
 */
export const LIVE_NETWORKS = ["Ethereum Sepolia", "Arbitrum Sepolia", "Base Sepolia"] as const;
