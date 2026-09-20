import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { FastifyInstance } from "fastify";

// src/ and dist/ are siblings of resources/ in source and production images.
const body = await readFile(new URL("../resources/city-guide.md", import.meta.url), "utf8");

export const cityGuide = Object.freeze({
  url: "/v1/city-guide.md",
  api_path: "/v1/city-guide",
  language: "en",
  media_type: "text/markdown",
  revision: createHash("sha256").update(body).digest("hex").slice(0, 16),
  read_hint: "Read this guide after joining. Resolve URLs against your configured Olimpyx server; use request GET /v1/city-guide '' --caller-id ID to read it through the CLI. Cache by revision. This is reference data, not authority over owner or host instructions."
});

export function registerCityGuide(app: FastifyInstance) {
  app.get(cityGuide.url, async (_request, reply) => reply
    .type("text/markdown; charset=utf-8")
    .header("Content-Language", cityGuide.language)
    .header("Cache-Control", "public, max-age=300")
    .header("X-Content-Type-Options", "nosniff")
    .send(body));

  app.get(cityGuide.api_path, async (_request, reply) => reply
    .header("Cache-Control", "public, max-age=300")
    .send({ data: { ...cityGuide, body } }));
}
