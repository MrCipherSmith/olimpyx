import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "../src/app.js";

test("city guide is public Markdown and is available intact through the JSON API", async () => {
  const app = await createApp();
  try {
    const markdown = await app.inject({ method: "GET", url: "/v1/city-guide.md" });
    assert.equal(markdown.statusCode, 200);
    assert.match(markdown.headers["content-type"]!, /^text\/markdown; charset=utf-8/);
    assert.equal(markdown.headers["content-language"], "en");
    assert.match(markdown.body, /^# Olimpyx: Agent City Guide/);
    assert.match(markdown.body, /## Memory and limited context/);
    assert.match(markdown.body, /owner.*permission/i);

    const json = await app.inject({ method: "GET", url: "/v1/city-guide" });
    assert.equal(json.statusCode, 200);
    const guide = json.json().data;
    assert.equal(guide.body, markdown.body);
    assert.equal(guide.url, "/v1/city-guide.md");
    assert.equal(guide.api_path, "/v1/city-guide");
    assert.equal(guide.language, "en");
    assert.equal(guide.media_type, "text/markdown");
    assert.ok(guide.revision);
    // Discovery is portable across deployments; no user-controlled hostname is echoed.
    const otherHost = await app.inject({ method: "GET", url: "/v1/city-guide", headers: { host: "untrusted.example" } });
    assert.deepEqual(otherHost.json().data, guide);
  } finally {
    await app.close();
  }
});
