import assert from "node:assert/strict";
import { Pool } from "pg";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test, type TestContext } from "node:test";
import { createApp, migrate } from "../src/app.js";

const baseUrl = process.env.DATABASE_URL ?? "postgres://olimpyx:olimpyx-local-only@127.0.0.1:55432/olimpyx";
const schema = `test_reslim_${randomUUID().replaceAll("-", "")}`;
let admin: Pool | null = null;
let pgAvailable = false;

const testUrl = new URL(baseUrl);
testUrl.searchParams.set("options", `-c search_path=${schema},public`);
const databaseUrl = testUrl.toString();

type App = Awaited<ReturnType<typeof createApp>>;
type Agent = { agentId: string; agentToken: string; session: string; installation: string };

let app: App | null = null;
const extraApps: App[] = [];
let roomId = "";
let keySeq = 0;
const key = (label: string) => `${label}-${++keySeq}`;
const moderatorToken = "resource-limits-moderator-token-0123456789";

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const mutate = (token: string, k: string) => ({ ...auth(token), "idempotency-key": k });
const modAuth = () => ({ authorization: `Bearer ${moderatorToken}` });

function ready(t: TestContext) {
  if (!pgAvailable || !app) { t.skip("PostgreSQL is not reachable at " + baseUrl); return false; }
  return true;
}

async function register(label: string) {
  const r = await app!.inject({ method: "POST", url: "/v1/owners/register", remoteAddress: `10.2.0.${++keySeq % 250}`, headers: { "idempotency-key": `reg-${label}` }, payload: { email: `${label}-${randomUUID()}@example.test`, password: "very secure password", display_name: label } });
  assert.equal(r.statusCode, 201, r.body);
  return { token: r.json().data.access_token as string, ownerId: r.json().data.owner.owner_id as string };
}

async function startSession(agentToken: string, installation: string, target: App = app!) {
  return target.inject({ method: "POST", url: "/v1/sessions", headers: mutate(agentToken, key("session")), payload: { installation_id: installation, host: { kind: "codex" }, persona_revision: 1 } });
}

async function newAgent(owner: string, label: string, target: App = app!): Promise<Agent> {
  const code = await target.inject({ method: "POST", url: "/v1/owners/me/enrollment-tokens", headers: mutate(owner, key(`code-${label}`)), payload: {} });
  assert.equal(code.statusCode, 201, code.body);
  const installation = `inst-${label}`;
  const enrolled = await target.inject({ method: "POST", url: "/v1/agents/enroll", headers: { "idempotency-key": key(`enroll-${label}`) }, payload: { enrollment_token: code.json().data.enrollment_token, installation_id: installation, profile: { name: `Agent ${label}`, role: "tester" } } });
  assert.equal(enrolled.statusCode, 201, enrolled.body);
  const agentId = enrolled.json().data.agent.agent_id, agentToken = enrolled.json().data.agent_token;
  const started = await startSession(agentToken, installation, target);
  assert.equal(started.statusCode, 201, started.body);
  return { agentId, agentToken, session: started.json().data.session_token, installation };
}

const rooms = (token: string) => app!.inject({ method: "GET", url: "/v1/rooms", headers: auth(token) });
const errorCode = (r: Awaited<ReturnType<App["inject"]>>) => r.json().error?.code;
const inbox = async (column: "agent_id" | "owner_id", id: string, type: string) =>
  (await app!.pg.query(`SELECT * FROM inbox_events WHERE ${column}=$1 AND type=$2 ORDER BY sequence`, [id, type])).rows;

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
  process.env.MODERATOR_TOKEN = moderatorToken;
  await admin.query("CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public");
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(databaseUrl);
  app = await createApp({ databaseUrl });
  const owner = await register("room-owner");
  const room = await app.inject({ method: "POST", url: "/v1/rooms", headers: mutate(owner.token, "room"), payload: { title: "Resource limits" } });
  roomId = room.json().data.room_id;
});
after(async () => {
  for (const extra of extraApps) await extra.close();
  if (app) await app.close();
  if (admin && pgAvailable) {
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await admin.end().catch(() => {});
  }
});

