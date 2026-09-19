import assert from "node:assert/strict";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { after, before, test, type TestContext } from "node:test";
import { createApp, migrate } from "../src/app.js";
import { LIMITS, QUOTA_ACTIONS, loadLimits, type QuotaAction } from "../src/limits.js";

const baseUrl = process.env.DATABASE_URL ?? "postgres://olimpyx:olimpyx-local-only@127.0.0.1:55432/olimpyx";
const schema = `test_limits_${randomUUID().replaceAll("-", "")}`;
let admin: Pool | null = null;
let pgAvailable = false;

const testUrl = new URL(baseUrl);
testUrl.searchParams.set("options", `-c search_path=${schema},public`);
const databaseUrl = testUrl.toString();

type App = Awaited<ReturnType<typeof createApp>>;
type Agent = { agentId: string; agentToken: string; session: string };
type Response = Awaited<ReturnType<App["inject"]>>;

/** Every action limited to 2 per agent and 3 per owner so each limit is reachable in a few requests. */
const SMALL_ENV: Record<string, string> = { OLIMPYX_LIMIT_DIRECT_MESSAGE_PAIR: "50" };
for (const action of QUOTA_ACTIONS) {
  SMALL_ENV[`OLIMPYX_LIMIT_${action.toUpperCase()}_AGENT`] = "2";
  SMALL_ENV[`OLIMPYX_LIMIT_${action.toUpperCase()}_OWNER`] = "3";
}

let app: App | null = null;
const extraApps: App[] = [];
let ownerToken = "";
let ownerId = "";
let otherOwnerToken = "";
let a: Agent, b: Agent, c: Agent;
let roomId = "";
let keySeq = 0;
const key = (label: string) => `${label}-${++keySeq}`;

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const mutate = (token: string, k: string) => ({ ...auth(token), "idempotency-key": k });

function ready(t: TestContext) {
  if (!pgAvailable || !app) { t.skip("PostgreSQL is not reachable at " + baseUrl); return false; }
  return true;
}

async function register(target: App, label: string) {
  const r = await target.inject({ method: "POST", url: "/v1/owners/register", remoteAddress: `10.1.0.${++keySeq % 250}`, headers: { "idempotency-key": `reg-${label}` }, payload: { email: `${label}-${randomUUID()}@example.test`, password: "very secure password", display_name: label } });
  assert.equal(r.statusCode, 201, r.body);
  return { token: r.json().data.access_token as string, ownerId: r.json().data.owner.owner_id as string };
}

async function newAgent(target: App, owner: string, label: string): Promise<Agent> {
  const code = await target.inject({ method: "POST", url: "/v1/owners/me/enrollment-tokens", headers: mutate(owner, `code-${label}`), payload: {} });
  assert.equal(code.statusCode, 201, code.body);
  const enrolled = await target.inject({ method: "POST", url: "/v1/agents/enroll", headers: { "idempotency-key": `enroll-${label}` }, payload: { enrollment_token: code.json().data.enrollment_token, installation_id: `inst-${label}`, profile: { name: `Agent ${label}`, role: "tester" } } });
  assert.equal(enrolled.statusCode, 201, enrolled.body);
  const agentId = enrolled.json().data.agent.agent_id, agentToken = enrolled.json().data.agent_token;
  const started = await target.inject({ method: "POST", url: "/v1/sessions", headers: mutate(agentToken, `session-${label}`), payload: { installation_id: `inst-${label}`, host: { kind: "codex" }, persona_revision: 1 } });
  assert.equal(started.statusCode, 201, started.body);
  return { agentId, agentToken, session: started.json().data.session_token };
}

function assertQuota(response: Response, action: string, scope: "agent" | "owner", limit: number, windowSec: number) {
  assert.equal(response.statusCode, 429, response.body);
  const error = response.json().error;
  assert.equal(error.code, "quota_exceeded");
  assert.equal(error.details.action, action);
  assert.equal(error.details.scope, scope);
  assert.equal(error.details.limit, limit);
  assert.equal(error.details.window_sec, windowSec);
  const retry = Number(response.headers["retry-after"]);
  assert.ok(retry >= 1 && retry <= windowSec, `retry ${retry}`);
  assert.equal(error.details.retry_after_sec, retry);
}

const ok = (response: Response) => assert.ok(response.statusCode >= 200 && response.statusCode < 300, `${response.statusCode} ${response.body}`);

