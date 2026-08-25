/**
 * Tests for the cross-network fold behind the Portfolio page.
 *
 * The page's job is to answer "where is my money, and how much of it is private" over
 * every chain at once. Two things make that dangerous to get wrong, and both are pinned
 * here:
 *
 *  - A chain with no cached snapshot must be reported as *unknown*, never summed as zero.
 *    Quietly treating "never opened" as "nothing here" understates what the user owns —
 *    the same failure that once made undecryptable shielded balances disappear.
 *  - Shielded and public value must stay apart. Merging them would erase the one
 *    distinction the wallet exists to maintain, and it would do so inside a number the
 *    user reads as authoritative.
 */

import { describe, it, expect } from "vitest";
import { aggregatePortfolio, type CachedNetworkEntry } from "../Portfolio";

const SEPOLIA = 4;
const BASE_SEPOLIA = 84532;
const ARB_SEPOLIA = 421614;

const KNOWN = [
  { id: SEPOLIA, name: "Sepolia" },
  { id: ARB_SEPOLIA, name: "Arbitrum Sepolia" },
  { id: BASE_SEPOLIA, name: "Base Sepolia" },
];

/** Build a cached snapshot for one network. */
function snapshot(
  networkId: number,
  balances: { address: string; symbol: string; amount: string; usd: number; shielded?: boolean }[],
  ageMs = 1000
): CachedNetworkEntry {
  return {
    networkId,
    ageMs,
    data: {
      balances: Object.fromEntries(
        balances.map((b) => [
          b.address,
          { contractAddress: b.address, tokenBalance: b.amount, totalValueUsd: b.usd, isShielded: b.shielded },
        ])
      ),
      tokens: balances.map((b) => ({ contractAddress: b.address, symbol: b.symbol })),
      totalUsd: balances.reduce((sum, b) => sum + b.usd, 0),
    },
  };
}