test("migrations add revoke, end-reason, payload and quota_events structures", async (t) => {
  if (!ready(t)) return;
  const columns = (await admin!.query("SELECT table_name||'.'||column_name c FROM information_schema.columns WHERE table_schema=$1", [schema])).rows.map(x => x.c);
  for (const column of ["agents.revoked_at", "sessions.end_reason", "inbox_events.payload", "quota_events.owner_id", "quota_events.actor_id"]) assert.ok(columns.includes(column), column);
  const indexes = (await admin!.query("SELECT indexname FROM pg_indexes WHERE schemaname=$1", [schema])).rows.map(x => x.indexname);
  for (const index of ["idx_quota_events_owner_action_created", "idx_quota_events_actor_action_created", "idx_sessions_agent_active", "idx_rooms_creator_created", "idx_tasks_assignee_open", "idx_tasks_creator_created", "idx_knowledge_cards_author_created", "idx_knowledge_versions_author_created", "idx_knowledge_reviews_reviewer_created", "idx_reports_reporter_created", "idx_enrollment_tokens_owner_unused", "idx_idempotency_created", "idx_messages_sender_created", "idx_inbox_events_occurred", "idx_inbox_events_agent_seq", "idx_inbox_events_owner_seq"]) assert.ok(indexes.includes(index), index);
});

test("AC-4 owner stop ends every session with a typed 401, records the event, and allows a new session", async (t) => {
  if (!ready(t)) return;
  const owner = await register("stop-owner"), other = await register("stop-other");
  const agent = await newAgent(owner.token, "stop");
  const second = (await startSession(agent.agentToken, agent.installation)).json().data;
  const stopUrl = `/v1/owners/me/agents/${agent.agentId}/stop`;
  assert.equal((await app!.inject({ method: "POST", url: stopUrl, headers: auth(owner.token), payload: {} })).statusCode, 400, "Idempotency-Key is required");
  const foreign = await app!.inject({ method: "POST", url: stopUrl, headers: mutate(other.token, key("stop-foreign")), payload: {} });
  assert.equal(foreign.statusCode, 403);
  assert.equal((await app!.inject({ method: "POST", url: stopUrl, headers: mutate(agent.session, key("stop-self")), payload: {} })).statusCode, 403, "owner-only route");
  assert.equal((await app!.inject({ method: "POST", url: `/v1/owners/me/agents/agt_missing/stop`, headers: mutate(owner.token, key("stop-missing")), payload: {} })).statusCode, 404);
  const secret = await app!.inject({ method: "POST", url: stopUrl, headers: mutate(owner.token, key("stop-secret")), payload: { reason: "token ghp_abcdefghijklmnopqrstuvwxyz0123" } });
  assert.equal(secret.statusCode, 422);
  assert.equal(errorCode(secret), "secret_detected");

  const stopped = await app!.inject({ method: "POST", url: stopUrl, headers: mutate(owner.token, key("stop")), payload: { reason: "Pause for review" } });
  assert.equal(stopped.statusCode, 200, stopped.body);
  assert.equal(stopped.json().data.agent_id, agent.agentId);
  assert.equal(stopped.json().data.session_ids.length, 2);
  for (const token of [agent.session, second.session_token]) {
    const r = await rooms(token);
    assert.equal(r.statusCode, 401);
    assert.equal(errorCode(r), "session_stopped");
  }
  const events = await inbox("agent_id", agent.agentId, "agent.stop_requested");
  assert.equal(events.length, 1);
  assert.equal(events[0].resource_kind, "agent");
  assert.equal(events[0].resource_id, agent.agentId);
  assert.equal(events[0].payload.reason, "Pause for review");
  assert.deepEqual([...events[0].payload.session_ids].sort(), [...stopped.json().data.session_ids].sort());
  assert.ok(stopped.json().data.session_ids.includes(second.session_id));

  const restarted = await startSession(agent.agentToken, agent.installation);
  assert.equal(restarted.statusCode, 201, "stop does not revoke");
  const listed = await app!.inject({ method: "GET", url: "/v1/inbox/events", headers: auth(restarted.json().data.session_token) });
  const event = listed.json().data.find((x: { type: string }) => x.type === "agent.stop_requested");
  assert.equal(event.data.reason, "Pause for review");
  assert.equal(event.resource.kind, "agent");
});

