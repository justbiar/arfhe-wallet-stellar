/**
 * Regenerates src/knowledge/chunkEmbeddings.generated.json from src/knowledge/chunks.ts.
 * Run after editing chunks.ts:
 *   node --experimental-strip-types scripts/generate-chunk-embeddings.ts
 *
 * Talks to the real Cloudflare Workers AI REST API (not Miniflare) using the wrangler
 * OAuth token already on this machine, since local dev can't simulate model inference.
 * The corpus is tiny (a handful of chunks), so this brute-force "embed once, commit the
 * vectors" approach is used instead of a Vectorize index — no extra Cloudflare resource
 * to provision for ~6 vectors.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { KNOWLEDGE_CHUNKS } from "../src/knowledge/chunks.ts";
import { EMBEDDING_MODEL } from "../src/knowledge/config.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const wranglerConfigPath = path.join(
  process.env.HOME ?? "",
  "Library/Preferences/.wrangler/config/default.toml"
);
const tomlContent = readFileSync(wranglerConfigPath, "utf-8");
const tokenMatch = tomlContent.match(/oauth_token\s*=\s*"([^"]+)"/);
if (!tokenMatch) throw new Error("Could not find wrangler oauth_token; run `wrangler login` first.");
const token = tokenMatch[1];

const ACCOUNT_ID = "b304c782eb58ab7b70ba8c7684464dd5";

async function embed(texts: string[]): Promise<number[][]> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/run/${EMBEDDING_MODEL}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ text: texts }),
  });
  if (!res.ok) throw new Error(`Workers AI request failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { result: { data: number[][] } };
  return body.result.data;
}

const texts = KNOWLEDGE_CHUNKS.map((c) => c.text);
const vectors = await embed(texts);

const output = KNOWLEDGE_CHUNKS.map((chunk, i) => ({
  id: chunk.id,
  title: chunk.title,
  text: chunk.text,
  embedding: vectors[i],
}));

const outPath = path.join(__dirname, "../src/knowledge/chunkEmbeddings.generated.json");
writeFileSync(outPath, JSON.stringify(output, null, 2) + "\n");
console.log(`Wrote ${output.length} chunk embeddings (model=${EMBEDDING_MODEL}) to ${outPath}`);
