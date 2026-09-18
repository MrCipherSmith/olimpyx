import assert from "node:assert/strict";
import { Pool } from "pg";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test, type TestContext } from "node:test";
import { createApp, migrate } from "../src/app.js";
import { SECRET_RULES } from "../src/secret-scan.js";

const baseUrl = process.env.DATABASE_URL ?? "postgres://olimpyx:olimpyx-local-only@127.0.0.1:55432/olimpyx";
const schema = `test_${randomUUID().replaceAll("-", "")}`;
let admin: Pool | null = null;
let pgAvailable = false;

const testUrl = new URL(baseUrl);
testUrl.searchParams.set("options", `-c search_path=${schema},public`);
const databaseUrl = testUrl.toString();
let app: Awaited<ReturnType<typeof createApp>> | null = null;
let ownerToken = "";
let otherOwnerToken = "";
let otherAgent: Agent;

type Agent = { agentId: string; agentToken: string; session: string };
const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const mutate = (token: string, key: string) => ({ ...auth(token), "idempotency-key": key });
const rev = (ms: number) => `${ms}-${randomUUID()}`;
const OLIMPYX_TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-AbCdE";
let keySeq = 0;
const key = (label: string) => `${label}-${++keySeq}`;

function ready(t: TestContext) {
  if (!pgAvailable || !app) { t.skip("PostgreSQL is not reachable at " + baseUrl); return false; }
  return true;
}

async function newAgent(owner: string, label: string): Promise<Agent> {
  const code = await app!.inject({ method: "POST", url: "/v1/owners/me/enrollment-tokens", headers: mutate(owner, `enroll-code-${label}`), payload: {} });
  const enrolled = await app!.inject({ method: "POST", url: "/v1/agents/enroll", headers: { "idempotency-key": `enroll-${label}` }, payload: { enrollment_token: code.json().data.enrollment_token, installation_id: `inst-${label}`, profile: { name: `Agent ${label}`, role: "tester" } } });
  assert.equal(enrolled.statusCode, 201);
  const agentId = enrolled.json().data.agent.agent_id, agentToken = enrolled.json().data.agent_token;
  const started = await app!.inject({ method: "POST", url: "/v1/sessions", headers: mutate(agentToken, `session-${label}`), payload: { installation_id: `inst-${label}`, host: { kind: "codex" }, persona_revision: 1 } });
  assert.equal(started.statusCode, 201);
  return { agentId, agentToken, session: started.json().data.session_token };
}

const save = (token: string, agentId: string, payload: Record<string, unknown>, k = key("mem")) =>
  app!.inject({ method: "POST", url: `/v1/agents/${agentId}/memory`, headers: mutate(token, k), payload });
const list = (token: string, agentId: string, qs = "") =>
  app!.inject({ method: "GET", url: `/v1/agents/${agentId}/memory${qs ? `?${qs}` : ""}`, headers: auth(token) });
const patch = (token: string, agentId: string, memoryId: string, active: boolean) =>
  app!.inject({ method: "PATCH", url: `/v1/agents/${agentId}/memory/${memoryId}`, headers: mutate(token, key("patch")), payload: { active } });
const consolidate = (token: string, agentId: string, payload: Record<string, unknown>, k = key("consolidate")) =>
  app!.inject({ method: "POST", url: `/v1/agents/${agentId}/memory/consolidate`, headers: mutate(token, k), payload });
const rollback = (token: string, agentId: string, payload: Record<string, unknown>, k = key("rollback")) =>
  app!.inject({ method: "POST", url: `/v1/agents/${agentId}/memory/rollback`, headers: mutate(token, k), payload });

async function seed(agentId: string, label: string, count: number, options: { kind?: string; active?: boolean; age?: string; persona_revision?: string | null } = {}) {
  await app!.pg.query(
    `INSERT INTO memories(id,agent_id,kind,summary,body,active,archived_reason,persona_revision,created_at)
     SELECT 'mem_seed_'||$2||'_'||n,$1,$3,'seed '||$2||' '||n,'seed body',$4,CASE WHEN $4 THEN NULL ELSE 'manual' END,$6,now()-$5::interval FROM generate_series(1,$7::int) n`,
    [agentId, label, options.kind ?? "fact", options.active ?? true, options.age ?? "2 hours", options.persona_revision ?? null, count]
  );
}
const row = async (memoryId: string) => (await app!.pg.query("SELECT * FROM memories WHERE id=$1", [memoryId])).rows[0];

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
  app = await createApp({ databaseUrl });
  const a = await app.inject({ method: "POST", url: "/v1/owners/register", headers: { "idempotency-key": "om-register-a" }, payload: { email: "om-owner@example.test", password: "very secure password", display_name: "Owner" } });
  ownerToken = a.json().data.access_token;
  const b = await app.inject({ method: "POST", url: "/v1/owners/register", headers: { "idempotency-key": "om-register-b" }, payload: { email: "om-other@example.test", password: "very secure password", display_name: "Other" } });
  otherOwnerToken = b.json().data.access_token;
  otherAgent = await newAgent(otherOwnerToken, "foreign");
});
after(async () => {
  if (app) await app.close();
  if (admin && pgAvailable) {
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await admin.end().catch(() => {});
  }
});

test("secret rules mirror the client SECRET_RULES exactly", async () => {
  const client = await import("../../../packages/client/src/redaction.js" as string) as { SECRET_RULES?: Array<[string, RegExp]> };
  assert.ok(Array.isArray(client.SECRET_RULES), "packages/client/src/redaction.js must export SECRET_RULES");
  assert.deepEqual(
    SECRET_RULES.map(([name, re]) => [name, re.source, re.flags]),
    client.SECRET_RULES!.map(([name, re]) => [name, re.source, re.flags])
  );
});

test("secret rules have no false positives on ids and persona revisions", () => {
  const benign = [`mem_${randomUUID().replaceAll("-", "")}`, `agt_${randomUUID().replaceAll("-", "")}`, rev(Date.now()), "a".repeat(43), "0123456789".repeat(5)];
  for (const value of benign) for (const [name, re] of SECRET_RULES) assert.equal(re.test(value), false, `${name} matched ${value}`);
  assert.ok(SECRET_RULES.find(([name]) => name === "olimpyx token")![1].test(`token ${OLIMPYX_TOKEN} here`));
});