test("typed session failures: agent end stores end_reason, expiry and staleness map to session_expired", async (t) => {
  if (!ready(t)) return;
  const owner = await register("typed-owner");
  const agent = await newAgent(owner.token, "typed");
  const sessionId = (await app!.pg.query("SELECT id FROM sessions WHERE agent_id=$1", [agent.agentId])).rows[0].id;
  const ended = await app!.inject({ method: "POST", url: `/v1/sessions/${sessionId}/end`, headers: mutate(agent.session, key("end")), payload: { reason: "host_ended" } });
  assert.equal(ended.statusCode, 200);
  assert.equal((await app!.pg.query("SELECT end_reason FROM sessions WHERE id=$1", [sessionId])).rows[0].end_reason, "host_ended");
  const after = await rooms(agent.session);
  assert.equal(after.statusCode, 401);
  assert.equal(errorCode(after), "session_expired");
  const fresh = (await startSession(agent.agentToken, agent.installation)).json().data.session_token;
  await app!.pg.query("UPDATE sessions SET last_heartbeat_at=now()-interval '5 minutes' WHERE agent_id=$1 AND ended_at IS NULL", [agent.agentId]);
  const stale = await rooms(fresh);
  assert.equal(stale.statusCode, 401);
  assert.equal(errorCode(stale), "session_expired");
  const unknown = await rooms("not-a-real-token");
  assert.equal(unknown.statusCode, 401);
  assert.equal(errorCode(unknown), "unauthorized");
});

test("AC-5 revoke: typed 401 on sessions and tokens, auth tokens revoked, event recorded, owner list shows revoked", async (t) => {
  if (!ready(t)) return;
  const owner = await register("revoke-owner");
  const agent = await newAgent(owner.token, "revoke"), sibling = await newAgent(owner.token, "revoke-sibling");
  const revoked = await app!.inject({ method: "POST", url: `/v1/owners/me/agents/${agent.agentId}/revoke`, headers: auth(owner.token) });
  assert.equal(revoked.statusCode, 200);
  const old = await rooms(agent.session);
  assert.equal(old.statusCode, 401);
  assert.equal(errorCode(old), "agent_revoked");
  const restart = await startSession(agent.agentToken, agent.installation);
  assert.equal(restart.statusCode, 401);
  assert.equal(errorCode(restart), "agent_revoked");
  const tokenRow = (await app!.pg.query("SELECT revoked_at FROM auth_tokens WHERE actor_type='agent' AND actor_id=$1", [agent.agentId])).rows[0];
  assert.ok(tokenRow.revoked_at);
  assert.equal((await app!.pg.query("SELECT end_reason FROM sessions WHERE agent_id=$1", [agent.agentId])).rows[0].end_reason, "revoked");
  const events = await inbox("agent_id", agent.agentId, "agent.revoked");
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].payload, {});
  // Even if the token row itself were un-revoked, the agent's revoked_at still wins.
  await app!.pg.query("UPDATE auth_tokens SET revoked_at=NULL WHERE actor_id=$1", [agent.agentId]);
  assert.equal(errorCode(await startSession(agent.agentToken, agent.installation)), "agent_revoked");
  const listed = await app!.inject({ method: "GET", url: "/v1/owners/me/agents", headers: auth(owner.token) });
  const byId = new Map(listed.json().data.map((x: { agent_id: string; revoked: boolean }) => [x.agent_id, x.revoked]));
  assert.equal(byId.get(agent.agentId), true);
  assert.equal(byId.get(sibling.agentId), false);
});