/** Old seeded rows fall outside every window, so they never count toward a quota. */
async function seedMessage(senderId: string, label: string) {
  const mid = `msg_seed_${label}_${randomUUID().replaceAll("-", "")}`;
  await app!.pg.query("INSERT INTO messages(id,room_id,sender_type,sender_id,sender_name,body,created_at) VALUES($1,$2,'agent',$3,'Seed',$4,now()-interval '3 days')", [mid, roomId, senderId, `seed ${label}`]);
  return mid;
}
async function seedVersion(authorId: string, label: string) {
  const cid = `knw_seed_${label}`, vid = `knv_seed_${label}`;
  await app!.pg.query("INSERT INTO knowledge_cards(id,author_agent_id,latest_version_id,created_at) VALUES($1,$2,$3,now()-interval '3 days')", [cid, authorId, vid]);
  await app!.pg.query("INSERT INTO knowledge_versions(id,card_id,version,topic,summary,body,author_agent_id,created_at) VALUES($1,$2,1,'seed','seed','seed',$3,now()-interval '3 days')", [vid, cid, authorId]);
  return { cid, vid };
}

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
  await admin.query("CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public");
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(databaseUrl);
  app = await createApp({ databaseUrl, env: SMALL_ENV });
  const o = await register(app, "limits-owner");
  ownerToken = o.token; ownerId = o.ownerId;
  otherOwnerToken = (await register(app, "limits-other")).token;
  a = await newAgent(app, ownerToken, "a");
  b = await newAgent(app, ownerToken, "b");
  c = await newAgent(app, otherOwnerToken, "c");
  roomId = `rom_seed_${randomUUID().replaceAll("-", "")}`;
  await app.pg.query("INSERT INTO rooms(id,slug,title,creator_type,creator_id,created_at,updated_at) VALUES($1,$1,'Seed','owner',$2,now()-interval '3 days',now())", [roomId, ownerId]);
});
after(async () => {
  for (const extra of extraApps) await extra.close();
  if (app) await app.close();
  if (admin && pgAvailable) {
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await admin.end().catch(() => {});
  }
});

test("defaults match the approved PRD §4 table", () => {
  const expected: Record<QuotaAction, [number, number, number]> = {
    message: [3600, 60, 200], reply: [3600, 120, 300], direct_message: [3600, 30, 100], help_thread: [3600, 10, 30],
    room_create: [86400, 5, 10], knowledge_card: [86400, 20, 50], knowledge_version: [86400, 30, 80], knowledge_review: [86400, 60, 150],
    task_create: [86400, 20, 50], report: [3600, 10, 20], subscription_change: [3600, 30, 60]
  };
  for (const action of QUOTA_ACTIONS) assert.deepEqual([LIMITS[action].window, LIMITS[action].agent, LIMITS[action].owner], expected[action], action);
  const defaults = loadLimits({});
  assert.equal(defaults.directMessagePair, 10);
  assert.deepEqual(defaults.capacity, { agents_per_owner: 10, enrollment_tokens_per_owner: 5, sessions_per_agent: 3, open_tasks_per_assignee: 20 });
});

test("env overrides: integers apply, 0 disables, invalid values fail fast at startup", async () => {
  const config = loadLimits({ OLIMPYX_LIMIT_DIRECT_MESSAGE_AGENT: "7", OLIMPYX_LIMIT_REPORT_OWNER: "0", OLIMPYX_CAP_SESSIONS_PER_AGENT: "1", OLIMPYX_LIMIT_DIRECT_MESSAGE_PAIR: "0" });
  assert.equal(config.actions.direct_message.agent, 7);
  assert.equal(config.actions.report.owner, 0);
  assert.equal(config.capacity.sessions_per_agent, 1);
  assert.equal(config.directMessagePair, 0);
  for (const bad of [{ OLIMPYX_LIMIT_MESSAGE_AGENT: "abc" }, { OLIMPYX_LIMIT_MESSAGE_OWNER: "-1" }, { OLIMPYX_LIMIT_REPLY_AGENT: "1.5" }, { OLIMPYX_CAP_SESSIONS_PER_AGENT: "0" }, { OLIMPYX_CAP_AGENTS_PER_OWNER: "ten" }]) {
    assert.throws(() => loadLimits(bad), /OLIMPYX_/, JSON.stringify(bad));
  }
  if (pgAvailable) await assert.rejects(createApp({ databaseUrl, env: { OLIMPYX_LIMIT_MESSAGE_AGENT: "abc" } }), /OLIMPYX_LIMIT_MESSAGE_AGENT/);
});

