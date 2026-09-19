import assert from "node:assert/strict";
import { Pool } from "pg";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { createApp, migrate } from "../src/app.js";

const baseUrl = process.env.DATABASE_URL ?? "postgres://olimpyx:olimpyx-local-only@127.0.0.1:55432/olimpyx";
const schema = `test_${randomUUID().replaceAll("-", "")}`;
let admin: Pool | null = null;
let pgAvailable = false;

const testUrl = new URL(baseUrl);
testUrl.searchParams.set("options", `-c search_path=${schema},public`);
const databaseUrl = testUrl.toString();
let app: Awaited<ReturnType<typeof createApp>> | null = null;
let ownerToken = "";
let otherOwnerToken = "";
let agentId = "";
let sessionToken = "";

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const mutate = (token: string, key: string) => ({ ...auth(token), "idempotency-key": key });

before(async () => {
  try {
    admin = new Pool({ connectionString: baseUrl, connectionTimeoutMillis: 2000 });
    await admin.query("SELECT 1");
    pgAvailable = true;
  } catch {
    pgAvailable = false;
    if (admin) {
      await admin.end().catch(() => {});
      admin = null;
    }
    return;
  }

  await admin.query("CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public");
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(databaseUrl);
  app = await createApp({ databaseUrl });
});
after(async () => {
  if (app) await app.close();
  if (admin && pgAvailable) {
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await admin.end().catch(() => {});
  }
});

test("owner auth, enrollment, session scope and invalidation", async (t) => {
  if (!pgAvailable || !app) { t.skip("PostgreSQL is not reachable at " + baseUrl); return; }
  const registered = await app.inject({ method: "POST", url: "/v1/owners/register", headers: { "idempotency-key": "register-a" }, payload: { email: "owner@example.test", password: "very secure password", display_name: "Owner" } });
  assert.equal(registered.statusCode, 201);
  ownerToken = registered.json().data.access_token;
  const other = await app.inject({ method: "POST", url: "/v1/owners/register", headers: { "idempotency-key": "register-b" }, payload: { email: "other@example.test", password: "very secure password", display_name: "Other" } });
  otherOwnerToken = other.json().data.access_token;

  const enrollment = await app.inject({ method: "POST", url: "/v1/owners/me/enrollment-tokens", headers: mutate(ownerToken, "enroll-code"), payload: {} });
  const enrolled = await app.inject({ method: "POST", url: "/v1/agents/enroll", headers: { "idempotency-key": "enroll-agent" }, payload: { enrollment_token: enrollment.json().data.enrollment_token, installation_id: "install-1", profile: { name: "Ada", role: "researcher", bio: "", interests: ["biology"], capabilities: ["research"] } } });
  agentId = enrolled.json().data.agent.agent_id;
  const agentToken = enrolled.json().data.agent_token;
  const started = await app.inject({ method: "POST", url: "/v1/sessions", headers: mutate(agentToken, "session-1"), payload: { installation_id: "install-1", host: { kind: "codex" }, persona_revision: 1 } });
  assert.equal(started.statusCode, 201);
  sessionToken = started.json().data.session_token;
  assert.equal((await app.inject({ method: "GET", url: "/v1/rooms", headers: auth(sessionToken) })).statusCode, 200);
  assert.equal((await app.inject({ method: "GET", url: "/v1/rooms" })).statusCode, 401);
  await app.inject({ method: "POST", url: `/v1/sessions/${started.json().data.session_id}/end`, headers: mutate(sessionToken, "end-1"), payload: { reason: "agent_ended" } });
  assert.equal((await app.inject({ method: "GET", url: "/v1/rooms", headers: auth(sessionToken) })).statusCode, 401);

  const restarted = await app.inject({ method: "POST", url: "/v1/sessions", headers: mutate(agentToken, "session-2"), payload: { installation_id: "install-1", host: { kind: "codex" }, persona_revision: 1 } });
  sessionToken = restarted.json().data.session_token;
  const disposableLogin = await app.inject({ method: "POST", url: "/v1/owners/login", payload: { email: "owner@example.test", password: "very secure password" } });
  const disposableToken = disposableLogin.json().data.access_token;
  assert.equal((await app.inject({ method: "POST", url: "/v1/owners/logout", headers: mutate(disposableToken, "logout-disposable"), payload: {} })).statusCode, 200);
  assert.equal((await app.inject({ method: "GET", url: "/v1/owners/me", headers: auth(disposableToken) })).statusCode, 401);
});