test("AC-5 restriction ends sessions with end_reason, records agent.restricted, answers 403; revoked agents are never touched", async (t) => {
  if (!ready(t)) return;
  const owner = await register("restrict-owner"), reporter = await register("restrict-reporter");
  const agent = await newAgent(owner.token, "restrict"), revokedAgent = await newAgent(owner.token, "restrict-revoked");
  await app!.inject({ method: "POST", url: `/v1/owners/me/agents/${revokedAgent.agentId}/revoke`, headers: auth(owner.token) });
  const report = await app!.inject({ method: "POST", url: "/v1/reports", headers: mutate(reporter.token, key("report")), payload: { target: { kind: "profile", id: agent.agentId }, category: "spam", explanation: "spam" } });
  assert.equal(report.statusCode, 201, report.body);
  const incident = (await app!.pg.query("SELECT * FROM incidents WHERE report_id=$1", [report.json().data.report_id])).rows[0];
  const restricted = await app!.inject({ method: "PATCH", url: `/v1/moderation/incidents/${incident.id}`, headers: modAuth(), payload: { expected_revision: incident.revision, action: "restrict_owner_temporary", duration_sec: 3600 } });
  assert.equal(restricted.statusCode, 200, restricted.body);
  const denied = await rooms(agent.session);
  assert.equal(denied.statusCode, 403);
  assert.equal(errorCode(denied), "restricted");
  assert.equal((await app!.pg.query("SELECT end_reason FROM sessions WHERE agent_id=$1", [agent.agentId])).rows[0].end_reason, "restricted");
  const events = await inbox("agent_id", agent.agentId, "agent.restricted");
  assert.equal(events.length, 1);
  assert.equal(events[0].payload.restriction_kind, "temporary");
  assert.equal(events[0].payload.incident_id, incident.id);
  assert.ok(events[0].payload.restricted_until);
  const untouched = (await app!.pg.query("SELECT restricted_until,restriction_kind,revoked_at FROM agents WHERE id=$1", [revokedAgent.agentId])).rows[0];
  assert.equal(untouched.restricted_until, null, "owner restriction must not give a revoked agent an expiry");
  assert.ok(untouched.revoked_at);
  assert.equal((await inbox("agent_id", revokedAgent.agentId, "agent.restricted")).length, 0);
  assert.equal(errorCode(await startSession(revokedAgent.agentToken, revokedAgent.installation)), "agent_revoked");

  const current = (await app!.pg.query("SELECT * FROM incidents WHERE id=$1", [incident.id])).rows[0];
  const granted = await app!.inject({ method: "PATCH", url: `/v1/moderation/incidents/${incident.id}`, headers: modAuth(), payload: { expected_revision: current.revision, action: "grant_appeal" } });
  assert.equal(granted.statusCode, 200, granted.body);
  assert.equal((await app!.pg.query("SELECT restricted FROM agents WHERE id=$1", [revokedAgent.agentId])).rows[0].restricted, true, "grant_appeal never un-revokes");
  assert.equal((await startSession(agent.agentToken, agent.installation)).statusCode, 201);
  assert.equal(errorCode(await startSession(revokedAgent.agentToken, revokedAgent.installation)), "agent_revoked");
});

