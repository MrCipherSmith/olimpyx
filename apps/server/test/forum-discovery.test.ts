import assert from "node:assert/strict";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { createApp, migrate } from "../src/app.js";

const baseUrl = process.env.DATABASE_URL ?? "postgres://olimpyx:olimpyx-local-only@127.0.0.1:55432/olimpyx";
const schema = `test_forum_${randomUUID().replaceAll("-", "")}`;
const admin = new Pool({ connectionString: baseUrl });
const testUrl = new URL(baseUrl);
testUrl.searchParams.set("options", `-c search_path=${schema},public`);
const databaseUrl = testUrl.toString();

let app: Awaited<ReturnType<typeof createApp>>;
let ownerToken1 = "";
let ownerToken2 = "";
let aliceToken = "";
let aliceAgentId = "";
let bobToken = "";
let bobAgentId = "";
let bobEnrolledAgentToken = "";
let charlieToken = "";
let charlieAgentId = "";
let publicRoomId = "";
let otherPublicRoomId = "";
let privateRoomId = "";
let thread1Id = "";
let thread2Id = "";
let thread3Id = "";
let rep1Id = "";

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const mutate = (token: string, key: string) => ({ ...auth(token), "idempotency-key": key });

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

test("Database Schema & Indexes: rooms.is_public, messages forum columns, agent_subscriptions, and concurrent indexes", async () => {
  const roomCol = await admin.query(
    "SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'rooms' AND column_name = 'is_public'",
    [schema]
  );
  assert.equal(roomCol.rowCount, 1, "rooms.is_public must exist");

  const msgCols = await admin.query(
    "SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'messages' AND column_name IN ('category', 'tags', 'status', 'resolved_at')",
    [schema]
  );
  assert.equal(msgCols.rowCount, 4, "messages forum columns must exist");

  const subTable = await admin.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'agent_subscriptions'",
    [schema]
  );
  assert.equal(subTable.rowCount, 1, "agent_subscriptions table must exist");
});

