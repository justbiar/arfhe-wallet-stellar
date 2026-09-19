import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { discover, hasTrustline, forgetAnchorSessions } from "../AnchorService.js";

const TOML = `
VERSION="2.7.0"
NETWORK_PASSPHRASE="Test SDF Network ; September 2015"
WEB_AUTH_ENDPOINT="https://anchor.example/auth"
TRANSFER_SERVER="https://anchor.example/sep6"

[[CURRENCIES]]
code="USDC"
issuer="GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"
`;

const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
const text = (body: string) => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(body) });

beforeEach(() => forgetAnchorSessions());
afterEach(() => { vi.unstubAllGlobals(); forgetAnchorSessions(); });

describe("anchor discovery", () => {
  it("reads the endpoints and the asset issuer from the anchor's own TOML", async () => {
    vi.stubGlobal("fetch", vi.fn(() => text(TOML)));
    const cfg = await discover("anchor.example");
    expect(cfg.webAuthEndpoint).toBe("https://anchor.example/auth");
    expect(cfg.transferServer).toBe("https://anchor.example/sep6");
    expect(cfg.assetIssuer).toBe("GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5");
  });

  it("refuses an anchor that is on another network", async () => {
    // Signing a challenge built for a different network is the confusion SEP-10 warns
    // about: the signature is valid there, and the user believed they were on testnet.
    vi.stubGlobal("fetch", vi.fn(() => text(TOML.replace("Test SDF Network ; September 2015", "Public Global Stellar Network ; September 2015"))));
    await expect(discover("anchor.example")).rejects.toThrow(/başka bir ağda/);
  });

  it("fails loudly when the TOML has no transfer server", async () => {
    vi.stubGlobal("fetch", vi.fn(() => text(TOML.replace(/TRANSFER_SERVER=.*\n/, ""))));
    await expect(discover("anchor.example")).rejects.toThrow(/eksik/);
  });
});

describe("trustline detection", () => {
  const withAccount = (balances: unknown[]) =>
    vi.fn((url: string) =>
      url.includes("stellar.toml") ? text(TOML) : ok({ balances })
    );

  it("reports ready only for the issuer the anchor names", async () => {
    vi.stubGlobal("fetch", withAccount([
      { asset_type: "native", balance: "100" },
      { asset_code: "USDC", asset_issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5", balance: "0" },
    ]));
    await expect(hasTrustline("GABC")).resolves.toEqual({ exists: true, trusted: true });
  });

  it("does not accept a USDC line from a different issuer", async () => {
    // Same code, different issuer is a different asset — and the anchor's payment would
    // sit unclaimed while the screen said the account was ready.
    vi.stubGlobal("fetch", withAccount([
      { asset_code: "USDC", asset_issuer: "GDIFFERENTISSUER", balance: "50" },
    ]));
    await expect(hasTrustline("GABC")).resolves.toEqual({ exists: true, trusted: false });
  });

  it("treats an unfunded account as a state, not an error", async () => {
    vi.stubGlobal("fetch", vi.fn((url: string) =>
      url.includes("stellar.toml") ? text(TOML) : Promise.resolve({ ok: false, status: 404 })
    ));
    await expect(hasTrustline("GABC")).resolves.toEqual({ exists: false, trusted: false });
  });
});