test("AC-6 tasks: decline, creator notifications, cancel signal and invalid transitions", async (t) => {
  if (!ready(t)) return;
  const owner = await register("task-owner"), other = await register("task-other");
  const assignee = await newAgent(other.token, "assignee");
  const create = (token: string, assigned = assignee.agentId) => app!.inject({ method: "POST", url: `/v1/rooms/${roomId}/tasks`, headers: mutate(token, key("task")), payload: { assigned_agent_id: assigned, title: "Research", description: "Do it" } });
  const patch = (taskId: string, payload: Record<string, unknown>) => app!.inject({ method: "PATCH", url: `/v1/tasks/${taskId}`, headers: mutate(assignee.session, key("patch")), payload });

  const declined = (await create(owner.token)).json().data.task_id;
  const decline = await patch(declined, { status: "cancelled", result: "Out of scope for me" });
  assert.equal(decline.statusCode, 200, decline.body);
  assert.equal(decline.json().data.status, "cancelled");
  const changed = (await inbox("owner_id", owner.ownerId, "task.changed")).filter(x => x.resource_id === declined);
  assert.equal(changed.length, 1);
  assert.deepEqual(changed[0].payload, { by: { actor_type: "agent", actor_id: assignee.agentId }, status: "cancelled" });

  const accepted = (await create(owner.token)).json().data.task_id;
  assert.equal((await patch(accepted, { status: "accepted" })).statusCode, 200);
  assert.equal((await patch(accepted, { status: "cancelled", result: "declining after accept" })).statusCode, 200);

  const started = (await create(owner.token)).json().data.task_id;
  assert.equal((await patch(started, { status: "in_progress" })).statusCode, 200);
  const late = await patch(started, { status: "cancelled", result: "too late" });
  assert.equal(late.statusCode, 409);
  assert.equal(errorCode(late), "invalid_task_transition");
  const secret = await patch((await create(owner.token)).json().data.task_id, { status: "cancelled", result: "password=supersecretvalue123" });
  assert.equal(secret.statusCode, 422);

  const cancel = await app!.inject({ method: "POST", url: `/v1/tasks/${started}/cancel`, headers: mutate(owner.token, key("cancel")), payload: {} });
  assert.equal(cancel.statusCode, 200, cancel.body);
  const cancelled = (await inbox("agent_id", assignee.agentId, "task.cancelled")).filter(x => x.resource_id === started);
  assert.equal(cancelled.length, 1);
  assert.deepEqual(cancelled[0].payload, { by: { actor_type: "owner", actor_id: owner.ownerId }, status: "cancelled" });
  const listed = await app!.inject({ method: "GET", url: "/v1/inbox/events?limit=100", headers: auth(assignee.session) });
  assert.ok(listed.json().data.some((x: { type: string; data: { status: string } }) => x.type === "task.cancelled" && x.data.status === "cancelled"));

  const agentCreator = await newAgent(owner.token, "creator");
  const byAgent = (await create(agentCreator.session)).json().data.task_id;
  assert.equal((await patch(byAgent, { status: "accepted" })).statusCode, 200);
  assert.equal((await inbox("agent_id", agentCreator.agentId, "task.changed")).filter(x => x.resource_id === byAgent).length, 1, "agent creators are notified by agent_id");
  const selfTask = (await create(assignee.session)).json().data.task_id;
  const before = (await inbox("agent_id", assignee.agentId, "task.changed")).length;
  assert.equal((await patch(selfTask, { status: "accepted" })).statusCode, 200);
  assert.equal((await inbox("agent_id", assignee.agentId, "task.changed")).length, before, "no self-notification when creator is the assignee");
});

test("AC-6 task creation: missing, revoked or restricted assignee is 422; capacity is 409 and atomic", async (t) => {
  if (!ready(t)) return;
  const owner = await register("assign-owner");
  const create = (target: App, assigned: string) => target.inject({ method: "POST", url: `/v1/rooms/${roomId}/tasks`, headers: mutate(owner.token, key("assign")), payload: { assigned_agent_id: assigned, title: "T", description: "D" } });
  const missing = await create(app!, "agt_does_not_exist");
  assert.equal(missing.statusCode, 422);
  assert.equal(errorCode(missing), "assignee_unavailable");
  const restrictedAgent = await newAgent(owner.token, "assign-restricted");
  await app!.pg.query("UPDATE agents SET restricted=true,restriction_kind='permanent' WHERE id=$1", [restrictedAgent.agentId]);
  assert.equal(errorCode(await create(app!, restrictedAgent.agentId)), "assignee_unavailable");
  const revokedAgent = await newAgent(owner.token, "assign-revoked");
  await app!.inject({ method: "POST", url: `/v1/owners/me/agents/${revokedAgent.agentId}/revoke`, headers: auth(owner.token) });
  assert.equal(errorCode(await create(app!, revokedAgent.agentId)), "assignee_unavailable");

  const capped = await createApp({ databaseUrl, env: { OLIMPYX_CAP_OPEN_TASKS_PER_ASSIGNEE: "2" } });
  extraApps.push(capped);
  const busy = await newAgent(owner.token, "assign-busy");
  const burst = await Promise.all([1, 2, 3, 4].map(() => create(capped, busy.agentId)));
  assert.deepEqual(burst.map(r => r.statusCode).sort(), [201, 201, 409, 409]);
  assert.ok(burst.filter(r => r.statusCode === 409).every(r => errorCode(r) === "assignee_at_capacity"));
  const done = burst.find(r => r.statusCode === 201)!.json().data.task_id;
  await app!.inject({ method: "PATCH", url: `/v1/tasks/${done}`, headers: mutate(busy.session, key("done")), payload: { status: "completed", result: "done" } });
  assert.equal((await create(capped, busy.agentId)).statusCode, 201, "terminal tasks free capacity");
});

