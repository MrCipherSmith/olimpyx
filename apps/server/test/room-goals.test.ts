import assert from "node:assert/strict";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { createApp, migrate } from "../src/app.js";
import { ensureVectorExtension } from "./pg-extension.js";

// W3 (issue #36): a room without an explicit, checkable goal degenerates into an open-ended
// chat that never concludes anything (roomyx's own diagnosis of the same failure mode, quoted
// in the issue). This adds goal, success_criteria and goal_status to `rooms` — all optional, so
// an existing room or one created without a goal stays fully valid — plus a creator-only
// PATCH /v1/rooms/:roomId and a room.goal_changed inbox event on a real status transition.
// Deliberately NOT covered: convergence machinery (participant voting/quorum to auto-close a
// goal). That needs a dispatcher this project doesn't have; the creator changes status by hand.

const baseUrl = process.env.DATABASE_URL ?? "postgres://olimpyx:olimpyx-local-only@127.0.0.1:55432/olimpyx";
const schema = `test_room_goals_${randomUUID().replaceAll("-", "")}`;
const admin = new Pool({ connectionString: baseUrl });
const testUrl = new URL(baseUrl);
testUrl.searchParams.set("options", `-c search_path=${schema},public`);
const databaseUrl = testUrl.toString();

let app: Awaited<ReturnType<typeof createApp>>;
let ownerToken = "";
let ownerId = "";
let seq = 0;

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const mutate = (token: string, key: string) => ({ ...auth(token), "idempotency-key": key });
const nextKey = (label: string) => `${label}-${++seq}`;

async function enrollAgent(name: string) {
  const tag = `${name}-${++seq}`;
  const enrollTok = (await app.inject({
    method: "POST",
    url: "/v1/owners/me/enrollment-tokens",
    headers: mutate(ownerToken, `enroll-tok-${tag}`),
    payload: {}
  })).json().data.enrollment_token;
  const enrolled = await app.inject({
    method: "POST",
    url: "/v1/agents/enroll",
    headers: { "idempotency-key": `enroll-${tag}` },
    payload: { enrollment_token: enrollTok, installation_id: `inst-${tag}`, profile: { name, role: "tester" } }
  });
  const agentId = enrolled.json().data.agent.agent_id;
  const session = await app.inject({
    method: "POST",
    url: "/v1/sessions",
    headers: mutate(enrolled.json().data.agent_token, `ses-${tag}`),
    payload: { installation_id: `inst-${tag}`, host: { kind: "codex" }, persona_revision: 1 }
  });
  return { agentId, token: session.json().data.session_token as string };
}

async function createRoom(token: string, title: string, extra: Record<string, unknown> = {}) {
  return app.inject({
    method: "POST",
    url: "/v1/rooms",
    headers: mutate(token, `room-${title}-${++seq}`),
    payload: { title, ...extra }
  });
}

async function patchRoom(roomId: string, token: string, payload: Record<string, unknown>) {
  return app.inject({ method: "PATCH", url: `/v1/rooms/${roomId}`, headers: auth(token), payload });
}

async function getRoom(roomId: string, token: string) {
  return app.inject({ method: "GET", url: `/v1/rooms/${roomId}`, headers: auth(token) });
}

async function listRooms(token: string) {
  return app.inject({ method: "GET", url: "/v1/rooms", headers: auth(token) });
}

async function bootstrap(token: string) {
  return app.inject({ method: "GET", url: "/v1/bootstrap", headers: auth(token) });
}

async function overview(token: string) {
  return app.inject({ method: "GET", url: "/v1/inbox/overview", headers: auth(token) });
}

async function post(roomId: string, token: string, payload: Record<string, unknown>) {
  return app.inject({ method: "POST", url: `/v1/rooms/${roomId}/messages`, headers: mutate(token, nextKey("msg")), payload });
}

async function joinRoom(roomId: string, token: string) {
  return app.inject({ method: "POST", url: `/v1/rooms/${roomId}/members`, headers: mutate(token, nextKey("join")), payload: {} });
}

async function inboxEvents(token: string, type?: string) {
  const r = await app.inject({ method: "GET", url: "/v1/inbox/events?limit=200", headers: auth(token) });
  const data = r.json().data as Array<{ event_id: string; type: string; resource: { kind: string; id: string }; data: any }>;
  return type ? data.filter(e => e.type === type) : data;
}

/** A fresh owner per test keeps agent enrollment well under the per-owner agent quota. */
async function freshOwner() {
  const reg = await app.inject({
    method: "POST",
    url: "/v1/owners/register",
    headers: { "idempotency-key": `reg-owner-${++seq}` },
    payload: { email: `owner_${randomUUID()}@example.test`, password: "very secure password", display_name: "Owner" }
  });
  ownerToken = reg.json().data.access_token;
  ownerId = reg.json().data.owner.owner_id;
}

before(async () => {
  await ensureVectorExtension(admin);
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(databaseUrl);
  app = await createApp({ databaseUrl });
});

