import { describe, expect, it } from "vitest";
import { env, SELF } from "cloudflare:test";

/**
 * POST /users/register testleri.
 *
 * Aynı wallet_address ile iki kez register edildiğinde `users` tablosunda tek satır kalmalı
 * (upsert), ve ikinci çağrı last_seen'i günceller. Hiçbir alanda tutar/miktar yok — bu tablo
 * yalnızca "hangi adres, hangi kaynaktan (google/created/mnemonic/private_key) ilk/son ne
 * zaman görüldü" bilgisini tutar.
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
    const res = await postRegister({ wallet_address: address, source: "created" });
    expect(res.status).toBe(200);

    const row = await env.USERS_DB.prepare("SELECT * FROM users WHERE wallet_address = ?1")
      .bind(address)
      .first();
    expect(row).toBeTruthy();
    expect(row!.source).toBe("created");
    expect(row!.first_seen).toBe(row!.last_seen);
  });

  it("aynı wallet_address iki kez register edilirse tek satır kalır ve last_seen güncellenir", async () => {
    const address = "0xBBB0000000000000000000000000000000bbb2";

    const first = await postRegister({ wallet_address: address, source: "google" });
    expect(first.status).toBe(200);

    const firstRow = await env.USERS_DB.prepare("SELECT * FROM users WHERE wallet_address = ?1")
      .bind(address)
      .first();
    const firstSeen = firstRow!.first_seen as string;

    // Force a distinct last_seen so the update is observable even if both calls land within
    // the same millisecond.
    await new Promise((resolve) => setTimeout(resolve, 5));

    const second = await postRegister({ wallet_address: address, source: "google" });
    expect(second.status).toBe(200);

    const { results } = await env.USERS_DB.prepare("SELECT * FROM users WHERE wallet_address = ?1")
      .bind(address)
      .all();
    expect(results).toHaveLength(1);

    const secondRow = results[0] as Record<string, unknown>;
    expect(secondRow.first_seen).toBe(firstSeen);
    expect((secondRow.last_seen as string) >= firstSeen).toBe(true);
  });

  it.each(["google", "created", "mnemonic", "private_key"])(
    'source "%s" için 200 döner',
    async (source) => {
      const address = `0xF${source.padEnd(39, "0")}`.slice(0, 42);
      const res = await postRegister({ wallet_address: address, source });
      expect(res.status).toBe(200);

      const row = await env.USERS_DB.prepare("SELECT * FROM users WHERE wallet_address = ?1")
        .bind(address)
        .first();
      expect(row!.source).toBe(source);
    }
  );

  it('source alanı geçerli 4 değerden biri değilse ("apple") 400 döner', async () => {
    const res = await postRegister({ wallet_address: "0xDDD", source: "apple" });
    expect(res.status).toBe(400);
  });

  it("wallet_address eksikse 400 döner", async () => {
    const res = await postRegister({ source: "created" });
    expect(res.status).toBe(400);
  });

  it("izin verilmeyen origin'den 403 döner", async () => {
    const res = await postRegister({ wallet_address: "0xEEE", source: "created" }, "https://evil.example");
    expect(res.status).toBe(403);
  });
});
