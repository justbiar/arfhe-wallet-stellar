import type { ChunkEmbedding, ScoredChunk } from "./types";

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export interface SelectOptions {
  topK: number;
  threshold: number;
}

/**
 * Off-topic queries must return no chunks rather than the least-bad match — the caller
 * (retrieveContext) treats an empty result as "inject nothing," not "inject the top-1 anyway."
 */
export function selectRelevantChunks(
  queryEmbedding: number[],
  chunks: ChunkEmbedding[],
  options: SelectOptions
): ScoredChunk[] {
  return chunks
    .map((chunk) => ({ chunk, score: cosineSimilarity(queryEmbedding, chunk.embedding) }))
    .filter((scored) => scored.score >= options.threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, options.topK)
    .map(({ chunk, score }) => ({ chunk: { id: chunk.id, title: chunk.title, text: chunk.text }, score }));
}
