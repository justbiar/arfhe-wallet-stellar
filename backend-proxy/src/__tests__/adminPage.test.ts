import { describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";

/**
 * GET /admin testleri.
 *
 * Bu route kasıtlı olarak sunucu tarafında auth'suz — sayfa boş açılır, veri sadece
 * tarayıcıda girilen secret ile /admin/users ve /admin/activity'ye (Bearer korumalı)
 * yapılan client-side fetch'lerle gelir. Burada sadece sayfanın kendisinin herkese açık,
 * HTML döndüğünü ve içinde beklenen iskeletin (login formu, sessionStorage kullanımı,
 * localStorage KULLANILMADIĞI) bulunduğunu doğruluyoruz — tarayıcı-içi davranış (fetch,
 * sort, filter) bu ortamda simüle edilmiyor.
 */

describe("GET /admin", () => {
  it("200 ve text/html döner", async () => {
    const res = await SELF.fetch("https://proxy.example/admin");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
  });

  it("Origin header olmadan da (CORS/origin kontrolüne tabi değil) erişilebilir", async () => {
    const res = await SELF.fetch("https://proxy.example/admin");
    expect(res.status).toBe(200);
  });

  it("login formu ve secret input içerir", async () => {
    const res = await SELF.fetch("https://proxy.example/admin");
    const html = await res.text();
    expect(html).toContain("secretInput");
    expect(html).toContain("Admin secret");
  });

  it("secret'ı sessionStorage'da tutar, localStorage kullanmaz", async () => {
    const res = await SELF.fetch("https://proxy.example/admin");
    const html = await res.text();
    expect(html).toContain("sessionStorage");
    expect(html).not.toContain("localStorage");
  });

  it("/admin/users ve /admin/activity'yi Authorization: Bearer ile çağırır", async () => {
    const res = await SELF.fetch("https://proxy.example/admin");
    const html = await res.text();
    expect(html).toContain("/admin/users");
    expect(html).toContain("/admin/activity");
    expect(html).toContain("Authorization");
    expect(html).toContain("Bearer");
  });

  it("POST ile 405 veya 404 döner (yalnızca GET destekleniyor)", async () => {
    const res = await SELF.fetch("https://proxy.example/admin", { method: "POST" });
    expect(res.status).not.toBe(200);
  });
});