test("AC-7 capacity: 6th live enrollment token and 11th active agent are 409; revoked agents free a slot", async (t) => {
  if (!ready(t)) return;
  const owner = await register("cap-owner");
  const code = () => app!.inject({ method: "POST", url: "/v1/owners/me/enrollment-tokens", headers: mutate(owner.token, key("cap-code")), payload: {} });
  const tokens: string[] = [];
  for (let i = 0; i < 5; i++) { const r = await code(); assert.equal(r.statusCode, 201); tokens.push(r.json().data.enrollment_token); }
  const sixth = await code();
  assert.equal(sixth.statusCode, 409);
  assert.equal(errorCode(sixth), "enrollment_token_limit_reached");
  const hashOf = (raw: string) => createHash("sha256").update(raw).digest("hex");
  await app!.pg.query("UPDATE enrollment_tokens SET expires_at=now()-interval '1 second' WHERE token_hash=$1", [hashOf(tokens[0])]);
  assert.equal((await code()).statusCode, 201, "expired tokens are not live");

  await app!.pg.query("INSERT INTO agents(id,owner_id,installation_id,name,role) SELECT 'agt_cap_'||n||'_'||$2,$1,'cap-'||n,'Cap '||n,'tester' FROM generate_series(1,9) n", [owner.ownerId, owner.ownerId.slice(-6)]);
  const enroll = (enrollmentToken: string) => app!.inject({ method: "POST", url: "/v1/agents/enroll", headers: { "idempotency-key": key("cap-enroll") }, payload: { enrollment_token: enrollmentToken, installation_id: `cap-inst-${keySeq}`, profile: { name: "Cap", role: "tester" } } });
  const tenth = await enroll(tokens[1]);
  assert.equal(tenth.statusCode, 201, tenth.body);
  const eleventh = await enroll(tokens[2]);
  assert.equal(eleventh.statusCode, 409);
  assert.equal(errorCode(eleventh), "agent_limit_reached");
  assert.equal((await app!.pg.query("SELECT used_at FROM enrollment_tokens WHERE token_hash=$1", [hashOf(tokens[2])])).rows[0].used_at, null, "a rejected enrollment does not consume the token");
  const blocked = await code();
  assert.equal(blocked.statusCode, 409);
  assert.equal(errorCode(blocked), "agent_limit_reached");

  await app!.pg.query("UPDATE agents SET restricted=true,restriction_kind='permanent' WHERE id=$1", [`agt_cap_1_${owner.ownerId.slice(-6)}`]);
  assert.equal(errorCode(await enroll(tokens[2])), "agent_limit_reached", "restricted agents still count");
  const revoked = await app!.inject({ method: "POST", url: `/v1/owners/me/agents/${tenth.json().data.agent.agent_id}/revoke`, headers: auth(owner.token) });
  assert.equal(revoked.statusCode, 200);
  assert.equal((await enroll(tokens[2])).statusCode, 201, "revoked agents do not count");
});

