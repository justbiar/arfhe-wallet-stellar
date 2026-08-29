import { describe, expect, it } from "vitest";
import { env, SELF } from "cloudflare:test";

/**
 * POST /activity/log testleri.
 *
 * Bu, users/register'ın aksine bir upsert değil — her çağrı `activity` tablosuna yeni bir
 * satır ekler (append-only). Hiçbir alanda tutar/miktar yok, yalnızca action_type
 * (send/shield/unshield) ve zaman damgası.
 */

const EXTENSION_ORIGIN = "chrome-extension://cdhfecdlpblpdngkadiigjmodedapoih";

function postActivity(body: unknown, origin: string = EXTENSION_ORIGIN) {
  return SELF.fetch("https://proxy.example/activity/log", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify(body),
  });
}

describe("POST /activity/log", () => {
  it("activity tablosuna yeni bir satır ekler", async () => {
    const address = "0x1110000000000000000000000000000000aaa1";
    const res = await postActivity({ wallet_address: address, action_type: "send" });
    expect(res.status).toBe(200);

    const { results } = await env.USERS_DB.prepare("SELECT * FROM activity WHERE wallet_address = ?1")
      .bind(address)
      .all();
    expect(results).toHaveLength(1);
    expect((results[0] as Record<string, unknown>).action_type).toBe("send");
  });

  it("her çağrı ayrı bir satır ekler — upsert yapmaz", async () => {
    const address = "0x2220000000000000000000000000000000bbb2";

    await postActivity({ wallet_address: address, action_type: "shield" });
    await postActivity({ wallet_address: address, action_type: "unshield" });
    await postActivity({ wallet_address: address, action_type: "send" });

    const { results } = await env.USERS_DB.prepare("SELECT * FROM activity WHERE wallet_address = ?1")
      .bind(address)
      .all();
    expect(results).toHaveLength(3);
    expect(results.map((r: unknown) => (r as Record<string, unknown>).action_type).sort()).toEqual([
      "send",
      "shield",
      "unshield",
    ]);
  });

  it("hiçbir satırda tutar/miktar alanı yoktur", async () => {
    const address = "0x3330000000000000000000000000000000ccc3";
    await postActivity({ wallet_address: address, action_type: "send" });

    const row = (await env.USERS_DB.prepare("SELECT * FROM activity WHERE wallet_address = ?1")
      .bind(address)
      .first()) as Record<string, unknown>;
    expect(Object.keys(row).sort()).toEqual(["action_type", "id", "timestamp", "wallet_address"]);
  });

  it('action_type "send"/"shield"/"unshield" dışında bir değerse 400 döner', async () => {
    const res = await postActivity({ wallet_address: "0x444", action_type: "swap" });
    expect(res.status).toBe(400);
  });

  it("wallet_address eksikse 400 döner", async () => {
    const res = await postActivity({ action_type: "send" });
    expect(res.status).toBe(400);
  });

  it("izin verilmeyen origin'den 403 döner", async () => {
    const res = await postActivity({ wallet_address: "0x555", action_type: "send" }, "https://evil.example");
    expect(res.status).toBe(403);
  });
});