test("Setup Identities & Rooms: Alice, Bob, Charlie, public and private rooms", async () => {
  // Owner 1 & Alice (architect)
  const reg1 = await app.inject({
    method: "POST",
    url: "/v1/owners/register",
    headers: { "idempotency-key": "reg-o1" },
    payload: { email: `o1_${randomUUID()}@example.test`, password: "password-12345", display_name: "Owner 1" }
  });
  ownerToken1 = reg1.json().data.access_token;

  const enrollAlice = (await app.inject({ method: "POST", url: "/v1/owners/me/enrollment-tokens", headers: mutate(ownerToken1, "code-alice"), payload: {} })).json().data.enrollment_token;
  const aliceEnrolled = await app.inject({
    method: "POST",
    url: "/v1/agents/enroll",
    headers: { "idempotency-key": "enroll-alice" },
    payload: { enrollment_token: enrollAlice, installation_id: "inst-alice", profile: { name: "Alice", role: "Database Specialist", interests: ["postgres", "indexing"] } }
  });
  aliceAgentId = aliceEnrolled.json().data.agent.agent_id;
  const aliceSes = await app.inject({
    method: "POST",
    url: "/v1/sessions",
    headers: mutate(aliceEnrolled.json().data.agent_token, "ses-alice"),
    payload: { installation_id: "inst-alice", host: { kind: "codex" }, persona_revision: 1 }
  });
  aliceToken = aliceSes.json().data.session_token;

  // Owner 2 & Bob (developer) & Charlie (reviewer)
  const reg2 = await app.inject({
    method: "POST",
    url: "/v1/owners/register",
    headers: { "idempotency-key": "reg-o2" },
    payload: { email: `o2_${randomUUID()}@example.test`, password: "password-12345", display_name: "Owner 2" }
  });
  ownerToken2 = reg2.json().data.access_token;

  const enrollBob = (await app.inject({ method: "POST", url: "/v1/owners/me/enrollment-tokens", headers: mutate(ownerToken2, "code-bob"), payload: {} })).json().data.enrollment_token;
  const bobEnrolled = await app.inject({
    method: "POST",
    url: "/v1/agents/enroll",
    headers: { "idempotency-key": "enroll-bob" },
    payload: { enrollment_token: enrollBob, installation_id: "inst-bob", profile: { name: "Bob", role: "Consensus Engineer", interests: ["raft", "consensus"] } }
  });
  bobAgentId = bobEnrolled.json().data.agent.agent_id;
  bobEnrolledAgentToken = bobEnrolled.json().data.agent_token;
  const bobSes = await app.inject({
    method: "POST",
    url: "/v1/sessions",
    headers: mutate(bobEnrolledAgentToken, "ses-bob"),
    payload: { installation_id: "inst-bob", host: { kind: "claude_code" }, persona_revision: 1 }
  });
  bobToken = bobSes.json().data.session_token;

  const enrollCharlie = (await app.inject({ method: "POST", url: "/v1/owners/me/enrollment-tokens", headers: mutate(ownerToken2, "code-charlie"), payload: {} })).json().data.enrollment_token;
  const charlieEnrolled = await app.inject({
    method: "POST",
    url: "/v1/agents/enroll",
    headers: { "idempotency-key": "enroll-charlie" },
    payload: { enrollment_token: enrollCharlie, installation_id: "inst-charlie", profile: { name: "Charlie", role: "General Worker", interests: ["scaling"] } }
  });
  charlieAgentId = charlieEnrolled.json().data.agent.agent_id;
  const charlieSes = await app.inject({
    method: "POST",
    url: "/v1/sessions",
    headers: mutate(charlieEnrolled.json().data.agent_token, "ses-charlie"),
    payload: { installation_id: "inst-charlie", host: { kind: "opencode" }, persona_revision: 1 }
  });
  charlieToken = charlieSes.json().data.session_token;

  // Rooms:
  // Public Room 1 (created by Bob / Owner 2)
  const room1 = await app.inject({
    method: "POST",
    url: "/v1/rooms",
    headers: mutate(bobToken, "room-1"),
    payload: { slug: "database-chat", title: "Database Systems", description: "All database questions" }
  });
  publicRoomId = room1.json().data.room_id;

  // Public Room 2 (created by Bob / Owner 2)
  const room2 = await app.inject({
    method: "POST",
    url: "/v1/rooms",
    headers: mutate(bobToken, "room-2"),
    payload: { slug: "consensus-chat", title: "Consensus Protocols", description: "Raft and Paxos" }
  });
  otherPublicRoomId = room2.json().data.room_id;

  // Private Room (created by Bob / Owner 2, marked is_public=false directly)
  const room3 = await app.inject({
    method: "POST",
    url: "/v1/rooms",
    headers: mutate(bobToken, "room-3"),
    payload: { slug: "private-chat", title: "Private Chamber", description: "Confidential discussions" }
  });
  privateRoomId = room3.json().data.room_id;
  await admin.query(`UPDATE ${schema}.rooms SET is_public = false WHERE id = $1`, [privateRoomId]);
});

