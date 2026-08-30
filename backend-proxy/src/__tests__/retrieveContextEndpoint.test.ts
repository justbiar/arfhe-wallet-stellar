import { describe, expect, it, vi, afterEach } from "vitest";
import { env, SELF } from "cloudflare:test";
import chunkEmbeddingsJson from "../knowledge/chunkEmbeddings.generated.json";

const UNSHIELD_EMBEDDING = chunkEmbeddingsJson.find((c) => c.id === "mimari-ve-unshield")!.embedding;
const EXTENSION_ORIGIN = "chrome-extension://cdhfecdlpblpdngkadiigjmodedapoih";

function postRetrieveContext(query: unknown) {
  return SELF.fetch("https://proxy.example/agent/retrieve-context", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: EXTENSION_ORIGIN },
    body: JSON.stringify({ query }),
  });
}

describe("POST /agent/retrieve-context", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("ilgili sorgu için chunk döner", async () => {
    vi.spyOn(env.AI, "run").mockResolvedValue({ data: [UNSHIELD_EMBEDDING] });

    const res = await postRetrieveContext("unshield nasıl çalışır");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { chunks: { title: string; text: string; score: number }[] };
    expect(body.chunks.length).toBeGreaterThan(0);
    expect(body.chunks[0]?.title).toContain("unshield");
  });

  it("AI çağrısı başarısız olursa 200 ve boş chunk listesi döner (asla sohbeti bozmaz)", async () => {
    vi.spyOn(env.AI, "run").mockRejectedValue(new Error("upstream down"));

    const res = await postRetrieveContext("unshield nasıl çalışır");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { chunks: unknown[] };
    expect(body.chunks).toEqual([]);
  });

  it("query alanı eksikse 400 döner", async () => {
    const res = await postRetrieveContext(undefined);
    expect(res.status).toBe(400);
  });

  it("izin verilmeyen origin'den 403 döner", async () => {
    const res = await SELF.fetch("https://proxy.example/agent/retrieve-context", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
      body: JSON.stringify({ query: "unshield nasıl çalışır" }),
    });
    expect(res.status).toBe(403);
  });
});