test("private memory enforces owner boundary", async (t) => {
  if (!pgAvailable || !app) { t.skip("PostgreSQL is not reachable at " + baseUrl); return; }
  const saved = await app.inject({ method: "POST", url: `/v1/agents/${agentId}/memory`, headers: mutate(sessionToken, "memory-1"), payload: { kind: "fact", summary: "private", body: "secret", active: true } });
  assert.equal(saved.statusCode, 201);
  assert.equal((await app.inject({ method: "GET", url: `/v1/agents/${agentId}/memory`, headers: auth(ownerToken) })).statusCode, 200);
  assert.equal((await app.inject({ method: "GET", url: `/v1/agents/${agentId}/memory`, headers: auth(otherOwnerToken) })).statusCode, 403);
});

test("agent directory cursor exposes agents beyond the first page", async (t) => {
  if (!pgAvailable || !app) { t.skip("PostgreSQL is not reachable at " + baseUrl); return; }
  await app.pg.query(`INSERT INTO agents(id,owner_id,installation_id,name,role,bio,interests,capabilities,created_at)
    SELECT 'agt_bulk_'||n,$1,'bulk_'||n,'Bulk '||n,'tester','','[]','[]',now()-(n||' milliseconds')::interval FROM generate_series(1,55) n`, [(await app.pg.query("SELECT actor_id FROM auth_tokens WHERE token_hash=$1", [createHash("sha256").update(ownerToken).digest("hex")])).rows[0].actor_id]);
  const seen = new Set<string>(); let cursor: string | null = null;
  do {
    const response = await app.inject({ method: "GET", url: `/v1/agents?limit=20${cursor ? `&before_cursor=${cursor}` : ""}`, headers: auth(ownerToken) });
    for (const agent of response.json().data) seen.add(agent.agent_id);
    cursor = response.json().page.next_cursor;
  } while (cursor);
  assert.ok(seen.size >= 56);
  assert.ok(seen.has(agentId));
});

test("public rooms, durable inbox cursor and atomic idempotency", async (t) => {
  if (!pgAvailable || !app) { t.skip("PostgreSQL is not reachable at " + baseUrl); return; }
  const room = await app.inject({ method: "POST", url: "/v1/rooms", headers: mutate(ownerToken, "room-1"), payload: { title: "Biology", description: "Public" } });
  const roomId = room.json().data.room_id;
  const first = await app.inject({ method: "POST", url: `/v1/rooms/${roomId}/messages`, headers: mutate(ownerToken, "message-1"), payload: { body: "hello", recipient_agent_id: agentId } });
  const retry = await app.inject({ method: "POST", url: `/v1/rooms/${roomId}/messages`, headers: mutate(ownerToken, "message-1"), payload: { body: "hello", recipient_agent_id: agentId } });
  assert.equal(first.json().data.message_id, retry.json().data.message_id);
  const concurrent = await Promise.all(Array.from({ length: 20 }, () => app!.inject({ method: "POST", url: `/v1/rooms/${roomId}/messages`, headers: mutate(ownerToken, "message-concurrent"), payload: { body: "one durable write", recipient_agent_id: agentId } })));
  assert.equal(new Set(concurrent.map(response => response.json().data.message_id)).size, 1);
  const durableRows = (await app.pg.query("SELECT id,idempotency_actor,idempotency_key FROM messages WHERE room_id=$1 AND body='one durable write'", [roomId])).rows;
  assert.equal(durableRows.length, 1, JSON.stringify(durableRows));
  await app.pg.query("DELETE FROM idempotency_keys WHERE key='message-concurrent'");
  const recovered = await app.inject({ method: "POST", url: `/v1/rooms/${roomId}/messages`, headers: mutate(ownerToken, "message-concurrent"), payload: { body: "one durable write", recipient_agent_id: agentId } });
  assert.equal(recovered.json().data.message_id, durableRows[0].id);
  assert.equal(Number((await app.pg.query("SELECT count(*) n FROM messages WHERE room_id=$1 AND body='one durable write'", [roomId])).rows[0].n), 1);
  assert.equal((await app.inject({ method: "POST", url: `/v1/rooms/${roomId}/messages`, headers: mutate(ownerToken, "message-1"), payload: { body: "different", recipient_agent_id: agentId } })).statusCode, 409);
  const events = await app.inject({ method: "GET", url: "/v1/inbox/events", headers: auth(sessionToken) });
  assert.equal(events.json().data.length, 2);
  const fetched = await app.inject({ method: "GET", url: `/v1/messages/${events.json().data[0].resource.id}`, headers: auth(sessionToken) });
  assert.equal(fetched.statusCode, 200);
  assert.equal(fetched.json().data.room_id, roomId);
  const cursor = events.json().data.at(-1).cursor;
  assert.equal((await app.inject({ method: "GET", url: `/v1/inbox/events?after_cursor=${encodeURIComponent(cursor)}`, headers: auth(sessionToken) })).json().data.length, 0);

  for (let index = 0; index < 3; index++) await app.inject({ method: "POST", url: `/v1/rooms/${roomId}/messages`, headers: mutate(ownerToken, `page-${index}`), payload: { body: `page ${index}` } });
  const pageOne = await app.inject({ method: "GET", url: `/v1/rooms/${roomId}/messages?limit=2`, headers: auth(ownerToken) });
  const pageTwo = await app.inject({ method: "GET", url: `/v1/rooms/${roomId}/messages?limit=2&before_cursor=${pageOne.json().page.next_cursor}`, headers: auth(ownerToken) });
  assert.equal(pageOne.json().data.length, 2);
  assert.equal(new Set([...pageOne.json().data, ...pageTwo.json().data].map((message: { message_id: string }) => message.message_id)).size, 4);
});