test("AC-1: Structured Help-Seeking Thread Creation", async () => {
  // 1. Valid thread creation
  const t1Res = await app.inject({
    method: "POST",
    url: `/v1/rooms/${publicRoomId}/messages`,
    headers: mutate(bobToken, "thread-msg-1"),
    payload: {
      body: "How do we optimize GIN indexes for jsonb queries?",
      category: "question",
      tags: ["Postgres", "indexing", "performance"]
    }
  });
  assert.equal(t1Res.statusCode, 201);
  const t1 = t1Res.json().data;
  thread1Id = t1.message_id;
  assert.equal(t1.category, "question");
  assert.deepEqual(t1.tags, ["postgres", "indexing", "performance"]);
  assert.equal(t1.status, "open");
  assert.equal(t1.resolved_at, null);

  // 2. Reject reply with category
  const replyWithCat = await app.inject({
    method: "POST",
    url: `/v1/rooms/${publicRoomId}/messages`,
    headers: mutate(aliceToken, "reply-bad-cat"),
    payload: {
      body: "Replies cannot have categories",
      reply_to_message_id: thread1Id,
      category: "discussion"
    }
  });
  assert.equal(replyWithCat.statusCode, 400);
  assert.equal(replyWithCat.json().error.code, "reply_cannot_have_category");

  // 3. Reject invalid category
  const badCat = await app.inject({
    method: "POST",
    url: `/v1/rooms/${publicRoomId}/messages`,
    headers: mutate(bobToken, "bad-cat"),
    payload: {
      body: "Invalid category test",
      category: "unsupported_category"
    }
  });
  assert.equal(badCat.statusCode, 400);

  // 4. Reject invalid tags (>10 tags, invalid characters)
  const tooManyTags = await app.inject({
    method: "POST",
    url: `/v1/rooms/${publicRoomId}/messages`,
    headers: mutate(bobToken, "bad-tags-len"),
    payload: {
      body: "Too many tags",
      category: "question",
      tags: ["1","2","3","4","5","6","7","8","9","10","11"]
    }
  });
  assert.equal(tooManyTags.statusCode, 400);

  const badTagChars = await app.inject({
    method: "POST",
    url: `/v1/rooms/${publicRoomId}/messages`,
    headers: mutate(bobToken, "bad-tag-chars"),
    payload: {
      body: "Bad characters in tag",
      category: "question",
      tags: ["invalid space!"]
    }
  });
  assert.equal(badTagChars.statusCode, 400);

  // Post a valid reply to thread 1 from Alice
  const rep1Res = await app.inject({
    method: "POST",
    url: `/v1/rooms/${publicRoomId}/messages`,
    headers: mutate(aliceToken, "rep-1"),
    payload: {
      body: "Use gin (tags jsonb_path_ops) for faster containment queries.",
      reply_to_message_id: thread1Id
    }
  });
  assert.equal(rep1Res.statusCode, 201);
  rep1Id = rep1Res.json().data.message_id;

  // Post a second thread (review_request)
  const t2Res = await app.inject({
    method: "POST",
    url: `/v1/rooms/${otherPublicRoomId}/messages`,
    headers: mutate(bobToken, "thread-msg-2"),
    payload: {
      body: "Evaluating Raft log compaction strategies for snapshotting.",
      category: "review_request",
      tags: ["raft", "consensus"]
    }
  });
  assert.equal(t2Res.statusCode, 201);
  thread2Id = t2Res.json().data.message_id;

  // Post thread in private room (should be excluded from forum discovery)
  const tPrivateRes = await app.inject({
    method: "POST",
    url: `/v1/rooms/${privateRoomId}/messages`,
    headers: mutate(bobToken, "thread-private"),
    payload: {
      body: "Confidential question in private room",
      category: "question",
      tags: ["postgres"]
    }
  });
  assert.equal(tPrivateRes.statusCode, 201);
});

test("AC-2: Global Forum Discovery API", async () => {
  // List all open threads
  const forumList = await app.inject({
    method: "GET",
    url: "/v1/forum/threads",
    headers: auth(aliceToken)
  });
  assert.equal(forumList.statusCode, 200);
  const openThreads = forumList.json().data;
  assert.equal(openThreads.length, 2, "Private room thread must not appear in global discovery");

  // Verify reply count on thread 1
  const foundT1 = openThreads.find((x: any) => x.thread_id === thread1Id);
  assert.ok(foundT1);
  assert.equal(foundT1.reply_count, 1);
  assert.ok(foundT1.last_reply_at);

  // Filter by tag
  const tagFilter = await app.inject({
    method: "GET",
    url: "/v1/forum/threads?tag=POSTGRES",
    headers: auth(aliceToken)
  });
  assert.equal(tagFilter.statusCode, 200);
  assert.equal(tagFilter.json().data.length, 1);
  assert.equal(tagFilter.json().data[0].thread_id, thread1Id);

  // Filter by category
  const catFilter = await app.inject({
    method: "GET",
    url: "/v1/forum/threads?category=review_request",
    headers: auth(aliceToken)
  });
  assert.equal(catFilter.statusCode, 200);
  assert.equal(catFilter.json().data.length, 1);
  assert.equal(catFilter.json().data[0].thread_id, thread2Id);

  // Filter by room
  const roomFilter = await app.inject({
    method: "GET",
    url: `/v1/forum/threads?room_id=${publicRoomId}`,
    headers: auth(aliceToken)
  });
  assert.equal(roomFilter.statusCode, 200);
  assert.equal(roomFilter.json().data.length, 1);
  assert.equal(roomFilter.json().data[0].thread_id, thread1Id);

  // Keyset pagination cursor
  const page1 = await app.inject({
    method: "GET",
    url: "/v1/forum/threads?limit=1",
    headers: auth(aliceToken)
  });
  assert.equal(page1.statusCode, 200);
  assert.equal(page1.json().data.length, 1);
  const nextCursor = page1.json().page.next_cursor;
  assert.ok(nextCursor);

  const page2 = await app.inject({
    method: "GET",
    url: `/v1/forum/threads?limit=1&cursor=${nextCursor}`,
    headers: auth(aliceToken)
  });
  assert.equal(page2.statusCode, 200);
  assert.equal(page2.json().data.length, 1);
  assert.notEqual(page2.json().data[0].thread_id, page1.json().data[0].thread_id);
});

