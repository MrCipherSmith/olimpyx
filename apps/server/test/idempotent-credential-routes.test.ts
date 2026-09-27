import assert from "node:assert/strict";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { createApp, migrate } from "../src/app.js";
import { ensureVectorExtension } from "./pg-extension.js";

// Regression coverage for #51: a retry with the same Idempotency-Key on /v1/owners/register,
// /v1/agents/enroll or /v1/sessions must not perform the underlying action a second time. The
// generic idempotency cache in app.ts's idem() never stores a credential-bearing response (by
// design, so no token ever lands in idempotency_keys), so each of these three routes is made
// naturally idempotent on its own business key (email, owner+installation_id, agent+Idempotency-Key)
// instead of relying on that cache.

const baseUrl = process.env.DATABASE_URL ?? "postgres://olimpyx:olimpyx-local-only@127.0.0.1:55432/olimpyx";
const schema = `test_idem_cred_${randomUUID().replaceAll("-", "")}`;
let admin: Pool | null = null;
let pgAvailable = false;

const testUrl = new URL(baseUrl);
testUrl.searchParams.set("options", `-c search_path=${schema},public`);
const databaseUrl = testUrl.toString();
let app: Awaited<ReturnType<typeof createApp>> | null = null;
let ipSeq = 0;

const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const mutate = (t: string, key: string) => ({ ...auth(t), "idempotency-key": key });
const nextIp = () => `10.51.0.${++ipSeq % 250}`;

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
});

after(async () => {
  if (app) await app.close();
  if (admin && pgAvailable) {
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await admin.end();
  }
});

async function registerOwner(email: string, password = "very secure password") {
  const r = await app!.inject({
    method: "POST",
    url: "/v1/owners/register",
    remoteAddress: nextIp(),
    headers: { "idempotency-key": `reg-${randomUUID()}` },
    payload: { email, password, display_name: "Idempotency Owner" }
  });
  assert.equal(r.statusCode, 201, r.body);
  return { token: r.json().data.access_token as string, ownerId: r.json().data.owner.owner_id as string };
}

async function enrollAgent(ownerToken: string, installationId: string, idempotencyKey: string) {
  const code = await app!.inject({ method: "POST", url: "/v1/owners/me/enrollment-tokens", headers: mutate(ownerToken, `code-${randomUUID()}`), payload: {} });
  assert.equal(code.statusCode, 201, code.body);
  const enrollmentToken = code.json().data.enrollment_token as string;
  const payload = { enrollment_token: enrollmentToken, installation_id: installationId, profile: { name: "Idempotency Agent", role: "tester" } };
  const response = await app!.inject({ method: "POST", url: "/v1/agents/enroll", headers: { "idempotency-key": idempotencyKey }, payload });
  return { response, payload };
}

test("owners/register: retry with the same Idempotency-Key and body resolves to the existing owner, not a second one", async (t) => {
  if (!pgAvailable || !app) { t.skip("PostgreSQL is not reachable"); return; }
  const email = `owner-${randomUUID()}@example.test`;
  const payload = { email, password: "very secure password", display_name: "Retry Owner" };
  const key = "register-retry-key";

  const first = await app.inject({ method: "POST", url: "/v1/owners/register", remoteAddress: nextIp(), headers: { "idempotency-key": key }, payload });
  assert.equal(first.statusCode, 201, first.body);
  const ownerId = first.json().data.owner.owner_id;
  const firstToken = first.json().data.access_token;

  const retry = await app.inject({ method: "POST", url: "/v1/owners/register", remoteAddress: nextIp(), headers: { "idempotency-key": key }, payload });
  assert.equal(retry.statusCode, 200, retry.body);
  assert.equal(retry.json().data.owner.owner_id, ownerId, "retry must resolve to the same owner, not a second one");
  // Registration can honestly recover from a lost response: unlike a one-time enrollment code or
  // a single session token, an owner can always mint a fresh credential (the same as /v1/owners/login
  // would), so the retry is not stuck returning a null token.
  assert.equal(typeof retry.json().data.access_token, "string");
  assert.notEqual(retry.json().data.access_token, firstToken, "the retry gets a freshly minted token, not the original (which cannot be recovered)");

  const count = await app.pg.query("SELECT count(*)::int n FROM owners WHERE email=$1", [email]);
  assert.equal(count.rows[0].n, 1, "no second owner row was created");
});

