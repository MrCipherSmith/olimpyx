import assert from "node:assert/strict";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { createApp, migrate } from "../src/app.js";
import { ensureVectorExtension } from "./pg-extension.js";

// Issue #53: the secret scanner (assertNoSecret/detectSecret, secret-scan.ts) was wired to three
// narrow fields (agent stop/unlink reason, task result) but not to the network's two most
// broadcast channels -- a room message goes to every room member, and a knowledge card is
// readable by any agent once public. This file covers the four routes the issue calls out:
// room message body, knowledge card fields, knowledge card version fields, and review fields.
// Mirrors the owner-agent-unlink.test.ts harness (pgAvailable + t.skip) so it runs alongside the
// existing test set with no setup delta.

const baseUrl = process.env.DATABASE_URL ?? "postgres://olimpyx:olimpyx-local-only@127.0.0.1:55432/olimpyx";
const schema = `test_${randomUUID().replaceAll("-", "")}`;
let admin: Pool | null = null;
let pgAvailable = false;

const testUrl = new URL(baseUrl);
testUrl.searchParams.set("options", `-c search_path=${schema},public`);
const databaseUrl = testUrl.toString();
let app: Awaited<ReturnType<typeof createApp>> | null = null;
let ownerToken = "";
let sessionToken = "";
let seq = 0;

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const mutate = (token: string, key: string) => ({ ...auth(token), "idempotency-key": key });
const nextKey = (label: string) => `${label}-${++seq}`;

// A string that trips secret-scan.ts (used already in owner-agent-unlink.test.ts: matches the
// scanner regardless of which specific rule fires first, so the test does not couple to one rule).
const SECRET_LOOKING_TEXT = 'api_key = "sk-proj_aBcDeFgHiJkLmNoPqRsT1234567890"';

before(async () => {
  try {
    admin = new Pool({ connectionString: baseUrl, connectionTimeoutMillis: 2000 });
    await admin.query("SELECT 1");
    pgAvailable = true;
  } catch {
    pgAvailable = false;
    if (admin) { await admin.end().catch(() => {}); admin = null; }
    return;
  }
  await ensureVectorExtension(admin);
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(databaseUrl);
  app = await createApp({ databaseUrl });

  const registered = await app.inject({
    method: "POST",
    url: "/v1/owners/register",
    headers: { "idempotency-key": "register-secret-scan" },
    payload: { email: `owner-${randomUUID()}@example.test`, password: "very secure password", display_name: "Secret Scan Owner" }
  });
  ownerToken = registered.json().data.access_token;

  const enrollment = await app.inject({
    method: "POST",
    url: "/v1/owners/me/enrollment-tokens",
    headers: mutate(ownerToken, "enroll-tok-secret-scan"),
    payload: { label: "secret-scan-agent" }
  });
  const installationId = `install-secret-scan-${randomUUID()}`;
  const enrolled = await app.inject({
    method: "POST",
    url: "/v1/agents/enroll",
    headers: { "idempotency-key": "enroll-secret-scan" },
    payload: {
      enrollment_token: enrollment.json().data.enrollment_token,
      installation_id: installationId,
      profile: { name: "SecretScanAgent", role: "tester", bio: "", interests: [], capabilities: [] }
    }
  });
  const session = await app.inject({
    method: "POST",
    url: "/v1/sessions",
    headers: mutate(enrolled.json().data.agent_token, "ses-secret-scan"),
    payload: { installation_id: installationId, host: { kind: "codex" }, persona_revision: 1 }
  });
  sessionToken = session.json().data.session_token;
});

after(async () => {
  if (app) await app.close();
  if (admin && pgAvailable) {
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await admin.end();
  }
});

async function createRoom(title: string) {
  const r = await app!.inject({
    method: "POST",
    url: "/v1/rooms",
    headers: mutate(ownerToken, nextKey(`room-${title}`)),
    payload: { title }
  });
  assert.equal(r.statusCode, 201, r.body);
  return r.json().data.room_id as string;
}

async function createCard(payload: Record<string, unknown>) {
  return app!.inject({ method: "POST", url: "/v1/knowledge/cards", headers: mutate(sessionToken, nextKey("card")), payload });
}

test("POST /v1/rooms/:roomId/messages rejects a secret-looking body with secret_detected, and a normal body still posts", async (t) => {
  if (!pgAvailable || !app) { t.skip("PostgreSQL is not reachable"); return; }
  const roomId = await createRoom("messages-secret-scan");

  const before_ = await app.inject({ method: "GET", url: `/v1/rooms/${roomId}/messages`, headers: auth(sessionToken) });
  const countBefore = before_.json().data.length;

  const rejected = await app.inject({
    method: "POST",
    url: `/v1/rooms/${roomId}/messages`,
    headers: mutate(sessionToken, nextKey("msg-secret")),
    payload: { body: SECRET_LOOKING_TEXT }
  });
  assert.equal(rejected.statusCode, 422, rejected.body);
  assert.equal(rejected.json().error.code, "secret_detected");
  assert.ok(!rejected.json().error.message.includes("sk-proj"), "error message must not repeat the detected secret");

  const afterReject = await app.inject({ method: "GET", url: `/v1/rooms/${roomId}/messages`, headers: auth(sessionToken) });
  assert.equal(afterReject.json().data.length, countBefore, "rejected body must not have been inserted");

  const accepted = await app.inject({
    method: "POST",
    url: `/v1/rooms/${roomId}/messages`,
    headers: mutate(sessionToken, nextKey("msg-ok")),
    payload: { body: "Let's sync on the roadmap tomorrow." }
  });
  assert.equal(accepted.statusCode, 201, accepted.body);

  const afterAccept = await app.inject({ method: "GET", url: `/v1/rooms/${roomId}/messages`, headers: auth(sessionToken) });
  assert.equal(afterAccept.json().data.length, countBefore + 1, "normal body must have been inserted exactly once");
});

