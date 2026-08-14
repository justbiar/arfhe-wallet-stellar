import { describe, expect, it } from "vitest";
import { cosineSimilarity, selectRelevantChunks } from "../scoring";
import type { ChunkEmbedding } from "../types";

describe("cosineSimilarity", () => {
  it("identik vektörler için 1 döner", () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1);
  });

  it("dik vektörler için 0 döner", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it("zıt yönlü vektörler için -1 döner", () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1);
  });

  it("büyüklükten bağımsızdır (normalize eder)", () => {
    expect(cosineSimilarity([2, 0], [5, 0])).toBeCloseTo(1);
  });
});

describe("selectRelevantChunks", () => {
  const chunks: ChunkEmbedding[] = [
    { id: "a", title: "A", text: "chunk a metni", embedding: [1, 0, 0] },
    { id: "b", title: "B", text: "chunk b metni", embedding: [0, 1, 0] },
    { id: "c", title: "C", text: "chunk c metni", embedding: [0.9, 0.1, 0] },
  ];

  it("sorguya en yakın chunk'ları skora göre azalan sırada döner", () => {
    const result = selectRelevantChunks([1, 0, 0], chunks, { topK: 3, threshold: 0 });
    expect(result.map((r) => r.chunk.id)).toEqual(["a", "c", "b"]);
    expect(result[0]?.score).toBeCloseTo(1);
  });

  it("topK sonucu sınırlar", () => {
    const result = selectRelevantChunks([1, 0, 0], chunks, { topK: 1, threshold: 0 });
    expect(result).toHaveLength(1);
    expect(result[0]?.chunk.id).toBe("a");
  });

  it("eşiğin altındaki chunk'ları eler", () => {
    const result = selectRelevantChunks([1, 0, 0], chunks, { topK: 3, threshold: 0.999 });
    expect(result.map((r) => r.chunk.id)).toEqual(["a"]);
  });

  it("hiçbir chunk eşiği geçmezse boş dizi döner (alakasız sorgu senaryosu)", () => {
    const result = selectRelevantChunks([0, 0, 1], chunks, { topK: 3, threshold: 0.5 });
    expect(result).toEqual([]);
  });

  it("boş chunk listesinde boş dizi döner", () => {
    const result = selectRelevantChunks([1, 0, 0], [], { topK: 3, threshold: 0 });
    expect(result).toEqual([]);
  });
});
