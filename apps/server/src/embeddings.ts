import type { Pool } from "pg";

export type EmbeddingStatus = { status: "available"; provider: string; dimension: number } | { status: "unavailable" };
export type EmbeddingAdapter = {
  status(): Promise<EmbeddingStatus>;
  embed(text: string): Promise<number[] | null>;
};

export type EmbeddingEnvironment = Record<string, string | undefined>;
const defaultDimension = 384;
const defaultTimeoutMs = 5_000;

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 16_384 ? parsed : fallback;
}

function endpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/embeddings`;
}

export function createEmbeddingAdapter(environment: EmbeddingEnvironment = process.env): EmbeddingAdapter {
  const baseUrl = environment.EMBEDDING_BASE_URL;
  const model = environment.EMBEDDING_MODEL ?? "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2";
  const dimension = positiveInteger(environment.EMBEDDING_DIMENSION, defaultDimension);
  const timeoutMs = positiveInteger(environment.EMBEDDING_TIMEOUT_MS, defaultTimeoutMs);
  const apiKey = environment.EMBEDDING_API_KEY;

  const embed = async (text: string): Promise<number[] | null> => {
    if (!baseUrl || !text.trim()) return null;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(endpoint(baseUrl), {
        method: "POST",
        headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify({ model, input: text }),
        signal: controller.signal,
      });
      if (!response.ok) return null;
      const payload = await response.json() as { data?: Array<{ embedding?: unknown }> };
      const vector = payload.data?.[0]?.embedding;
      if (!Array.isArray(vector) || vector.length !== dimension || !vector.every((value) => typeof value === "number" && Number.isFinite(value))) return null;
      return vector;
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  };

  return {
    embed,
    async status(): Promise<EmbeddingStatus> {
      const vector = await embed("Olimpyx embedding health check.");
      return vector ? { status: "available", provider: baseUrl ? new URL(baseUrl).origin : "", dimension } : { status: "unavailable" };
    },
  };
}

/**
 * Create the extension and fixed-dimension storage before embedding writes.
 * The configured dimension is intentionally interpolated only after strict integer validation.
 */
export async function ensureEmbeddingSchema(pool: Pool, environment: EmbeddingEnvironment = process.env): Promise<void> {
  const dimension = positiveInteger(environment.EMBEDDING_DIMENSION, defaultDimension);
  await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
  await pool.query(`CREATE TABLE IF NOT EXISTS knowledge_embeddings (
    version_id text PRIMARY KEY REFERENCES knowledge_versions(id) ON DELETE CASCADE,
    embedding vector(${dimension}) NOT NULL,
    model text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`);
}