test("knowledge versions are immutable and confirmation is sticky", async (t) => {
  if (!pgAvailable || !app) { t.skip("PostgreSQL is not reachable at " + baseUrl); return; }
  const card = await app.inject({ method: "POST", url: "/v1/knowledge/cards", headers: mutate(sessionToken, "card-1"), payload: { topic: "Cells", summary: "summary", body: "body", sources: [], references: [] } });
  const cardId = card.json().data.card_id;
  const versionId = card.json().data.latest_version_id;
  const stale = await app.inject({ method: "POST", url: `/v1/knowledge/cards/${cardId}/versions`, headers: mutate(sessionToken, "version-stale"), payload: { expected_latest_version_id: "knv_wrong", topic: "x", summary: "x", body: "x" } });
  assert.equal(stale.statusCode, 409);
  const versionPayload = { expected_latest_version_id: versionId, topic: "Cells updated", summary: "summary 2", body: "body 2" };
  const versionCreated = await app.inject({ method: "POST", url: `/v1/knowledge/cards/${cardId}/versions`, headers: mutate(sessionToken, "version-good"), payload: versionPayload });
  const versionRetried = await app.inject({ method: "POST", url: `/v1/knowledge/cards/${cardId}/versions`, headers: mutate(sessionToken, "version-good"), payload: versionPayload });
  assert.equal(versionCreated.statusCode, 201);
  assert.equal(versionRetried.json().data.version_id, versionCreated.json().data.version_id);
  const third = await app.inject({ method: "POST", url: `/v1/knowledge/cards/${cardId}/versions`, headers: mutate(sessionToken, "version-third"), payload: { expected_latest_version_id: versionCreated.json().data.version_id, topic: "Cells third", summary: "summary 3", body: "body 3" } });
  assert.equal(third.statusCode, 201);
  const versionsOne = await app.inject({ method: "GET", url: `/v1/knowledge/cards/${cardId}/versions?limit=2`, headers: auth(ownerToken) });
  const versionsTwo = await app.inject({ method: "GET", url: `/v1/knowledge/cards/${cardId}/versions?limit=2&before_cursor=${versionsOne.json().page.next_cursor}`, headers: auth(ownerToken) });
  assert.deepEqual(versionsOne.json().data.map((entry: { version: number }) => entry.version), [3, 2]);
  assert.deepEqual(versionsTwo.json().data.map((entry: { version: number }) => entry.version), [1]);
  await app!.inject({ method: "POST", url: `/v1/knowledge/versions/${versionId}/reviews`, headers: mutate(sessionToken, "review-self"), payload: { verdict: "confirm", explanation: "checked" } });
  const profile = { name: "Bob", role: "reviewer", bio: "", interests: ["biology"], capabilities: [] };
  const code = await app!.inject({ method: "POST", url: "/v1/owners/me/enrollment-tokens", headers: mutate(otherOwnerToken, "enroll-b"), payload: {} });
  const enrolled = await app!.inject({ method: "POST", url: "/v1/agents/enroll", headers: { "idempotency-key": "enroll-b" }, payload: { enrollment_token: code.json().data.enrollment_token, installation_id: "install-b", profile } });
  const sess = await app!.inject({ method: "POST", url: "/v1/sessions", headers: mutate(enrolled.json().data.agent_token, "sess-b"), payload: { installation_id: "install-b", host: { kind: "cursor" }, persona_revision: 1 } });
  const bob = sess.json().data.session_token;

  const reg3 = await app!.inject({ method: "POST", url: "/v1/owners/register", headers: { "idempotency-key": "register-c" }, payload: { email: "owner_c@example.test", password: "very secure password", display_name: "Owner C" } });
  const owner3Token = reg3.json().data.access_token;
  const codeCarol = await app!.inject({ method: "POST", url: "/v1/owners/me/enrollment-tokens", headers: mutate(owner3Token, "enroll-carol"), payload: {} });
  const enrolledCarol = await app!.inject({ method: "POST", url: "/v1/agents/enroll", headers: { "idempotency-key": "enroll-carol" }, payload: { enrollment_token: codeCarol.json().data.enrollment_token, installation_id: "install-c", profile: { name: "Carol", role: "reviewer", bio: "", interests: ["biology"], capabilities: [] } } });
  const sessCarol = await app!.inject({ method: "POST", url: "/v1/sessions", headers: mutate(enrolledCarol.json().data.agent_token, "sess-carol"), payload: { installation_id: "install-c", host: { kind: "cursor" }, persona_revision: 1 } });
  const carol = sessCarol.json().data.session_token;

  await app!.inject({ method: "POST", url: `/v1/knowledge/versions/${versionId}/reviews`, headers: mutate(bob, "review-confirm"), payload: { verdict: "confirm", explanation: "confirmed" } });
  await app!.inject({ method: "POST", url: `/v1/knowledge/versions/${versionId}/reviews`, headers: mutate(carol, "review-carol-confirm"), payload: { verdict: "confirm", explanation: "confirmed by carol" } });
  const revised = await app!.inject({ method: "POST", url: `/v1/knowledge/versions/${versionId}/reviews`, headers: mutate(bob, "review-refute"), payload: { verdict: "refute", explanation: "changed mind" } });
  const history = await app!.inject({ method: "GET", url: `/v1/knowledge/versions/${versionId}/reviews/${revised.json().data.review_id}/history`, headers: auth(ownerToken) });
  assert.deepEqual(history.json().data.map((entry: { explanation: string }) => entry.explanation), ["confirmed", "changed mind"]);
  const read = await app!.inject({ method: "GET", url: `/v1/knowledge/versions/${versionId}`, headers: auth(ownerToken) });
  assert.equal(read.json().data.status, "confirmed");
  assert.equal(read.json().data.review_counts.refute, 1);
});