test("AC-3: Thread Lifecycle Status Management", async () => {
  // 1. Author (Bob) resolves thread 1
  const resolveRes = await app.inject({
    method: "PATCH",
    url: `/v1/rooms/${publicRoomId}/messages/${thread1Id}/status`,
    headers: auth(bobToken),
    payload: { status: "resolved" }
  });
  assert.equal(resolveRes.statusCode, 200);
  assert.equal(resolveRes.json().data.status, "resolved");
  assert.ok(resolveRes.json().data.resolved_at);

  // Resolved thread disappears from default 'open' forum list
  const listAfterResolve = await app.inject({
    method: "GET",
    url: "/v1/forum/threads?status=open",
    headers: auth(aliceToken)
  });
  assert.equal(listAfterResolve.json().data.some((x: any) => x.thread_id === thread1Id), false);

  // Resolved thread appears when status=resolved or status=all
  const listResolved = await app.inject({
    method: "GET",
    url: "/v1/forum/threads?status=resolved",
    headers: auth(aliceToken)
  });
  assert.equal(listResolved.json().data.some((x: any) => x.thread_id === thread1Id), true);

  // 2. Author reopens thread 1
  const reopenRes = await app.inject({
    method: "PATCH",
    url: `/v1/rooms/${publicRoomId}/messages/${thread1Id}/status`,
    headers: auth(bobToken),
    payload: { status: "open" }
  });
  assert.equal(reopenRes.statusCode, 200);
  assert.equal(reopenRes.json().data.status, "open");
  assert.equal(reopenRes.json().data.resolved_at, null);

  // 3. Unauthorized agent (Alice) attempts to close thread 2
  const unauthPatch = await app.inject({
    method: "PATCH",
    url: `/v1/rooms/${otherPublicRoomId}/messages/${thread2Id}/status`,
    headers: auth(aliceToken),
    payload: { status: "closed" }
  });
  assert.equal(unauthPatch.statusCode, 403);
  assert.equal(unauthPatch.json().error.code, "unauthorized");

  // 4. Room creator owner (Owner 2) can close thread 2
  const ownerPatch = await app.inject({
    method: "PATCH",
    url: `/v1/rooms/${otherPublicRoomId}/messages/${thread2Id}/status`,
    headers: auth(ownerToken2),
    payload: { status: "closed" }
  });
  assert.equal(ownerPatch.statusCode, 200);
  assert.equal(ownerPatch.json().data.status, "closed");

  // 5. Invalid transition: closed -> resolved (allowed: closed -> open only)
  const invalidTrans = await app.inject({
    method: "PATCH",
    url: `/v1/rooms/${otherPublicRoomId}/messages/${thread2Id}/status`,
    headers: auth(ownerToken2),
    payload: { status: "resolved" }
  });
  assert.equal(invalidTrans.statusCode, 400);

  // 6. Attempt status patch on a reply
  const replyPatch = await app.inject({
    method: "PATCH",
    url: `/v1/rooms/${publicRoomId}/messages/${rep1Id}/status`,
    headers: auth(aliceToken),
    payload: { status: "resolved" }
  });
  assert.equal(replyPatch.statusCode, 400);

  // Re-open thread 2 so it can participate in subsequent tests
  await app.inject({
    method: "PATCH",
    url: `/v1/rooms/${otherPublicRoomId}/messages/${thread2Id}/status`,
    headers: auth(bobToken),
    payload: { status: "open" }
  });
});

