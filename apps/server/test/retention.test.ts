import assert from "node:assert/strict";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { after, before, test, type TestContext } from "node:test";
import { createApp, migrate } from "../src/app.js";
import { pruneOnce, startPruning, RETENTION_LOCK_KEY, type PruneLogger } from "../src/retention.js";
import { LONGEST_LIMIT_WINDOW_SEC } from "../src/limits.js";

const baseUrl = process.env.DATABASE_URL ?? "postgres://olimpyx:olimpyx-local-only@127.0.0.1:55432/olimpyx";
const schema = `test_retention_${randomUUID().replaceAll("-", "")}`;
let admin: Pool | null = null;
let pgAvailable = false;

const testUrl = new URL(baseUrl);
testUrl.searchParams.set("options", `-c search_path=${schema},public`);
const databaseUrl = testUrl.toString();

type App = Awaited<ReturnType<typeof createApp>>;
let app: App | null = null;

function ready(t: TestContext) {
  if (!pgAvailable || !app) { t.skip("PostgreSQL is not reachable at " + baseUrl); return false; }
  return true;
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

// -- fixture helpers (direct SQL: retention operates below the API, and tests need exact timestamps) --

async function makeOwner(label: string): Promise<string> {
  const id = `own_${label}_${randomUUID().replaceAll("-", "")}`;
  await app!.pg.query("INSERT INTO owners(id,email,password_hash,display_name) VALUES($1,$2,'x','Owner')", [id, `${id}@example.test`]);
  return id;
}

async function makeAgent(ownerId: string, label: string): Promise<string> {
  const id = `agt_${label}_${randomUUID().replaceAll("-", "")}`;
  await app!.pg.query(
    "INSERT INTO agents(id,owner_id,installation_id,name,role) VALUES($1,$2,$3,'Agent','tester')",
    [id, ownerId, `inst-${id}`]
  );
  return id;
}

/** Inserts a session with explicit timestamps so retention boundaries are exact, not wall-clock-flaky. */
async function makeSession(agentId: string, opts: { heartbeatAgo: string; endedAgo?: string | null; expiresAgo?: string }): Promise<string> {
  const id = `ses_${randomUUID().replaceAll("-", "")}`;
  const endedAtExpr = opts.endedAgo ? `now() - interval '${opts.endedAgo}'` : "NULL";
  const expiresAtExpr = opts.expiresAgo ? `now() - interval '${opts.expiresAgo}'` : `now() - interval '${opts.heartbeatAgo}' + interval '1 hour'`;
  await app!.pg.query(
    `INSERT INTO sessions(id,agent_id,token_hash,host,persona_revision,expires_at,last_heartbeat_at,ended_at,created_at)
     VALUES($1,$2,$3,'{}'::jsonb,1, ${expiresAtExpr}, now() - interval '${opts.heartbeatAgo}', ${endedAtExpr}, now() - interval '${opts.heartbeatAgo}')`,
    [id, agentId, `th_${id}`]
  );
  return id;
}

async function makeInboxEvent(target: { agentId?: string; ownerId?: string }, ago: string): Promise<number> {
  const id = `evt_${randomUUID().replaceAll("-", "")}`;
  const r = await app!.pg.query(
    `INSERT INTO inbox_events(id,agent_id,owner_id,type,resource_kind,resource_id,occurred_at)
     VALUES($1,$2,$3,'message.created','message','res',now() - interval '${ago}') RETURNING sequence`,
    [id, target.agentId ?? null, target.ownerId ?? null]
  );
  return Number(r.rows[0].sequence);
}

async function setCheckpoint(actorType: "agent" | "owner", actorId: string, sequence: number): Promise<void> {
  await app!.pg.query(
    "INSERT INTO inbox_checkpoints(actor_type,actor_id,sequence) VALUES($1,$2,$3) ON CONFLICT(actor_type,actor_id) DO UPDATE SET sequence=excluded.sequence",
    [actorType, actorId, sequence]
  );
}

async function makeIdempotencyKey(label: string, ago: string): Promise<string> {
  const actorKey = `idem_${label}_${randomUUID().replaceAll("-", "")}`;
  await app!.pg.query(
    `INSERT INTO idempotency_keys(actor_key,key,body_hash,status,response,created_at)
     VALUES($1,'k','hash',200,'{}'::jsonb, now() - interval '${ago}')`,
    [actorKey]
  );
  return actorKey;
}

async function makeQuotaEvent(ownerId: string, ago: string): Promise<number> {
  const r = await app!.pg.query(
    "INSERT INTO quota_events(action,actor_type,actor_id,owner_id,created_at) VALUES('subscription_change','owner',$1,$1, now() - interval '" + ago + "') RETURNING id",
    [ownerId]
  );
  return Number(r.rows[0].id);
}

const rowExists = async (table: string, column: string, value: string | number) =>
  (await app!.pg.query(`SELECT 1 FROM ${table} WHERE ${column}=$1`, [value])).rowCount! > 0;

test("invalid retention env throws synchronously, without touching the DB", async (t) => {
  if (!ready(t)) return;
  await assert.rejects(() => pruneOnce(app!.pg, { OLIMPYX_RETENTION_IDEMPOTENCY_DAYS: "not-a-number" }));
  await assert.rejects(() => pruneOnce(app!.pg, { OLIMPYX_RETENTION_SESSIONS_DAYS: "0" }));
  await assert.rejects(() => pruneOnce(app!.pg, { OLIMPYX_RETENTION_INBOX_DAYS: "-3" }));
  // the lock must not be left held by a rejected attempt
  const result = await pruneOnce(app!.pg, {});
  assert.equal(result.skipped, false);
});

test("idempotency_keys: only rows past OLIMPYX_RETENTION_IDEMPOTENCY_DAYS are deleted (boundary)", async (t) => {
  if (!ready(t)) return;
  const stale = await makeIdempotencyKey("stale", "7 days 1 minute");
  const fresh = await makeIdempotencyKey("fresh", "6 days 23 hours");
  const result = await pruneOnce(app!.pg, {});
  assert.equal(result.skipped, false);
  assert.equal(await rowExists("idempotency_keys", "actor_key", stale), false);
  assert.equal(await rowExists("idempotency_keys", "actor_key", fresh), true);
});

test("sessions: past-retention rows are pruned but each agent's most-recent session is kept even if old", async (t) => {
  if (!ready(t)) return;
  const owner = await makeOwner("s1");
  const agent = await makeAgent(owner, "s1");
  // both sessions are well past the 30-day default retention
  const oldest = await makeSession(agent, { heartbeatAgo: "40 days", endedAgo: "40 days" });
  const latest = await makeSession(agent, { heartbeatAgo: "32 days", endedAgo: "32 days" });

  const other = await makeAgent(owner, "s1b");
  const withinRetention = await makeSession(other, { heartbeatAgo: "5 days", endedAgo: "5 days" });

  const result = await pruneOnce(app!.pg, {});
  assert.equal(result.skipped, false);
  assert.equal(await rowExists("sessions", "id", oldest), false, "session past retention and not the agent's latest must be deleted");
  assert.equal(await rowExists("sessions", "id", latest), true, "the agent's single most-recent session is kept regardless of age");
  assert.equal(await rowExists("sessions", "id", withinRetention), true, "session inside the retention window is kept");
});

test("sessions: boundary just before/after OLIMPYX_RETENTION_SESSIONS_DAYS", async (t) => {
  if (!ready(t)) return;
  const owner = await makeOwner("s2");
  // agentOld gets a fresh "latest" session plus the boundary session, so the "keep latest" exception
  // (tested separately above) doesn't mask the plain age boundary being tested here.
  const agentOld = await makeAgent(owner, "s2old");
  await makeSession(agentOld, { heartbeatAgo: "5 days", endedAgo: "5 days" }); // this agent's actual latest
  const justPast = await makeSession(agentOld, { heartbeatAgo: "30 days 1 minute", endedAgo: "30 days 1 minute" });

  const agentFresh = await makeAgent(owner, "s2fresh");
  const justWithin = await makeSession(agentFresh, { heartbeatAgo: "29 days 23 hours", endedAgo: "29 days 23 hours" });

  const result = await pruneOnce(app!.pg, {});
  assert.equal(result.skipped, false);
  assert.equal(await rowExists("sessions", "id", justPast), false);
  assert.equal(await rowExists("sessions", "id", justWithin), true);
});

test("inbox_events: unacknowledged events are never deleted, even past retention", async (t) => {
  if (!ready(t)) return;
  const owner = await makeOwner("i1");
  const agent = await makeAgent(owner, "i1");
  const unacked = await makeInboxEvent({ agentId: agent }, "40 days");
  // no checkpoint row at all for this agent
  const result = await pruneOnce(app!.pg, {});
  assert.equal(result.skipped, false);
  assert.equal(await rowExists("inbox_events", "sequence", unacked), true);
});

test("inbox_events: acknowledged agent events are pruned by the ('agent', agent_id) checkpoint", async (t) => {
  if (!ready(t)) return;
  const owner = await makeOwner("i2");
  const agent = await makeAgent(owner, "i2");
  const acked = await makeInboxEvent({ agentId: agent }, "40 days");
  const notYetAcked = await makeInboxEvent({ agentId: agent }, "35 days");
  await setCheckpoint("agent", agent, acked); // checkpoint sits exactly at `acked`, before `notYetAcked`

  const result = await pruneOnce(app!.pg, {});
  assert.equal(result.skipped, false);
  assert.equal(await rowExists("inbox_events", "sequence", acked), false, "acknowledged (sequence <= checkpoint) must be pruned");
  assert.equal(await rowExists("inbox_events", "sequence", notYetAcked), true, "sequence beyond the checkpoint is unacknowledged and kept");
});

test("inbox_events: owner-scoped events are pruned by the ('owner', owner_id) checkpoint, independent of agent checkpoints", async (t) => {
  if (!ready(t)) return;
  const owner = await makeOwner("i3");
  const agent = await makeAgent(owner, "i3");
  const ownerAcked = await makeInboxEvent({ ownerId: owner }, "40 days");
  const agentUnacked = await makeInboxEvent({ agentId: agent }, "40 days");
  await setCheckpoint("owner", owner, ownerAcked);
  // deliberately no checkpoint for the agent

  const result = await pruneOnce(app!.pg, {});
  assert.equal(result.skipped, false);
  assert.equal(await rowExists("inbox_events", "sequence", ownerAcked), false);
  assert.equal(await rowExists("inbox_events", "sequence", agentUnacked), true, "an owner checkpoint must not acknowledge the agent's own events");
});

test("inbox_events: boundary just before/after OLIMPYX_RETENTION_INBOX_DAYS", async (t) => {
  if (!ready(t)) return;
  const owner = await makeOwner("i4");
  const agent = await makeAgent(owner, "i4");
  const justPast = await makeInboxEvent({ agentId: agent }, "30 days 1 minute");
  const justWithin = await makeInboxEvent({ agentId: agent }, "29 days 23 hours");
  await setCheckpoint("agent", agent, justWithin); // both are acknowledged; only age decides

  const result = await pruneOnce(app!.pg, {});
  assert.equal(result.skipped, false);
  assert.equal(await rowExists("inbox_events", "sequence", justPast), false);
  assert.equal(await rowExists("inbox_events", "sequence", justWithin), true);
});

test("quota_events: pruned unconditionally past the longest quota window (24h), independent of ack state", async (t) => {
  if (!ready(t)) return;
  assert.equal(LONGEST_LIMIT_WINDOW_SEC, 86400, "sanity: this test assumes the 24h daily-action window");
  const owner = await makeOwner("q1");
  const stale = await makeQuotaEvent(owner, "25 hours");
  const fresh = await makeQuotaEvent(owner, "23 hours");

  const result = await pruneOnce(app!.pg, {});
  assert.equal(result.skipped, false);
  assert.equal(await rowExists("quota_events", "id", stale), false);
  assert.equal(await rowExists("quota_events", "id", fresh), true);
});

test("pruneOnce is idempotent: a second run right after finds nothing left to delete", async (t) => {
  if (!ready(t)) return;
  const owner = await makeOwner("idem");
  await makeIdempotencyKey("idem", "10 days");
  const first = await pruneOnce(app!.pg, {});
  assert.equal(first.skipped, false);
  assert.ok(first.idempotency_keys >= 1);

  const second = await pruneOnce(app!.pg, {});
  assert.deepEqual(second, { skipped: false, idempotency_keys: 0, sessions: 0, inbox_events: 0, quota_events: 0 });
  void owner;
});

test("two concurrent pruneOnce calls: exactly one skips (global advisory lock)", async (t) => {
  if (!ready(t)) return;
  // A bare `Promise.all([pruneOnce(), pruneOnce()])` against an empty local Postgres is not a reliable
  // test: each pass finishes in low single-digit milliseconds, so the two calls often don't truly overlap
  // and both succeed sequentially. Instead, simulate "another replica is already pruning" deterministically:
  // hold the exact same advisory lock on a separate connection for the duration of a real pruneOnce call.
  const holder = await app!.pg.connect();
  try {
    const locked = await holder.query("SELECT pg_advisory_lock(hashtext($1))", [RETENTION_LOCK_KEY]);
    assert.equal(locked.rowCount, 1);

    const whileLockHeld = await pruneOnce(app!.pg, {});
    assert.deepEqual(whileLockHeld, { skipped: true });

    await holder.query("SELECT pg_advisory_unlock(hashtext($1))", [RETENTION_LOCK_KEY]);
  } finally {
    holder.release();
  }

  const afterRelease = await pruneOnce(app!.pg, {});
  assert.equal(afterRelease.skipped, false, "once the other replica's lock is released, pruning must proceed");
});

test("startPruning: OLIMPYX_PRUNE=off never touches the pool and stop() is a no-op", () => {
  let touched = false;
  const fakePool = {
    connect: async () => { touched = true; throw new Error("pruneOnce must not run when OLIMPYX_PRUNE=off"); }
  } as unknown as Pool;
  const logs: unknown[] = [];
  const logger: PruneLogger = { info: (o) => logs.push(o), error: (o) => logs.push(o) };

  const handle = startPruning(fakePool, { OLIMPYX_PRUNE: "off" }, logger);
  handle.stop();

  assert.equal(touched, false);
  assert.equal(logs.length, 0);
});

test("startPruning: runs pruneOnce at boot and logs the result; stop() clears the interval", async (t) => {
  if (!ready(t)) return;
  const logs: Array<{ level: "info" | "error"; obj: unknown }> = [];
  const logger: PruneLogger = {
    info: (obj) => logs.push({ level: "info", obj }),
    error: (obj) => logs.push({ level: "error", obj })
  };
  const handle = startPruning(app!.pg, {}, logger);
  // let the fire-and-forget boot run settle
  await new Promise((resolve) => setTimeout(resolve, 200));
  handle.stop();
  assert.ok(logs.length >= 1, "expected at least one logged boot run");
  assert.equal(logs.every((l) => l.level === "info"), true, `expected only info logs, got ${JSON.stringify(logs)}`);
});
