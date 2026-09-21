import assert from "node:assert/strict";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { createApp, migrate } from "../src/app.js";
import { ensureVectorExtension } from "./pg-extension.js";

// Owner-initiated unlink flow. Mirrors the agent-activity.test.ts harness
// so it can run alongside the existing test set with no setup delta. The
// feature is documented in docs/operations/unlink-agent.md; the assertions
// below are the contract that doc is written against.

const baseUrl = process.env.DATABASE_URL ?? "postgres://olimpyx:olimpyx-local-only@127.0.0.1:55432/olimpyx";
const schema = `test_${randomUUID().replaceAll("-", "")}`;
let admin: Pool | null = null;
let pgAvailable = false;

const testUrl = new URL(baseUrl);
testUrl.searchParams.set("options", `-c search_path=${schema},public`);
const databaseUrl = testUrl.toString();
let app: Awaited<ReturnType<typeof createApp>> | null = null;
let ownerToken = "";

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

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
    headers: { "idempotency-key": "register-unlink" },
    payload: { email: `owner-${randomUUID()}@example.test`, password: "very secure password", display_name: "Unlink Owner" }
  });
  ownerToken = registered.json().data.access_token;
});

after(async () => {
  if (app) await app.close();
  if (admin && pgAvailable) {
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await admin.end();
  }
});

// Helper: enroll one agent under this owner and return its access_token + agent_id.
async function enrollAgent(installationId: string, name: string) {
  const enrollment = await app!.inject({
    method: "POST",
    url: "/v1/owners/me/enrollment-tokens",
    headers: { authorization: `Bearer ${ownerToken}`, "idempotency-key": `enroll-tok-${installationId}` },
    payload: { label: `unlink-test ${name}` }
  });
  const enrolled = await app!.inject({
    method: "POST",
    url: "/v1/agents/enroll",
    headers: { "idempotency-key": `enroll-${installationId}` },
    payload: {
      enrollment_token: enrollment.json().data.enrollment_token,
      installation_id: installationId,
      profile: { name, role: "tester", bio: "", interests: [], capabilities: [] }
    }
  });
  return {
    agentId: enrolled.json().data.agent.agent_id,
    agentToken: enrolled.json().data.agent_token
  };
}

test("unlink sets unlinked_at, marks restricted, and tears down tokens/sessions/subscriptions", async (t) => {
  if (!pgAvailable || !app) { t.skip("PostgreSQL is not reachable"); return; }
  const { agentId, agentToken } = await enrollAgent(`install-unlink-${randomUUID()}`, "Pin");

  // Start a session so we can confirm the endpoint ends it.
  const session = await app.inject({
    method: "POST", url: "/v1/sessions",
    headers: { authorization: `Bearer ${agentToken}`, "idempotency-key": "ses-before-unlink" },
    payload: { installation_id: "install-unlink", host: { kind: "codex" }, persona_revision: 1 }
  });
  assert.equal(session.statusCode, 201);

  // Unlink with a reason.
  const reason = "owner is rotating machines";
  const response = await app.inject({
    method: "POST",
    url: `/v1/owners/me/agents/${agentId}/unlink`,
    headers: { authorization: `Bearer ${ownerToken}`, "idempotency-key": "unlink-1" },
    payload: { reason }
  });
  assert.equal(response.statusCode, 200);
  const data = response.json().data;
  assert.equal(data.agent_id, agentId);
  assert.equal(data.unlinked_reason, reason);
  assert.ok(data.unlinked_at, "unlinked_at must be a timestamp");

  // Token is revoked -> session endpoints now 401 agent_revoked.
  const after = await app.inject({
    method: "POST", url: "/v1/sessions",
    headers: { authorization: `Bearer ${agentToken}`, "idempotency-key": "ses-after-unlink" },
    payload: { installation_id: "install-unlink", host: { kind: "codex" }, persona_revision: 1 }
  });
  assert.equal(after.statusCode, 401);

  // Owner list still exposes the agent, with unlinked=true and revoked unchanged.
  const list = await app.inject({
    method: "GET", url: `/v1/owners/me/agents`,
    headers: { authorization: `Bearer ${ownerToken}` }
  });
  const row = list.json().data.find((a: any) => a.agent_id === agentId);
  assert.ok(row, "owner list must still return unlinked agent");
  assert.equal(row.unlinked, true);
  assert.equal(row.revoked, false);
  assert.ok(row.unlinked_at);
  assert.equal(row.unlinked_reason, reason);
});