/** Agent A hits its own limit; agent B (same owner, under its own limit) then hits the owner aggregate. */
async function exercise(action: QuotaAction, perform: (agent: Agent, i: number) => Promise<Response>, windowSec: number) {
  ok(await perform(a, 1));
  ok(await perform(a, 2));
  assertQuota(await perform(a, 3), action, "agent", 2, windowSec);
  ok(await perform(b, 1));
  assertQuota(await perform(b, 2), action, "owner", 3, windowSec);
}

test("AC-1 room messages: agent limit, owner aggregate incl. human posts, replay never counted", async (t) => {
  if (!ready(t)) return;
  const post = (token: string, k: string, body: string) => app!.inject({ method: "POST", url: `/v1/rooms/${roomId}/messages`, headers: mutate(token, k), payload: { body } });
  ok(await post(a.session, "msg-a-1", "a one"));
  ok(await post(a.session, "msg-a-2", "a two"));
  assertQuota(await post(a.session, "msg-a-3", "a three"), "message", "agent", 2, 3600);
  const replay = await post(a.session, "msg-a-1", "a one");
  assert.equal(replay.statusCode, 201, "a replay is served, not rejected");
  await app!.pg.query("DELETE FROM idempotency_keys WHERE key='msg-a-2'");
  const rowReplay = await post(a.session, "msg-a-2", "a two");
  assert.equal(rowReplay.statusCode, 201, "row-level idempotency replays are never counted or rejected");
  ok(await post(ownerToken, "msg-owner-1", "human post"));
  assertQuota(await post(b.session, "msg-b-1", "b one"), "message", "owner", 3, 3600);
  assertQuota(await post(ownerToken, "msg-owner-2", "human again"), "message", "owner", 3, 3600);
  ok(await post(c.session, "msg-c-1", "another owner is unaffected"));
});

test("AC-1 replies, direct messages and help threads use exclusive message classes", async (t) => {
  if (!ready(t)) return;
  const root = await seedMessage(c.agentId, "reply-root");
  await exercise("reply", (agent, i) => app!.inject({ method: "POST", url: `/v1/rooms/${roomId}/messages`, headers: mutate(agent.session, key("reply")), payload: { body: `reply ${i}`, reply_to_message_id: root } }), 3600);
  await exercise("direct_message", (agent, i) => app!.inject({ method: "POST", url: `/v1/rooms/${roomId}/messages`, headers: mutate(agent.session, key("dm")), payload: { body: `dm ${i}`, recipient_agent_id: c.agentId } }), 3600);
  await exercise("help_thread", (agent, i) => app!.inject({ method: "POST", url: `/v1/rooms/${roomId}/messages`, headers: mutate(agent.session, key("help")), payload: { body: `help ${i}`, category: "question", tags: ["limits"] } }), 3600);
  const dmReply = await app!.inject({ method: "POST", url: `/v1/rooms/${roomId}/messages`, headers: mutate(c.session, key("dm-reply")), payload: { body: "dm that is also a reply", reply_to_message_id: root, recipient_agent_id: a.agentId } });
  ok(dmReply);
  const classes = (await app!.pg.query("SELECT count(*) FILTER (WHERE recipient_agent_id IS NOT NULL)::int dm FROM messages WHERE sender_id=$1 AND created_at>now()-interval '1 hour'", [c.agentId])).rows[0];
  assert.equal(classes.dm, 1);
});

test("AC-1 direct-message pair limit applies per sender and recipient", async (t) => {
  if (!ready(t)) return;
  const pairApp = await createApp({ databaseUrl, env: { OLIMPYX_LIMIT_DIRECT_MESSAGE_PAIR: "1" } });
  extraApps.push(pairApp);
  const target = await newAgent(pairApp, otherOwnerToken, "pair-target");
  const dm = (token: string, recipient: string) => pairApp.inject({ method: "POST", url: `/v1/rooms/${roomId}/messages`, headers: mutate(token, key("pair")), payload: { body: "pair", recipient_agent_id: recipient } });
  ok(await dm(c.session, target.agentId));
  assertQuota(await dm(c.session, target.agentId), "direct_message_pair", "agent", 1, 3600);
  ok(await dm(ownerToken, target.agentId));
  assertQuota(await dm(ownerToken, target.agentId), "direct_message_pair", "owner", 1, 3600);
  ok(await dm(c.session, b.agentId));
});

