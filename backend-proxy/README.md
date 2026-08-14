# ArfheWallet Agent Proxy

Cloudflare Worker that fronts OpenRouter for the in-wallet AI agent (Arfio). The
OpenRouter API key never ships inside the extension bundle — it lives only as a Worker
secret. Two endpoints:

- `POST /agent/chat` — forwards `{ messages, tools }` to OpenRouter, falling back through
  `MODEL_CHAIN` (`src/modelConfig.ts`) on rate limits / outages.
- `POST /agent/retrieve-context` — embeds `{ query }` (the user's chat message) with
  Workers AI and returns the most relevant chunks of `FHE_COMPLETE_GUIDE.md` for
  `AgentOrchestrator` (extension side) to splice into the system prompt. Read-only
  enrichment only — this endpoint has no path to signing or sending anything.

## Development

```bash
npm install
npm run dev         # wrangler dev
npm run typecheck   # tsc --noEmit
npx vitest run      # test suite (Vitest + @cloudflare/vitest-pool-workers / Miniflare)
```

Tests that exercise the `AI` binding talk to the **real** Workers AI API (Miniflare can't
simulate model inference locally), so `npx vitest run` needs a `wrangler login`'d session
with access to the Cloudflare account in `wrangler.toml`. Pure-logic tests
(`src/knowledge/__tests__/scoring.test.ts`) don't need any binding.

## RAG knowledge base — regenerating chunk embeddings

`src/knowledge/chunkEmbeddings.generated.json` is **derived data**, not hand-written: it's
the embedding vectors for each entry in `src/knowledge/chunks.ts`, precomputed once and
committed so `/agent/retrieve-context` can do a cheap brute-force cosine comparison at
request time without embedding the whole knowledge base on every call or provisioning a
vector database for what is currently ~6 chunks.

**Whenever you edit `src/knowledge/chunks.ts` (add, remove, or reword a chunk), regenerate
the embeddings file before committing:**

```bash
node --experimental-strip-types scripts/generate-chunk-embeddings.ts
```

This calls the real Cloudflare Workers AI REST API directly (not through `wrangler dev`)
using the OAuth token from your local `wrangler login` session, embeds every chunk in
`chunks.ts` with the model in `src/knowledge/config.ts` (`EMBEDDING_MODEL`, currently
`@cf/baai/bge-m3`), and overwrites `chunkEmbeddings.generated.json`. Commit the
regenerated file alongside your `chunks.ts` change — if you forget, retrieval keeps
scoring against stale vectors for text that no longer exists, silently returning wrong or
missing context.

If you ever change `EMBEDDING_MODEL` itself, the same script must be re-run (a query is
always embedded with the *current* model at request time, so a mismatch between the query
embedding's model and the stored chunk embeddings' model makes every similarity score
meaningless — you'd be comparing vectors from two different vector spaces).

### Why `bge-m3`, not `bge-base-en-v1.5`

The default Workers AI embedding model, `@cf/baai/bge-base-en-v1.5`, was tested against
Turkish queries (the wallet's primary language for the agent) and found unusable: on-topic
and off-topic queries scored in overlapping ranges (an off-topic control query scored
higher than some genuine matches), so no relevance threshold could separate them.
`@cf/baai/bge-m3` (multilingual) gives a clean separation — off-topic queries top out
around 0.35–0.38 cosine similarity, genuine matches score 0.42–0.62 — which is what
`RELEVANCE_THRESHOLD` in `src/knowledge/config.ts` is calibrated against.

### Why these 6 chunks and not the whole guide

`chunks.ts` deliberately excludes `FHE_COMPLETE_GUIDE.md`'s version tables, chainId list,
ABI selector table, file map, and deploy commands — those are live/derived facts that go
stale independently of this file (a dependency bump or redeploy doesn't touch
`chunks.ts`), and embedding them as static prose would let the agent confidently answer
with outdated version numbers or addresses. Only the durable, conceptual sections ("how
does X work", "why is Y designed this way") are chunked.
