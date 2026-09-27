import assert from "node:assert/strict";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { createApp, migrate } from "../src/app.js";
import { ensureVectorExtension } from "./pg-extension.js";

// Regression coverage for #52: `before_cursor` and `after_cursor` must stay distinct all the way
// through GET /v1/rooms/:roomId/messages, and the requested direction -- not which route branch
// handled the request (flat room, root_only, thread_id) -- must pick both the comparison operator
// and the sort order. Before this fix, the flat/root_only branches always paginated backward
// (older) and the thread_id branch always paginated forward (newer), regardless of which cursor
// parameter the caller sent.

const baseUrl = process.env.DATABASE_URL ?? "postgres://olimpyx:olimpyx-local-only@127.0.0.1:55432/olimpyx";
const schema = `test_cursor_dir_${randomUUID().replaceAll("-", "")}`;
let admin: Pool | null = null;
let pgAvailable = false;

const testUrl = new URL(baseUrl);
testUrl.searchParams.set("options", `-c search_path=${schema},public`);
const databaseUrl = testUrl.toString();
let app: Awaited<ReturnType<typeof createApp>> | null = null;
let ownerToken = "";

const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const mutate = (t: string, key: string) => ({ ...auth(t), "idempotency-key": key });

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
    headers: { "idempotency-key": "register-cursor-dir" },
    payload: { email: `owner-${randomUUID()}@example.test`, password: "very secure password", display_name: "Cursor Owner" }
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

async function createRoom(title: string) {
  const room = await app!.inject({
    method: "POST",
    url: "/v1/rooms",
    headers: mutate(ownerToken, `room-${title}-${randomUUID()}`),
    payload: { title }
  });
  return room.json().data.room_id as string;
}

async function postMessage(roomId: string, body: string, extra: Record<string, unknown> = {}) {
  const res = await app!.inject({
    method: "POST",
    url: `/v1/rooms/${roomId}/messages`,
    headers: mutate(ownerToken, `msg-${randomUUID()}`),
    payload: { body, ...extra }
  });
  assert.equal(res.statusCode, 201, JSON.stringify(res.json()));
  return res.json().data.message_id as string;
}

async function fetchMessages(roomId: string, query: string) {
  const res = await app!.inject({
    method: "GET",
    url: `/v1/rooms/${roomId}/messages${query}`,
    headers: auth(ownerToken)
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.json()));
  return res.json() as { data: Array<{ message_id: string }>; page: { next_cursor: string | null } };
}

test("room messages: before_cursor pages older, after_cursor pages newer, and neither collapses into the other", async (t) => {
  if (!pgAvailable || !app) { t.skip("PostgreSQL is not reachable"); return; }
  const roomId = await createRoom("flat-cursor-direction");
  const ids: string[] = [];
  for (let i = 0; i < 5; i++) ids.push(await postMessage(roomId, `flat message ${i}`));
  const [m1, m2, m3, m4, m5] = ids;

  // Backward compatibility: before_cursor still means "strictly older than this cursor,
  // newest-first" -- exactly what it meant before this fix.
  const older = await fetchMessages(roomId, `?before_cursor=${m3}`);
  assert.deepEqual(older.data.map(m => m.message_id), [m2, m1]);

  // The bug: after_cursor must page forward (newer, ascending), not collapse into the same
  // "older" branch as before_cursor. limit=2 makes this an exact, full page so next_cursor
  // is populated (same "full page" convention the before_cursor side already uses).
  const newer = await fetchMessages(roomId, `?after_cursor=${m3}&limit=2`);
  assert.deepEqual(newer.data.map(m => m.message_id), [m4, m5]);
  assert.equal(newer.page.next_cursor, m5, "next_cursor must point at the newest row so a follow-up after_cursor call keeps walking forward");

  // The page returned by `after` must not re-include anything already covered by `before`,
  // and must continue forward from where the caller left off, not restart from the newest rows.
  const overlap = older.data.map(m => m.message_id).filter(id => newer.data.map(m => m.message_id).includes(id));
  assert.deepEqual(overlap, []);

  // Walking forward from the newest cursor must be empty -- there is nothing newer.
  const exhausted = await fetchMessages(roomId, `?after_cursor=${m5}`);
  assert.deepEqual(exhausted.data, []);
  assert.equal(exhausted.page.next_cursor, null);

  // Legacy unsuffixed aliases must resolve to the same directions as their `_cursor` forms.
  const olderLegacy = await fetchMessages(roomId, `?before=${m3}`);
  assert.deepEqual(olderLegacy.data.map(m => m.message_id), [m2, m1]);
  const newerLegacy = await fetchMessages(roomId, `?after=${m3}`);
  assert.deepEqual(newerLegacy.data.map(m => m.message_id), [m4, m5]);
});