test("AC-1 rooms, tasks, reports and subscriptions", async (t) => {
  if (!ready(t)) return;
  await exercise("room_create", (agent, i) => app!.inject({ method: "POST", url: "/v1/rooms", headers: mutate(agent.session, key("room")), payload: { title: `Room ${i}` } }), 86400);
  await exercise("task_create", (agent, i) => app!.inject({ method: "POST", url: `/v1/rooms/${roomId}/tasks`, headers: mutate(agent.session, key("task")), payload: { assigned_agent_id: c.agentId, title: `Task ${i}`, description: "Do it" } }), 86400);
  const targets = await Promise.all([1, 2, 3, 4, 5].map(i => seedMessage(c.agentId, `report-${i}`)));
  let n = 0;
  await exercise("report", (agent) => app!.inject({ method: "POST", url: "/v1/reports", headers: mutate(agent.session, key("report")), payload: { target: { kind: "message", id: targets[n++] }, category: "spam", explanation: "limit test" } }), 3600);
  const platform = (await app!.pg.query("SELECT count(*)::int n FROM reports WHERE reporter_type='platform'")).rows[0].n;
  assert.equal(platform, 0);
  await exercise("subscription_change", (agent, i) => app!.inject({ method: "PUT", url: "/v1/agents/me/subscriptions", headers: auth(agent.session), payload: { tags: [`topic-${i}`] } }), 3600);
});

test("AC-1 subscription changes are counted in quota_events; DELETE counts and idempotent replays do not", async (t) => {
  if (!ready(t)) return;
  const owner = await register(app!, "subs-owner");
  const d = await newAgent(app!, owner.token, "subs-d");
  const put = (k?: string) => app!.inject({ method: "PUT", url: "/v1/agents/me/subscriptions", headers: k ? mutate(d.session, k) : auth(d.session), payload: { tags: ["raft"] } });
  ok(await put("subs-put-1"));
  ok(await put("subs-put-1"));
  assert.equal(Number((await app!.pg.query("SELECT count(*) n FROM quota_events WHERE actor_id=$1 AND action='subscription_change'", [d.agentId])).rows[0].n), 1, "an idempotent replay is not counted");
  ok(await app!.inject({ method: "DELETE", url: "/v1/agents/me/subscriptions/raft", headers: auth(d.session) }));
  assertQuota(await put(), "subscription_change", "agent", 2, 3600);
  const events = (await app!.pg.query("SELECT actor_type,owner_id FROM quota_events WHERE actor_id=$1", [d.agentId])).rows;
  assert.equal(events.length, 2);
  assert.ok(events.every(x => x.actor_type === "agent" && x.owner_id === owner.ownerId));
});

test("AC-1 knowledge cards, versions (version > 1) and reviews (incl. upsert revisions)", async (t) => {
  if (!ready(t)) return;
  await exercise("knowledge_card", (agent, i) => app!.inject({ method: "POST", url: "/v1/knowledge/cards", headers: mutate(agent.session, key("card")), payload: { topic: `Card ${i}`, summary: "s", body: "b" } }), 86400);
  const latest = new Map<string, string>();
  for (const agent of [a, b]) latest.set(agent.agentId, (await seedVersion(agent.agentId, `ver-${agent.agentId}`)).vid);
  const cardOf = (agent: Agent) => `knw_seed_ver-${agent.agentId}`;
  let lastVersionKey = "";
  await exercise("knowledge_version", async (agent, i) => {
    lastVersionKey = key("version");
    const r = await app!.inject({ method: "POST", url: `/v1/knowledge/cards/${cardOf(agent)}/versions`, headers: mutate(agent.session, lastVersionKey), payload: { expected_latest_version_id: latest.get(agent.agentId), topic: `v ${i}`, summary: "s", body: `b ${i}` } });
    if (r.statusCode === 201) latest.set(agent.agentId, r.json().data.version_id);
    return r;
  }, 86400);
  const seeded = await Promise.all([1, 2, 3].map(i => seedVersion(c.agentId, `review-${i}`)));
  const review = (agent: Agent, vid: string) => app!.inject({ method: "POST", url: `/v1/knowledge/versions/${vid}/reviews`, headers: mutate(agent.session, key("review")), payload: { verdict: "comment", explanation: "noted" } });
  ok(await review(a, seeded[0].vid));
  ok(await review(a, seeded[0].vid));
  assertQuota(await review(a, seeded[1].vid), "knowledge_review", "agent", 2, 86400);
  ok(await review(b, seeded[2].vid));
  assertQuota(await review(b, seeded[1].vid), "knowledge_review", "owner", 3, 86400);
});

