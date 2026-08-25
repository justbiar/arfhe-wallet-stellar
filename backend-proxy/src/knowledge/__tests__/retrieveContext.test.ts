import { describe, expect, it, vi } from "vitest";
import { retrieveContext } from "../retrieveContext";
import { KNOWLEDGE_CHUNKS } from "../chunks";
import chunkEmbeddingsJson from "../chunkEmbeddings.generated.json";

const REAL_UNSHIELD_EMBEDDING = chunkEmbeddingsJson.find(
  (c) => c.id === "mimari-ve-unshield"
)!.embedding;

function fakeAi(embedding: number[] | null) {
  return {
    run: vi.fn(async () => (embedding ? { data: [embedding] } : { data: [] })),
  };
}

describe("retrieveContext", () => {
  it("chunk embedding'ine yakın bir sorgu için o chunk'ı döner", async () => {
    const ai = fakeAi(REAL_UNSHIELD_EMBEDDING);
    const result = await retrieveContext(ai, "unshield nasıl çalışır");
    expect(result.length).toBeGreaterThan(0);
    expect(result[0]?.chunk.id).toBe("mimari-ve-unshield");
    expect(ai.run).toHaveBeenCalledWith(expect.stringContaining("bge-m3"), {
      text: ["unshield nasıl çalışır"],
    });
  });

  it("boş sorgu için AI'ı çağırmadan boş dizi döner", async () => {
    const ai = fakeAi(REAL_UNSHIELD_EMBEDDING);
    const result = await retrieveContext(ai, "   ");
    expect(result).toEqual([]);
    expect(ai.run).not.toHaveBeenCalled();
  });

  it("AI binding hata fırlatırsa boş dizi döner (asla throw etmez)", async () => {
    const ai = { run: vi.fn(async () => { throw new Error("upstream down"); }) };
    const result = await retrieveContext(ai, "unshield nasıl çalışır");
    expect(result).toEqual([]);
  });

  it("AI yanıtı beklenmeyen şekilde gelirse boş dizi döner", async () => {
    const ai = { run: vi.fn(async () => ({ unexpected: true })) };
    const result = await retrieveContext(ai, "unshield nasıl çalışır");
    expect(result).toEqual([]);
  });

  it("hiçbir chunk skoru eşiği geçmezse boş dizi döner (alakasız sorgu)", async () => {
    const orthogonalEmbedding = new Array(REAL_UNSHIELD_EMBEDDING.length).fill(0);
    orthogonalEmbedding[0] = 1;
    const ai = fakeAi(orthogonalEmbedding);
    const result = await retrieveContext(ai, "yarın hava nasıl olacak");
    expect(result).toEqual([]);
  });

  it("tüm bilgi chunk'ları için embedding üretilmiş olmalı", () => {
    const ids = new Set(chunkEmbeddingsJson.map((c) => c.id));
    for (const chunk of KNOWLEDGE_CHUNKS) {
      expect(ids.has(chunk.id)).toBe(true);
    }
    expect(chunkEmbeddingsJson).toHaveLength(KNOWLEDGE_CHUNKS.length);
  });
});