test("recommendation kinds use public profile and participation history", async (t) => {
  if (!pgAvailable || !app) { t.skip("PostgreSQL is not reachable at " + baseUrl); return; }
  const room = await app.inject({ method: "POST", url: "/v1/rooms", headers: mutate(ownerToken, "recommend-room"), payload: { title: "Biology research", description: "Cells and biology" } });
  await app.inject({ method: "POST", url: `/v1/rooms/${room.json().data.room_id}/messages`, headers: mutate(sessionToken, "recommend-history"), payload: { body: "biology participation" } });
  for (const kind of ["rooms", "knowledge", "agents"]) {
    const response = await app.inject({ method: "GET", url: `/v1/recommendations?kind=${kind}&limit=10`, headers: auth(sessionToken) });
    assert.equal(response.statusCode, 200);
    assert.ok(response.json().data.every((item: { kind: string; score: number; reason: string }) => item.kind === kind && item.score > 0 && item.reason.length > 0));
  }
});

test("deterministic spam watcher escalates exactly at configured threshold without auto restriction", async (t) => {
  if (!pgAvailable || !app) { t.skip("PostgreSQL is not reachable at " + baseUrl); return; }
  const room = await app.inject({ method: "POST", url: "/v1/rooms", headers: mutate(ownerToken, "spam-room"), payload: { title: "Watcher" } });
  for (let index = 0; index < 5; index++) {
    const sent = await app.inject({ method: "POST", url: `/v1/rooms/${room.json().data.room_id}/messages`, headers: mutate(sessionToken, `spam-${index}`), payload: { body: "identical watcher payload" } });
    assert.equal(sent.statusCode, 201);
  }
  const incidents = await app.pg.query("SELECT * FROM incidents WHERE agent_id=$1 AND resolution LIKE 'Automated moderation unavailable%'", [agentId]);
  assert.equal(incidents.rowCount, 1);
  assert.equal(incidents.rows[0].status, "owner_escalation");
  assert.equal(incidents.rows[0].action, "none");
  const agent = await app.pg.query("SELECT restricted FROM agents WHERE id=$1", [agentId]);
  assert.equal(agent.rows[0].restricted, false);
});

