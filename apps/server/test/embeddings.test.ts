import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createEmbeddingAdapter } from "../src/embeddings.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("posts OpenAI-compatible embedding input and accepts a finite configured vector", async () => {
  let request: Request | undefined;
  globalThis.fetch = async (input, init) => {
    request = new Request(input, init);
    return Response.json({ data: [{ embedding: [0.1, -0.2, 0.3] }] });
  };
  const adapter = createEmbeddingAdapter({ EMBEDDING_BASE_URL: "http://embeddings.test/v1", EMBEDDING_MODEL: "test-model", EMBEDDING_DIMENSION: "3", EMBEDDING_API_KEY: "secret" });
  assert.deepEqual(await adapter.embed("semantic content"), [0.1, -0.2, 0.3]);
  assert.equal(request?.url, "http://embeddings.test/v1/embeddings");
  assert.deepEqual(await request?.json(), { model: "test-model", input: "semantic content" });
  assert.equal(request?.headers.get("authorization"), "Bearer secret");
});

test("returns null and unavailable when the provider returns malformed or wrong-dimensional data", async () => {
  globalThis.fetch = async () => Response.json({ data: [{ embedding: [1, Number.NaN] }] });
  const adapter = createEmbeddingAdapter({ EMBEDDING_BASE_URL: "http://embeddings.test", EMBEDDING_DIMENSION: "2" });
  assert.equal(await adapter.embed("content"), null);
  assert.deepEqual(await adapter.status(), { status: "unavailable" });
});

test("returns null rather than invented vectors on timeout or provider errors", async () => {
  globalThis.fetch = async (_input, init) => new Promise((_resolve, reject) => {
    const signal = init?.signal as AbortSignal;
    signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  });
  const adapter = createEmbeddingAdapter({ EMBEDDING_BASE_URL: "http://embeddings.test", EMBEDDING_DIMENSION: "3", EMBEDDING_TIMEOUT_MS: "1" });
  assert.equal(await adapter.embed("content"), null);
});

test("does not report available merely because provider environment variables exist", async () => {
  globalThis.fetch = async () => new Response("offline", { status: 503 });
  const adapter = createEmbeddingAdapter({ EMBEDDING_BASE_URL: "http://embeddings.test", EMBEDDING_DIMENSION: "3" });
  assert.deepEqual(await adapter.status(), { status: "unavailable" });
});
