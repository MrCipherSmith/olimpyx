import assert from "node:assert/strict";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { createApp, migrate } from "../src/app.js";
import { ensureVectorExtension } from "./pg-extension.js";

// W4 (issue #36): bootstrapFor used to return ten room titles/descriptions and nothing else worth
// acting on ("an agent sees ten signs and, typically, zero unread"). This adds, per room in
// active_rooms, the goal fields, participant count, own-membership flag, last message time and a
// room-scoped unread count; and two new bootstrap lists, my_tasks (this agent's open assignments)
// and open_help (open forum root threads matching this agent's tag subscriptions, minus its own).
// Deliberately reuses the GET /v1/forum/threads selection predicate for open_help instead of a
// second, divergent way of picking "an open root thread with a category".

const baseUrl = process.env.DATABASE_URL ?? "postgres://olimpyx:olimpyx-local-only@127.0.0.1:55432/olimpyx";
const schema = `test_bootstrap_ctx_${randomUUID().replaceAll("-", "")}`;
const admin = new Pool({ connectionString: baseUrl });
const testUrl = new URL(baseUrl);
testUrl.searchParams.set("options", `-c search_path=${schema},public`);
const databaseUrl = testUrl.toString();

let app: Awaited<ReturnType<typeof createApp>>;
let ownerToken = "";
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

async function post(roomId: string, token: string, payload: Record<string, unknown>) {
  return app.inject({ method: "POST", url: `/v1/rooms/${roomId}/messages`, headers: mutate(token, nextKey("msg")), payload });
}

async function joinRoom(roomId: string, token: string) {
  return app.inject({ method: "POST", url: `/v1/rooms/${roomId}/members`, headers: mutate(token, nextKey("join")), payload: {} });
}

async function bootstrap(token: string) {
  return app.inject({ method: "GET", url: "/v1/bootstrap", headers: auth(token) });
}

async function subscribe(token: string, tags: string[]) {
  return app.inject({ method: "PUT", url: "/v1/agents/me/subscriptions", headers: auth(token), payload: { tags } });
}

async function createTask(roomId: string, token: string, assignedAgentId: string, title: string) {
  return app.inject({
    method: "POST",
    url: `/v1/rooms/${roomId}/tasks`,
    headers: mutate(token, nextKey("task")),
    payload: { assigned_agent_id: assignedAgentId, title, description: "details" }
  });
}

async function patchTask(taskId: string, token: string, payload: Record<string, unknown>) {
  return app.inject({ method: "PATCH", url: `/v1/tasks/${taskId}`, headers: mutate(token, nextKey("task-patch")), payload });
}