test("AC-1/AC-12 categories, persona_revision rule and optional active", async (t) => {
  if (!ready(t)) return;
  const a = await newAgent(ownerToken, "kinds");
  for (const kind of ["fact", "decision", "preference", "relationship", "project", "task_result", "capability", "conversation_summary"]) {
    const r = await save(a.session, a.agentId, { kind, summary: `kind ${kind}`, body: "b" });
    assert.equal(r.statusCode, 201, r.body);
    assert.equal(r.json().data.active, true);
    assert.equal(r.json().data.kind, kind);
    assert.equal(r.json().data.deduplicated, false);
  }
  const influence = await save(a.session, a.agentId, { kind: "personality_influence", summary: "be concise", body: "b", persona_revision: rev(Date.now()) });
  assert.equal(influence.statusCode, 201, influence.body);
  assert.equal(influence.json().data.persona_revision.length > 13, true);
  assert.equal((await save(a.session, a.agentId, { kind: "gossip", summary: "x", body: "b" })).statusCode, 400);
  assert.equal((await save(a.session, a.agentId, { kind: "personality_influence", summary: "no rev", body: "b" })).statusCode, 400);
  assert.equal((await save(a.session, a.agentId, { kind: "fact", summary: "rev on fact", body: "b", persona_revision: rev(Date.now()) })).statusCode, 400);
  assert.equal((await save(a.session, a.agentId, { kind: "personality_influence", summary: "bad rev", body: "b", persona_revision: "not-a-revision" })).statusCode, 400);
  const archived = await save(a.session, a.agentId, { kind: "fact", summary: "stored archived", body: "b", active: false });
  assert.equal(archived.statusCode, 201);
  assert.equal(archived.json().data.active, false);
  assert.equal(archived.json().data.archived_reason, "manual");
  const bodyless = await save(a.session, a.agentId, { kind: "fact", summary: "no body given" });
  assert.equal(bodyless.statusCode, 201, bodyless.body);
  assert.equal(bodyless.json().data.body, "");
  assert.equal((await save(a.session, a.agentId, { kind: "fact", summary: "too long body", body: "x".repeat(50001) })).statusCode, 400);
  const full = await save(ownerToken, a.agentId, { kind: "decision", summary: "full shape", body: "b", tags: ["Postgres", "search"], confidence: "high", source_ref: { kind: "message", id_or_url: "msg_abc" } });
  assert.equal(full.statusCode, 201);
  assert.deepEqual(full.json().data.tags, ["postgres", "search"]);
  assert.equal(full.json().data.confidence, "high");
  assert.match(full.json().data.memory_id, /^mem_[0-9a-f]{32}$/);
  for (const field of ["archived_reason", "supersedes_id", "superseded_by", "consolidated_into", "persona_revision"]) assert.equal(full.json().data[field], null, field);
});

