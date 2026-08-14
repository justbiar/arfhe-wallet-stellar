import { EMBEDDING_MODEL, RELEVANCE_THRESHOLD, TOP_K } from "./config";
import { selectRelevantChunks } from "./scoring";
import type { ChunkEmbedding, ScoredChunk } from "./types";
import chunkEmbeddingsJson from "./chunkEmbeddings.generated.json";

const CHUNK_EMBEDDINGS = chunkEmbeddingsJson as ChunkEmbedding[];

export interface AiBinding {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}

function extractQueryEmbedding(result: unknown): number[] | null {
  if (typeof result !== "object" || result === null) return null;
  const data = (result as { data?: unknown }).data;
  if (!Array.isArray(data) || !Array.isArray(data[0])) return null;
  return data[0] as number[];
}

/**
 * Embeds the user's message and returns the chunks worth splicing into the agent's
 * context, most relevant first. Never throws: any failure (AI binding error, malformed
 * response) degrades to an empty result — the caller sends the turn without extra
 * context rather than failing the whole chat request over an optional enrichment step.
 */
export async function retrieveContext(ai: AiBinding, query: string): Promise<ScoredChunk[]> {
  if (!query.trim()) return [];

  let result: unknown;
  try {
    result = await ai.run(EMBEDDING_MODEL, { text: [query] });
  } catch {
    return [];
  }

  const queryEmbedding = extractQueryEmbedding(result);
  if (!queryEmbedding) return [];

  return selectRelevantChunks(queryEmbedding, CHUNK_EMBEDDINGS, {
    topK: TOP_K,
    threshold: RELEVANCE_THRESHOLD,
  });
}
