/** Multilingual embedding model — bge-base-en-v1.5 was verified unusable for Turkish
 * queries (off-topic and on-topic scores overlap, no viable threshold); bge-m3 gives a
 * clean separation. See conversation history / PR description for the comparison. */
export const EMBEDDING_MODEL = "@cf/baai/bge-m3";

/** Below this cosine similarity, a chunk is considered irrelevant to the query and is
 * never injected — calibrated against bge-m3 scores where an off-topic Turkish query
 * topped out at ~0.38 and true matches ranged ~0.44-0.60. */
export const RELEVANCE_THRESHOLD = 0.42;

/** Max number of chunks spliced into the context message per user turn. */
export const TOP_K = 3;