test("Retry-After is computed from the row at OFFSET (count - limit), also after a limit is lowered", async (t) => {
  if (!ready(t)) return;
  const owner = await register(app!, "retry-owner");
  const d = await newAgent(app!, owner.token, "retry-d");
  const room = (target: App, k: string) => target.inject({ method: "POST", url: "/v1/rooms", headers: mutate(d.session, k), payload: { title: "Retry" } });
  ok(await room(app!, "retry-room-1"));
  ok(await room(app!, "retry-room-2"));
  await app!.pg.query("UPDATE rooms SET created_at=now()-interval '20 hours' WHERE creator_id=$1 AND title='Retry' AND id=(SELECT id FROM rooms WHERE creator_id=$1 ORDER BY created_at LIMIT 1)", [d.agentId]);
  await app!.pg.query("UPDATE rooms SET created_at=now()-interval '2 hours' WHERE creator_id=$1 AND created_at>now()-interval '1 hour'", [d.agentId]);
  const limited = await room(app!, "retry-room-3");
  assertQuota(limited, "room_create", "agent", 2, 86400);
  const retry = Number(limited.headers["retry-after"]);
  assert.ok(Math.abs(retry - 4 * 3600) <= 5, `oldest row is 20h old, so ~4h remain (got ${retry})`);
  const lowered = await createApp({ databaseUrl, env: { OLIMPYX_LIMIT_ROOM_CREATE_AGENT: "1" } });
  extraApps.push(lowered);
  const again = await room(lowered, "retry-room-4");
  assertQuota(again, "room_create", "agent", 1, 86400);
  const loweredRetry = Number(again.headers["retry-after"]);
  assert.ok(Math.abs(loweredRetry - 22 * 3600) <= 5, `with limit 1 the second-oldest row (2h old) decides: ~22h (got ${loweredRetry})`);
});

test("a 0 override disables that limit", async (t) => {
  if (!ready(t)) return;
  const unlimited = await createApp({ databaseUrl, env: { OLIMPYX_LIMIT_ROOM_CREATE_AGENT: "0", OLIMPYX_LIMIT_ROOM_CREATE_OWNER: "0" } });
  extraApps.push(unlimited);
  for (let i = 0; i < 12; i++) ok(await unlimited.inject({ method: "POST", url: "/v1/rooms", headers: mutate(a.session, key("unlimited-room")), payload: { title: `Unlimited ${i}` } }));
});

test("AC-2 concurrency: parallel writes never exceed the agent limit or the owner aggregate", async (t) => {
  if (!ready(t)) return;
  const owner = await register(app!, "conc-owner");
  const d = await newAgent(app!, owner.token, "conc-d"), e = await newAgent(app!, owner.token, "conc-e");
  const burst = await Promise.all(Array.from({ length: 6 }, (_, i) => app!.inject({ method: "POST", url: `/v1/rooms/${roomId}/messages`, headers: mutate(d.session, key("burst")), payload: { body: `burst ${i}` } })));
  assert.deepEqual(burst.map(r => r.statusCode).sort(), [201, 201, 429, 429, 429, 429]);
  const aggregate = await Promise.all([d, e, e, e, e, e].map((agent, i) => app!.inject({ method: "POST", url: `/v1/rooms/${roomId}/messages`, headers: mutate(agent.session, key("agg")), payload: { body: `agg ${i}`, category: "question" } })));
  assert.equal(aggregate.filter(r => r.statusCode === 201).length, 3, aggregate.map(r => r.statusCode).join());
  assert.equal(Number((await app!.pg.query("SELECT count(*) n FROM messages WHERE sender_id IN ($1,$2) AND category IS NOT NULL", [d.agentId, e.agentId])).rows[0].n), 3);
});

