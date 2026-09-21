import assert from "node:assert/strict";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { createApp, migrate } from "../src/app.js";

// W2 (issue #36): the inbox previously produced exactly three event types (agent.revoked,
// message.created, moderation.updated), two of them administrative. An agent that checked its
// inbox after being assigned a task, having its knowledge card reviewed or published, or being
// relevant to a forum question saw nothing worth acting on. This file covers the five new event
// types added to close that gap: task.assigned, task.updated, forum.question, knowledge.reviewed,
// knowledge.published — including that none of them duplicate events for a single recipient.

const baseUrl = process.env.DATABASE_URL ?? "postgres://olimpyx:olimpyx-local-only@127.0.0.1:55432/olimpyx";
const schema = `test_initiative_events_${randomUUID().replaceAll("-", "")}`;
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

async function createRoom(title: string) {
  const roomRes = await app.inject({
    method: "POST",
    url: "/v1/rooms",
    headers: mutate(ownerToken, `room-${title}-${++seq}`),
    payload: { title }
  });
  return roomRes.json().data.room_id as string;
}

async function post(roomId: string, token: string, payload: Record<string, unknown>) {
  return app.inject({ method: "POST", url: `/v1/rooms/${roomId}/messages`, headers: mutate(token, nextKey("msg")), payload });
}

async function createTask(roomId: string, token: string, payload: Record<string, unknown>) {
  return app.inject({ method: "POST", url: `/v1/rooms/${roomId}/tasks`, headers: mutate(token, nextKey("task")), payload });
}

async function patchTask(taskId: string, assigneeToken: string, payload: Record<string, unknown>) {
  return app.inject({ method: "PATCH", url: `/v1/tasks/${taskId}`, headers: mutate(assigneeToken, nextKey("patch")), payload });
}

async function subscribe(token: string, tags: string[]) {
  const r = await app.inject({ method: "PUT", url: "/v1/agents/me/subscriptions", headers: auth(token), payload: { tags } });
  assert.equal(r.statusCode, 200, r.body);
  return r;
}

async function createCard(token: string, payload: Record<string, unknown>) {
  const r = await app.inject({ method: "POST", url: "/v1/knowledge/cards", headers: mutate(token, nextKey("card")), payload });
  assert.equal(r.statusCode, 201, r.body);
  return r.json().data as { card_id: string; latest_version_id: string };
}

async function reviewVersion(token: string, versionId: string, payload: Record<string, unknown>) {
  return app.inject({ method: "POST", url: `/v1/knowledge/versions/${versionId}/reviews`, headers: mutate(token, nextKey("review")), payload });
}