test("AC-2 secrets are refused with 422 and never echoed", async (t) => {
  if (!ready(t)) return;
  const a = await newAgent(ownerToken, "secrets");
  const sk = "sk-proj-abcdefghijklmnopqrstuvwxyz012345";
  const cases: Array<[Record<string, unknown>, string, string]> = [
    [{ kind: "fact", summary: `key is ${sk}`, body: "b" }, sk, "credential-like token"],
    [{ kind: "fact", summary: "header", body: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123" }, "abcdefghijklmnopqrstuvwxyz0123", "authorization header"],
    [{ kind: "fact", summary: "pk", body: "-----BEGIN RSA PRIVATE KEY-----\nMIIE" }, "MIIE", "private key"],
    [{ kind: "fact", summary: `bare ${OLIMPYX_TOKEN}`, body: "b" }, OLIMPYX_TOKEN, "olimpyx token"],
    [{ kind: "fact", summary: "tag secret", body: "b", tags: ["sk-abcdefghijklmnopqrstu"] }, "sk-abcdefghijklmnopqrstu", "credential-like token"],
    [{ kind: "fact", summary: "ref secret", body: "b", source_ref: { kind: "url", id_or_url: `https://example.com/?t=${OLIMPYX_TOKEN}` } }, OLIMPYX_TOKEN, "olimpyx token"],
    [{ kind: "fact", summary: "ref string", body: "b", source_ref: `note ${sk}` }, sk, "credential-like token"]
  ];
  for (const [payload, secret, kind] of cases) {
    const r = await save(a.session, a.agentId, payload);
    assert.equal(r.statusCode, 422, r.body);
    assert.equal(r.json().error.code, "secret_detected");
    assert.equal(r.json().error.details.kind, kind);
    assert.equal(r.body.includes(secret), false);
  }
  assert.equal(Number((await app!.pg.query("SELECT count(*) n FROM memories WHERE agent_id=$1", [a.agentId])).rows[0].n), 0);
  const c = await consolidate(a.session, a.agentId, { summary: `state ${OLIMPYX_TOKEN}` });
  assert.equal(c.statusCode, 422);
  assert.equal(c.body.includes(OLIMPYX_TOKEN), false);
  const r = await rollback(ownerToken, a.agentId, { to_persona_revision: rev(1789000000000), reverted_persona_revisions: [], target_created_at: new Date().toISOString(), reason: `oops ${sk}` });
  assert.equal(r.statusCode, 422);
  assert.equal(r.body.includes(sk), false);
  const benign = await save(a.session, a.agentId, { kind: "fact", summary: `ids mem_${randomUUID().replaceAll("-", "")} and ${rev(Date.now())}`, body: "b" });
  assert.equal(benign.statusCode, 201, benign.body);
});

test("AC-3 dedup returns existing record, writes nothing and does not consume rate limit", async (t) => {
  if (!ready(t)) return;
  const a = await newAgent(ownerToken, "dedup");
  await seed(a.agentId, "dedup", 28, { age: "10 minutes" });
  const first = await save(a.session, a.agentId, { kind: "fact", summary: "The sky is blue", body: "b" });
  assert.equal(first.statusCode, 201);
  const eventCount = async () => Number((await app!.pg.query("SELECT count(*) n FROM memory_events WHERE agent_id=$1", [a.agentId])).rows[0].n);
  const eventsBefore = await eventCount();
  for (let i = 0; i < 3; i++) {
    const dup = await save(a.session, a.agentId, { kind: "fact", summary: "  the SKY   is\tblue ", body: "other body" });
    assert.equal(dup.statusCode, 200, dup.body);
    assert.equal(dup.json().data.deduplicated, true);
    assert.equal(dup.json().data.memory_id, first.json().data.memory_id);
  }
  assert.equal(Number((await app!.pg.query("SELECT count(*) n FROM memories WHERE agent_id=$1", [a.agentId])).rows[0].n), 29);
  assert.equal(await eventCount(), eventsBefore, "deduplicated writes must not insert audit rows");
  const differentKind = await save(a.session, a.agentId, { kind: "decision", summary: "The sky is blue", body: "b" });
  assert.equal(differentKind.statusCode, 201);
  const superseding = await save(a.session, a.agentId, { kind: "fact", summary: "The sky is blue", body: "b", supersedes_id: first.json().data.memory_id });
  assert.equal(superseding.statusCode, 429, "the 31st created row is rate limited even when superseding");
  await app!.pg.query("UPDATE memories SET created_at=now()-interval '2 hours' WHERE id LIKE 'mem_seed_dedup_%'");
  const superseded = await save(a.session, a.agentId, { kind: "fact", summary: "The sky is blue", body: "b", supersedes_id: first.json().data.memory_id });
  assert.equal(superseded.statusCode, 201, superseded.body);
  assert.equal(superseded.json().data.deduplicated, false);
  assert.notEqual(superseded.json().data.memory_id, first.json().data.memory_id);
});

test("AC-4 supersede chain, error cases and concurrent supersede", async (t) => {
  if (!ready(t)) return;
  const a = await newAgent(ownerToken, "supersede");
  const original = (await save(a.session, a.agentId, { kind: "decision", summary: "use mysql", body: "b" })).json().data;
  const next = await save(a.session, a.agentId, { kind: "decision", summary: "use postgres", body: "b", supersedes_id: original.memory_id });
  assert.equal(next.statusCode, 201, next.body);
  assert.equal(next.json().data.supersedes_id, original.memory_id);
  const old = await row(original.memory_id);
  assert.equal(old.active, false);
  assert.equal(old.superseded_by, next.json().data.memory_id);
  assert.equal(old.archived_reason, "superseded");
  const foreign = (await save(otherAgent.session, otherAgent.agentId, { kind: "decision", summary: "foreign", body: "b" })).json().data;
  const foreignRes = await save(a.session, a.agentId, { kind: "decision", summary: "x1", body: "b", supersedes_id: foreign.memory_id });
  assert.equal(foreignRes.statusCode, 404);
  assert.equal((await save(a.session, a.agentId, { kind: "decision", summary: "x2", body: "b", supersedes_id: "mem_missing" })).statusCode, 404);
  const inactive = await save(a.session, a.agentId, { kind: "decision", summary: "x3", body: "b", supersedes_id: original.memory_id });
  assert.equal(inactive.statusCode, 409);
  assert.equal(inactive.json().error.code, "memory_not_active");
  const mismatch = await save(a.session, a.agentId, { kind: "fact", summary: "x4", body: "b", supersedes_id: next.json().data.memory_id });
  assert.equal(mismatch.statusCode, 409);
  assert.equal(mismatch.json().error.code, "kind_mismatch");
  const target = (await save(a.session, a.agentId, { kind: "fact", summary: "race target", body: "b" })).json().data;
  const raced = await Promise.all([1, 2, 3].map(i => save(a.session, a.agentId, { kind: "fact", summary: `race winner ${i}`, body: "b", supersedes_id: target.memory_id })));
  assert.deepEqual(raced.map(r => r.statusCode).sort(), [201, 409, 409]);
  const winner = raced.find(r => r.statusCode === 201)!.json().data.memory_id;
  assert.equal((await row(target.memory_id)).superseded_by, winner);
});

test("AC-5 retrieval filters, search, keyset paging and single fetch", async (t) => {
  if (!ready(t)) return;
  const a = await newAgent(ownerToken, "retrieval");
  const pg = (await save(a.session, a.agentId, { kind: "decision", summary: "Use PostgreSQL full text search", body: "decided", tags: ["postgres"] })).json().data;
  const pct = (await save(a.session, a.agentId, { kind: "fact", summary: "discount 100% applied", body: "b" })).json().data;
  const plain = (await save(a.session, a.agentId, { kind: "fact", summary: "discount 100 applied", body: "b" })).json().data;
  const under = (await save(a.session, a.agentId, { kind: "fact", summary: "snake_case naming", body: "b" })).json().data;
  const gone = (await save(a.session, a.agentId, { kind: "fact", summary: "archived thing", body: "b", active: false })).json().data;
  const ids = (r: any) => r.json().data.map((x: any) => x.memory_id);
  const def = await list(a.session, a.agentId);
  assert.equal(def.statusCode, 200);
  assert.equal(ids(def).includes(gone.memory_id), false);
  assert.deepEqual(ids(await list(a.session, a.agentId, "status=archived")), [gone.memory_id]);
  assert.equal(ids(await list(a.session, a.agentId, "status=all")).length, 5);
  assert.deepEqual(ids(await list(a.session, a.agentId, "kind=decision")), [pg.memory_id]);
  assert.deepEqual(ids(await list(a.session, a.agentId, "tag=postgres")), [pg.memory_id]);
  assert.deepEqual(ids(await list(a.session, a.agentId, "q=postgresql")), [pg.memory_id]);
  assert.deepEqual(ids(await list(a.session, a.agentId, "q=decided")), [pg.memory_id]);
  assert.deepEqual(ids(await list(a.session, a.agentId, `q=${encodeURIComponent("%")}`)), [pct.memory_id]);
  assert.deepEqual(ids(await list(a.session, a.agentId, `q=${encodeURIComponent("_")}`)), [under.memory_id]);
  assert.ok(plain.memory_id);
  assert.equal((await list(a.session, a.agentId, "status=bogus")).statusCode, 400);
  assert.equal((await list(a.session, a.agentId, "limit=0")).statusCode, 400);
  const badCursor = await list(a.session, a.agentId, "cursor=mem_unknown");
  assert.equal(badCursor.statusCode, 400);
  assert.equal(badCursor.json().error.code, "bad_request");

  const b = await newAgent(ownerToken, "paging");
  await app!.pg.query(`INSERT INTO memories(id,agent_id,kind,summary,body,active,created_at) SELECT 'mem_page_'||lpad(n::text,3,'0'),$1,'fact','page '||n,'b',true,'2026-01-01T00:00:00Z' FROM generate_series(1,25) n`, [b.agentId]);
  const seen: string[] = [];
  let cursor: string | null = null;
  do {
    const page: any = await list(b.session, b.agentId, `limit=7${cursor ? `&cursor=${cursor}` : ""}`);
    assert.equal(page.statusCode, 200, page.body);
    seen.push(...ids(page));
    cursor = page.json().page.next_cursor;
  } while (cursor);
  assert.equal(seen.length, 25);
  assert.equal(new Set(seen).size, 25);

  const one = await app!.inject({ method: "GET", url: `/v1/agents/${a.agentId}/memory/${gone.memory_id}`, headers: auth(a.session) });
  assert.equal(one.statusCode, 200);
  assert.equal(one.json().data.archived_reason, "manual");
  const foreign = (await save(otherAgent.session, otherAgent.agentId, { kind: "fact", summary: "foreign fetch", body: "b" })).json().data;
  assert.equal((await app!.inject({ method: "GET", url: `/v1/agents/${a.agentId}/memory/${foreign.memory_id}`, headers: auth(a.session) })).statusCode, 404);
  assert.equal((await app!.inject({ method: "GET", url: `/v1/agents/${a.agentId}/memory/mem_nope`, headers: auth(ownerToken) })).statusCode, 404);
});

test("AC-6 consolidation revisions, bounds, concurrency and selective bootstrap", async (t) => {
  if (!ready(t)) return;
  const empty = await newAgent(ownerToken, "mvp-empty");
  const emptyBoot = (await app!.inject({ method: "GET", url: "/v1/bootstrap", headers: auth(empty.session) })).json().data;
  assert.equal(emptyBoot.memory_summary, null);
  assert.equal(emptyBoot.memory.summary_id, null);

  const mvp = await newAgent(ownerToken, "mvp");
  await app!.pg.query(`INSERT INTO memories(id,agent_id,kind,summary,body,active,archived_reason,created_at) SELECT 'mem_mvp_'||n,$1,CASE WHEN n%3=0 THEN 'personality_influence' ELSE 'fact' END,'mvp summary '||n,'b',n<>5,CASE WHEN n=5 THEN 'manual' END,now()-(n||' minutes')::interval FROM generate_series(1,14) n`, [mvp.agentId]);
  const expected = (await app!.pg.query("SELECT summary FROM memories WHERE agent_id=$1 AND active=true ORDER BY created_at DESC LIMIT 10", [mvp.agentId])).rows.map(x => x.summary).join("\n");
  const mvpBoot = (await app!.inject({ method: "GET", url: "/v1/bootstrap", headers: auth(mvp.session) })).json().data;
  assert.equal(mvpBoot.memory_summary, expected);
  assert.equal(mvpBoot.memory.summary_id, null);
  assert.deepEqual(mvpBoot.memory.active_counts, { knowledge: 9, influence: 4 });

  const a = await newAgent(ownerToken, "consolidate");
  await seed(a.agentId, "cons", 6, { age: "3 hours" });
  await seed(a.agentId, "consinf", 2, { age: "3 hours", kind: "personality_influence", persona_revision: rev(1789000000000) });
  const coveredUntil = new Date(Date.now() - 60_000).toISOString();
  const recent = (await save(a.session, a.agentId, { kind: "fact", summary: "fresh after summary", body: "b" })).json().data;
  const c1 = await consolidate(a.session, a.agentId, { summary: "Consolidated state v1", covered_until: coveredUntil });
  assert.equal(c1.statusCode, 201, c1.body);
  assert.equal(c1.json().data.revision, 1);
  assert.equal(c1.json().data.archived_memory_count, 6);
  assert.match(c1.json().data.summary_id, /^msum_/);
  const archived = (await app!.pg.query("SELECT * FROM memories WHERE agent_id=$1 AND id LIKE 'mem\\_seed\\_cons\\_%'", [a.agentId])).rows;
  assert.ok(archived.every(x => !x.active && x.archived_reason === "consolidated" && x.consolidated_into === c1.json().data.summary_id));
  assert.equal(Number((await app!.pg.query("SELECT count(*) n FROM memories WHERE agent_id=$1 AND kind='personality_influence' AND active", [a.agentId])).rows[0].n), 2);
  assert.equal((await row(recent.memory_id)).active, true);

  const boot = (await app!.inject({ method: "GET", url: "/v1/bootstrap", headers: auth(a.session) })).json().data;
  assert.ok(boot.memory_summary.startsWith("Consolidated state v1"));
  assert.ok(boot.memory_summary.includes("fresh after summary"));
  assert.ok(boot.memory_summary.includes("seed consinf 1"));
  assert.equal(boot.memory.summary_id, c1.json().data.summary_id);
  assert.equal(boot.memory.summary_revision, 1);
  assert.ok(boot.memory.recent_memory_ids.includes(recent.memory_id));
  assert.deepEqual(boot.memory.active_counts, { knowledge: 1, influence: 2 });

  const future = await consolidate(a.session, a.agentId, { summary: "future", covered_until: new Date(Date.now() + 3_600_000).toISOString() });
  assert.equal(future.statusCode, 400);
  const earlier = await consolidate(a.session, a.agentId, { summary: "earlier", covered_until: new Date(Date.now() - 7_200_000).toISOString() });
  assert.equal(earlier.statusCode, 400);
  const concurrent = await Promise.all([1, 2, 3].map(i => consolidate(i === 2 ? ownerToken : a.session, a.agentId, { summary: `concurrent ${i}` })));
  assert.deepEqual(concurrent.map(r => r.statusCode), [201, 201, 201], concurrent.map(r => r.body).join("\n"));
  assert.deepEqual(concurrent.map(r => r.json().data.revision).sort(), [2, 3, 4]);
  assert.equal((await row(recent.memory_id)).archived_reason, "consolidated");
});

test("AC-7 owner rollback archives reverted influences only and notifies", async (t) => {
  if (!ready(t)) return;
  const a = await newAgent(ownerToken, "rollback");
  const base = 1789000000000, r1 = rev(base), r2 = rev(base + 1000), r3 = rev(base + 2000);
  const keep = (await save(a.session, a.agentId, { kind: "personality_influence", summary: "influence keep", body: "b", persona_revision: r1 })).json().data;
  const drop2 = (await save(a.session, a.agentId, { kind: "personality_influence", summary: "influence drop two", body: "b", persona_revision: r2 })).json().data;
  const drop3 = (await save(a.session, a.agentId, { kind: "personality_influence", summary: "influence drop three", body: "b", persona_revision: r3 })).json().data;
  const fact = (await save(a.session, a.agentId, { kind: "fact", summary: "fact survives", body: "b", persona_revision: undefined })).json().data;
  const decision = (await save(a.session, a.agentId, { kind: "decision", summary: "decision survives", body: "b" })).json().data;
  await app!.pg.query(`INSERT INTO memories(id,agent_id,kind,summary,body,active,created_at) VALUES('mem_legacy_old',$1,'personality_influence','legacy old','b',true,now()-interval '2 days'),('mem_legacy_new',$1,'personality_influence','legacy new','b',true,now()-interval '1 hour')`, [a.agentId]);
  const payload = { to_persona_revision: r1, reverted_persona_revisions: [r2, r3], target_created_at: new Date(Date.now() - 86_400_000).toISOString(), reason: "Reverting drift" };
  const denied = await rollback(a.session, a.agentId, payload);
  assert.equal(denied.statusCode, 403);
  const done = await rollback(ownerToken, a.agentId, payload);
  assert.equal(done.statusCode, 200, done.body);
  assert.equal(done.json().data.rolled_back_count, 3);
  assert.deepEqual([...done.json().data.memory_ids].sort(), [drop2.memory_id, drop3.memory_id, "mem_legacy_new"].sort());
  assert.equal(done.json().data.to_persona_revision, r1);
  for (const id of [keep.memory_id, fact.memory_id, decision.memory_id, "mem_legacy_old"]) assert.equal((await row(id)).active, true, id);
  for (const id of [drop2.memory_id, drop3.memory_id, "mem_legacy_new"]) assert.equal((await row(id)).archived_reason, "personality_rollback", id);
  const events = (await app!.pg.query("SELECT * FROM memory_events WHERE agent_id=$1 AND type='rolled_back'", [a.agentId])).rows;
  assert.equal(events.length, 1);
  assert.equal(events[0].actor_type, "owner");
  const inbox = (await app!.pg.query("SELECT * FROM inbox_events WHERE type='memory.rolled_back' AND resource_id=$1", [a.agentId])).rows;
  assert.equal(inbox.filter(x => x.agent_id === a.agentId).length, 1);
  assert.equal(inbox.filter(x => x.owner_id && !x.agent_id).length, 1);
  const boot = (await app!.inject({ method: "GET", url: "/v1/bootstrap", headers: auth(a.session) })).json().data;
  assert.equal(boot.memory_summary.includes("influence drop"), false);
  assert.equal(boot.memory_summary.includes("legacy new"), false);
  assert.ok(boot.memory_summary.includes("influence keep"));
  const archived = await list(ownerToken, a.agentId, "status=archived&kind=personality_influence");
  assert.deepEqual(archived.json().data.map((x: any) => x.memory_id).sort(), [drop2.memory_id, drop3.memory_id, "mem_legacy_new"].sort());
  assert.equal((await rollback(otherOwnerToken, a.agentId, payload)).statusCode, 403);
  const replay = await app!.inject({ method: "POST", url: `/v1/agents/${a.agentId}/memory/rollback`, headers: mutate(ownerToken, "rollback-replay"), payload });
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.json().data.rolled_back_count, 0);
  assert.deepEqual(replay.json().data.memory_ids, []);
  assert.equal(Number((await app!.pg.query("SELECT count(*) n FROM memory_events WHERE agent_id=$1 AND type='rolled_back'", [a.agentId])).rows[0].n), 1, "no audit row for a no-op rollback");
  assert.equal(Number((await app!.pg.query("SELECT count(*) n FROM inbox_events WHERE type='memory.rolled_back' AND resource_id=$1", [a.agentId])).rows[0].n), 2, "no inbox events for a no-op rollback");
});

test("AC-8 rate limit and capacity limits, including under concurrency", async (t) => {
  if (!ready(t)) return;
  const a = await newAgent(ownerToken, "rate");
  for (let i = 0; i < 30; i++) assert.equal((await save(i % 2 ? ownerToken : a.session, a.agentId, { kind: "fact", summary: `rate ${i}`, body: "b" })).statusCode, 201);
  const limited = await save(a.session, a.agentId, { kind: "fact", summary: "rate 31", body: "b" });
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.json().error.code, "quota_exceeded");
  const retry = Number(limited.headers["retry-after"]);
  assert.ok(retry > 0 && retry <= 3600);
  assert.equal(limited.json().error.details.retry_after_sec, retry);

  const c = await newAgent(ownerToken, "capacity");
  await seed(c.agentId, "cap", 499);
  const burst = await Promise.all([1, 2, 3, 4].map(i => save(c.session, c.agentId, { kind: "fact", summary: `burst ${i}`, body: "b" })));
  assert.deepEqual(burst.map(r => r.statusCode).sort(), [201, 409, 409, 409]);
  assert.ok(burst.filter(r => r.statusCode === 409).every(r => r.json().error.code === "memory_consolidation_required"));
  assert.equal(Number((await app!.pg.query("SELECT count(*) n FROM memories WHERE agent_id=$1 AND active AND kind<>'personality_influence'", [c.agentId])).rows[0].n), 500);
  const replaced = await save(c.session, c.agentId, { kind: "fact", summary: "supersede at capacity", body: "b", supersedes_id: "mem_seed_cap_1" });
  assert.equal(replaced.statusCode, 201, replaced.body);

  await seed(c.agentId, "capinf", 49, { kind: "personality_influence", persona_revision: rev(1789000000000) });
  const infBurst = await Promise.all([1, 2, 3].map(i => save(c.session, c.agentId, { kind: "personality_influence", summary: `inf burst ${i}`, body: "b", persona_revision: rev(1789000000000 + i) })));
  assert.deepEqual(infBurst.map(r => r.statusCode).sort(), [201, 409, 409]);
  assert.ok(infBurst.filter(r => r.statusCode === 409).every(r => r.json().error.code === "influence_limit_reached"));
  assert.equal(Number((await app!.pg.query("SELECT count(*) n FROM memories WHERE agent_id=$1 AND active AND kind='personality_influence'", [c.agentId])).rows[0].n), 50);
});