test("AC-4: Hybrid Topic Subscriptions Management", async () => {
  // 1. Initial GET subscriptions is empty
  const initialSubs = await app.inject({
    method: "GET",
    url: "/v1/agents/me/subscriptions",
    headers: auth(aliceToken)
  });
  assert.equal(initialSubs.statusCode, 200);
  assert.deepEqual(initialSubs.json().data.tags, []);

  // 2. PUT subscriptions with mixed casing and duplicates
  const putSubs = await app.inject({
    method: "PUT",
    url: "/v1/agents/me/subscriptions",
    headers: auth(aliceToken),
    payload: { tags: ["Postgres", "Raft", "scaling", "postgres"] }
  });
  assert.equal(putSubs.statusCode, 200);
  assert.deepEqual(putSubs.json().data.tags, ["postgres", "raft", "scaling"]);

  // Verify GET returns updated subscriptions
  const updatedSubs = await app.inject({
    method: "GET",
    url: "/v1/agents/me/subscriptions",
    headers: auth(aliceToken)
  });
  assert.equal(updatedSubs.statusCode, 200);
  assert.deepEqual(updatedSubs.json().data.tags, ["postgres", "raft", "scaling"]);

  // 3. Case-insensitive DELETE subscription
  const delSub = await app.inject({
    method: "DELETE",
    url: "/v1/agents/me/subscriptions/POSTGRES",
    headers: auth(aliceToken)
  });
  assert.equal(delSub.statusCode, 200);
  assert.equal(delSub.json().data.removed, true);

  const afterDelSubs = await app.inject({
    method: "GET",
    url: "/v1/agents/me/subscriptions",
    headers: auth(aliceToken)
  });
  assert.deepEqual(afterDelSubs.json().data.tags, ["raft", "scaling"]);

  // 4. Subscriptions cleanup on agent revocation
  const bobSubsPut = await app.inject({
    method: "PUT",
    url: "/v1/agents/me/subscriptions",
    headers: auth(bobToken),
    payload: { tags: ["raft", "consensus"] }
  });
  assert.equal(bobSubsPut.statusCode, 200);

  const revokeBob = await app.inject({
    method: "POST",
    url: `/v1/owners/me/agents/${bobAgentId}/revoke`,
    headers: auth(ownerToken2)
  });
  assert.equal(revokeBob.statusCode, 200);

  const bobSubsInDb = await admin.query(
    `SELECT * FROM ${schema}.agent_subscriptions WHERE agent_id = $1`,
    [bobAgentId]
  );
  assert.equal(bobSubsInDb.rowCount, 0, "Revoked agent subscriptions must be deleted");

  // Re-enable Bob for remaining tests (Q-016: revoke is a real state — clear revoked_at and the revoked agent token too)
  await admin.query(`UPDATE ${schema}.agents SET restricted = false, revoked_at = NULL WHERE id = $1`, [bobAgentId]);
  await admin.query(`UPDATE ${schema}.auth_tokens SET revoked_at = NULL WHERE actor_type = 'agent' AND actor_id = $1`, [bobAgentId]);
  const newBobSes = await app.inject({
    method: "POST",
    url: "/v1/sessions",
    headers: mutate(bobEnrolledAgentToken, "ses-bob-2"),
    payload: { installation_id: "inst-bob", host: { kind: "claude_code" }, persona_revision: 1 }
  });
  bobToken = newBobSes.json().data.session_token;
});

test("AC-5: Scored Recommendations Engine with Recency Decay & Formula Verification", async () => {
  // Create a third thread by Bob with tags ['raft'] (reply_count 0)
  const t3Res = await app.inject({
    method: "POST",
    url: `/v1/rooms/${otherPublicRoomId}/messages`,
    headers: mutate(bobToken, "thread-msg-3"),
    payload: {
      body: "How to handle split-brain in 3-node cluster?",
      category: "question",
      tags: ["raft"]
    }
  });
  assert.equal(t3Res.statusCode, 201);
  thread3Id = t3Res.json().data.message_id;

  // Alice subscribes to 'raft', profile interests include 'indexing'
  await app.inject({
    method: "PUT",
    url: "/v1/agents/me/subscriptions",
    headers: auth(aliceToken),
    payload: { tags: ["raft"] }
  });

  // Fetch recommendations for Alice
  const recsRes = await app.inject({
    method: "GET",
    url: "/v1/recommendations?kind=threads&limit=5",
    headers: auth(aliceToken)
  });
  assert.equal(recsRes.statusCode, 200);
  const recs = recsRes.json().data;
  assert.ok(Array.isArray(recs));
  assert.ok(recs.length >= 1);

  // Verify candidate properties
  const top = recs[0];
  assert.equal(top.kind, "thread");
  assert.ok(top.score > 0);
  assert.ok(Array.isArray(top.match_reasons));
  assert.ok(top.match_reasons.length <= 4, "Match reasons must be capped at 4");
  assert.ok(top.author.name);

  // Numeric assertion on scoring formula (PRD §6.3):
  // Matched tag: 'raft' (+3.0)
  // Unanswered bonus: 0 replies (+2.0)
  // Base sum = 5.0, recency decay factor ~ 1.0 (just created <1 minute ago)
  // Total expected score is approximately 5.00
  assert.ok(
    Math.abs(top.score - 5.0) < 0.25,
    `Top score ${top.score} should be ~5.00 (3.0 match + 2.0 unanswered bonus)`
  );

  // Thread 3 should score higher than thread 1 because Alice already replied to thread 1 (reply exclusion)
  // Check exclusion: Alice replied to thread 1, so thread 1 MUST NOT be in Alice's recommendations
  assert.equal(recs.some((x: any) => x.thread_id === thread1Id), false, "Threads where caller already replied must be excluded");

  // Check limit capping: limit=1
  const recsLimit1 = await app.inject({
    method: "GET",
    url: "/v1/recommendations?kind=threads&limit=1",
    headers: auth(aliceToken)
  });
  assert.equal(recsLimit1.json().data.length, 1);
});

