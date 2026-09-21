import assert from "node:assert/strict";
import { Pool } from "pg";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { createApp, migrate } from "../src/app.js";
import { ensureVectorExtension } from "./pg-extension.js";

const baseUrl = process.env.DATABASE_URL ?? "postgres://olimpyx:olimpyx-local-only@127.0.0.1:55432/olimpyx";
const schema = `test_${randomUUID().replaceAll("-", "")}`;
let admin: Pool | null = null;
let pgAvailable = false;

const testUrl = new URL(baseUrl);
testUrl.searchParams.set("options", `-c search_path=${schema},public`);
const databaseUrl = testUrl.toString();
let app: Awaited<ReturnType<typeof createApp>> | null = null;
let ownerToken = "";
let agentToken = "";
let sessionToken = "";
let agentId = "";
let sessionId = "";

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const mutate = (token: string, key: string) => ({ ...auth(token), "idempotency-key": key });

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

  // Owner signup (registration returns the access_token directly).
  const registered = await app.inject({
    method: "POST",
    url: "/v1/owners/register",
    headers: { "idempotency-key": "register-activity" },
    payload: { email: `owner-${randomUUID()}@example.test`, password: "very secure password", display_name: "Activity Owner" }
  });
  ownerToken = registered.json().data.access_token;

  // Agent enroll + session.
  const enrollment = await app.inject({ method: "POST", url: "/v1/owners/me/enrollment-tokens", headers: mutate(ownerToken, "enroll-tok"), payload: { label: "activity test" } });
  const enrolled = await app.inject({ method: "POST", url: "/v1/agents/enroll", headers: { "idempotency-key": "enroll-activity" }, payload: { enrollment_token: enrollment.json().data.enrollment_token, installation_id: "install-activity", profile: { name: "Pin", role: "tester", bio: "", interests: [], capabilities: [] } } });
  agentId = enrolled.json().data.agent.agent_id;
  agentToken = enrolled.json().data.agent_token;
  const session = await app.inject({ method: "POST", url: "/v1/sessions", headers: mutate(agentToken, "session-start"), payload: { installation_id: "install-activity", host: { kind: "codex" }, persona_revision: 1 } });
  sessionToken = session.json().data.session_token;
  sessionId = session.json().data.session_id;
});

after(async () => {
  if (app) await app.close();
  if (admin && pgAvailable) {
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await admin.end();
  }
});

test("F-01: re-enroll with same installation returns structured 409, not 500", async (t) => {
  if (!pgAvailable || !app) { t.skip("PostgreSQL is not reachable"); return; }
  const enrollment = await app.inject({ method: "POST", url: "/v1/owners/me/enrollment-tokens", headers: mutate(ownerToken, "enroll-tok-2"), payload: { label: "reenroll" } });
  const retry = await app.inject({
    method: "POST", url: "/v1/agents/enroll",
    headers: mutate(ownerToken, "enroll-retry"),
    payload: { enrollment_token: enrollment.json().data.enrollment_token, installation_id: "install-activity", profile: { name: "Pin Dup", role: "tester", bio: "", interests: [], capabilities: [] } }
  });
  assert.equal(retry.statusCode, 409);
  const body = retry.json();
  assert.equal(body.error.code, "agent_already_enrolled");
  assert.equal(body.error.details.agent_id, agentId);
  assert.equal(typeof body.error.details.profile_revision, "number");
});

test("F-02: POST /v1/sessions/me/activity requires session auth", async (t) => {
  if (!pgAvailable || !app) { t.skip("PostgreSQL is not reachable"); return; }
  const response = await app.inject({ method: "POST", url: "/v1/sessions/me/activity", payload: { kind: "lobby" } });
  assert.equal(response.statusCode, 401);
});

test("F-02: agent can declare kind=room with a valid room", async (t) => {
  if (!pgAvailable || !app) { t.skip("PostgreSQL is not reachable"); return; }
  const room = await app.inject({ method: "POST", url: "/v1/rooms", headers: mutate(ownerToken, "act-room"), payload: { title: "Activity Room", description: "test" } });
  const roomId = room.json().data.room_id;
  const set = await app.inject({ method: "POST", url: "/v1/sessions/me/activity", headers: auth(sessionToken), payload: { kind: "room", room_id: roomId, note: "drafting a memo" } });
  assert.equal(set.statusCode, 200);
  assert.equal(set.json().data.kind, "room");
  assert.equal(set.json().data.location_ref, roomId);

  // /v1/agents exposes current_activity while the session is live.
  const me = await app.inject({ method: "GET", url: `/v1/agents/${agentId}`, headers: auth(sessionToken) });
  assert.equal(me.json().data.presence, "online");
  assert.equal(me.json().data.current_activity.kind, "room");
  assert.equal(me.json().data.current_activity.location_ref, roomId);
});

test("F-02: invalid kind returns 422, missing room_id returns 422, missing room returns 404", async (t) => {
  if (!pgAvailable || !app) { t.skip("PostgreSQL is not reachable"); return; }
  const bad = await app.inject({ method: "POST", url: "/v1/sessions/me/activity", headers: auth(sessionToken), payload: { kind: "moon" } });
  assert.equal(bad.statusCode, 422);
  const missing = await app.inject({ method: "POST", url: "/v1/sessions/me/activity", headers: auth(sessionToken), payload: { kind: "room" } });
  assert.equal(missing.statusCode, 422);
  const phantom = await app.inject({ method: "POST", url: "/v1/sessions/me/activity", headers: auth(sessionToken), payload: { kind: "room", room_id: "rom_does_not_exist" } });
  assert.equal(phantom.statusCode, 404);
});

test("F-02: current_activity becomes null after the session ends", async (t) => {
  if (!pgAvailable || !app) { t.skip("PostgreSQL is not reachable"); return; }
  await app.inject({ method: "POST", url: `/v1/sessions/${sessionId}/end`, headers: mutate(sessionToken, "end-it"), payload: { reason: "agent_ended" } });
  const me = await app.inject({ method: "GET", url: `/v1/agents/${agentId}`, headers: auth(ownerToken) });
  assert.equal(me.json().data.presence, "offline");
  assert.equal(me.json().data.current_activity ?? null, null);
});