test("AC-9 reactivation follows the archive state model", async (t) => {
  if (!ready(t)) return;
  const a = await newAgent(ownerToken, "reactivate");
  const old = (await save(a.session, a.agentId, { kind: "fact", summary: "old", body: "b" })).json().data;
  await save(a.session, a.agentId, { kind: "fact", summary: "new", body: "b", supersedes_id: old.memory_id });
  const sup = await patch(a.session, a.agentId, old.memory_id, true);
  assert.equal(sup.statusCode, 409);
  assert.equal(sup.json().error.code, "memory_not_reactivatable");

  await seed(a.agentId, "react", 1, { age: "3 hours" });
  assert.equal((await consolidate(a.session, a.agentId, { summary: "s", covered_until: new Date(Date.now() - 3_600_000).toISOString() })).statusCode, 201);
  assert.equal((await patch(ownerToken, a.agentId, "mem_seed_react_1", true)).json().error.code, "memory_not_reactivatable");

  const r = rev(1789000000000);
  const inf = (await save(a.session, a.agentId, { kind: "personality_influence", summary: "inf", body: "b", persona_revision: r })).json().data;
  assert.equal((await rollback(ownerToken, a.agentId, { to_persona_revision: rev(1788000000000), reverted_persona_revisions: [r], target_created_at: new Date().toISOString() })).statusCode, 200);
  assert.equal((await patch(a.session, a.agentId, inf.memory_id, true)).statusCode, 403);
  const restored = await patch(ownerToken, a.agentId, inf.memory_id, true);
  assert.equal(restored.statusCode, 200, restored.body);
  assert.equal(restored.json().data.active, true);
  assert.equal(restored.json().data.archived_reason, null);

  const manual = (await save(a.session, a.agentId, { kind: "fact", summary: "manual one", body: "b" })).json().data;
  const off = await patch(a.session, a.agentId, manual.memory_id, false);
  assert.equal(off.statusCode, 200);
  assert.equal(off.json().data.archived_reason, "manual");
  const on = await patch(a.session, a.agentId, manual.memory_id, true);
  assert.equal(on.statusCode, 200);
  assert.equal(on.json().data.active, true);
  assert.equal((await patch(a.session, a.agentId, manual.memory_id, false)).statusCode, 200);
  const active = Number((await app!.pg.query("SELECT count(*) n FROM memories WHERE agent_id=$1 AND active AND kind<>'personality_influence'", [a.agentId])).rows[0].n);
  await seed(a.agentId, "reactcap", 500 - active);
  const full = await patch(a.session, a.agentId, manual.memory_id, true);
  assert.equal(full.statusCode, 409);
  assert.equal(full.json().error.code, "memory_consolidation_required");
  const types = (await app!.pg.query("SELECT type FROM memory_events WHERE agent_id=$1", [a.agentId])).rows.map(x => x.type);
  for (const type of ["created", "superseded", "consolidated", "rolled_back", "reactivated", "archived"]) assert.ok(types.includes(type), type);
  assert.equal((await patch(a.session, a.agentId, "mem_nope", true)).statusCode, 404);
});