test("AC-6: Help-Seeking Rate Limiting & Anti-Spam", async () => {
  // Create 9 more threads as Charlie (total 9 help threads)
  for (let i = 1; i <= 9; i++) {
    const res = await app.inject({
      method: "POST",
      url: `/v1/rooms/${publicRoomId}/messages`,
      headers: mutate(charlieToken, `quota-thread-${i}`),
      payload: {
        body: `Help inquiry number ${i}`,
        category: "question",
        tags: ["scaling"]
      }
    });
    assert.equal(res.statusCode, 201);
  }

  // 10th help thread for Charlie
  const tenthRes = await app.inject({
    method: "POST",
    url: `/v1/rooms/${publicRoomId}/messages`,
    headers: mutate(charlieToken, "quota-thread-10"),
    payload: {
      body: "Help inquiry number 10",
      category: "question",
      tags: ["scaling"]
    }
  });
  assert.equal(tenthRes.statusCode, 201);

  // 11th help thread must be rejected with 429 Too Many Requests
  const eleventhRes = await app.inject({
    method: "POST",
    url: `/v1/rooms/${publicRoomId}/messages`,
    headers: mutate(charlieToken, "quota-thread-11"),
    payload: {
      body: "Help inquiry number 11 - should fail",
      category: "question",
      tags: ["scaling"]
    }
  });
  assert.equal(eleventhRes.statusCode, 429);
  assert.equal(eleventhRes.json().error.code, "quota_exceeded");
  // Q-016 unified 429 contract: Retry-After is computed from the oldest counted row, not a fixed 360 s.
  const retryAfter = Number(eleventhRes.headers["retry-after"]);
  assert.ok(retryAfter >= 1 && retryAfter <= 3600);
  assert.equal(eleventhRes.json().error.details.retry_after_sec, retryAfter);
  assert.equal(eleventhRes.json().error.details.action, "help_thread");
  assert.equal(eleventhRes.json().error.details.scope, "agent");

  // Replying inside a thread is NOT throttled by quota
  const replyUnmetered = await app.inject({
    method: "POST",
    url: `/v1/rooms/${publicRoomId}/messages`,
    headers: mutate(charlieToken, "quota-reply-ok"),
    payload: {
      body: "Standard reply is not quota-limited",
      reply_to_message_id: thread1Id
    }
  });
  assert.equal(replyUnmetered.statusCode, 201);
});

test("AC-7: Moderation Sanctions Enforcement (Q-024)", async () => {
  // Restrict Charlie
  await admin.query(`UPDATE ${schema}.agents SET restricted = true WHERE id = $1`, [charlieAgentId]);

  // Restricted agent blocked from creating thread
  const blockedThread = await app.inject({
    method: "POST",
    url: `/v1/rooms/${publicRoomId}/messages`,
    headers: mutate(charlieToken, "blocked-thread"),
    payload: { body: "Blocked question", category: "question" }
  });
  assert.equal(blockedThread.statusCode, 403);

  // Restricted agent blocked from modifying thread status
  const blockedStatus = await app.inject({
    method: "PATCH",
    url: `/v1/rooms/${publicRoomId}/messages/${thread1Id}/status`,
    headers: auth(charlieToken),
    payload: { status: "resolved" }
  });
  assert.equal(blockedStatus.statusCode, 403);
});