describe("aggregatePortfolio", () => {
  it("hiç veri yokken bakiyeyi sıfır ilan etmez", () => {
    const result = aggregatePortfolio([], KNOWN);

    expect(result.totalUsd).toBe(0);
    expect(result.slices).toHaveLength(0);
    // The total is 0 only because nothing is known — and the page must be able to say so.
    expect(result.missing).toEqual(["Sepolia", "Arbitrum Sepolia", "Base Sepolia"]);
  });

  it("yüklenmemiş ağı eksik olarak bildirir, sıfır olarak toplamaz", () => {
    const result = aggregatePortfolio(
      [snapshot(SEPOLIA, [{ address: "0xa", symbol: "ETH", amount: "1", usd: 100 }])],
      KNOWN
    );

    expect(result.totalUsd).toBe(100);
    // Two chains were never opened. They are unknown, not empty — the distinction that
    // keeps the headline figure honest.
    expect(result.missing).toEqual(["Arbitrum Sepolia", "Base Sepolia"]);
    expect(result.slices).toHaveLength(1);
  });

  it("ağların toplamını toplar", () => {
    const result = aggregatePortfolio(
      [
        snapshot(SEPOLIA, [{ address: "0xa", symbol: "ETH", amount: "1", usd: 100 }]),
        snapshot(BASE_SEPOLIA, [{ address: "0xb", symbol: "USDC", amount: "50", usd: 50 }]),
      ],
      KNOWN
    );

    expect(result.totalUsd).toBe(150);
    expect(result.slices).toHaveLength(2);
    expect(result.missing).toEqual(["Arbitrum Sepolia"]);
  });

  it("aynı sembolü ağlar arasında tek satırda birleştirir", () => {
    const result = aggregatePortfolio(
      [
        snapshot(SEPOLIA, [{ address: "0xa", symbol: "USDC", amount: "40", usd: 40 }]),
        snapshot(BASE_SEPOLIA, [{ address: "0xb", symbol: "USDC", amount: "60", usd: 60 }]),
      ],
      KNOWN
    );

    const usdc = result.assets.find((a) => a.symbol === "USDC");
    expect(usdc?.valueUsd).toBe(100);
    expect(usdc?.amount).toBe(100);
    // The chains are named, so a combined row stays honest rather than merely tidy.
    expect(usdc?.networks.sort()).toEqual(["Base Sepolia", "Sepolia"]);
  });

  it("gizli ve açık bakiyeyi aynı satırda birleştirmez", () => {
    const result = aggregatePortfolio(
      [
        snapshot(SEPOLIA, [
          { address: "0xa", symbol: "USDC", amount: "40", usd: 40 },
          { address: "0xb", symbol: "aeUSDC", amount: "60", usd: 60, shielded: true },
        ]),
      ],
      KNOWN
    );

    // Two rows, because public and shielded are different holdings with different
    // properties — one is visible to everyone, the other to no one.
    expect(result.assets).toHaveLength(2);
    expect(result.assets.some((a) => a.isShielded)).toBe(true);
    expect(result.assets.some((a) => !a.isShielded)).toBe(true);
  });

  it("gizli değeri ağlar arasında tek sefer sayar", () => {
    const result = aggregatePortfolio(
      [
        snapshot(SEPOLIA, [
          { address: "0xa", symbol: "ETH", amount: "1", usd: 100 },
          { address: "0xs", symbol: "aeETH", amount: "0.5", usd: 50, shielded: true },
        ]),
        snapshot(BASE_SEPOLIA, [{ address: "0xt", symbol: "aeETH", amount: "0.25", usd: 25, shielded: true }]),
      ],
      KNOWN
    );

    expect(result.totalUsd).toBe(175);
    expect(result.shieldedUsd).toBe(75);
    // Per-network shielded value must add up to the overall figure, or the ratio shown
    // beside it would contradict the rows underneath.
    expect(result.slices.reduce((s, x) => s + x.shieldedUsd, 0)).toBe(75);
  });

  it("değersiz ve bozuk satırları toplama katmaz", () => {
    const result = aggregatePortfolio(
      [
        {
          networkId: SEPOLIA,
          ageMs: 0,
          data: {
            balances: {
              "0xa": { contractAddress: "0xa", tokenBalance: "1", totalValueUsd: 100 },
              "0xzero": { contractAddress: "0xzero", tokenBalance: "9999", totalValueUsd: 0 },
              "0xnan": { contractAddress: "0xnan", tokenBalance: "x", totalValueUsd: Number.NaN },
            },
            tokens: [{ contractAddress: "0xa", symbol: "ETH" }],
            totalUsd: 100,
          },
        },
      ],
      KNOWN
    );

    // A price we do not have is not value; listing it as a $0 row would bury the holdings
    // that do have one.
    expect(result.assets).toHaveLength(1);
    expect(result.assets[0].symbol).toBe("ETH");
  });

  it("FHE desteğini ağ başına doğru işaretler", () => {
    const result = aggregatePortfolio(
      [
        snapshot(SEPOLIA, [{ address: "0xa", symbol: "ETH", amount: "1", usd: 10 }]),
        snapshot(999999, [{ address: "0xb", symbol: "XYZ", amount: "1", usd: 10 }]),
      ],
      [...KNOWN, { id: 999999, name: "Some Custom Chain" }]
    );

    expect(result.slices.find((s) => s.networkId === SEPOLIA)?.supportsFhe).toBe(true);
    // A user-added chain has no coprocessor behind it, and the row must not imply one.
    expect(result.slices.find((s) => s.networkId === 999999)?.supportsFhe).toBe(false);
  });

  it("değere göre azalan sıralar", () => {
    const result = aggregatePortfolio(
      [
        snapshot(SEPOLIA, [
          { address: "0xa", symbol: "SMALL", amount: "1", usd: 5 },
          { address: "0xb", symbol: "BIG", amount: "1", usd: 500 },
        ]),
      ],
      KNOWN
    );

    expect(result.assets.map((a) => a.symbol)).toEqual(["BIG", "SMALL"]);
  });
});