test("owners/register: the right email with the wrong password is rejected and never issues a token", async (t) => {
  if (!pgAvailable || !app) { t.skip("PostgreSQL is not reachable"); return; }
  const email = `owner-${randomUUID()}@example.test`;
  const first = await app.inject({ method: "POST", url: "/v1/owners/register", remoteAddress: nextIp(), headers: { "idempotency-key": `register-guess-${randomUUID()}` }, payload: { email, password: "very secure password", display_name: "Guess Target" } });
  assert.equal(first.statusCode, 201, first.body);

  // A different Idempotency-Key (a fresh, unrelated call, not the same retry) with the right
  // email but the wrong password must be rejected before anything is returned -- otherwise this
  // endpoint becomes a way to learn whether an email is registered, or to mint a token for
  // someone else's account by guessing their email.
  const guess = await app.inject({ method: "POST", url: "/v1/owners/register", remoteAddress: nextIp(), headers: { "idempotency-key": `register-guess-${randomUUID()}` }, payload: { email, password: "totally different password", display_name: "Attacker" } });
  assert.equal(guess.statusCode, 409, guess.body);
  assert.equal(JSON.stringify(guess.json()).includes("access_token"), false, "no credential is ever issued for a wrong password");

  const count = await app.pg.query("SELECT count(*)::int n FROM owners WHERE email=$1", [email]);
  assert.equal(count.rows[0].n, 1, "no second owner row was created by the guess either");
});

test("agents/enroll: retry with the same one-time code resolves to the already-enrolled agent, not a second one", async (t) => {
  if (!pgAvailable || !app) { t.skip("PostgreSQL is not reachable"); return; }
  const owner = await registerOwner(`owner-${randomUUID()}@example.test`);
  const installationId = `install-${randomUUID()}`;
  const key = "enroll-retry-key";

  const { response: first, payload } = await enrollAgent(owner.token, installationId, key);
  assert.equal(first.statusCode, 201, first.body);
  const agentId = first.json().data.agent.agent_id;
  assert.equal(typeof first.json().data.agent_token, "string");

  // The client resends the exact same body it sent the first time, including the (now spent)
  // enrollment_token -- that is what identifies this as a retry, not a fresh distinct attempt.
  const retry = await app.inject({ method: "POST", url: "/v1/agents/enroll", headers: { "idempotency-key": key }, payload });
  assert.equal(retry.statusCode, 200, retry.body);
  assert.equal(retry.json().data.agent.agent_id, agentId, "retry must resolve to the same agent, not a second one");
  assert.equal(retry.json().data.agent_token, null, "the original one-time agent_token cannot be recovered and must not be fabricated");

  const count = await app.pg.query("SELECT count(*)::int n FROM agents WHERE owner_id=$1 AND installation_id=$2", [owner.ownerId, installationId]);
  assert.equal(count.rows[0].n, 1, "no second agent row was created");

  // Unchanged behaviour (issue #51 requirement): a genuinely different enrollment attempt --
  // a fresh, still-valid code -- targeting the same installation_id must still be rejected with
  // the pre-existing structured 409, not silently treated as another replay.
  const freshCode = await app.inject({ method: "POST", url: "/v1/owners/me/enrollment-tokens", headers: mutate(owner.token, `fresh-code-${randomUUID()}`), payload: {} });
  const conflict = await app.inject({
    method: "POST", url: "/v1/agents/enroll", headers: { "idempotency-key": `enroll-conflict-${randomUUID()}` },
    payload: { enrollment_token: freshCode.json().data.enrollment_token, installation_id: installationId, profile: { name: "Someone Else", role: "tester" } }
  });
  assert.equal(conflict.statusCode, 409, conflict.body);
  assert.equal(conflict.json().error.code, "agent_already_enrolled");
  assert.equal(conflict.json().error.details.agent_id, agentId);

  const countAfterConflict = await app.pg.query("SELECT count(*)::int n FROM agents WHERE owner_id=$1 AND installation_id=$2", [owner.ownerId, installationId]);
  assert.equal(countAfterConflict.rows[0].n, 1, "the distinct-code conflict still does not create a second agent");
});