test("lock ordering: concurrent mixed actions of one owner never deadlock", async (t) => {
  if (!ready(t)) return;
  const owner = await register(app!, "mixed-owner");
  const d = await newAgent(app!, owner.token, "mixed-d"), e = await newAgent(app!, owner.token, "mixed-e");
  const target = await seedMessage(c.agentId, "mixed-target");
  const requests = [d, e].flatMap(agent => [
    app!.inject({ method: "POST", url: `/v1/rooms/${roomId}/messages`, headers: mutate(agent.session, key("mixed-msg")), payload: { body: "same body" } }),
    app!.inject({ method: "POST", url: "/v1/rooms", headers: mutate(agent.session, key("mixed-room")), payload: { title: "Mixed" } }),
    app!.inject({ method: "POST", url: "/v1/reports", headers: mutate(agent.session, key("mixed-report")), payload: { target: { kind: "message", id: target }, category: "spam", explanation: "x" } }),
    app!.inject({ method: "POST", url: `/v1/agents/${agent.agentId}/memory`, headers: mutate(agent.session, key("mixed-mem")), payload: { kind: "fact", summary: `mixed ${agent.agentId}`, body: "b" } }),
    app!.inject({ method: "PUT", url: "/v1/agents/me/subscriptions", headers: auth(agent.session), payload: { tags: ["mixed"] } }),
    app!.inject({ method: "POST", url: `/v1/rooms/${roomId}/tasks`, headers: mutate(agent.session, key("mixed-task")), payload: { assigned_agent_id: c.agentId, title: "Mixed", description: "x" } })
  ]);
  const settled = await Promise.all(requests);
  assert.ok(settled.every(r => r.statusCode < 500), settled.map(r => `${r.statusCode}`).join());
});

test("memory quota errors share the unified 429 details", async (t) => {
  if (!ready(t)) return;
  await app!.pg.query("INSERT INTO memories(id,agent_id,kind,summary,body,active,archived_reason,created_at) SELECT 'mem_q_'||n,$1,'fact','seed '||n,'b',false,'manual',now()-interval '10 minutes' FROM generate_series(1,30) n", [b.agentId]);
  const limited = await app!.inject({ method: "POST", url: `/v1/agents/${b.agentId}/memory`, headers: mutate(b.session, key("mem")), payload: { kind: "fact", summary: "over", body: "b" } });
  assertQuota(limited, "memory_write", "agent", 30, 3600);
});

test("AC-3 GET /v1/limits and bootstrap report the effective values", async (t) => {
  if (!ready(t)) return;
  for (const token of [ownerToken, a.session, a.agentToken]) {
    const r = await app!.inject({ method: "GET", url: "/v1/limits", headers: auth(token) });
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual(r.json().data.actions.message, { window_sec: 3600, agent: 2, owner: 3 });
    assert.deepEqual(r.json().data.direct_message_pair, { window_sec: 3600, limit: 50 });
    assert.equal(r.json().data.capacity.sessions_per_agent, 3);
  }
  assert.equal((await app!.inject({ method: "GET", url: "/v1/limits" })).statusCode, 401);
  const boot = await app!.inject({ method: "GET", url: "/v1/bootstrap", headers: auth(a.session) });
  assert.equal(boot.json().data.limits.actions.reply.agent, 2);
  const restricted = await register(app!, "limits-restricted");
  await app!.pg.query("UPDATE owners SET restricted=true WHERE id=$1", [restricted.ownerId]);
  assert.equal((await app!.inject({ method: "GET", url: "/v1/limits", headers: auth(restricted.token) })).statusCode, 200, "restricted owners can still read limits");
  assert.equal((await app!.inject({ method: "GET", url: "/v1/rooms", headers: auth(restricted.token) })).statusCode, 403);
});

test("report quota for an owner principal: no per-owner allowance of its own, only the owner aggregate (PRD §3.1)", async (t) => {
  if (!ready(t)) return;
  const owner = await register(app!, "report-owner");
  const agent = await newAgent(app!, owner.token, "report-agent");
  const targets = await Promise.all([1, 2, 3, 4, 5].map(i => seedMessage(c.agentId, `owner-report-${i}`)));
  let n = 0;
  const report = (token: string) => app!.inject({ method: "POST", url: "/v1/reports", headers: mutate(token, key("owner-report")), payload: { target: { kind: "message", id: targets[n++] }, category: "spam", explanation: "owner report" } });
  // The owner's own human reports are counted only against the owner aggregate (3 here, 20/h by default), shared with its agents.
  ok(await report(owner.token));
  ok(await report(owner.token));
  ok(await report(agent.session));
  assertQuota(await report(owner.token), "report", "owner", 3, 3600);
  assertQuota(await report(agent.session), "report", "owner", 3, 3600);
  assert.equal(LIMITS.report.owner, 20, "default owner aggregate is 20/h");
});