test("AC-10 access control on every memory endpoint and audit log", async (t) => {
  if (!ready(t)) return;
  const a = await newAgent(ownerToken, "access");
  const sibling = await newAgent(ownerToken, "access-sibling");
  const m = (await save(a.session, a.agentId, { kind: "fact", summary: "access summary", body: "UNIQUE-BODY-MARKER" })).json().data;
  const base = `/v1/agents/${a.agentId}/memory`;
  const calls: Array<[string, string, Record<string, unknown> | undefined]> = [
    ["GET", base, undefined],
    ["GET", `${base}/${m.memory_id}`, undefined],
    ["GET", `${base}/events`, undefined],
    ["POST", base, { kind: "fact", summary: "intrude", body: "b" }],
    ["PATCH", `${base}/${m.memory_id}`, { active: false }],
    ["POST", `${base}/consolidate`, { summary: "intrude" }],
    ["POST", `${base}/rollback`, { to_persona_revision: rev(1789000000000), reverted_persona_revisions: [], target_created_at: new Date().toISOString() }]
  ];
  for (const token of [otherOwnerToken, sibling.session, a.agentToken]) {
    for (const [method, url, payload] of calls) {
      const r = await app!.inject({ method: method as any, url, headers: mutate(token, key("access")), ...(payload ? { payload } : {}) });
      assert.equal(r.statusCode, 403, `${method} ${url} -> ${r.statusCode}`);
    }
  }
  assert.equal((await app!.inject({ method: "GET", url: `${base}/events`, headers: auth(a.session) })).statusCode, 403);
  const events = await app!.inject({ method: "GET", url: `${base}/events`, headers: auth(ownerToken) });
  assert.equal(events.statusCode, 200);
  assert.ok(events.json().data.some((e: any) => e.type === "created" && e.memory_ids.includes(m.memory_id)));
  assert.equal(events.body.includes("UNIQUE-BODY-MARKER"), false);
  assert.equal(events.body.includes("access summary"), false);
  const paged = await app!.inject({ method: "GET", url: `${base}/events?limit=1`, headers: auth(ownerToken) });
  assert.equal(paged.json().data.length, 1);
});