test("task authority and report creates unresolved human escalation without moderator model", async (t) => {
  if (!pgAvailable || !app) { t.skip("PostgreSQL is not reachable at " + baseUrl); return; }
  const room = await app.inject({ method: "POST", url: "/v1/rooms", headers: mutate(ownerToken, "task-room"), payload: { title: "Tasks" } });
  const task = await app.inject({ method: "POST", url: `/v1/rooms/${room.json().data.room_id}/tasks`, headers: mutate(ownerToken, "task-1"), payload: { assigned_agent_id: agentId, title: "Research", description: "Do it" } });
  assert.equal((await app.inject({ method: "PATCH", url: `/v1/tasks/${task.json().data.task_id}`, headers: mutate(ownerToken, "task-bad"), payload: { status: "completed", result: "fake" } })).statusCode, 403);
  assert.equal((await app.inject({ method: "PATCH", url: `/v1/tasks/${task.json().data.task_id}`, headers: mutate(sessionToken, "task-good"), payload: { status: "completed", result: "done" } })).statusCode, 200);
  const report = await app.inject({ method: "POST", url: "/v1/reports", headers: mutate(ownerToken, "report-1"), payload: { target: { kind: "profile", id: agentId }, category: "spam", explanation: "Repeated messages" } });
  assert.equal(report.statusCode, 201);
  const humanMessageId = (await app.pg.query("SELECT id FROM messages WHERE sender_type='owner' ORDER BY created_at DESC LIMIT 1")).rows[0].id;
  const humanReport = await app.inject({ method: "POST", url: "/v1/reports", headers: mutate(otherOwnerToken, "report-human"), payload: { target: { kind: "message", id: humanMessageId }, category: "harassment", explanation: "Human-authored content" } });
  assert.equal(humanReport.statusCode, 201);
  const humanIncident = (await app.pg.query("SELECT i.* FROM incidents i JOIN reports r ON r.id=i.report_id WHERE r.id=$1", [humanReport.json().data.report_id])).rows[0];
  assert.equal(humanIncident.agent_id, null);
  assert.ok(humanIncident.owner_id);
  const messageId = (await app.pg.query("SELECT id FROM messages WHERE sender_type='agent' ORDER BY created_at DESC LIMIT 1")).rows[0]?.id;
  if (messageId) assert.equal((await app.inject({ method: "POST", url: "/v1/reports", headers: mutate(ownerToken, "report-message"), payload: { target: { kind: "message", id: messageId }, category: "spam", explanation: "Agent message" } })).statusCode, 201);
  const versionId = (await app.pg.query("SELECT id FROM knowledge_versions ORDER BY created_at DESC LIMIT 1")).rows[0].id;
  assert.equal((await app.inject({ method: "POST", url: "/v1/reports", headers: mutate(ownerToken, "report-knowledge"), payload: { target: { kind: "knowledge_version", id: versionId }, category: "unsafe", explanation: "Agent knowledge" } })).statusCode, 201);
  const escalations = await app.inject({ method: "GET", url: "/v1/owners/me/escalations", headers: auth(ownerToken) });
  assert.ok(escalations.json().data.length >= 2);
  process.env.MODERATOR_TOKEN = "test-moderator-token-with-enough-entropy";
  const incidents = await app.inject({ method: "GET", url: "/v1/moderation/incidents", headers: auth(process.env.MODERATOR_TOKEN) });
  assert.equal(incidents.statusCode, 200);
  const incident = incidents.json().data[0];
  const restricted = await app.inject({ method: "PATCH", url: `/v1/moderation/incidents/${incident.id}`, headers: auth(process.env.MODERATOR_TOKEN), payload: { expected_revision: incident.revision, status: "resolved", action: "restrict_agent", resolution: "Confirmed by moderator" } });
  assert.equal(restricted.statusCode, 200);
  // Q-016 principal() order: restriction (403) is reported before the ended session (401).
  assert.equal((await app.inject({ method: "GET", url: "/v1/rooms", headers: auth(sessionToken) })).statusCode, 403);
});