after(async () => {
  if (app) await app.close();
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.end();
});

test("schema migration: rooms has goal, success_criteria, goal_status with the expected defaults and a status check constraint", async () => {
  const cols = await admin.query(
    `SELECT column_name, is_nullable, column_default FROM information_schema.columns
     WHERE table_schema=$1 AND table_name='rooms' AND column_name IN ('goal','success_criteria','goal_status')
     ORDER BY column_name`,
    [schema]
  );
  const byName = Object.fromEntries(cols.rows.map((r: any) => [r.column_name, r]));
  assert.equal(byName.goal.is_nullable, "YES");
  assert.equal(byName.success_criteria.is_nullable, "NO");
  assert.match(byName.success_criteria.column_default, /'\[\]'/);
  assert.equal(byName.goal_status.is_nullable, "NO");
  assert.match(byName.goal_status.column_default, /'open'/);

  const constraint = await admin.query(
    `SELECT pg_get_constraintdef(oid) def FROM pg_constraint WHERE conname='chk_rooms_goal_status' AND connamespace=$1::regnamespace`,
    [schema]
  );
  assert.equal(constraint.rowCount, 1);
  assert.match(constraint.rows[0].def, /'open'/);
  assert.match(constraint.rows[0].def, /'reached'/);
  assert.match(constraint.rows[0].def, /'abandoned'/);
});

test("POST /v1/rooms: goal and success_criteria are optional, a room without one is fully valid with open defaults", async () => {
  await freshOwner();

  const withGoal = await createRoom(ownerToken, "with-goal", { goal: "Ship the migration", success_criteria: ["tests pass", "docs updated"] });
  assert.equal(withGoal.statusCode, 201, withGoal.body);
  const dataWithGoal = withGoal.json().data;
  assert.equal(dataWithGoal.goal, "Ship the migration");
  assert.deepEqual(dataWithGoal.success_criteria, ["tests pass", "docs updated"]);
  assert.equal(dataWithGoal.goal_status, "open");

  const withoutGoal = await createRoom(ownerToken, "without-goal");
  assert.equal(withoutGoal.statusCode, 201, withoutGoal.body);
  const dataWithoutGoal = withoutGoal.json().data;
  assert.equal(dataWithoutGoal.goal, null);
  assert.deepEqual(dataWithoutGoal.success_criteria, []);
  assert.equal(dataWithoutGoal.goal_status, "open");

  // Validation still applies when a goal is given: empty criteria strings are rejected.
  const badCriteria = await createRoom(ownerToken, "bad-criteria", { success_criteria: [""] });
  assert.equal(badCriteria.statusCode, 400, badCriteria.body);
});

test("goal fields appear identically in GET /v1/rooms, GET /v1/rooms/:roomId and bootstrap's active_rooms", async () => {
  await freshOwner();
  const central = await enrollAgent("central-fields");

  const created = await createRoom(ownerToken, "fields-room", { goal: "Answer the open question", success_criteria: ["a decision is recorded"] });
  const roomId = created.json().data.room_id;
  const goalless = await createRoom(ownerToken, "fields-room-goalless");
  const goallessId = goalless.json().data.room_id;

  const single = await getRoom(roomId, ownerToken);
  assert.equal(single.statusCode, 200, single.body);
  const singleData = single.json().data;
  assert.equal(singleData.goal, "Answer the open question");
  assert.deepEqual(singleData.success_criteria, ["a decision is recorded"]);
  assert.equal(singleData.goal_status, "open");

  const list = await listRooms(ownerToken);
  assert.equal(list.statusCode, 200, list.body);
  const listed = list.json().data.find((r: any) => r.room_id === roomId);
  assert.deepEqual(listed.success_criteria, ["a decision is recorded"]);
  assert.equal(listed.goal, "Answer the open question");
  assert.equal(listed.goal_status, "open");
  const listedGoalless = list.json().data.find((r: any) => r.room_id === goallessId);
  assert.equal(listedGoalless.goal, null);
  assert.deepEqual(listedGoalless.success_criteria, []);
  assert.equal(listedGoalless.goal_status, "open");

  const boot = await bootstrap(central.token);
  assert.equal(boot.statusCode, 200, boot.body);
  const activeRooms = boot.json().data.active_rooms;
  const bootRoom = activeRooms.find((r: any) => r.room_id === roomId);
  assert.equal(bootRoom.goal, "Answer the open question");
  assert.deepEqual(bootRoom.success_criteria, ["a decision is recorded"]);
  assert.equal(bootRoom.goal_status, "open");
  const bootGoalless = activeRooms.find((r: any) => r.room_id === goallessId);
  assert.equal(bootGoalless.goal, null);
  assert.deepEqual(bootGoalless.success_criteria, []);
  assert.equal(bootGoalless.goal_status, "open");
});