test("influence fingerprint includes persona_revision", async (t) => {
  if (!ready(t)) return;
  const a = await newAgent(ownerToken, "inf-fingerprint");
  const r1 = rev(1789000000000), r2 = rev(1789000001000);
  const first = await save(a.session, a.agentId, { kind: "personality_influence", summary: "Prefer short answers", persona_revision: r1 });
  assert.equal(first.statusCode, 201, first.body);
  const same = await save(a.session, a.agentId, { kind: "personality_influence", summary: "prefer  SHORT answers", persona_revision: r1 });
  assert.equal(same.statusCode, 200, same.body);
  assert.equal(same.json().data.memory_id, first.json().data.memory_id);
  const next = await save(a.session, a.agentId, { kind: "personality_influence", summary: "Prefer short answers", persona_revision: r2 });
  assert.equal(next.statusCode, 201, next.body);
  assert.notEqual(next.json().data.memory_id, first.json().data.memory_id);
  assert.equal(next.json().data.persona_revision, r2);
});

test("migration recomputes recent influence fingerprints written before persona_revision scoping", async (t) => {
  if (!ready(t)) return;
  const a = await newAgent(ownerToken, "inf-legacy-fingerprint");
  const r1 = rev(1789000000000);
  const first = await save(a.session, a.agentId, { kind: "personality_influence", summary: "Prefer terse replies", persona_revision: r1 });
  assert.equal(first.statusCode, 201, first.body);
  const legacy = createHash("sha256").update("personality_influence:prefer terse replies").digest("hex");
  await app!.pg.query("UPDATE memories SET fingerprint=$1 WHERE id=$2", [legacy, first.json().data.memory_id]);
  await migrate(databaseUrl);
  const again = await save(a.session, a.agentId, { kind: "personality_influence", summary: "Prefer terse replies", persona_revision: r1 });
  assert.equal(again.statusCode, 200, again.body);
  assert.equal(again.json().data.memory_id, first.json().data.memory_id);
});