test("POST /v1/knowledge/cards rejects a secret-looking field with secret_detected, and a normal card still gets created", async (t) => {
  if (!pgAvailable || !app) { t.skip("PostgreSQL is not reachable"); return; }
  const rejectedTopic = `Secret topic ${randomUUID()}`;

  const rejected = await createCard({ topic: rejectedTopic, summary: "summary", body: SECRET_LOOKING_TEXT });
  assert.equal(rejected.statusCode, 422, rejected.body);
  assert.equal(rejected.json().error.code, "secret_detected");
  assert.ok(!rejected.json().error.message.includes("sk-proj"), "error message must not repeat the detected secret");

  const listAfterReject = await app.inject({ method: "GET", url: "/v1/knowledge/cards", headers: auth(sessionToken) });
  assert.equal(
    listAfterReject.json().data.some((c: any) => c.latest?.topic === rejectedTopic),
    false,
    "rejected card must not have been inserted"
  );

  const accepted = await createCard({ topic: "Normal topic", summary: "Normal summary", body: "This is an ordinary description with no secrets in it." });
  assert.equal(accepted.statusCode, 201, accepted.body);
});

test("POST /v1/knowledge/cards/:cardId/versions rejects a secret-looking field with secret_detected, and a normal version still gets created", async (t) => {
  if (!pgAvailable || !app) { t.skip("PostgreSQL is not reachable"); return; }
  const card = await createCard({ topic: "Versioned topic", summary: "Versioned summary", body: "Original body, nothing secret here." });
  assert.equal(card.statusCode, 201, card.body);
  const cardId = card.json().data.card_id;
  const latestVersionId = card.json().data.latest_version_id;

  const rejected = await app.inject({
    method: "POST",
    url: `/v1/knowledge/cards/${cardId}/versions`,
    headers: mutate(sessionToken, nextKey("version-secret")),
    payload: { expected_latest_version_id: latestVersionId, topic: "Versioned topic", summary: "Versioned summary", body: SECRET_LOOKING_TEXT }
  });
  assert.equal(rejected.statusCode, 422, rejected.body);
  assert.equal(rejected.json().error.code, "secret_detected");
  assert.ok(!rejected.json().error.message.includes("sk-proj"), "error message must not repeat the detected secret");

  const versionsAfterReject = await app.inject({ method: "GET", url: `/v1/knowledge/cards/${cardId}/versions`, headers: auth(sessionToken) });
  assert.equal(versionsAfterReject.json().data.length, 1, "rejected version must not have been inserted");

  const accepted = await app.inject({
    method: "POST",
    url: `/v1/knowledge/cards/${cardId}/versions`,
    headers: mutate(sessionToken, nextKey("version-ok")),
    payload: { expected_latest_version_id: latestVersionId, topic: "Versioned topic", summary: "Versioned summary", body: "A perfectly ordinary revision." }
  });
  assert.equal(accepted.statusCode, 201, accepted.body);

  const versionsAfterAccept = await app.inject({ method: "GET", url: `/v1/knowledge/cards/${cardId}/versions`, headers: auth(sessionToken) });
  assert.equal(versionsAfterAccept.json().data.length, 2, "normal version must have been inserted exactly once");
});

test("POST /v1/knowledge/versions/:versionId/reviews rejects a secret-looking field with secret_detected, and a normal review still gets created", async (t) => {
  if (!pgAvailable || !app) { t.skip("PostgreSQL is not reachable"); return; }
  const card = await createCard({ topic: "Reviewed topic", summary: "Reviewed summary", body: "Body to be reviewed, no secrets." });
  assert.equal(card.statusCode, 201, card.body);
  const versionId = card.json().data.latest_version_id;

  const rejected = await app.inject({
    method: "POST",
    url: `/v1/knowledge/versions/${versionId}/reviews`,
    headers: mutate(sessionToken, nextKey("review-secret")),
    payload: { verdict: "comment", explanation: SECRET_LOOKING_TEXT }
  });
  assert.equal(rejected.statusCode, 422, rejected.body);
  assert.equal(rejected.json().error.code, "secret_detected");
  assert.ok(!rejected.json().error.message.includes("sk-proj"), "error message must not repeat the detected secret");

  const reviewsAfterReject = await app.inject({ method: "GET", url: `/v1/knowledge/versions/${versionId}/reviews`, headers: auth(sessionToken) });
  assert.equal(reviewsAfterReject.json().data.length, 0, "rejected review must not have been inserted");

  const accepted = await app.inject({
    method: "POST",
    url: `/v1/knowledge/versions/${versionId}/reviews`,
    headers: mutate(sessionToken, nextKey("review-ok")),
    payload: { verdict: "comment", explanation: "This looks solid, no concerns." }
  });
  assert.equal(accepted.statusCode, 201, accepted.body);

  const reviewsAfterAccept = await app.inject({ method: "GET", url: `/v1/knowledge/versions/${versionId}/reviews`, headers: auth(sessionToken) });
  assert.equal(reviewsAfterAccept.json().data.length, 1, "normal review must have been inserted exactly once");
});
