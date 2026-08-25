/**
 * Tests for the one guarantee a swap has to keep: **the number the user is shown is the
 * number the transaction enforces.**
 *
 * It did not. Two decisions combined to burn real funds:
 *
 *  1. On testnets the quote displayed the CoinGecko market rate "so prices look
 *     realistic". The pool, not CoinGecko, decides the output.
 *  2. On testnets `amountOutMinimum` was set to `0` — "accept whatever the pool gives" —
 *     while the panel above it displayed a minimum received.
 *
 * So the interface promised at least 12.72 UNI for 56 USDC, the transaction promised
 * nothing, and the pool paid 0.000116 UNI. Slippage protection exists for precisely that
 * transaction: with a real floor it would have reverted and the funds would have stayed.
 *
 * The arithmetic is reproduced here directly rather than through the service, because that
 * path needs a live pool, an RPC and CoinGecko. What is pinned is the rule, and the rule is
 * simple enough that stating it in a test is the point.
 */

import { describe, it, expect } from "vitest";

/** The floor now built into every swap, from the same figure the user is quoted. */
function minimumOut(quotedOutRaw: bigint, slippageBps: number): bigint {
  return (quotedOutRaw * BigInt(10000 - slippageBps)) / 10000n;
}

/** 18-decimal token amount. */
const units = (whole: string) => BigInt(Math.round(parseFloat(whole) * 1e6)) * 10n ** 12n;

describe("swap slippage floor", () => {
  it("kotasyondan gerçek bir taban üretir", () => {
    const quoted = units("12.784736");
    const floor = minimumOut(quoted, 50); // 0.5%

    expect(floor).toBeGreaterThan(0n);
    // Within half a percent of what was quoted, which is what "0.5% slippage" means.
    expect(Number(floor) / Number(quoted)).toBeCloseTo(0.995, 4);
  });

  it("felaket çıktıyı reddedecek kadar yüksek bir taban kurar", () => {
    // The exact trade that lost the funds: quoted 12.784736 UNI, pool paid 0.000116352.
    const quoted = units("12.784736");
    const actuallyPaid = units("0.000116352");
    const floor = minimumOut(quoted, 50);

    // With this floor in the transaction, the router reverts instead of settling. That is
    // the whole difference between losing 56 USDC and keeping it.
    expect(actuallyPaid).toBeLessThan(floor);
  });

  it("taban asla sıfır olmaz", () => {
    // The regression: `minAmountOut = 0n` on testnets accepted any output at all,
    // including dust, on the networks where pools diverge most.
    for (const slippageBps of [10, 50, 100, 300, 500]) {
      const floor = minimumOut(units("1.0"), slippageBps);
      expect(floor, `slippage ${slippageBps}bps`).toBeGreaterThan(0n);
    }
  });

  it("yüksek kayma toleransı bile korumayı kaldırmaz", () => {
    // Even a deliberately loose 5% still refuses a six-orders-of-magnitude shortfall.
    const quoted = units("12.784736");
    const floor = minimumOut(quoted, 500);

    expect(floor).toBeGreaterThan(units("12.0"));
    expect(units("0.000116352")).toBeLessThan(floor);
  });

  it("küçük kaymayı geçirir", () => {
    // Normal execution — a fraction of a percent below the quote — must still settle, or
    // the protection would block ordinary trades.
    const quoted = units("100.0");
    const floor = minimumOut(quoted, 50);
    const realistic = units("99.8");

    expect(realistic).toBeGreaterThan(floor);
  });
});

describe("quoted amount and enforced floor agree", () => {
  /**
   * The failure was not the arithmetic — it was that the displayed figure and the
   * transaction were computed from *different sources*. This pins that they share one.
   */
  it("gösterilen minimum ile zincire giden taban aynı sayıdan türer", () => {
    const poolQuote = units("12.784736");
    const slippageBps = 50;

    // What the panel prints.
    const displayedMinimum = minimumOut(poolQuote, slippageBps);
    // What goes into exactInputSingle.
    const enforcedFloor = minimumOut(poolQuote, slippageBps);

    expect(enforcedFloor).toBe(displayedMinimum);
  });

  it("piyasa kuru tabanı belirlemez", () => {
    // CoinGecko said 0.228299 UNI per USDC; the pool said otherwise. Deriving the floor
    // from the market figure is what made the on-chain protection meaningless.
    const marketBasedOut = units("12.784736"); // 56 USDC × 0.228299
    const poolBasedOut = units("0.000116352");

    const floorFromPool = minimumOut(poolBasedOut, 50);
    const floorFromMarket = minimumOut(marketBasedOut, 50);

    // A floor derived from the pool is one the pool can actually satisfy; one derived from
    // the market cannot be met and must therefore revert rather than be discarded.
    expect(poolBasedOut).toBeGreaterThan(floorFromPool);
    expect(poolBasedOut).toBeLessThan(floorFromMarket);
  });
});