test("a write that waited behind a consolidation is timestamped after it and stays visible", async (t) => {
  if (!ready(t)) return;
  const a = await newAgent(ownerToken, "lock-order");
  const holder = await app!.pg.connect();
  let pending: ReturnType<typeof save> | null = null;
  try {
    await holder.query("BEGIN");
    await holder.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`memory:${a.agentId}`]);
    pending = save(a.session, a.agentId, { kind: "fact", summary: "written behind consolidation", body: "b" });
    let waiting = false;
    for (let i = 0; i < 200 && !waiting; i++) {
      const w = await app!.pg.query(
        "SELECT count(*)::int n FROM pg_locks WHERE locktype='advisory' AND NOT granted AND objsubid=1 AND objid::bigint=(hashtext($1)::bigint & 4294967295)",
        [`memory:${a.agentId}`]
      );
      waiting = w.rows[0].n > 0;
      if (!waiting) await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(waiting, "memory write should be blocked on the agent memory lock");
    await new Promise((r) => setTimeout(r, 30));
    // Simulates a consolidation that commits while the write is waiting on the lock.
    await holder.query(
      "INSERT INTO memory_summaries(id,agent_id,revision,summary,covered_until,archived_memory_count,created_by_type,created_by_id) VALUES($1,$2,1,'held consolidation',clock_timestamp(),0,'owner','own_test')",
      [`msum_held_${randomUUID().replaceAll("-", "")}`, a.agentId]
    );
    await holder.query("COMMIT");
  } catch (e) {
    await holder.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    holder.release();
  }
  const written = await pending!;
  assert.equal(written.statusCode, 201, written.body);
  const boot = (await app!.inject({ method: "GET", url: "/v1/bootstrap", headers: auth(a.session) })).json().data;
  assert.ok(boot.memory_summary.startsWith("held consolidation"));
  assert.ok(boot.memory.recent_memory_ids.includes(written.json().data.memory_id), "write must be newer than covered_until");
  assert.ok(boot.memory_summary.includes("written behind consolidation"));
});

test("consolidation is rate limited per agent and errors are not cached by idempotency", async (t) => {
  if (!ready(t)) return;
  const a = await newAgent(ownerToken, "cons-rate");
  await app!.pg.query(
    `INSERT INTO memory_summaries(id,agent_id,revision,summary,covered_until,archived_memory_count,created_by_type,created_by_id,created_at)
     SELECT 'msum_rate_'||$2||'_'||n,$1,n,'s '||n,now()-interval '2 hours',0,'agent',$1,now()-interval '10 minutes' FROM generate_series(1,10) n`,
    [a.agentId, a.agentId.slice(-8)]
  );
  const k = key("cons-rate");
  const limited = await consolidate(a.session, a.agentId, { summary: "eleventh" }, k);
  assert.equal(limited.statusCode, 429, limited.body);
  assert.equal(limited.json().error.code, "quota_exceeded");
  const retry = Number(limited.headers["retry-after"]);
  assert.ok(retry >= 2990 && retry <= 3600, String(retry));
  assert.equal(limited.json().error.details.retry_after_sec, retry);
  await app!.pg.query("UPDATE memory_summaries SET created_at=now()-interval '2 hours' WHERE agent_id=$1", [a.agentId]);
  const ok = await consolidate(a.session, a.agentId, { summary: "eleventh" }, k);
  assert.equal(ok.statusCode, 201, ok.body);
  assert.equal(ok.json().data.revision, 11);
});

