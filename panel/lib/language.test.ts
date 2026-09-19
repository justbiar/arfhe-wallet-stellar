import { beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => { localStorage.clear(); vi.resetModules(); });

describe("panel language", () => {
  it("defaults to English independently of the extension preference", async () => {
    localStorage.setItem("arfhe_language", "tr");
    const { pt } = await import("./language");
    expect(document.documentElement.lang).toBe("en");
    expect(pt("Köprü")).toBe("Bridge");
  });
  it("persists Turkish and restores it after a fresh module load", async () => {
    const { setPanelLanguage, pt } = await import("./language");
    setPanelLanguage("tr");
    expect(pt("Köprü")).toBe("Köprü");
    expect(localStorage.getItem("arfhe_panel_language")).toBe("tr");
    vi.resetModules();
    const fresh = await import("./language");
    expect(fresh.pt("Yükleme")).toBe("Yükleme");
    expect(document.documentElement.lang).toBe("tr");
  });
  it("translates dynamic copy without altering amounts or transaction objects", async () => {
    const { pt } = await import("./language");
    expect(pt("İşlem başına 50 – 3000 TRY")).toBe("Per transaction: 50–3000 TRY");
    expect(pt("TRY → USDC  ·  YÜKLEME")).toBe("TRY → USDC · DEPOSIT");
    expect(pt("En az 1 USDC · bakiye 0")).toBe("Minimum 1 USDC · balance 0");
    expect(pt("Şirket, rampadan 3 ödemeyi karşılayacak kadar TRY yatıracak.")).toBe("Company will deposit enough TRY through the ramp to cover 3 payments.");
    const transaction = { hash: "abc", amount: "12.3456789" };
    expect(pt(transaction)).toBe(transaction);
    expect(pt("12.3456789")).toBe("12.3456789");
  });
  it("falls back to English for invalid saved preferences", async () => {
    localStorage.setItem("arfhe_panel_language", "de");
    const { pt } = await import("./language");
    expect(pt("Köprü")).toBe("Bridge");
  });
});
