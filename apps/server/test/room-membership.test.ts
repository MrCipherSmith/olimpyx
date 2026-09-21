import assert from "node:assert/strict";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { createApp, migrate } from "../src/app.js";

// W1 (issue #36): a room message without an explicit recipient must fan out to every
// current room member except the sender, via the new room_members table. Addressed
// messages and thread-root notifications must keep behaving exactly as before, and
// membership itself must be joinable/leavable explicitly, and auto-joined on first post.

const baseUrl = process.env.DATABASE_URL ?? "postgres://olimpyx:olimpyx-local-only@127.0.0.1:55432/olimpyx";
const schema = `test_room_members_${randomUUID().replaceAll("-", "")}`;
const admin = new Pool({ connectionString: baseUrl });
const testUrl = new URL(baseUrl);
testUrl.searchParams.set("options", `-c search_path=${schema},public`);
const databaseUrl = testUrl.toString();

let app: Awaited<ReturnType<typeof createApp>>;
let ownerToken = "";
let seq = 0;

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const mutate = (token: string, key: string) => ({ ...auth(token), "idempotency-key": key });

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

async function createRoom(title: string) {
  const roomRes = await app.inject({
    method: "POST",
    url: "/v1/rooms",
    headers: mutate(ownerToken, `room-${title}-${++seq}`),
    payload: { title }
  });
  return roomRes.json().data.room_id as string;
}

async function post(roomId: string, token: string, key: string, payload: Record<string, unknown>) {
  return app.inject({ method: "POST", url: `/v1/rooms/${roomId}/messages`, headers: mutate(token, key), payload });
}

async function join(roomId: string, token: string, key: string) {
  return app.inject({ method: "POST", url: `/v1/rooms/${roomId}/members`, headers: mutate(token, key), payload: {} });
}

async function leave(roomId: string, token: string, key: string) {
  return app.inject({ method: "DELETE", url: `/v1/rooms/${roomId}/members/me`, headers: mutate(token, key) });
}

async function inboxEventIdsFor(token: string) {
  const r = await app.inject({ method: "GET", url: "/v1/inbox/events", headers: auth(token) });
  return (r.json().data as Array<{ resource: { id: string } }>).map(e => e.resource.id);
}

async function members(roomId: string) {
  // Queried through app.pg, not the plain `admin` pool: app.pg's connection has the test
  // schema on its search_path (set via `databaseUrl`), `admin` does not.
  const r = await app.pg.query("SELECT agent_id FROM room_members WHERE room_id=$1 ORDER BY agent_id", [roomId]);
  return r.rows.map((x: any) => x.agent_id as string);
}

/** A fresh owner per test keeps agent enrollment well under the 10-active-agents-per-owner quota. */
async function freshOwner() {
  const reg = await app.inject({
    method: "POST",
    url: "/v1/owners/register",
    headers: { "idempotency-key": `reg-owner-${++seq}` },
    payload: { email: `owner_${randomUUID()}@example.test`, password: "very secure password", display_name: "Owner" }
  });
  ownerToken = reg.json().data.access_token;
}

before(async () => {
  await admin.query("CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public");
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(databaseUrl);
  app = await createApp({ databaseUrl });
});

after(async () => {
  if (app) await app.close();
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.end();
});

test("schema migration: room_members table exists with the expected shape", async () => {
  const cols = await admin.query(
    "SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='room_members' ORDER BY column_name",
    [schema]
  );
  assert.deepEqual(cols.rows.map((r: any) => r.column_name).sort(), ["agent_id", "joined_at", "room_id"]);
  const pk = await admin.query(
    `SELECT a.attname FROM pg_index i
     JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=ANY(i.indkey)
     WHERE i.indrelid=$1::regclass AND i.indisprimary`,
    [`${schema}.room_members`]
  );
  assert.deepEqual(pk.rows.map((r: any) => r.attname).sort(), ["agent_id", "room_id"]);
});

test("auto-join: posting a message makes the sender a room member, idempotently", async () => {
  await freshOwner();
  const roomId = await createRoom("auto-join");
  const alice = await enrollAgent("alice-auto");
  assert.deepEqual(await members(roomId), []);

  const first = await post(roomId, alice.token, "auto-1", { body: "hello room" });
  assert.equal(first.statusCode, 201);
  assert.deepEqual(await members(roomId), [alice.agentId]);

  // A second message from the same agent must not error or duplicate the membership row (ON CONFLICT DO NOTHING).
  const second = await post(roomId, alice.token, "auto-2", { body: "hello again" });
  assert.equal(second.statusCode, 201);
  assert.deepEqual(await members(roomId), [alice.agentId]);
});

test("fan-out: a message with no recipient notifies every other current member, not the sender", async () => {
  await freshOwner();
  const roomId = await createRoom("fan-out");
  const alice = await enrollAgent("alice-fanout");
  const bob = await enrollAgent("bob-fanout");
  const carol = await enrollAgent("carol-fanout");

  await post(roomId, alice.token, "fanout-alice-1", { body: "alice starts the room" });

  const bobMsg = await post(roomId, bob.token, "fanout-bob-1", { body: "bob joins in" });
  const bobMsgId = bobMsg.json().data.message_id;
  // At the time bob posts, alice is the only other member: alice gets it, bob does not.
  assert.ok((await inboxEventIdsFor(alice.token)).includes(bobMsgId));
  assert.ok(!(await inboxEventIdsFor(bob.token)).includes(bobMsgId));

  const carolMsg = await post(roomId, carol.token, "fanout-carol-1", { body: "carol joins in" });
  const carolMsgId = carolMsg.json().data.message_id;
  // Now alice and bob are both members: both get carol's message, carol does not.
  assert.ok((await inboxEventIdsFor(alice.token)).includes(carolMsgId), "alice should receive carol's fan-out event");
  assert.ok((await inboxEventIdsFor(bob.token)).includes(carolMsgId), "bob should receive carol's fan-out event");
  assert.ok(!(await inboxEventIdsFor(carol.token)).includes(carolMsgId), "carol (the sender) must not receive her own fan-out event");
});

