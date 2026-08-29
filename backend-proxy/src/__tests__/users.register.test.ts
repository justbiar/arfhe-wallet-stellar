import { describe, expect, it } from "vitest";
import { env, SELF } from "cloudflare:test";

/**
 * POST /users/register testleri.
 *
 * Aynı wallet_address ile iki kez register edildiğinde `users` tablosunda tek satır kalmalı
 * (upsert), ve ikinci çağrı last_seen'i günceller. Hiçbir alanda tutar/miktar yok — bu tablo
 * yalnızca "hangi adres, hangi email, hangi kaynaktan (google/password) ilk/son ne zaman
 * görüldü" bilgisini tutar.
 */

const EXTENSION_ORIGIN = "chrome-extension://cdhfecdlpblpdngkadiigjmodedapoih";

function postRegister(body: unknown, origin: string = EXTENSION_ORIGIN) {
  return SELF.fetch("https://proxy.example/users/register", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify(body),
  });
}

describe("POST /users/register", () => {
  it("yeni bir wallet_address için users tablosuna bir satır ekler", async () => {
    const address = "0xAAA0000000000000000000000000000000aaa1";
    const res = await postRegister({ wallet_address: address, source: "password" });
    expect(res.status).toBe(200);

    const row = await env.USERS_DB.prepare("SELECT * FROM users WHERE wallet_address = ?1")
      .bind(address)
      .first();
    expect(row).toBeTruthy();
    expect(row!.source).toBe("password");
    expect(row!.email).toBeNull();
    expect(row!.first_seen).toBe(row!.last_seen);
  });

  it("aynı wallet_address iki kez register edilirse tek satır kalır ve last_seen güncellenir", async () => {
    const address = "0xBBB0000000000000000000000000000000bbb2";

    const first = await postRegister({ wallet_address: address, source: "google", email: "user@example.com" });
    expect(first.status).toBe(200);

    const firstRow = await env.USERS_DB.prepare("SELECT * FROM users WHERE wallet_address = ?1")
      .bind(address)
      .first();
    const firstSeen = firstRow!.first_seen as string;

    // Force a distinct last_seen so the update is observable even if both calls land within
    // the same millisecond.
    await new Promise((resolve) => setTimeout(resolve, 5));

    const second = await postRegister({ wallet_address: address, source: "google", email: "user@example.com" });
    expect(second.status).toBe(200);

    const { results } = await env.USERS_DB.prepare("SELECT * FROM users WHERE wallet_address = ?1")
      .bind(address)
      .all();
    expect(results).toHaveLength(1);

    const secondRow = results[0] as Record<string, unknown>;
    expect(secondRow.first_seen).toBe(firstSeen);
    expect((secondRow.last_seen as string) >= firstSeen).toBe(true);
    expect(secondRow.email).toBe("user@example.com");
  });

  it("ikinci çağrıda email gönderilmezse mevcut email korunur (COALESCE)", async () => {
    const address = "0xCCC0000000000000000000000000000000ccc3";

    await postRegister({ wallet_address: address, source: "google", email: "keep-me@example.com" });
    await postRegister({ wallet_address: address, source: "google" });

    const row = await env.USERS_DB.prepare("SELECT * FROM users WHERE wallet_address = ?1")
      .bind(address)
      .first();
    expect(row!.email).toBe("keep-me@example.com");
  });

  it('source alanı "google" veya "password" değilse 400 döner', async () => {
    const res = await postRegister({ wallet_address: "0xDDD", source: "apple" });
    expect(res.status).toBe(400);
  });

  it("wallet_address eksikse 400 döner", async () => {
    const res = await postRegister({ source: "password" });
    expect(res.status).toBe(400);
  });

  it("izin verilmeyen origin'den 403 döner", async () => {
    const res = await postRegister({ wallet_address: "0xEEE", source: "password" }, "https://evil.example");
    expect(res.status).toBe(403);
  });
});