test("room messages: a forward page continues where the caller left off across repeated after_cursor calls", async (t) => {
  if (!pgAvailable || !app) { t.skip("PostgreSQL is not reachable"); return; }
  const roomId = await createRoom("flat-cursor-walk");
  const ids: string[] = [];
  for (let i = 0; i < 5; i++) ids.push(await postMessage(roomId, `walk message ${i}`));
  const [m1, m2, m3, m4, m5] = ids;

  const page1 = await fetchMessages(roomId, `?after_cursor=${m3}&limit=1`);
  assert.deepEqual(page1.data.map(m => m.message_id), [m4]);
  assert.equal(page1.page.next_cursor, m4);

  const page2 = await fetchMessages(roomId, `?after_cursor=${page1.page.next_cursor}&limit=1`);
  assert.deepEqual(page2.data.map(m => m.message_id), [m5]);

  // Nothing already read (m1, m2, m3) should ever resurface on the forward walk.
  const seen = new Set([...page1.data, ...page2.data].map(m => m.message_id));
  for (const alreadyRead of [m1, m2, m3]) assert.ok(!seen.has(alreadyRead));
});

test("thread messages: before_cursor pages older within the thread, after_cursor pages newer, direction is not tied to the route branch", async (t) => {
  if (!pgAvailable || !app) { t.skip("PostgreSQL is not reachable"); return; }
  const roomId = await createRoom("thread-cursor-direction");
  const root = await postMessage(roomId, "thread root");
  const reply1 = await postMessage(roomId, "reply 1", { reply_to_message_id: root });
  const reply2 = await postMessage(roomId, "reply 2", { reply_to_message_id: root });
  const reply3 = await postMessage(roomId, "reply 3", { reply_to_message_id: root });
  const reply4 = await postMessage(roomId, "reply 4", { reply_to_message_id: root });

  // Full thread, chronological: root, reply1, reply2, reply3, reply4.
  const full = await fetchMessages(roomId, `?thread_id=${root}`);
  assert.deepEqual(full.data.map(m => m.message_id), [root, reply1, reply2, reply3, reply4]);

  // before_cursor=reply3 -> strictly older than reply3, newest-first: reply2, reply1, root.
  const older = await fetchMessages(roomId, `?thread_id=${root}&before_cursor=${reply3}`);
  assert.deepEqual(older.data.map(m => m.message_id), [reply2, reply1, root]);

  // after_cursor=reply3 -> strictly newer than reply3, oldest-first: reply4. limit=1 makes
  // this a full page so next_cursor is populated.
  const newer = await fetchMessages(roomId, `?thread_id=${root}&after_cursor=${reply3}&limit=1`);
  assert.deepEqual(newer.data.map(m => m.message_id), [reply4]);
  assert.equal(newer.page.next_cursor, reply4);

  const overlap = older.data.map(m => m.message_id).filter(id => newer.data.map(m => m.message_id).includes(id));
  assert.deepEqual(overlap, []);
});

test("room messages: before_cursor and after_cursor together are rejected as a bad request", async (t) => {
  if (!pgAvailable || !app) { t.skip("PostgreSQL is not reachable"); return; }
  const roomId = await createRoom("cursor-conflict");
  const m1 = await postMessage(roomId, "one");
  const m2 = await postMessage(roomId, "two");
  const res = await app.inject({
    method: "GET",
    url: `/v1/rooms/${roomId}/messages?before_cursor=${m2}&after_cursor=${m1}`,
    headers: auth(ownerToken)
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, "bad_request");
});