test("AC-7 a 4th active session supersedes the oldest; stale sessions do not count", async (t) => {
  if (!ready(t)) return;
  const owner = await register("sessions-owner");
  const agent = await newAgent(owner.token, "sessions");
  const tokens = [agent.session];
  for (let i = 0; i < 3; i++) tokens.push((await startSession(agent.agentToken, agent.installation)).json().data.session_token);
  const oldest = await rooms(tokens[0]);
  assert.equal(oldest.statusCode, 401);
  assert.equal(errorCode(oldest), "session_superseded");
  for (const token of tokens.slice(1)) assert.equal((await rooms(token)).statusCode, 200);
  assert.equal((await app!.pg.query("SELECT count(*)::int n FROM sessions WHERE agent_id=$1 AND end_reason='superseded'", [agent.agentId])).rows[0].n, 1);

  await app!.pg.query("UPDATE sessions SET last_heartbeat_at=now()-interval '5 minutes' WHERE agent_id=$1 AND ended_at IS NULL AND created_at=(SELECT min(created_at) FROM sessions WHERE agent_id=$1 AND ended_at IS NULL)", [agent.agentId]);
  const fifth = (await startSession(agent.agentToken, agent.installation)).json().data.session_token;
  assert.equal((await app!.pg.query("SELECT count(*)::int n FROM sessions WHERE agent_id=$1 AND end_reason='superseded'", [agent.agentId])).rows[0].n, 1, "the stale session freed a slot");
  assert.equal((await rooms(fifth)).statusCode, 200);

  const parallel = await Promise.all([1, 2, 3, 4].map(() => startSession(agent.agentToken, agent.installation)));
  assert.ok(parallel.every(r => r.statusCode === 201));
  const active = (await app!.pg.query("SELECT count(*)::int n FROM sessions WHERE agent_id=$1 AND ended_at IS NULL AND last_heartbeat_at>now()-interval '90 seconds'", [agent.agentId])).rows[0].n;
  assert.equal(active, 3, "concurrent starts never exceed the cap");
});

test("typed principal order: credential class before revoke, revoke before restriction", async (t) => {
  if (!ready(t)) return;
  const owner = await register("order-owner");
  const agent = await newAgent(owner.token, "order");
  await app!.pg.query("UPDATE agents SET restricted=true,restriction_kind='permanent' WHERE id=$1", [agent.agentId]);
  assert.equal(errorCode(await rooms(agent.session)), "restricted");
  await app!.inject({ method: "POST", url: `/v1/owners/me/agents/${agent.agentId}/revoke`, headers: auth(owner.token) });
  assert.equal(errorCode(await rooms(agent.session)), "agent_revoked");
  const wrongClass = await app!.inject({ method: "GET", url: "/v1/bootstrap", headers: auth(agent.agentToken) });
  assert.equal(wrongClass.statusCode, 403);
  assert.equal(errorCode(wrongClass), "forbidden");
});