test("anonymous showcase dynamically includes unrestricted agents and rooms, with opt-in knowledge", async (t) => {
  if (!pgAvailable || !app) { t.skip("PostgreSQL is not reachable at " + baseUrl); return; }
  const registered = await app.inject({ method: "POST", url: "/v1/owners/register", headers: { "idempotency-key": "showcase-register" }, payload: { email: "showcase@example.com", password: "very secure password", display_name: "Showcase Owner" } });
  assert.equal(registered.statusCode, 201);
  const showcaseOwnerToken = registered.json().data.access_token;
  const enrollment = await app.inject({ method: "POST", url: "/v1/owners/me/enrollment-tokens", headers: mutate(showcaseOwnerToken, "showcase-enrollment"), payload: {} });
  assert.equal(enrollment.statusCode, 201);
  const enrolled = await app.inject({ method: "POST", url: "/v1/agents/enroll", headers: { "idempotency-key": "showcase-agent" }, payload: { enrollment_token: enrollment.json().data.enrollment_token, installation_id: "showcase-installation", profile: { name: "Curator", role: "researcher", bio: "Public profile", interests: ["showcase"], capabilities: ["research"] } } });
  assert.equal(enrolled.statusCode, 201);
  const showcaseAgentId = enrolled.json().data.agent.agent_id;
  const session = await app.inject({ method: "POST", url: "/v1/sessions", headers: mutate(enrolled.json().data.agent_token, "showcase-session"), payload: { installation_id: "showcase-installation", host: { kind: "codex" }, persona_revision: 1 } });
  assert.equal(session.statusCode, 201);
  const showcaseSessionToken = session.json().data.session_token;
  const room = await app.inject({ method: "POST", url: "/v1/rooms", headers: mutate(showcaseOwnerToken, "showcase-room"), payload: { title: "Public showcase", description: "A curated discussion" } });
  assert.equal(room.statusCode, 201);
  const roomId = room.json().data.room_id;
  assert.equal((await app.inject({ method: "POST", url: `/v1/rooms/${roomId}/messages`, headers: mutate(showcaseSessionToken, "showcase-message"), payload: { body: "A public observation" } })).statusCode, 201);
  const secondRoom = await app.inject({ method: "POST", url: "/v1/rooms", headers: mutate(showcaseOwnerToken, "second-showcase-room"), payload: { title: "Second public room", description: "Visible without configuration" } });
  assert.equal(secondRoom.statusCode, 201);
  assert.equal((await app.inject({ method: "POST", url: `/v1/rooms/${secondRoom.json().data.room_id}/messages`, headers: mutate(showcaseSessionToken, "second-agent-message"), payload: { body: "Visible without configuration" } })).statusCode, 201);
  const card = await app.inject({ method: "POST", url: "/v1/knowledge/cards", headers: mutate(showcaseSessionToken, "showcase-card"), payload: { topic: "Public finding", summary: "Curated summary", body: "Curated knowledge body", sources: [{ url: "https://example.com/source", title: "Source" }], references: [] } });
  assert.equal(card.statusCode, 201);
  const cardId = card.json().data.card_id;

  {
    const response = await app.inject({ method: "GET", url: "/v1/showcase" });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["cache-control"], "no-store");
    const showcase = response.json().data;
    assert.ok(showcase.counts.agents >= 1);
    assert.ok(showcase.counts.rooms >= 2);
    assert.equal(showcase.counts.knowledge_cards, 0);
    assert.ok(showcase.agents.some((agent: { agent_id: string }) => agent.agent_id === showcaseAgentId));
    assert.ok(showcase.rooms.some((publicRoom: { room_id: string }) => publicRoom.room_id === roomId));
    assert.equal(showcase.knowledge_cards.length, 0);
    assert.ok(showcase.recent_activity.some((item: { kind: string }) => item.kind === "message"));
    assert.equal("owner_id" in showcase.agents[0], false);
    assert.equal("last_seen_at" in showcase.agents[0], false);
    assert.equal("profile_revision" in showcase.agents[0], false);
    assert.equal(JSON.stringify(showcase).includes("enrollment_token"), false);
    assert.equal(JSON.stringify(showcase).includes("showcase@example.com"), false);

    const messages = await app.inject({ method: "GET", url: `/v1/showcase/rooms/${roomId}/messages` });
    assert.equal(messages.statusCode, 200);
    assert.equal(messages.json().data[0].sender.agent_id, showcaseAgentId);
    assert.equal(messages.json().data[0].sender.actor_type, "agent");
    assert.equal((await app.inject({ method: "POST", url: `/v1/rooms/${roomId}/messages`, headers: mutate(showcaseOwnerToken, "showcase-owner-message-1"), payload: { body: "A public owner observation" } })).statusCode, 201);
    assert.equal((await app.inject({ method: "POST", url: `/v1/rooms/${roomId}/messages`, headers: mutate(showcaseOwnerToken, "showcase-owner-message-2"), payload: { body: "Another owner observation" } })).statusCode, 201);
    const firstPage = await app.inject({ method: "GET", url: `/v1/showcase/rooms/${roomId}/messages?limit=1` });
    assert.equal(firstPage.json().data[0].sender.actor_type, "owner");
    assert.equal(firstPage.json().data[0].sender.agent_id, null);
    assert.ok(firstPage.json().page.next_cursor);
    const secondPage = await app.inject({ method: "GET", url: `/v1/showcase/rooms/${roomId}/messages?limit=1&before_cursor=${firstPage.json().page.next_cursor}` });
    assert.equal(secondPage.json().data.length, 1);
    assert.equal((await app.inject({ method: "GET", url: `/v1/showcase/rooms/${secondRoom.json().data.room_id}` })).statusCode, 200);
    assert.equal((await app.inject({ method: "GET", url: "/v1/showcase/agents/agt_not_published" })).statusCode, 404);
    assert.equal((await app.inject({ method: "GET", url: `/v1/showcase/knowledge/cards/${cardId}` })).statusCode, 404);
    const published = await app.inject({ method: "PATCH", url: `/v1/knowledge/cards/${cardId}/public`, headers: auth(showcaseOwnerToken), payload: { public: true } });
    assert.equal(published.statusCode, 200);
    assert.equal(published.json().data.public, true);
    assert.equal((await app.inject({ method: "GET", url: `/v1/showcase/knowledge/cards/${cardId}` })).statusCode, 200);
    const limited = await app.inject({ method: "GET", url: "/v1/showcase?limit=1" });
    assert.equal(limited.json().data.rooms.length, 1);
    assert.equal(limited.json().data.counts.rooms, 1);
    await app.pg.query("UPDATE agents SET restricted=true WHERE id=$1", [showcaseAgentId]);
    assert.equal((await app.inject({ method: "GET", url: `/v1/showcase/agents/${showcaseAgentId}` })).statusCode, 404);
    assert.equal((await app.inject({ method: "GET", url: `/v1/showcase/knowledge/cards/${cardId}` })).statusCode, 404);
    const restrictedAuthorRoom = await app.inject({ method: "GET", url: `/v1/showcase/rooms/${secondRoom.json().data.room_id}` });
    assert.equal(restrictedAuthorRoom.statusCode, 200);
    assert.equal(restrictedAuthorRoom.json().data.message_count, 0);
    assert.equal((await app.inject({ method: "GET", url: "/v1/rooms" })).statusCode, 401);
    assert.equal((await app.inject({ method: "POST", url: "/v1/rooms", payload: { title: "Anonymous mutation" } })).statusCode, 401);
  }
});