test("replaying a consolidate Idempotency-Key returns the same revision without a second row", async (t) => {
  if (!ready(t)) return;
  const a = await newAgent(ownerToken, "cons-replay");
  await seed(a.agentId, "consreplay", 3, { age: "3 hours" });
  const k = key("cons-replay");
  const first = await consolidate(a.session, a.agentId, { summary: "replayed summary" }, k);
  assert.equal(first.statusCode, 201, first.body);
  const again = await consolidate(a.session, a.agentId, { summary: "replayed summary" }, k);
  assert.equal(again.statusCode, 201, again.body);
  assert.equal(again.json().data.summary_id, first.json().data.summary_id);
  assert.equal(again.json().data.revision, first.json().data.revision);
  assert.equal(Number((await app!.pg.query("SELECT count(*) n FROM memory_summaries WHERE agent_id=$1", [a.agentId])).rows[0].n), 1);
  assert.equal(Number((await app!.pg.query("SELECT count(*) n FROM memory_events WHERE agent_id=$1 AND type='consolidated'", [a.agentId])).rows[0].n), 1);
  const racedKey = key("cons-race");
  const raced = await Promise.all([1, 2, 3].map(() => consolidate(a.session, a.agentId, { summary: "raced summary" }, racedKey)));
  assert.deepEqual(raced.map((r) => r.statusCode), [201, 201, 201]);
  assert.equal(new Set(raced.map((r) => r.json().data.summary_id)).size, 1);
  assert.equal(Number((await app!.pg.query("SELECT count(*) n FROM memory_summaries WHERE agent_id=$1", [a.agentId])).rows[0].n), 2);
});

test("active and archived_reason are kept consistent by a CHECK constraint", async (t) => {
  if (!ready(t)) return;
  const a = await newAgent(ownerToken, "check");
  await assert.rejects(
    app!.pg.query("INSERT INTO memories(id,agent_id,kind,summary,body,active) VALUES('mem_check_inactive',$1,'fact','x','b',false)", [a.agentId]),
    (e: any) => e.code === "23514"
  );
  await assert.rejects(
    app!.pg.query("INSERT INTO memories(id,agent_id,kind,summary,body,active,archived_reason) VALUES('mem_check_active',$1,'fact','x','b',true,'manual')", [a.agentId]),
    (e: any) => e.code === "23514"
  );
});

test("migration is idempotent", async (t) => {
  if (!ready(t)) return;
  const constraintOid = async () => (await app!.pg.query("SELECT oid FROM pg_constraint WHERE conname='chk_memories_archived_reason' AND conrelid='memories'::regclass")).rows[0]?.oid;
  const before = await constraintOid();
  await migrate(databaseUrl);
  await migrate(databaseUrl);
  assert.ok(before);
  assert.equal(await constraintOid(), before, "the CHECK constraint is not dropped and re-validated on every boot");
  const a = await newAgent(ownerToken, "legacy");
  assert.equal((await save(a.session, a.agentId, { kind: "fact", summary: "after re-migrate", body: "b" })).statusCode, 201);
});

test("migration upgrades a pre-Q-008 memories table", async (t) => {
  if (!ready(t)) return;
  const legacy = `test_legacy_${randomUUID().replaceAll("-", "")}`;
  const legacyUrl = new URL(baseUrl);
  legacyUrl.searchParams.set("options", `-c search_path=${legacy},public`);
  await admin!.query(`CREATE SCHEMA ${legacy}`);
  const pool = new Pool({ connectionString: legacyUrl.toString() });
  try {
    // Pre-Q-008 DDL copied verbatim from main.
    await pool.query(`
      CREATE TABLE owners (id text PRIMARY KEY, email text UNIQUE NOT NULL, password_hash text NOT NULL, display_name text NOT NULL, restricted boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE agents (id text PRIMARY KEY, owner_id text NOT NULL REFERENCES owners(id), installation_id text NOT NULL, name text NOT NULL, role text NOT NULL, bio text NOT NULL DEFAULT '', interests jsonb NOT NULL DEFAULT '[]', capabilities jsonb NOT NULL DEFAULT '[]', profile_revision integer NOT NULL DEFAULT 1, restricted boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(owner_id, installation_id));
      CREATE TABLE memories (id text PRIMARY KEY, agent_id text NOT NULL REFERENCES agents(id), kind text NOT NULL, summary text NOT NULL, body text NOT NULL, active boolean NOT NULL, source_ref jsonb, created_at timestamptz NOT NULL DEFAULT now());
      INSERT INTO owners(id,email,password_hash,display_name) VALUES('own_legacy','legacy@example.test','x','Legacy');
      INSERT INTO agents(id,owner_id,installation_id,name,role) VALUES('agt_legacy','own_legacy','inst-legacy','Legacy','tester');
      INSERT INTO memories(id,agent_id,kind,summary,body,active) VALUES
        ('mem_old_active','agt_legacy','fact','legacy active summary','findable legacy body',true),
        ('mem_old_inactive','agt_legacy','fact','legacy inactive summary','b',false);
    `);
    await migrate(legacyUrl.toString());
    await migrate(legacyUrl.toString());
    const cols = (await pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='memories'", [legacy])).rows.map((x) => x.column_name);
    for (const c of ["tags", "confidence", "persona_revision", "supersedes_id", "superseded_by", "consolidated_into", "fingerprint", "archived_reason", "search_tsv"]) assert.ok(cols.includes(c), c);
    const rows = (await pool.query("SELECT id,active,archived_reason,tags FROM memories ORDER BY id")).rows;
    assert.deepEqual(rows.map((x) => [x.id, x.active, x.archived_reason, x.tags]), [["mem_old_active", true, null, []], ["mem_old_inactive", false, "manual", []]]);
    const found = (await pool.query("SELECT id FROM memories WHERE search_tsv @@ websearch_to_tsquery('simple','findable')")).rows.map((x) => x.id);
    assert.deepEqual(found, ["mem_old_active"]);
    const check = (await pool.query("SELECT convalidated FROM pg_constraint WHERE conname='chk_memories_archived_reason' AND conrelid=to_regclass($1)", [`${legacy}.memories`])).rows;
    assert.equal(check.length, 1);
    assert.equal(check[0].convalidated, true);
    for (const table of ["memory_summaries", "memory_events"]) assert.ok((await pool.query("SELECT to_regclass($1) r", [`${legacy}.${table}`])).rows[0].r, table);
    assert.ok((await pool.query("SELECT 1 FROM pg_indexes WHERE schemaname=$1 AND indexname='idx_memories_agent_created'", [legacy])).rowCount);
  } finally {
    await pool.end().catch(() => {});
    await admin!.query(`DROP SCHEMA IF EXISTS ${legacy} CASCADE`).catch(() => {});
  }
});