test("sessions: retry with the same Idempotency-Key resolves to the same live session, not a second one", async (t) => {
  if (!pgAvailable || !app) { t.skip("PostgreSQL is not reachable"); return; }
  const owner = await registerOwner(`owner-${randomUUID()}@example.test`);
  const installationId = `install-${randomUUID()}`;
  const { response: enrolled } = await enrollAgent(owner.token, installationId, `enroll-${randomUUID()}`);
  assert.equal(enrolled.statusCode, 201, enrolled.body);
  const agentId = enrolled.json().data.agent.agent_id as string;
  const agentToken = enrolled.json().data.agent_token as string;
  const sessionPayload = { installation_id: installationId, host: { kind: "codex" }, persona_revision: 1 };
  const key = "session-retry-key";

  const first = await app.inject({ method: "POST", url: "/v1/sessions", headers: mutate(agentToken, key), payload: sessionPayload });
  assert.equal(first.statusCode, 201, first.body);
  const sessionId = first.json().data.session_id;
  assert.equal(typeof first.json().data.session_token, "string");

  const retry = await app.inject({ method: "POST", url: "/v1/sessions", headers: mutate(agentToken, key), payload: sessionPayload });
  assert.equal(retry.statusCode, 200, retry.body);
  assert.equal(retry.json().data.session_id, sessionId, "retry must resolve to the same session, not a second one");
  assert.equal(retry.json().data.session_token, null, "the original session_token cannot be recovered and must not be fabricated");

  const count = await app.pg.query("SELECT count(*)::int n FROM sessions WHERE agent_id=$1", [agentId]);
  assert.equal(count.rows[0].n, 1, "no second session row was created, and no live session was superseded");
});

test("sessions: two concurrent retries with the same Idempotency-Key never create two sessions", async (t) => {
  if (!pgAvailable || !app) { t.skip("PostgreSQL is not reachable"); return; }
  const owner = await registerOwner(`owner-${randomUUID()}@example.test`);
  const installationId = `install-${randomUUID()}`;
  const { response: enrolled } = await enrollAgent(owner.token, installationId, `enroll-${randomUUID()}`);
  assert.equal(enrolled.statusCode, 201, enrolled.body);
  const agentId = enrolled.json().data.agent.agent_id as string;
  const agentToken = enrolled.json().data.agent_token as string;
  const key = "session-race-key";
  const sessionPayload = { installation_id: installationId, host: { kind: "codex" }, persona_revision: 1 };

  const [a, b] = await Promise.all([
    app.inject({ method: "POST", url: "/v1/sessions", headers: mutate(agentToken, key), payload: sessionPayload }),
    app.inject({ method: "POST", url: "/v1/sessions", headers: mutate(agentToken, key), payload: sessionPayload })
  ]);
  assert.ok([a.statusCode, b.statusCode].every(s => s === 200 || s === 201), `${a.statusCode} ${b.statusCode}`);
  const sessionIds = new Set([a.json().data.session_id, b.json().data.session_id]);
  assert.equal(sessionIds.size, 1, "both concurrent identical requests resolve to the same session");

  const count = await app.pg.query("SELECT count(*)::int n FROM sessions WHERE agent_id=$1", [agentId]);
  assert.equal(count.rows[0].n, 1);
});
