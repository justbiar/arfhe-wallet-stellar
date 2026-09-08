/**
 * When the opening animation plays.
 *
 * The rule has to fail in the right direction. Suppressing it wrongly costs a first-time
 * user the only moment the wallet introduces itself; playing it wrongly costs a returning
 * user five seconds. So every uncertain case — no record, an unreadable store, a clock that
 * moved — plays it.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

const LAST_SHOWN_KEY = "arfhe_splash_last_shown";
const COOLDOWN = 4 * 60 * 60 * 1000;

/** The predicate as Splash.tsx defines it. */
function shouldPlaySplash(): boolean {
  try {
    const last = Number(localStorage.getItem(LAST_SHOWN_KEY));
    if (!Number.isFinite(last) || last <= 0) return true;
    if (last > Date.now()) return true;
    return Date.now() - last >= COOLDOWN;
  } catch {
    return true;
  }
}

describe("splash cooldown", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T12:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("plays on a first-ever open", () => {
    expect(shouldPlaySplash()).toBe(true);
  });

  it("does not play again straight away", () => {
    localStorage.setItem(LAST_SHOWN_KEY, String(Date.now()));
    expect(shouldPlaySplash()).toBe(false);
  });

  it("stays quiet across a burst of opens — the case it exists for", () => {
    localStorage.setItem(LAST_SHOWN_KEY, String(Date.now()));
    for (const minutes of [1, 5, 30, 120, 239]) {
      vi.setSystemTime(new Date("2026-01-01T12:00:00Z").getTime() + minutes * 60_000);
      expect(shouldPlaySplash()).toBe(false);
    }
  });

  it("plays again once the wallet has been left alone", () => {
    localStorage.setItem(LAST_SHOWN_KEY, String(Date.now()));
    vi.setSystemTime(Date.now() + COOLDOWN);
    expect(shouldPlaySplash()).toBe(true);
  });

  it("plays when the stored value is nonsense rather than trusting it", () => {
    for (const junk of ["", "abc", "NaN", "-1", "0"]) {
      localStorage.setItem(LAST_SHOWN_KEY, junk);
      expect(shouldPlaySplash()).toBe(true);
    }
  });

  it("plays when the clock has moved backwards, instead of suppressing forever", () => {
    // A timestamp in the future would otherwise never reach the cooldown.
    localStorage.setItem(LAST_SHOWN_KEY, String(Date.now() + 10 * COOLDOWN));
    expect(shouldPlaySplash()).toBe(true);
  });

  it("plays when storage cannot be read at all", () => {
    const original = Object.getOwnPropertyDescriptor(window, "localStorage");
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() { throw new Error("blocked"); },
    });
    expect(shouldPlaySplash()).toBe(true);
    if (original) Object.defineProperty(window, "localStorage", original);
  });
});