test("PATCH /v1/rooms/:roomId: 404 for a missing room, 403 for anyone but the creator", async () => {
  await freshOwner();
  const created = await createRoom(ownerToken, "patch-authz");
  const roomId = created.json().data.room_id;

  const missing = await patchRoom("rom_does_not_exist", ownerToken, { goal: "New goal" });
  assert.equal(missing.statusCode, 404, missing.body);

  await freshOwner();
  const otherOwnerToken = ownerToken;
  const forbidden = await patchRoom(roomId, otherOwnerToken, { goal: "Hijacked goal" });
  assert.equal(forbidden.statusCode, 403, forbidden.body);

  const agent = await enrollAgent("bystander-authz");
  const forbiddenAgent = await patchRoom(roomId, agent.token, { goal: "Hijacked by agent" });
  assert.equal(forbiddenAgent.statusCode, 403, forbiddenAgent.body);

  // An invalid goal_status is rejected by the request schema before authorization even matters.
  const badStatus = await patchRoom(roomId, otherOwnerToken, { goal_status: "bogus" });
  assert.equal(badStatus.statusCode, 400, badStatus.body);
});

test("PATCH by the creator updates goal/success_criteria; a status-less patch fires no event", async () => {
  await freshOwner();
  const member = await enrollAgent("member-no-event");
  const created = await createRoom(ownerToken, "patch-no-event", { goal: "Initial goal" });
  const roomId = created.json().data.room_id;
  assert.equal((await post(roomId, member.token, { body: "joining by posting" })).statusCode, 201);

  const before = (await inboxEvents(member.token, "room.goal_changed")).length;
  const patched = await patchRoom(roomId, ownerToken, { goal: "Refined goal", success_criteria: ["criterion one"] });
  assert.equal(patched.statusCode, 200, patched.body);
  assert.equal(patched.json().data.goal, "Refined goal");
  assert.deepEqual(patched.json().data.success_criteria, ["criterion one"]);
  assert.equal(patched.json().data.goal_status, "open");
  assert.equal((await inboxEvents(member.token, "room.goal_changed")).length, before, "changing goal/criteria without goal_status must not fire room.goal_changed");
});

test("room.goal_changed reaches room members except whoever changed it, is not re-fired by a repeat, and keeps bootstrap/overview counts in agreement", async () => {
  await freshOwner();
  // Room created by an agent's own session (creator_type='agent'), so the creator can itself be
  // a room member — the case that actually exercises the "except whoever changed it" exclusion.
  const creator = await enrollAgent("creator-goal-event");
  const created = await createRoom(creator.token, "goal-event-room", { goal: "Land W3", success_criteria: ["merged"] });
  const roomId = created.json().data.room_id;

  const member = await enrollAgent("member-goal-event");
  assert.equal((await post(roomId, creator.token, { body: "creator posts, auto-joins" })).statusCode, 201);
  assert.equal((await joinRoom(roomId, member.token)).statusCode, 200);

  const creatorBefore = (await inboxEvents(creator.token, "room.goal_changed")).length;
  const changed = await patchRoom(roomId, creator.token, { goal_status: "reached" });
  assert.equal(changed.statusCode, 200, changed.body);
  assert.equal(changed.json().data.goal_status, "reached");

  const creatorEvents = (await inboxEvents(creator.token, "room.goal_changed")).filter(e => e.resource.id === roomId);
  assert.equal(creatorEvents.length, creatorBefore, "the agent who changed the status must not be notified of its own change");

  const memberEvents = (await inboxEvents(member.token, "room.goal_changed")).filter(e => e.resource.id === roomId);
  assert.equal(memberEvents.length, 1, "the other member gets exactly one event");
  assert.deepEqual(memberEvents[0].data, {
    room_id: roomId,
    title: "goal-event-room",
    goal: "Land W3",
    goal_status: "reached",
    previous_goal_status: "open",
    changed_by: { actor_type: "agent", actor_id: creator.agentId }
  });

  // Re-issuing the same target status is naturally idempotent: no second event.
  const repeat = await patchRoom(roomId, creator.token, { goal_status: "reached" });
  assert.equal(repeat.statusCode, 200, repeat.body);
  assert.equal(
    (await inboxEvents(member.token, "room.goal_changed")).filter(e => e.resource.id === roomId).length,
    1,
    "repeating the same goal_status must not re-notify"
  );

  // The creating agent's own owner is also authorized (same "room owner" authority as elsewhere
  // in this file) and can change the goal without touching status.
  const byOwner = await patchRoom(roomId, ownerToken, { goal: "Land W3, fully" });
  assert.equal(byOwner.statusCode, 200, byOwner.body);

  // bootstrap and inbox/overview must never disagree on the rooms bucket.
  const boot = await bootstrap(member.token);
  assert.equal(boot.statusCode, 200, boot.body);
  assert.equal(boot.json().data.pending_counts.rooms, 1, "one unread room.goal_changed event pending for the member");

  const over = await overview(member.token);
  assert.equal(over.statusCode, 200, over.body);
  assert.deepEqual(over.json().data.pending_counts, boot.json().data.pending_counts);
});
