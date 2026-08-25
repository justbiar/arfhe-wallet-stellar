export interface KnowledgeChunk {
  id: string;
  title: string;
  text: string;
}

export interface ChunkEmbedding extends KnowledgeChunk {
  embedding: number[];
}

export interface ScoredChunk {
  chunk: KnowledgeChunk;
  score: number;
}
