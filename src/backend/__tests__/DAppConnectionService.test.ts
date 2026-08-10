/**
 * Tests for the dApp request guards.
 *
 * `checkRequestMatchesWallet` decides whether a WalletConnect request is signed at all, so
 * a hole here is a funds-loss bug rather than a UI glitch: the chain is signed into the
 * transaction, and the account is what actually pays.
 */

import { describe, it, expect } from "vitest";
import { checkRequestMatchesWallet, analyzeFheRisk } from "../DAppConnectionService.js";

const SEPOLIA = 11155111;
const MAINNET = 1;
const ALICE = "0xAbCdEf0000000000000000000000000000000001";
const BOB = "0x1234560000000000000000000000000000000002";

describe("checkRequestMatchesWallet", () => {
  it("zincir ve hesap uyuşuyorsa geçirir", () => {
    expect(checkRequestMatchesWallet(`eip155:${SEPOLIA}`, SEPOLIA, ALICE, ALICE)).toBeNull();
  });

  it("imzalayan belirtilmemişse sadece zincire bakar", () => {
    // Not every method names an address; inventing a mismatch would break them.
    expect(checkRequestMatchesWallet(`eip155:${SEPOLIA}`, SEPOLIA, undefined, ALICE)).toBeNull();
  });

  it("mainnet isteği testnet cüzdanında reddedilir", () => {
    // The case that used to execute silently on whichever network was selected.
    const problem = checkRequestMatchesWallet(`eip155:${MAINNET}`, SEPOLIA, ALICE, ALICE);
    expect(problem).toContain("chain 1");
    expect(problem).toContain("chain 11155111");
  });

  it("testnet isteği mainnet cüzdanında da reddedilir", () => {
    // The dangerous direction: a transaction the user believed was a test, sent for real.
    expect(checkRequestMatchesWallet(`eip155:${SEPOLIA}`, MAINNET, ALICE, ALICE)).not.toBeNull();
  });

  it("zincir bilgisi yoksa reddeder", () => {
    expect(checkRequestMatchesWallet(undefined, SEPOLIA, ALICE, ALICE)).not.toBeNull();
    expect(checkRequestMatchesWallet("eip155:", SEPOLIA, ALICE, ALICE)).not.toBeNull();
    expect(checkRequestMatchesWallet("garbage", SEPOLIA, ALICE, ALICE)).not.toBeNull();
  });

  it("aktif ağ yoksa reddeder", () => {
    expect(checkRequestMatchesWallet(`eip155:${SEPOLIA}`, undefined, ALICE, ALICE)).not.toBeNull();
  });

  it("başka bir hesap için istenen imzayı reddeder", () => {
    const problem = checkRequestMatchesWallet(`eip155:${SEPOLIA}`, SEPOLIA, BOB, ALICE);
    expect(problem).toContain(BOB);
    expect(problem).toContain(ALICE);
  });

  it("adres karşılaştırması büyük/küçük harfe duyarsızdır", () => {
    // EIP-55 checksummed vs lowercase is the same account.
    expect(
      checkRequestMatchesWallet(`eip155:${SEPOLIA}`, SEPOLIA, ALICE.toLowerCase(), ALICE.toUpperCase().replace("0X", "0x"))
    ).toBeNull();
  });

  it("aktif hesap yokken imzalayan istenirse reddeder", () => {
    expect(checkRequestMatchesWallet(`eip155:${SEPOLIA}`, SEPOLIA, ALICE, undefined)).not.toBeNull();
  });

  it("adres olmayan imzalayan alanını yok sayar", () => {
    // Malformed params must not become an accidental bypass or a false rejection.
    expect(checkRequestMatchesWallet(`eip155:${SEPOLIA}`, SEPOLIA, 42, ALICE)).toBeNull();
    expect(checkRequestMatchesWallet(`eip155:${SEPOLIA}`, SEPOLIA, "not-an-address", ALICE)).toBeNull();
  });
});

describe("analyzeFheRisk", () => {
  it("düz ETH transferini güvenli sayar", () => {
    expect(analyzeFheRisk(undefined, ALICE).riskLevel).toBe("safe");
    expect(analyzeFheRisk("0x", ALICE).riskLevel).toBe("safe");
  });

  it("gizli bakiyeye dokunan selector'ı işaretler", () => {
    // unwrap(uint256) — moves value out of the confidential layer.
    const analysis = analyzeFheRisk("0x2e1a7d4d" + "0".repeat(64), ALICE);
    expect(analysis.isFheSensitive).toBe(true);
    expect(analysis.riskLevel).not.toBe("safe");
  });
});