async function patchThreadStatus(roomId: string, messageId: string, token: string, status: string) {
  return app.inject({ method: "PATCH", url: `/v1/rooms/${roomId}/messages/${messageId}/status`, headers: auth(token), payload: { status } });
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

test("active_rooms: member_count, is_member and last_message_at reflect actual membership and posting", async () => {
  await freshOwner();
  const a = await enrollAgent("member-a");
  const b = await enrollAgent("member-b");

  const room = await createRoom(ownerToken, "membership-room");
  const roomId = room.json().data.room_id;

  // Nobody has posted yet: no members, no last message.
  const beforeAnyone = await bootstrap(a.token);
  assert.equal(beforeAnyone.statusCode, 200, beforeAnyone.body);
  let row = beforeAnyone.json().data.active_rooms.find((r: any) => r.room_id === roomId);
  assert.equal(row.member_count, 0);
  assert.equal(row.is_member, false);
  assert.equal(row.last_message_at, null);

  // A posts: auto-joins, becomes a member, room now has a last message.
  const posted = await post(roomId, a.token, { body: "hello room" });
  assert.equal(posted.statusCode, 201, posted.body);

  const afterAPosts = await bootstrap(a.token);
  row = afterAPosts.json().data.active_rooms.find((r: any) => r.room_id === roomId);
  assert.equal(row.member_count, 1);
  assert.equal(row.is_member, true);
  assert.ok(row.last_message_at, "last_message_at must be set once a message exists");

  // B never joined: sees the same member_count, but is_member is false for B.
  const bView = await bootstrap(b.token);
  row = bView.json().data.active_rooms.find((r: any) => r.room_id === roomId);
  assert.equal(row.member_count, 1);
  assert.equal(row.is_member, false);

  // B explicitly joins: member_count goes to 2, is_member becomes true for B.
  assert.equal((await joinRoom(roomId, b.token)).statusCode, 200);
  const bAfterJoin = await bootstrap(b.token);
  row = bAfterJoin.json().data.active_rooms.find((r: any) => r.room_id === roomId);
  assert.equal(row.member_count, 2);
  assert.equal(row.is_member, true);
});

test("active_rooms: goal fields survive alongside the new aggregates", async () => {
  await freshOwner();
  const agent = await enrollAgent("goal-fields");
  const room = await createRoom(ownerToken, "goal-room", { goal: "Decide the schema", success_criteria: ["ADR merged"] });
  const roomId = room.json().data.room_id;

  const boot = await bootstrap(agent.token);
  const row = boot.json().data.active_rooms.find((r: any) => r.room_id === roomId);
  assert.equal(row.goal, "Decide the schema");
  assert.deepEqual(row.success_criteria, ["ADR merged"]);
  assert.equal(row.goal_status, "open");
});

test("active_rooms: unread_count is scoped per room, not the global pending_counts.messages total", async () => {
  await freshOwner();
  const watcher = await enrollAgent("unread-watcher");
  const poster = await enrollAgent("unread-poster");

  const roomWithTraffic = await createRoom(ownerToken, "unread-busy-room");
  const busyId = roomWithTraffic.json().data.room_id;
  const roomQuiet = await createRoom(ownerToken, "unread-quiet-room");
  const quietId = roomQuiet.json().data.room_id;

  assert.equal((await joinRoom(busyId, watcher.token)).statusCode, 200);
  assert.equal((await joinRoom(quietId, watcher.token)).statusCode, 200);

  // Two messages land in the busy room from someone else; the watcher never posts there itself.
  assert.equal((await post(busyId, poster.token, { body: "first" })).statusCode, 201);
  assert.equal((await post(busyId, poster.token, { body: "second" })).statusCode, 201);

  const boot = await bootstrap(watcher.token);
  assert.equal(boot.statusCode, 200, boot.body);
  const busyRow = boot.json().data.active_rooms.find((r: any) => r.room_id === busyId);
  const quietRow = boot.json().data.active_rooms.find((r: any) => r.room_id === quietId);
  assert.equal(busyRow.unread_count, 2, "both messages from the other agent are unread for the watcher");
  assert.equal(quietRow.unread_count, 0, "the quiet room has no unread events");
  assert.equal(boot.json().data.pending_counts.messages, 2, "global count still agrees with the per-room total here");
});

test("my_tasks: lists this agent's non-terminal assignments and drops them once completed", async () => {
  await freshOwner();
  const assignee = await enrollAgent("task-assignee");
  const otherAgent = await enrollAgent("task-bystander");
  const room = await createRoom(ownerToken, "task-room");
  const roomId = room.json().data.room_id;

  const created = await createTask(roomId, ownerToken, assignee.agentId, "Write the migration");
  assert.equal(created.statusCode, 201, created.body);
  const taskId = created.json().data.task_id;

  // A task assigned to someone else must not show up for this agent.
  const otherTask = await createTask(roomId, ownerToken, otherAgent.agentId, "Not yours");
  assert.equal(otherTask.statusCode, 201, otherTask.body);

  const boot = await bootstrap(assignee.token);
  assert.equal(boot.statusCode, 200, boot.body);
  const myTasks = boot.json().data.my_tasks;
  const mine = myTasks.find((t: any) => t.task_id === taskId);
  assert.ok(mine, "the assigned task must appear in my_tasks");
  assert.equal(mine.room_id, roomId);
  assert.equal(mine.title, "Write the migration");
  assert.equal(mine.status, "proposed");
  assert.equal(mine.assigned_by.actor_type, "owner");
  assert.ok(!myTasks.some((t: any) => t.task_id === otherTask.json().data.task_id), "another agent's task must not appear");

  // Accept, then complete: once terminal, the task must drop out of my_tasks.
  assert.equal((await patchTask(taskId, assignee.token, { status: "accepted" })).statusCode, 200);
  const stillOpen = await bootstrap(assignee.token);
  assert.ok(stillOpen.json().data.my_tasks.some((t: any) => t.task_id === taskId), "an accepted (non-terminal) task still shows");

  assert.equal((await patchTask(taskId, assignee.token, { status: "completed", result: "done" })).statusCode, 200);
  const afterComplete = await bootstrap(assignee.token);
  assert.ok(!afterComplete.json().data.my_tasks.some((t: any) => t.task_id === taskId), "a completed task must not appear in my_tasks");
});

test("open_help: open root threads matching this agent's subscribed tags, excluding its own threads and non-matching tags/status", async () => {
  await freshOwner();
  const seeker = await enrollAgent("help-seeker");
  const helper = await enrollAgent("help-author");
  const room = await createRoom(ownerToken, "help-room");
  const roomId = room.json().data.room_id;

  assert.equal((await subscribe(seeker.token, ["postgres"])).statusCode, 200);

  // Matches: open root question tagged postgres, authored by someone else.
  const matching = await post(roomId, helper.token, { body: "How do I tune autovacuum?", category: "question", tags: ["postgres"] });
  assert.equal(matching.statusCode, 201, matching.body);
  const matchingId = matching.json().data.message_id;

  // Does not match: tag the seeker never subscribed to.
  const otherTag = await post(roomId, helper.token, { body: "Anyone into networking?", category: "question", tags: ["networking"] });
  assert.equal(otherTag.statusCode, 201, otherTag.body);

  // Does not match: the seeker's own thread, even though the tag matches.
  const ownThread = await post(roomId, seeker.token, { body: "My own postgres question", category: "question", tags: ["postgres"] });
  assert.equal(ownThread.statusCode, 201, ownThread.body);

  const boot = await bootstrap(seeker.token);
  assert.equal(boot.statusCode, 200, boot.body);
  const helpIds = boot.json().data.open_help.map((t: any) => t.thread_id);
  assert.ok(helpIds.includes(matchingId), "a matching open thread from someone else must appear");
  assert.ok(!helpIds.includes(otherTag.json().data.message_id), "a thread without a subscribed tag must not appear");
  assert.ok(!helpIds.includes(ownThread.json().data.message_id), "the agent's own thread must not appear even if tagged the same way");

  const found = boot.json().data.open_help.find((t: any) => t.thread_id === matchingId);
  assert.equal(found.room_id, roomId);
  assert.equal(found.category, "question");
  assert.deepEqual(found.tags, ["postgres"]);
  assert.equal(found.author.id, helper.agentId);

  // Resolve the matching thread: it must fall out of open_help (status is no longer "open").
  assert.equal((await patchThreadStatus(roomId, matchingId, helper.token, "resolved")).statusCode, 200);
  const afterResolve = await bootstrap(seeker.token);
  assert.ok(
    !afterResolve.json().data.open_help.some((t: any) => t.thread_id === matchingId),
    "a resolved thread must not appear in open_help"
  );
});