async function publishCard(publicVal: boolean, cardId: string) {
  return app.inject({ method: "PATCH", url: `/v1/knowledge/cards/${cardId}/public`, headers: auth(ownerToken), payload: { public: publicVal } });
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

test("task.assigned: reaches a different assignee with a self-sufficient payload, never a self-assigning creator", async () => {
  await freshOwner();
  const roomId = await createRoom("task-assigned");
  const assignee = await enrollAgent("assignee-ta");

  const created = await createTask(roomId, ownerToken, { assigned_agent_id: assignee.agentId, title: "Investigate drift", description: "Look into it" });
  assert.equal(created.statusCode, 201, created.body);
  const taskId = created.json().data.task_id;

  const events = await inboxEvents(assignee.token, "task.assigned");
  const forThisTask = events.filter(e => e.resource.id === taskId);
  assert.equal(forThisTask.length, 1, "assignee must get exactly one task.assigned event");
  assert.deepEqual(forThisTask[0].data, {
    task_id: taskId,
    room_id: roomId,
    title: "Investigate drift",
    status: "proposed",
    assigned_by: { actor_type: "owner", actor_id: ownerId }
  });

  // An agent that assigns a task to itself is not notified of its own action.
  const selfAssignee = await enrollAgent("self-ta");
  const before = (await inboxEvents(selfAssignee.token, "task.assigned")).length;
  const selfTask = await createTask(roomId, selfAssignee.token, { assigned_agent_id: selfAssignee.agentId, title: "Self task", description: "d" });
  assert.equal(selfTask.statusCode, 201, selfTask.body);
  assert.equal((await inboxEvents(selfAssignee.token, "task.assigned")).length, before, "no self-notification when creator is the assignee");
});

test("task.updated: reaches the creator only when status actually moves, never the assignee itself", async () => {
  await freshOwner();
  const roomId = await createRoom("task-updated");
  const assignee = await enrollAgent("assignee-tu");

  const created = await createTask(roomId, ownerToken, { assigned_agent_id: assignee.agentId, title: "Ship it", description: "d" });
  const taskId = created.json().data.task_id;

  const accepted = await patchTask(taskId, assignee.token, { status: "accepted" });
  assert.equal(accepted.statusCode, 200, accepted.body);
  let updates = (await inboxEvents(ownerToken, "task.updated")).filter(e => e.resource.id === taskId);
  assert.equal(updates.length, 1, "creator gets one task.updated for the accept transition");
  assert.deepEqual(updates[0].data, {
    task_id: taskId,
    title: "Ship it",
    status: "accepted",
    previous_status: "proposed",
    updated_by: { actor_type: "agent", actor_id: assignee.agentId }
  });

  // Re-patching with the same status is not a status change and must not fire another event.
  const noop = await patchTask(taskId, assignee.token, { status: "accepted" });
  assert.equal(noop.statusCode, 200, noop.body);
  updates = (await inboxEvents(ownerToken, "task.updated")).filter(e => e.resource.id === taskId);
  assert.equal(updates.length, 1, "no duplicate event when status is patched to its current value");

  const started = await patchTask(taskId, assignee.token, { status: "in_progress" });
  assert.equal(started.statusCode, 200, started.body);
  updates = (await inboxEvents(ownerToken, "task.updated")).filter(e => e.resource.id === taskId);
  assert.equal(updates.length, 2, "a genuine second transition fires a second event");
  assert.equal(updates[1].data.previous_status, "accepted");
  assert.equal(updates[1].data.status, "in_progress");

  // An agent that both created and is assigned the task never gets notified of its own update.
  const selfAgent = await enrollAgent("self-tu");
  const selfTask = (await createTask(roomId, selfAgent.token, { assigned_agent_id: selfAgent.agentId, title: "Solo", description: "d" })).json().data.task_id;
  const beforeSelf = (await inboxEvents(selfAgent.token, "task.updated")).length;
  await patchTask(selfTask, selfAgent.token, { status: "accepted" });
  assert.equal((await inboxEvents(selfAgent.token, "task.updated")).length, beforeSelf, "no self-notification when creator is the assignee");
});

test("forum.question: reaches tag subscribers exactly once each, even across several matching tags, never the author", async () => {
  await freshOwner();
  const roomId = await createRoom("forum-question");
  const author = await enrollAgent("author-fq");
  const subscriber = await subscribeToTags("subscriber-fq", ["alpha", "beta"]);
  const bystander = await enrollAgent("bystander-fq");

  const asked = await post(roomId, author.token, { body: "How should we approach this?", category: "question", tags: ["alpha", "beta", "gamma"] });
  assert.equal(asked.statusCode, 201, asked.body);
  const messageId = asked.json().data.message_id;

  const subscriberEvents = (await inboxEvents(subscriber.token, "forum.question")).filter(e => e.resource.id === messageId);
  assert.equal(subscriberEvents.length, 1, "subscribed to two of three tags must still yield exactly one event, not two");
  assert.deepEqual(subscriberEvents[0].data, {
    message_id: messageId,
    room_id: roomId,
    category: "question",
    tags: ["alpha", "beta", "gamma"],
    topic: "How should we approach this?",
    author: { actor_type: "agent", actor_id: author.agentId, display_name: "author-fq" }
  });

  assert.equal((await inboxEvents(bystander.token, "forum.question")).filter(e => e.resource.id === messageId).length, 0, "a non-subscriber must not receive the event");
  assert.equal((await inboxEvents(author.token, "forum.question")).filter(e => e.resource.id === messageId).length, 0, "the author must never receive their own forum.question event");

  // A tagged, non-forum message (no category — not a thread root) must not fire forum.question.
  const plain = await post(roomId, author.token, { body: "just a tagged note", tags: ["alpha"] });
  assert.equal(plain.statusCode, 201, plain.body);
  assert.equal((await inboxEvents(subscriber.token, "forum.question")).filter(e => e.resource.id === plain.json().data.message_id).length, 0, "a message without a category is not a forum thread root");
});

async function subscribeToTags(name: string, tags: string[]) {
  const a = await enrollAgent(name);
  await subscribe(a.token, tags);
  return a;
}

test("knowledge.reviewed: reaches the card's author on someone else's verdict, never on a self-review", async () => {
  await freshOwner();
  const author = await enrollAgent("author-kr");
  const reviewer = await enrollAgent("reviewer-kr");

  const card = await createCard(author.token, { topic: "Caching strategy", summary: "Notes", body: "Body text" });

  const review = await reviewVersion(reviewer.token, card.latest_version_id, { verdict: "confirm", explanation: "checks out", evidence: [] });
  assert.equal(review.statusCode, 201, review.body);

  const authorEvents = (await inboxEvents(author.token, "knowledge.reviewed")).filter(e => e.resource.id === card.latest_version_id);
  assert.equal(authorEvents.length, 1, "author must get exactly one knowledge.reviewed event");
  assert.deepEqual(authorEvents[0].data, {
    version_id: card.latest_version_id,
    card_id: card.card_id,
    topic: "Caching strategy",
    verdict: "confirm",
    reviewer_agent_id: reviewer.agentId
  });

  // The author reviewing their own version must not notify themselves.
  const before = (await inboxEvents(author.token, "knowledge.reviewed")).length;
  const selfReview = await reviewVersion(author.token, card.latest_version_id, { verdict: "confirm", explanation: "self check", evidence: [] });
  assert.equal(selfReview.statusCode, 201, selfReview.body);
  assert.equal((await inboxEvents(author.token, "knowledge.reviewed")).length, before, "no self-notification on a self-review");
});

test("knowledge.published: reaches the author and every reviewer exactly once, only on the false->true transition", async () => {
  await freshOwner();
  const author = await enrollAgent("author-kp");
  const reviewerA = await enrollAgent("reviewer-a-kp");
  const reviewerB = await enrollAgent("reviewer-b-kp");

  const card = await createCard(author.token, { topic: "Retry policy", summary: "Notes", body: "Body text" });
  await reviewVersion(reviewerA.token, card.latest_version_id, { verdict: "confirm", explanation: "ok", evidence: [] });
  await reviewVersion(reviewerB.token, card.latest_version_id, { verdict: "refute", explanation: "disagree", evidence: [] });

  const published = await publishCard(true, card.card_id);
  assert.equal(published.statusCode, 200, published.body);
  assert.equal(published.json().data.public, true);

  for (const recipient of [author, reviewerA, reviewerB]) {
    const events = (await inboxEvents(recipient.token, "knowledge.published")).filter(e => e.resource.id === card.card_id);
    assert.equal(events.length, 1, `${recipient.agentId} must get exactly one knowledge.published event`);
    assert.deepEqual(events[0].data, { card_id: card.card_id, topic: "Retry policy", published_by: { actor_type: "owner", actor_id: ownerId } });
  }

  // Re-publishing an already-public card must not re-notify anyone.
  const republished = await publishCard(true, card.card_id);
  assert.equal(republished.statusCode, 200, republished.body);
  assert.equal((await inboxEvents(author.token, "knowledge.published")).filter(e => e.resource.id === card.card_id).length, 1);

  // Unpublishing must not fire the event either.
  const unpublished = await publishCard(false, card.card_id);
  assert.equal(unpublished.statusCode, 200, unpublished.body);
  assert.equal((await inboxEvents(author.token, "knowledge.published")).filter(e => e.resource.id === card.card_id).length, 1);
});

test("bootstrap pending_counts reflect the new event types, not just messages and moderation", async () => {
  await freshOwner();
  const roomId = await createRoom("bootstrap-counts");
  const central = await enrollAgent("central-bc");
  const other = await enrollAgent("other-bc");

  await createTask(roomId, ownerToken, { assigned_agent_id: central.agentId, title: "Do the thing", description: "d" });

  await subscribe(central.token, ["zeta"]);
  await post(roomId, other.token, { body: "zeta question", category: "question", tags: ["zeta"] });

  const card = await createCard(central.token, { topic: "Bootstrap topic", summary: "s", body: "b" });
  await reviewVersion(other.token, card.latest_version_id, { verdict: "confirm", explanation: "ok", evidence: [] });
  await publishCard(true, card.card_id);

  const bootstrap = await app.inject({ method: "GET", url: "/v1/bootstrap", headers: auth(central.token) });
  assert.equal(bootstrap.statusCode, 200, bootstrap.body);
  const counts = bootstrap.json().data.pending_counts;
  assert.equal(counts.tasks, 1, "one task.assigned event pending");
  assert.equal(counts.forum, 1, "one forum.question event pending");
  assert.equal(counts.knowledge, 2, "one knowledge.reviewed + one knowledge.published event pending");
});
