/**
 * The recovery path for a page chunk that will not load.
 *
 * This is worth testing directly because the failure it handles is invisible in normal
 * use and catastrophic when it happens: every page in the wallet is code-split, so a
 * chunk that does not arrive is not a blank panel but a crash screen over the whole app.
 * The behaviour has three parts that each matter on their own — retry once, reload once,
 * and never reload twice — and the third is the one that turns a bad situation into an
 * unusable one if it is wrong.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const RELOAD_KEY = "arfhe_chunk_reload";

/** Load the module fresh so its imports re-read the stubbed globals. */
async function loadModule() {
  vi.resetModules();
  return import("../lazyWithRetry");
}

/**
 * Drive the factory the way React.lazy does, without React.
 *
 * `lazyWithRetry` hands React a lazy component whose payload is the async function under
 * test; React calls it and suspends on the promise. Reaching in for `_payload._result`
 * is that same call, minus a renderer.
 */
function runPayload(lazyComponent: unknown): Promise<unknown> {
  const payload = (lazyComponent as { _payload: { _result: () => Promise<unknown> } })._payload;
  return payload._result();
}

describe("lazyWithRetry", () => {
  let reloads: number;

  beforeEach(() => {
    reloads = 0;
    sessionStorage.clear();
    // jsdom's location.reload is not configurable in place; replace the accessor.
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...window.location, reload: () => { reloads += 1; } },
    });
  });

  it("passes a successful import straight through", async () => {
    const { default: lazyWithRetry } = await loadModule();
    const mod = { default: () => null };
    const factory = vi.fn().mockResolvedValue(mod);

    const result = await runPayload(lazyWithRetry(factory as never));

    expect(result).toBe(mod);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(reloads).toBe(0);
  });

  it("retries once, and a chunk that arrives on the second try never reloads", async () => {
    const { default: lazyWithRetry } = await loadModule();
    const mod = { default: () => null };
    const factory = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch dynamically imported module"))
      .mockResolvedValueOnce(mod);

    const result = await runPayload(lazyWithRetry(factory as never));

    expect(result).toBe(mod);
    expect(factory).toHaveBeenCalledTimes(2);
    // The transient case must not cost the user a page reload.
    expect(reloads).toBe(0);
  });

  it("reloads once when both attempts fail, and does not resolve", async () => {
    const { default: lazyWithRetry } = await loadModule();
    const factory = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));

    let settled = false;
    void runPayload(lazyWithRetry(factory as never)).then(
      () => { settled = true; },
      () => { settled = true; },
    );
    await vi.waitFor(() => expect(reloads).toBe(1));
    await new Promise((r) => setTimeout(r, 10));

    expect(factory).toHaveBeenCalledTimes(2);
    // Resolving would render a half-built page in the moment before the reload lands.
    expect(settled).toBe(false);
    expect(sessionStorage.getItem(RELOAD_KEY)).toBe("1");
  });

  it("does not reload a second time — a missing chunk must not loop", async () => {
    sessionStorage.setItem(RELOAD_KEY, "1");
    const { default: lazyWithRetry } = await loadModule();
    const boom = new TypeError("Failed to fetch");
    const factory = vi.fn().mockRejectedValue(boom);

    await expect(runPayload(lazyWithRetry(factory as never))).rejects.toBe(boom);

    expect(reloads).toBe(0);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("hands the reload budget back once the app has mounted", async () => {
    sessionStorage.setItem(RELOAD_KEY, "1");
    const { noteChunkLoadSucceeded } = await loadModule();

    noteChunkLoadSucceeded();

    expect(sessionStorage.getItem(RELOAD_KEY)).toBeNull();
  });
});
