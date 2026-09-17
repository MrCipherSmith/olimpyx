import assert from "node:assert/strict";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { createApp, migrate } from "../src/app.js";

const baseUrl = process.env.DATABASE_URL ?? "postgres://olimpyx:olimpyx-local-only@127.0.0.1:55432/olimpyx";
const schema = `test_threads_${randomUUID().replaceAll("-", "")}`;
const admin = new Pool({ connectionString: baseUrl });
const testUrl = new URL(baseUrl);
testUrl.searchParams.set("options", `-c search_path=${schema},public`);
const databaseUrl = testUrl.toString();

let app: Awaited<ReturnType<typeof createApp>>;
let ownerToken = "";
let aliceToken = "";
let aliceAgentId = "";
let bobToken = "";
let bobAgentId = "";
let roomId = "";
let otherRoomId = "";

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

test("thread hierarchy, flattening, queries, and notification routing", async () => {
  // Test 1: Verify schema migration (root_message_id column and idx_messages_root index)
  const colRes = await admin.query(
    "SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'messages' AND column_name = 'root_message_id'",
    [schema]
  );
  assert.equal(colRes.rowCount, 1, "root_message_id column must exist in messages table");

  const idxRes = await admin.query(
    "SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = 'messages' AND indexname = 'idx_messages_root'",
    [schema]
  );
  assert.equal(idxRes.rowCount, 1, "idx_messages_root index must exist on messages table");

  // Setup Owner, Agents Alice and Bob
  const reg = await app.inject({
    method: "POST",
    url: "/v1/owners/register",
    headers: { "idempotency-key": "reg-owner" },
    payload: { email: `owner_${randomUUID()}@example.test`, password: "very secure password", display_name: "Owner" }
  });
  assert.equal(reg.statusCode, 201);
  ownerToken = reg.json().data.access_token;

  // Enroll Alice
  const enrollTok1 = (await app.inject({ method: "POST", url: "/v1/owners/me/enrollment-tokens", headers: mutate(ownerToken, "code-1"), payload: {} })).json().data.enrollment_token;
  const enrolledAlice = await app.inject({
    method: "POST",
    url: "/v1/agents/enroll",
    headers: { "idempotency-key": "enroll-alice" },
    payload: { enrollment_token: enrollTok1, installation_id: "inst-alice", profile: { name: "Alice", role: "architect" } }
  });
  aliceAgentId = enrolledAlice.json().data.agent.agent_id;
  const aliceSession = await app.inject({
    method: "POST",
    url: "/v1/sessions",
    headers: mutate(enrolledAlice.json().data.agent_token, "ses-alice"),
    payload: { installation_id: "inst-alice", host: { kind: "codex" }, persona_revision: 1 }
  });
  aliceToken = aliceSession.json().data.session_token;

  // Enroll Bob
  const enrollTok2 = (await app.inject({ method: "POST", url: "/v1/owners/me/enrollment-tokens", headers: mutate(ownerToken, "code-2"), payload: {} })).json().data.enrollment_token;
  const enrolledBob = await app.inject({
    method: "POST",
    url: "/v1/agents/enroll",
    headers: { "idempotency-key": "enroll-bob" },
    payload: { enrollment_token: enrollTok2, installation_id: "inst-bob", profile: { name: "Bob", role: "developer" } }
  });
  bobAgentId = enrolledBob.json().data.agent.agent_id;
  const bobSession = await app.inject({
    method: "POST",
    url: "/v1/sessions",
    headers: mutate(enrolledBob.json().data.agent_token, "ses-bob"),
    payload: { installation_id: "inst-bob", host: { kind: "claude_code" }, persona_revision: 1 }
  });
  bobToken = bobSession.json().data.session_token;

  // Create primary room and other room
  const roomRes = await app.inject({
    method: "POST",
    url: "/v1/rooms",
    headers: mutate(ownerToken, "room-main"),
    payload: { title: "Main Discussion" }
  });
  roomId = roomRes.json().data.room_id;

  const otherRoomRes = await app.inject({
    method: "POST",
    url: "/v1/rooms",
    headers: mutate(ownerToken, "room-other"),
    payload: { title: "Other Room" }
  });
  otherRoomId = otherRoomRes.json().data.room_id;

  // Test 2: Alice posts a Root Message
  const root1 = await app.inject({
    method: "POST",
    url: `/v1/rooms/${roomId}/messages`,
    headers: mutate(aliceToken, "msg-root-1"),
    payload: { body: "RFC: Thread-Structured Rooms" }
  });
  assert.equal(root1.statusCode, 201);
  const root1Data = root1.json().data;
  assert.equal(root1Data.reply_to_message_id, null);
  assert.equal(root1Data.root_message_id, null);
  const root1Id = root1Data.message_id;

  // Test 12b: Reply to nonexistent parent message returns HTTP 404
  const orphanReply = await app.inject({
    method: "POST",
    url: `/v1/rooms/${roomId}/messages`,
    headers: mutate(bobToken, "msg-orphan"),
    payload: { body: "Orphan reply", reply_to_message_id: "msg_nonexistent_999" }
  });
  assert.equal(orphanReply.statusCode, 404);
  assert.match(orphanReply.json().error.message, /Parent message not found/i);

  // Test 3: Bob directly replies to Root Message
  const reply1 = await app.inject({
    method: "POST",
    url: `/v1/rooms/${roomId}/messages`,
    headers: mutate(bobToken, "msg-reply-1"),
    payload: { body: "Looks great, +1", reply_to_message_id: root1Id }
  });
  assert.equal(reply1.statusCode, 201);
  const reply1Data = reply1.json().data;
  assert.equal(reply1Data.reply_to_message_id, root1Id);
  assert.equal(reply1Data.root_message_id, root1Id);
  const reply1Id = reply1Data.message_id;

  // Test 9: Implicit Inbox Routing -> Alice receives notification of Bob's reply
  const aliceEvents = await app.inject({
    method: "GET",
    url: "/v1/inbox/events",
    headers: auth(aliceToken)
  });
  assert.equal(aliceEvents.statusCode, 200);
  const aliceEvList = aliceEvents.json().data;
  const replyEvent = aliceEvList.find((e: any) => e.type === "message.created" && e.resource.id === reply1Id);
  assert.ok(replyEvent, "Alice should receive an inbox event for Bob's reply in Alice's thread");

  // Test 4: Nested Reply Flattening -> Alice replies to Bob's reply
  const reply2 = await app.inject({
    method: "POST",
    url: `/v1/rooms/${roomId}/messages`,
    headers: mutate(aliceToken, "msg-reply-2"),
    payload: { body: "Thanks Bob!", reply_to_message_id: reply1Id }
  });
  assert.equal(reply2.statusCode, 201);
  const reply2Data = reply2.json().data;
  assert.equal(reply2Data.reply_to_message_id, reply1Id);
  assert.equal(reply2Data.root_message_id, root1Id, "Nested reply should flatten to root1Id");

  // Test 10: Self-Reply Exclusion -> Alice should NOT receive notification for her own reply
  const aliceEventsAfter = await app.inject({
    method: "GET",
    url: "/v1/inbox/events",
    headers: auth(aliceToken)
  });
  const selfEvent = aliceEventsAfter.json().data.find((e: any) => e.resource.id === reply2Data.message_id);
  assert.equal(selfEvent, undefined, "Alice should not receive an inbox event for her own message");

  // Test 10b: Bob replies to Bob's reply in Alice's thread -> Alice (root author) receives notification, Bob excluded
  const reply3 = await app.inject({
    method: "POST",
    url: `/v1/rooms/${roomId}/messages`,
    headers: mutate(bobToken, "msg-reply-3"),
    payload: { body: "Bob following up on his own point", reply_to_message_id: reply1Id }
  });
  assert.equal(reply3.statusCode, 201);
  const reply3Data = reply3.json().data;
  assert.equal(reply3Data.root_message_id, root1Id);

  const aliceEventsAfter3 = await app.inject({
    method: "GET",
    url: "/v1/inbox/events",
    headers: auth(aliceToken)
  });
  const reply3Event = aliceEventsAfter3.json().data.find((e: any) => e.resource.id === reply3Data.message_id);
  assert.ok(reply3Event, "Alice (root author) should receive notification when Bob replies to his own reply in Alice's thread");

  const bobEvents = await app.inject({
    method: "GET",
    url: "/v1/inbox/events",
    headers: auth(bobToken)
  });
  const bobSelfEvent = bobEvents.json().data.find((e: any) => e.resource.id === reply3Data.message_id);
  assert.equal(bobSelfEvent, undefined, "Bob should not receive notification for his own reply");

  // Test 5: Cross-Room Rejection -> Reply to root1Id from otherRoomId
  const crossRoom = await app.inject({
    method: "POST",
    url: `/v1/rooms/${otherRoomId}/messages`,
    headers: mutate(bobToken, "msg-cross-room"),
    payload: { body: "Cross-room reply", reply_to_message_id: root1Id }
  });
  assert.equal(crossRoom.statusCode, 400);
  assert.match(crossRoom.json().error.message, /different room/);

  // Post a second root message to test root_only filtering
  const root2 = await app.inject({
    method: "POST",
    url: `/v1/rooms/${roomId}/messages`,
    headers: mutate(bobToken, "msg-root-2"),
    payload: { body: "Second independent topic" }
  });
  assert.equal(root2.statusCode, 201);
  const root2Id = root2.json().data.message_id;

  // Test 6: root_only=true Query
  const rootsQuery = await app.inject({
    method: "GET",
    url: `/v1/rooms/${roomId}/messages?root_only=true`,
    headers: auth(aliceToken)
  });
  assert.equal(rootsQuery.statusCode, 200);
  const roots = rootsQuery.json().data;
  assert.equal(roots.length, 2);
  const fetchedRoot1 = roots.find((r: any) => r.message_id === root1Id);
  assert.equal(fetchedRoot1.reply_count, 3);
  assert.ok(fetchedRoot1.last_reply_at);

  const fetchedRoot2 = roots.find((r: any) => r.message_id === root2Id);
  assert.equal(fetchedRoot2.reply_count, 0);
  assert.equal(fetchedRoot2.last_reply_at, null);

  // Test 7: thread_id Query in Chronological Order (ASC)
  const threadQuery = await app.inject({
    method: "GET",
    url: `/v1/rooms/${roomId}/messages?thread_id=${root1Id}`,
    headers: auth(aliceToken)
  });
  assert.equal(threadQuery.statusCode, 200);
  const threadMessages = threadQuery.json().data;
  assert.equal(threadMessages.length, 4);
  assert.equal(threadMessages[0].message_id, root1Id);
  assert.equal(threadMessages[1].message_id, reply1Id);
  assert.equal(threadMessages[2].message_id, reply2Data.message_id);
  assert.equal(threadMessages[3].message_id, reply3Data.message_id);

  // Test 7b: Auto-resolution when passing a reply message ID as thread_id
  const autoResolveQuery = await app.inject({
    method: "GET",
    url: `/v1/rooms/${roomId}/messages?thread_id=${reply1Id}`,
    headers: auth(aliceToken)
  });
  assert.equal(autoResolveQuery.statusCode, 200);
  assert.equal(autoResolveQuery.json().data[0].message_id, root1Id);

  // Test 7c: Mode C with after_cursor alias
  const afterCursorQuery = await app.inject({
    method: "GET",
    url: `/v1/rooms/${roomId}/messages?thread_id=${root1Id}&after_cursor=${root1Id}`,
    headers: auth(aliceToken)
  });
  assert.equal(afterCursorQuery.statusCode, 200);
  assert.equal(afterCursorQuery.json().data[0].message_id, reply1Id);

  // Test 7 (Cursor Validation): Cross-thread cursor yields 400 Bad Request
  const badCursor = await app.inject({
    method: "GET",
    url: `/v1/rooms/${roomId}/messages?thread_id=${root1Id}&before_cursor=${root2Id}`,
    headers: auth(aliceToken)
  });
  assert.equal(badCursor.statusCode, 400);
  assert.match(badCursor.json().error.message, /Cursor does not belong/);

  // Test 8: Mutual Exclusion Guard (root_only=true + thread_id -> 400)
  const mutualExclusion = await app.inject({
    method: "GET",
    url: `/v1/rooms/${roomId}/messages?root_only=true&thread_id=${root1Id}`,
    headers: auth(aliceToken)
  });
  assert.equal(mutualExclusion.statusCode, 400);
  assert.match(mutualExclusion.json().error.message, /Cannot specify both/);

  // Test 10: Default query without params remains 100% backward compatible (flat list, newest-first)
  const flatQuery = await app.inject({
    method: "GET",
    url: `/v1/rooms/${roomId}/messages`,
    headers: auth(aliceToken)
  });
  assert.equal(flatQuery.statusCode, 200);
  assert.equal(flatQuery.json().data.length, 5); // root1, reply1, reply2, reply3, root2
});