test("AC-10 usage: window usage and 7/30-day contribution counters per agent and aggregate, owner-private", async (t) => {
  if (!ready(t)) return;
  const owner = await register("usage-owner"), other = await register("usage-other");
  const a = await newAgent(owner.token, "usage-a"), b = await newAgent(owner.token, "usage-b");
  const x = await newAgent(other.token, "usage-x");
  const post = (token: string, payload: Record<string, unknown>) => app!.inject({ method: "POST", url: `/v1/rooms/${roomId}/messages`, headers: mutate(token, key("usage-msg")), payload });
  const thread = (await post(a.session, { body: "help me", category: "question" })).json().data.message_id;
  const foreign = (await post(x.session, { body: "x asks", category: "question" })).json().data.message_id;
  await post(a.session, { body: "plain" });
  await post(a.session, { body: "reply in other thread", reply_to_message_id: foreign });
  await post(a.session, { body: "reply in own thread", reply_to_message_id: thread });
  await post(b.session, { body: "b plain" });
  assert.equal((await app!.inject({ method: "PATCH", url: `/v1/rooms/${roomId}/messages/${thread}/status`, headers: auth(a.session), payload: { status: "resolved" } })).statusCode, 200);
  const card = await app!.inject({ method: "POST", url: "/v1/knowledge/cards", headers: mutate(a.session, key("usage-card")), payload: { topic: "Usage", summary: "s", body: "b" } });
  const version = await app!.inject({ method: "POST", url: `/v1/knowledge/cards/${card.json().data.card_id}/versions`, headers: mutate(a.session, key("usage-version")), payload: { expected_latest_version_id: card.json().data.latest_version_id, topic: "Usage 2", summary: "s", body: "b2" } });
  assert.equal(version.statusCode, 201);
  const xCard = await app!.inject({ method: "POST", url: "/v1/knowledge/cards", headers: mutate(x.session, key("usage-xcard")), payload: { topic: "X", summary: "s", body: "b" } });
  assert.equal((await app!.inject({ method: "POST", url: `/v1/knowledge/versions/${xCard.json().data.latest_version_id}/reviews`, headers: mutate(a.session, key("usage-review")), payload: { verdict: "confirm", explanation: "ok" } })).statusCode, 201);
  const forOthers = await app!.inject({ method: "POST", url: `/v1/rooms/${roomId}/tasks`, headers: mutate(other.token, key("usage-task")), payload: { assigned_agent_id: a.agentId, title: "For X", description: "d" } });
  const forSelf = await app!.inject({ method: "POST", url: `/v1/rooms/${roomId}/tasks`, headers: mutate(owner.token, key("usage-task")), payload: { assigned_agent_id: a.agentId, title: "Own", description: "d" } });
  for (const task of [forOthers, forSelf]) assert.equal((await app!.inject({ method: "PATCH", url: `/v1/tasks/${task.json().data.task_id}`, headers: mutate(a.session, key("usage-done")), payload: { status: "completed", result: "done" } })).statusCode, 200);
  await app!.inject({ method: "POST", url: `/v1/rooms/${roomId}/messages`, headers: mutate(owner.token, key("usage-human")), payload: { body: "human post" } });

  const usage = await app!.inject({ method: "GET", url: "/v1/owners/me/usage", headers: auth(owner.token) });
  assert.equal(usage.statusCode, 200, usage.body);
  const data = usage.json().data;
  assert.deepEqual(data.agents.map((y: { agent_id: string }) => y.agent_id).sort(), [a.agentId, b.agentId].sort());
  const ua = data.agents.find((y: { agent_id: string }) => y.agent_id === a.agentId);
  assert.deepEqual(ua.window.message, { used: 1, limit: 60, window_sec: 3600 });
  assert.equal(ua.window.help_thread.used, 1);
  assert.equal(ua.window.reply.used, 2);
  assert.equal(ua.window.knowledge_version.used, 1);
  assert.equal(data.owner.window.message.used, 3, "owner aggregate counts a, b and the human post");
  assert.equal(data.owner.window.message.limit, 200);
  for (const period of ["days_7", "days_30"]) {
    assert.deepEqual(ua.counters[period], { messages: 4, replies_in_other_threads: 1, own_threads_resolved: 1, knowledge_cards: 1, knowledge_versions: 1, reviews_given: 1, tasks_completed_for_others: 1 });
    assert.equal(data.owner.counters[period].messages, 5);
  }
  assert.equal(JSON.stringify(data).includes(x.agentId), false, "another owner's agents never appear");
  const own = await app!.inject({ method: "GET", url: "/v1/agents/me/usage", headers: auth(a.session) });
  assert.equal(own.statusCode, 200, own.body);
  assert.equal(own.json().data.agent_id, a.agentId);
  assert.equal(own.json().data.counters.days_7.tasks_completed_for_others, 1);
  assert.equal((await app!.inject({ method: "GET", url: "/v1/owners/me/usage", headers: auth(a.session) })).statusCode, 403);
  assert.equal((await app!.inject({ method: "GET", url: "/v1/agents/me/usage", headers: auth(owner.token) })).statusCode, 403);
  const showcase = await app!.inject({ method: "GET", url: "/v1/showcase" });
  assert.equal(JSON.stringify(showcase.json()).includes("counters"), false);
});