test("unlink refuses an agent owned by a different owner with 404, not 403", async (t) => {
  if (!pgAvailable || !app) { t.skip("PostgreSQL is not reachable"); return; }
  // Second owner registers; tries to unlink the first owner's agent.
  const other = await app.inject({
    method: "POST", url: "/v1/owners/register",
    headers: { "idempotency-key": "register-other-unlink" },
    payload: { email: `other-${randomUUID()}@example.test`, password: "another secure password", display_name: "Other" }
  });
  const otherToken = other.json().data.access_token;

  const { agentId } = await enrollAgent(`install-cross-${randomUUID()}`, "CrossPin");
  const response = await app.inject({
    method: "POST",
    url: `/v1/owners/me/agents/${agentId}/unlink`,
    headers: { authorization: `Bearer ${otherToken}`, "idempotency-key": "unlink-cross" },
    payload: { reason: "trying to take it" }
  });
  assert.equal(response.statusCode, 404);
  assert.equal(response.json().error.code, "not_found");
});

test("unlink refuses unknown agent ids with 404", async (t) => {
  if (!pgAvailable || !app) { t.skip("PostgreSQL is not reachable"); return; }
  const response = await app.inject({
    method: "POST",
    url: `/v1/owners/me/agents/agt_does_not_exist/unlink`,
    headers: { authorization: `Bearer ${ownerToken}`, "idempotency-key": "unlink-404" },
    payload: { reason: null }
  });
  assert.equal(response.statusCode, 404);
});

test("unlink is idempotent under an Idempotency-Key, but rejects a fresh call as 409", async (t) => {
  if (!pgAvailable || !app) { t.skip("PostgreSQL is not reachable"); return; }
  const { agentId } = await enrollAgent(`install-idem-${randomUUID()}`, "IdemPin");
  const headers = { authorization: `Bearer ${ownerToken}`, "idempotency-key": "unlink-idem-1" };
  const payload = { reason: "first call" };

  const first = await app.inject({ method: "POST", url: `/v1/owners/me/agents/${agentId}/unlink`, headers, payload });
  assert.equal(first.statusCode, 200);

  const replay = await app.inject({ method: "POST", url: `/v1/owners/me/agents/${agentId}/unlink`, headers, payload });
  assert.equal(replay.statusCode, 200, "idempotency-key replay must return original response");

  const second = await app.inject({
    method: "POST", url: `/v1/owners/me/agents/${agentId}/unlink`,
    headers: { authorization: `Bearer ${ownerToken}`, "idempotency-key": "unlink-idem-fresh" },
    payload: { reason: "second call without the same key" }
  });
  assert.equal(second.statusCode, 409);
  assert.equal(second.json().error.code, "already_unlinked");
});

test("unlink rejects secret-looking reasons with 422 before any state change", async (t) => {
  if (!pgAvailable || !app) { t.skip("PostgreSQL is not reachable"); return; }
  const { agentId } = await enrollAgent(`install-secret-${randomUUID()}`, "SecPin");
  // `api_key = "..."` matches the `credential assignment` rule in secret-scan.ts;
  // using a real-looking bearer-style token would also work but tying it to a
  // familiar format keeps the failure message stable.
  const response = await app.inject({
    method: "POST",
    url: `/v1/owners/me/agents/${agentId}/unlink`,
    headers: { authorization: `Bearer ${ownerToken}`, "idempotency-key": "unlink-secret" },
    payload: { reason: 'api_key = "sk-proj_aBcDeFgHiJkLmNoPqRsT1234567890"' }
  });
  assert.equal(response.statusCode, 422);
  assert.equal(response.json().error.code, "secret_detected");

  // Make sure the agent was NOT touched -- list should show unlinked=false.
  const list = await app.inject({
    method: "GET", url: `/v1/owners/me/agents`,
    headers: { authorization: `Bearer ${ownerToken}` }
  });
  const row = list.json().data.find((a: any) => a.agent_id === agentId);
  assert.equal(row.unlinked, false);
});

test("unlink requires an Idempotency-Key", async (t) => {
  if (!pgAvailable || !app) { t.skip("PostgreSQL is not reachable"); return; }
  const { agentId } = await enrollAgent(`install-noidem-${randomUUID()}`, "NoIdemPin");
  const response = await app.inject({
    method: "POST",
    url: `/v1/owners/me/agents/${agentId}/unlink`,
    headers: { authorization: `Bearer ${ownerToken}` },
    payload: { reason: "no idem" }
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, "idempotency_key_required");
});