test("left member gets nothing: fan-out excludes an agent who explicitly left the room", async () => {
  await freshOwner();
  const roomId = await createRoom("left-member");
  const dana = await enrollAgent("dana-leave");
  const erin = await enrollAgent("erin-leave");

  await post(roomId, dana.token, "leave-dana-1", { body: "dana says hi" });
  assert.ok((await members(roomId)).includes(dana.agentId));

  const leftRes = await leave(roomId, dana.token, "dana-leave-1");
  assert.equal(leftRes.statusCode, 200);
  assert.equal(leftRes.json().data.left, true);
  assert.ok(!(await members(roomId)).includes(dana.agentId), "dana must no longer be a member after leaving");

  const erinMsg = await post(roomId, erin.token, "leave-erin-1", { body: "erin posts after dana left" });
  const erinMsgId = erinMsg.json().data.message_id;

  assert.ok(!(await inboxEventIdsFor(dana.token)).includes(erinMsgId), "dana left the room and must not receive erin's fan-out event");
});

test("explicit join: an agent can join without posting and then receives fan-out", async () => {
  await freshOwner();
  const roomId = await createRoom("explicit-join");
  const finn = await enrollAgent("finn-join");
  const grace = await enrollAgent("grace-join");

  assert.ok(!(await members(roomId)).includes(finn.agentId));
  const joinRes = await join(roomId, finn.token, "finn-join-1");
  assert.equal(joinRes.statusCode, 200);
  assert.equal(joinRes.json().data.agent_id, finn.agentId);
  assert.ok(joinRes.json().data.joined_at);
  assert.ok((await members(roomId)).includes(finn.agentId));

  // Joining twice is idempotent and does not error or duplicate the row.
  const rejoinRes = await join(roomId, finn.token, "finn-join-2");
  assert.equal(rejoinRes.statusCode, 200);
  assert.deepEqual(await members(roomId), [finn.agentId]);

  const graceMsg = await post(roomId, grace.token, "finn-join-grace-1", { body: "grace says hi to the room" });
  const graceMsgId = graceMsg.json().data.message_id;

  assert.ok((await inboxEventIdsFor(finn.token)).includes(graceMsgId), "finn joined explicitly and must receive the room fan-out even though he never posted");
});

test("only agents can join or leave a room, not owners", async () => {
  await freshOwner();
  const roomId = await createRoom("owner-forbidden");
  // Owner tokens are outside the ["session","agent"] credential class principal() accepts for
  // these routes, so they're rejected as "forbidden" before the handler's own agent_only check runs.
  const joinAsOwner = await join(roomId, ownerToken, "owner-join-1");
  assert.equal(joinAsOwner.statusCode, 403);
  assert.equal(joinAsOwner.json().error.code, "forbidden");

  const leaveAsOwner = await leave(roomId, ownerToken, "owner-leave-1");
  assert.equal(leaveAsOwner.statusCode, 403);
  assert.equal(leaveAsOwner.json().error.code, "forbidden");
});

test("addressed message: still notifies only the addressee, even when the addressee is already a member (no duplicate)", async () => {
  await freshOwner();
  const roomId = await createRoom("addressed");
  const holly = await enrollAgent("holly-addr");
  const ian = await enrollAgent("ian-addr");

  // Both post once first so both are current members of the room.
  await post(roomId, holly.token, "addr-holly-1", { body: "holly says hi" });
  await post(roomId, ian.token, "addr-ian-1", { body: "ian says hi" });
  assert.ok((await members(roomId)).includes(holly.agentId) && (await members(roomId)).includes(ian.agentId));

  const addressed = await post(roomId, ian.token, "addr-ian-2", { body: "hey holly, direct message", recipient_agent_id: holly.agentId });
  assert.equal(addressed.statusCode, 201);
  const addressedId = addressed.json().data.message_id;

  const hollyEvents = await inboxEventIdsFor(holly.token);
  const matchesForHolly = hollyEvents.filter(id => id === addressedId);
  assert.equal(matchesForHolly.length, 1, "the addressee must receive exactly one event for the addressed message, not two");

  // ian (a member, but not the addressee) must NOT receive an event for the addressed message,
  // confirming addressed messages do not also fan out to the rest of the room.
  const row = await app.pg.query("SELECT 1 FROM inbox_events WHERE agent_id=$1 AND resource_id=$2", [ian.agentId, addressedId]);
  assert.equal(row.rowCount, 0, "ian is a member but not the addressee and must not receive the addressed message");
});

test("thread reply still notifies the root author (who is a member from posting the root)", async () => {
  await freshOwner();
  const roomId = await createRoom("thread-root");
  const jill = await enrollAgent("jill-thread");
  const kim = await enrollAgent("kim-thread");

  const root = await post(roomId, jill.token, "thread-jill-root", { body: "RFC: something worth discussing" });
  const rootId = root.json().data.message_id;

  const reply = await post(roomId, kim.token, "thread-kim-reply", { body: "+1 from kim", reply_to_message_id: rootId });
  const replyId = reply.json().data.message_id;

  assert.ok((await inboxEventIdsFor(jill.token)).includes(replyId), "jill (root author) should receive an inbox event for kim's reply");
});
