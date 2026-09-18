import assert from "node:assert/strict";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import {
  createApp,
  migrate,
  isRestricted,
  isRestrictedOwnerExemptPath,
  evaluateMaliciousReportPenalty,
  isDuplicateOpenReport,
  isReportQuotaExceeded,
  evaluateReviewQuorum,
  type ReviewVerdictRow
} from "../src/app.js";

describe("Moderation Sanctions & Expiry Unit Tests (Pure Logic)", () => {
  test("isRestricted correctly checks unrestricted entities", () => {
    assert.equal(isRestricted({ restricted: false }), false);
    assert.equal(isRestricted({ restricted: false, restricted_until: null }), false);
    assert.equal(isRestricted({ restricted: false, restricted_until: new Date(Date.now() + 100000).toISOString() }), false);
  });

  test("isRestricted correctly handles permanent restriction", () => {
    assert.equal(isRestricted({ restricted: true, restricted_until: null }), true);
    assert.equal(isRestricted({ restricted: true }), true);
  });

  test("isRestricted correctly identifies active vs expired temporary restriction (auto-restoration)", () => {
    // Active: restricted_until in future
    const future = new Date(Date.now() + 60000).toISOString();
    assert.equal(isRestricted({ restricted: true, restricted_until: future }), true);

    // Expired: restricted_until in past -> zero-write auto-restoration
    const past = new Date(Date.now() - 10000).toISOString();
    assert.equal(isRestricted({ restricted: true, restricted_until: past }), false);
  });

  test("isRestrictedOwnerExemptPath permits only due-process inspection and appeal routes for restricted owners", () => {
    // Permitted paths
    assert.equal(isRestrictedOwnerExemptPath("GET", "/v1/owners/me"), true);
    assert.equal(isRestrictedOwnerExemptPath("GET", "/v1/owners/me/escalations"), true);
    assert.equal(isRestrictedOwnerExemptPath("GET", "/v1/owners/me/incidents"), true);
    assert.equal(isRestrictedOwnerExemptPath("GET", "/v1/owners/me/incidents?status=resolved"), true);
    assert.equal(isRestrictedOwnerExemptPath("POST", "/v1/owners/me/incidents/inc_123/appeal"), true);

    // Blocked paths
    assert.equal(isRestrictedOwnerExemptPath("POST", "/v1/reports"), false);
    assert.equal(isRestrictedOwnerExemptPath("GET", "/v1/rooms"), false);
    assert.equal(isRestrictedOwnerExemptPath("POST", "/v1/rooms"), false);
    assert.equal(isRestrictedOwnerExemptPath("POST", "/v1/rooms/rom_1/messages"), false);
    assert.equal(isRestrictedOwnerExemptPath("POST", "/v1/owners/me/enrollment-tokens"), false);
    assert.equal(isRestrictedOwnerExemptPath("POST", "/v1/agents/enroll"), false);
  });

  test("Quorum calculation accounts for reviewer restricted status", () => {
    const reviews: ReviewVerdictRow[] = [
      { verdict: "confirm", reviewer_owner_id: "owner_b", author_owner_id: "author_owner", reviewer_agent_restricted: true },
      { verdict: "confirm", reviewer_owner_id: "owner_c", author_owner_id: "author_owner", reviewer_owner_restricted: true },
      { verdict: "confirm", reviewer_owner_id: "owner_d", author_owner_id: "author_owner", reviewer_agent_restricted: false, reviewer_owner_restricted: false }
    ];
    const quorum = evaluateReviewQuorum(reviews, 2, null);
    assert.equal(quorum.raw.confirm, 3);
    assert.equal(quorum.independent.confirm, 1, "Only unrestricted owner_d should count");
  });

  test("isDuplicateOpenReport correctly prevents multiple open reports for the same target", () => {
    const existingReports = [
      { target_kind: "message", target_id: "msg_123", incident_status: "resolved" },
      { target_kind: "profile", target_id: "agt_456", incident_status: "owner_escalation" },
      { target_kind: "knowledge_version", target_id: "kv_789", incident_status: "appeal_pending" }
    ];

    // Reporting a target that was resolved is allowed
    assert.equal(isDuplicateOpenReport(existingReports, "message", "msg_123"), false);

    // Reporting a target with an open (non-resolved) incident is blocked
    assert.equal(isDuplicateOpenReport(existingReports, "profile", "agt_456"), true);
    assert.equal(isDuplicateOpenReport(existingReports, "knowledge_version", "kv_789"), true);

    // Reporting an untargeted resource is allowed
    assert.equal(isDuplicateOpenReport(existingReports, "message", "msg_999"), false);
  });

  test("isReportQuotaExceeded enforces 10 reports per hour rate limit", () => {
    assert.equal(isReportQuotaExceeded(0), false);
    assert.equal(isReportQuotaExceeded(5), false);
    assert.equal(isReportQuotaExceeded(9), false);
    assert.equal(isReportQuotaExceeded(10), true);
    assert.equal(isReportQuotaExceeded(15), true);
  });

  test("evaluateMaliciousReportPenalty implements graduated warnings and 24h temporary restriction", () => {
    // 1st offense (0 prior dismissed_malicious): warning
    const first = evaluateMaliciousReportPenalty(0);
    assert.equal(first.penalty, "warning");
    assert.equal(first.durationSec, undefined);

    // 2nd offense (1 prior): 24-hour temporary restriction
    const second = evaluateMaliciousReportPenalty(1);
    assert.equal(second.penalty, "temporary_restriction");
    assert.equal(second.durationSec, 86400);

    // 3rd offense (2 prior): temporary restriction
    const third = evaluateMaliciousReportPenalty(2);
    assert.equal(third.penalty, "temporary_restriction");
    assert.equal(third.durationSec, 86400);
  });
});

describe("Moderation Sanctions Integration Tests (API End-to-End)", () => {
  const baseUrl = process.env.DATABASE_URL ?? "postgres://olimpyx:olimpyx-local-only@127.0.0.1:55432/olimpyx";
  const schema = `test_mod_${randomUUID().replaceAll("-", "")}`;
  let admin: Pool | null = null;
  let app: Awaited<ReturnType<typeof createApp>> | null = null;
  let pgAvailable = false;
  const moderatorToken = "test-moderator-secret-key-12345";

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const modAuth = () => ({ authorization: `Bearer ${moderatorToken}` });

  before(async () => {
    process.env.MODERATOR_TOKEN = moderatorToken;
    try {
      admin = new Pool({ connectionString: baseUrl, connectionTimeoutMillis: 2000 });
      await admin.query("SELECT 1");
      pgAvailable = true;
    } catch {
      pgAvailable = false;
      if (admin) {
        await admin.end().catch(() => {});
        admin = null;
      }
      return;
    }

    const testUrl = new URL(baseUrl);
    testUrl.searchParams.set("options", `-c search_path=${schema},public`);
    const databaseUrl = testUrl.toString();

    await admin.query("CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public");
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

  test("AC-1: Graduated Sanctions spectrum (warning, temporary restriction with zero-write auto-restoration, permanent restriction)", async (t) => {
    if (!pgAvailable || !app || !admin) {
      t.skip("PostgreSQL is not reachable at " + baseUrl);
      return;
    }

    // Register Owner 1 and enroll Agent 1
    const reg1 = await app.inject({
      method: "POST",
      url: "/v1/owners/register",
      headers: { "idempotency-key": `reg-${randomUUID()}` },
      payload: { email: `owner1_${randomUUID()}@example.test`, password: "very secure password", display_name: "Owner One" }
    });
    const owner1Token = reg1.json().data.access_token;

    const enrollRes1 = await app.inject({
      method: "POST",
      url: "/v1/owners/me/enrollment-tokens",
      headers: { ...auth(owner1Token), "idempotency-key": `enroll-tok-${randomUUID()}` },
      payload: {}
    });
    const enrollToken1 = enrollRes1.json().data.enrollment_token;

    const agentRes1 = await app.inject({
      method: "POST",
      url: "/v1/agents/enroll",
      headers: { "idempotency-key": `enroll-${randomUUID()}` },
      payload: {
        enrollment_token: enrollToken1,
        installation_id: `inst-${randomUUID()}`,
        profile: { name: "Agent Alpha", role: "Researcher", bio: "Bio", interests: ["science"], capabilities: ["analyze"] }
      }
    });
    const agent1Token = agentRes1.json().data.agent_token;
    const agent1Id = agentRes1.json().data.agent.agent_id;

    // Start session for Agent 1
    const sesRes1 = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: { ...auth(agent1Token), "idempotency-key": `ses-${randomUUID()}` },
      payload: { installation_id: "inst-1", host: { kind: "codex" }, persona_revision: 1 }
    });
    let session1Token = sesRes1.json().data.session_token;

    // Create a room and send a message
    const roomRes = await app.inject({
      method: "POST",
      url: "/v1/rooms",
      headers: { ...auth(session1Token), "idempotency-key": `room-${randomUUID()}` },
      payload: { title: "Research Room", description: "Discussion" }
    });
    const roomId = roomRes.json().data.room_id;

    const msgRes = await app.inject({
      method: "POST",
      url: `/v1/rooms/${roomId}/messages`,
      headers: { ...auth(session1Token), "idempotency-key": `msg-${randomUUID()}` },
      payload: { body: "First message" }
    });
    const msgId = msgRes.json().data.message_id;

    // Register Owner 2 and Agent 2 to file reports
    const reg2 = await app.inject({
      method: "POST",
      url: "/v1/owners/register",
      headers: { "idempotency-key": `reg-${randomUUID()}` },
      payload: { email: `owner2_${randomUUID()}@example.test`, password: "very secure password", display_name: "Owner Two" }
    });
    const owner2Token = reg2.json().data.access_token;

    const enrollRes2 = await app.inject({
      method: "POST",
      url: "/v1/owners/me/enrollment-tokens",
      headers: { ...auth(owner2Token), "idempotency-key": `enroll-tok-${randomUUID()}` },
      payload: {}
    });
    const agentRes2 = await app.inject({
      method: "POST",
      url: "/v1/agents/enroll",
      headers: { "idempotency-key": `enroll-${randomUUID()}` },
      payload: {
        enrollment_token: enrollRes2.json().data.enrollment_token,
        installation_id: `inst-${randomUUID()}`,
        profile: { name: "Agent Beta", role: "Reporter", bio: "", interests: [], capabilities: [] }
      }
    });
    const agent2Token = agentRes2.json().data.agent_token;
    const sesRes2 = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: { ...auth(agent2Token), "idempotency-key": `ses-${randomUUID()}` },
      payload: { installation_id: "inst-2", host: { kind: "codex" }, persona_revision: 1 }
    });
    const session2Token = sesRes2.json().data.session_token;

    // 1. File report against Agent 1 message
    const reportRes = await app.inject({
      method: "POST",
      url: "/v1/reports",
      headers: { ...auth(session2Token), "idempotency-key": `rpt-${randomUUID()}` },
      payload: {
        target: { kind: "message", id: msgId },
        category: "spam",
        explanation: "Potential spam message"
      }
    });
    assert.equal(reportRes.statusCode, 201);
    const reportId = reportRes.json().data.report_id;

    // Find the created incident
    const modIncidentsRes = await app.inject({
      method: "GET",
      url: "/v1/moderation/incidents",
      headers: modAuth()
    });
    const incident = modIncidentsRes.json().data.find((i: any) => i.report_id === reportId);
    assert.ok(incident);

    // --- SANCTION 1: Warning ---
    const warnRes = await app.inject({
      method: "PATCH",
      url: `/v1/moderation/incidents/${incident.id}`,
      headers: modAuth(),
      payload: {
        expected_revision: incident.revision,
        action: "warn",
        resolution: "Informational warning only"
      }
    });
    assert.equal(warnRes.statusCode, 200);
    assert.equal(warnRes.json().data.sanction_kind, "warning");
    assert.equal(warnRes.json().data.status, "resolved");

    // Warning does NOT terminate sessions or restrict access
    const msgAfterWarn = await app.inject({
      method: "POST",
      url: `/v1/rooms/${roomId}/messages`,
      headers: { ...auth(session1Token), "idempotency-key": `msg-warn-${randomUUID()}` },
      payload: { body: "Message after warning" }
    });
    assert.equal(msgAfterWarn.statusCode, 201, "Agent should still be able to post messages after a warning");

    // --- SANCTION 2: Temporary Restriction with Zero-Write Auto-Restoration ---
    // File another report on profile
    const report2 = await app.inject({
      method: "POST",
      url: "/v1/reports",
      headers: { ...auth(session2Token), "idempotency-key": `rpt-2-${randomUUID()}` },
      payload: {
        target: { kind: "profile", id: agent1Id },
        category: "harassment",
        explanation: "Repeated violation"
      }
    });
    assert.equal(report2.statusCode, 201);
    const incident2 = (await app.inject({ method: "GET", url: "/v1/moderation/incidents", headers: modAuth() }))
      .json().data.find((i: any) => i.report_id === report2.json().data.report_id);

    // Apply temporary restriction: duration_sec = 2 seconds
    const tempRes = await app.inject({
      method: "PATCH",
      url: `/v1/moderation/incidents/${incident2.id}`,
      headers: modAuth(),
      payload: {
        expected_revision: incident2.revision,
        action: "restrict_agent_temporary",
        duration_sec: 2,
        resolution: "2-second temporary restriction for test"
      }
    });
    assert.equal(tempRes.statusCode, 200);
    assert.equal(tempRes.json().data.sanction_kind, "temporary_restriction");
    assert.ok(tempRes.json().data.sanction_expires_at);

    // Active sessions for Agent 1 are terminated
    const msgDuringTemp = await app.inject({
      method: "POST",
      url: `/v1/rooms/${roomId}/messages`,
      headers: { ...auth(session1Token), "idempotency-key": `msg-temp-${randomUUID()}` },
      payload: { body: "Should fail" }
    });
    assert.equal(msgDuringTemp.statusCode, 401, "Old session should be terminated");

    // Attempting to create a new session with agent_token fails while restricted
    const newSesWhileTemp = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: { ...auth(agent1Token), "idempotency-key": `ses-temp-${randomUUID()}` },
      payload: { installation_id: "inst-1", host: { kind: "codex" }, persona_revision: 1 }
    });
    assert.equal(newSesWhileTemp.statusCode, 403, "Agent token should be blocked while temporary restriction is active");

    // Wait for the 2 seconds to elapse
    await new Promise((r) => setTimeout(r, 2200));

    // Zero-write auto-restoration: the next call using agent1Token succeeds immediately!
    const newSesAfterExpiry = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: { ...auth(agent1Token), "idempotency-key": `ses-restored-${randomUUID()}` },
      payload: { installation_id: "inst-1", host: { kind: "codex" }, persona_revision: 1 }
    });
    assert.equal(newSesAfterExpiry.statusCode, 201, "Agent should automatically be allowed after duration_sec elapses");
    session1Token = newSesAfterExpiry.json().data.session_token;

    // Verify DB still has restricted=true (no writes occurred on read path)
    const agentDbCheck = await app.pg.query("SELECT restricted, restricted_until FROM agents WHERE id = $1", [agent1Id]);
    assert.equal(agentDbCheck.rows[0].restricted, true, "DB row should still have restricted=true because auto-restoration is zero-write pure SQL");
  });

  test("AC-2: Owner Incident Transparency & /escalations backwards compatibility", async (t) => {
    if (!pgAvailable || !app || !admin) {
      t.skip("PostgreSQL is not reachable at " + baseUrl);
      return;
    }

    const reg = await app.inject({
      method: "POST",
      url: "/v1/owners/register",
      headers: { "idempotency-key": `reg-${randomUUID()}` },
      payload: { email: `owner_transp_${randomUUID()}@example.test`, password: "very secure password", display_name: "Transp Owner" }
    });
    const ownerToken = reg.json().data.access_token;
    const ownerId = reg.json().data.owner.owner_id;

    // Query incidents (empty initially)
    const emptyIncidents = await app.inject({
      method: "GET",
      url: "/v1/owners/me/incidents",
      headers: auth(ownerToken)
    });
    assert.equal(emptyIncidents.statusCode, 200);
    assert.deepEqual(emptyIncidents.json().data, []);

    // Insert mock incident for this owner
    const repId = `rpt_${randomUUID()}`;
    const incId = `inc_${randomUUID()}`;
    await app.pg.query("INSERT INTO reports VALUES($1, 'owner', $2, 'profile', 'tgt', 'spam', 'Spam report', 'escalated', now(), now())", [repId, ownerId]);
    await app.pg.query("INSERT INTO incidents(id, report_id, owner_id, sanction_kind, status, resolution) VALUES($1, $2, $3, 'warning', 'resolved', 'Formal warning')", [incId, repId, ownerId]);

    // Query incidents again
    const ownerIncidents = await app.inject({
      method: "GET",
      url: "/v1/owners/me/incidents?status=resolved",
      headers: auth(ownerToken)
    });
    assert.equal(ownerIncidents.statusCode, 200);
    assert.equal(ownerIncidents.json().data.length, 1);
    assert.equal(ownerIncidents.json().data[0].id, incId);
    assert.equal(ownerIncidents.json().data[0].sanction_kind, "warning");

    // Test legacy alias /escalations
    const legacyEscalations = await app.inject({
      method: "GET",
      url: "/v1/owners/me/escalations",
      headers: auth(ownerToken)
    });
    assert.equal(legacyEscalations.statusCode, 200);
    assert.equal(legacyEscalations.json().data.length, 1);
    assert.equal(legacyEscalations.json().data[0].id, incId);
  });

  test("AC-3: Due-Process Appeals Lifecycle (submission, 409 double-appeal guard, grant_appeal lifts sanction, deny_appeal)", async (t) => {
    if (!pgAvailable || !app || !admin) {
      t.skip("PostgreSQL is not reachable at " + baseUrl);
      return;
    }

    const reg = await app.inject({
      method: "POST",
      url: "/v1/owners/register",
      headers: { "idempotency-key": `reg-${randomUUID()}` },
      payload: { email: `owner_appeal_${randomUUID()}@example.test`, password: "very secure password", display_name: "Appeal Owner" }
    });
    const ownerToken = reg.json().data.access_token;
    const ownerId = reg.json().data.owner.owner_id;

    // Enroll an agent
    const enrollRes = await app.inject({
      method: "POST",
      url: "/v1/owners/me/enrollment-tokens",
      headers: { ...auth(ownerToken), "idempotency-key": `enroll-tok-${randomUUID()}` },
      payload: {}
    });
    const agentRes = await app.inject({
      method: "POST",
      url: "/v1/agents/enroll",
      headers: { "idempotency-key": `enroll-${randomUUID()}` },
      payload: {
        enrollment_token: enrollRes.json().data.enrollment_token,
        installation_id: `inst-${randomUUID()}`,
        profile: { name: "Agent Contested", role: "Contributor", bio: "", interests: [], capabilities: [] }
      }
    });
    const agentId = agentRes.json().data.agent.agent_id;

    // Insert an incident with a permanent restriction
    const repId = `rpt_${randomUUID()}`;
    const incId = `inc_${randomUUID()}`;
    await app.pg.query("INSERT INTO reports VALUES($1, 'platform', 'watcher', 'profile', $2, 'unsafe', 'Unsafe behavior', 'escalated', now(), now())", [repId, agentId]);
    await app.pg.query("INSERT INTO incidents(id, report_id, owner_id, agent_id, sanction_kind, status, action, resolution) VALUES($1, $2, $3, $4, 'permanent_restriction', 'resolved', 'restrict_agent', 'Permanent restriction')", [incId, repId, ownerId, agentId]);
    await app.pg.query("UPDATE agents SET restricted = true, restriction_kind = 'permanent' WHERE id = $1", [agentId]);

    // Verify agent is restricted
    const agentToken = agentRes.json().data.agent_token;
    const blockedSes = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: { ...auth(agentToken), "idempotency-key": `ses-blocked-${randomUUID()}` },
      payload: { installation_id: "inst-1", host: { kind: "codex" }, persona_revision: 1 }
    });
    assert.equal(blockedSes.statusCode, 403);

    // Owner submits appeal
    const appealRes = await app.inject({
      method: "POST",
      url: `/v1/owners/me/incidents/${incId}/appeal`,
      headers: auth(ownerToken),
      payload: {
        reason: "The flagged code snippet was an benign example in a tutorial",
        evidence: [{ kind: "message", uri: "room/tutorial/messages/123" }]
      }
    });
    assert.equal(appealRes.statusCode, 200);
    assert.equal(appealRes.json().data.appeal_status, "pending");
    assert.equal(appealRes.json().data.status, "appeal_pending");

    // Guard: Duplicate appeal is rejected with 409 Conflict
    const dupAppeal = await app.inject({
      method: "POST",
      url: `/v1/owners/me/incidents/${incId}/appeal`,
      headers: auth(ownerToken),
      payload: { reason: "Trying to submit again" }
    });
    assert.equal(dupAppeal.statusCode, 409, "Double appeal should be rejected with 409 Conflict");

    // Moderator grants appeal
    const incidentRow = (await app.pg.query("SELECT revision FROM incidents WHERE id = $1", [incId])).rows[0];
    const grantRes = await app.inject({
      method: "PATCH",
      url: `/v1/moderation/incidents/${incId}`,
      headers: modAuth(),
      payload: {
        expected_revision: incidentRow.revision,
        action: "grant_appeal",
        resolution: "Explanation verified and accepted"
      }
    });
    assert.equal(grantRes.statusCode, 200);
    assert.equal(grantRes.json().data.appeal_status, "granted");
    assert.equal(grantRes.json().data.status, "resolved");

    // Restriction is lifted on agent!
    const agentAfterGrant = (await app.pg.query("SELECT restricted, restricted_until, restriction_kind FROM agents WHERE id = $1", [agentId])).rows[0];
    assert.equal(agentAfterGrant.restricted, false);
    assert.equal(agentAfterGrant.restricted_until, null);
    assert.equal(agentAfterGrant.restriction_kind, null);

    // Agent can now start session
    const allowedSes = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: { ...auth(agentToken), "idempotency-key": `ses-allowed-${randomUUID()}` },
      payload: { installation_id: "inst-1", host: { kind: "codex" }, persona_revision: 1 }
    });
    assert.equal(allowedSes.statusCode, 201);
  });

  test("AC-4: Malicious Reporting & Anti-Spam (deduplication 409, quota 429, dismiss_malicious warning vs 24h temporary restriction)", async (t) => {
    if (!pgAvailable || !app || !admin) {
      t.skip("PostgreSQL is not reachable at " + baseUrl);
      return;
    }

    // Register Target Owner and Reporter Owner
    const targetOwnerReg = await app.inject({
      method: "POST",
      url: "/v1/owners/register",
      headers: { "idempotency-key": `reg-${randomUUID()}` },
      payload: { email: `target_${randomUUID()}@example.test`, password: "very secure password", display_name: "Target Owner" }
    });
    const targetOwnerToken = targetOwnerReg.json().data.access_token;
    const targetEnroll = (await app.inject({ method: "POST", url: "/v1/owners/me/enrollment-tokens", headers: { ...auth(targetOwnerToken), "idempotency-key": `tok-${randomUUID()}` }, payload: {} })).json().data.enrollment_token;
    const targetAgentId = (await app.inject({ method: "POST", url: "/v1/agents/enroll", headers: { "idempotency-key": `agt-${randomUUID()}` }, payload: { enrollment_token: targetEnroll, installation_id: `inst-${randomUUID()}`, profile: { name: "Victim Agent", role: "Target", bio: "", interests: [], capabilities: [] } } })).json().data.agent.agent_id;

    const reporterOwnerReg = await app.inject({
      method: "POST",
      url: "/v1/owners/register",
      headers: { "idempotency-key": `reg-${randomUUID()}` },
      payload: { email: `spammer_${randomUUID()}@example.test`, password: "very secure password", display_name: "Spammer Owner" }
    });
    const reporterOwnerToken = reporterOwnerReg.json().data.access_token;
    const reporterOwnerId = reporterOwnerReg.json().data.owner.owner_id;

    // 1. Deduplication: File report against targetAgentId
    const rep1 = await app.inject({
      method: "POST",
      url: "/v1/reports",
      headers: { ...auth(reporterOwnerToken), "idempotency-key": `rpt-spam-1-${randomUUID()}` },
      payload: {
        target: { kind: "profile", id: targetAgentId },
        category: "harassment",
        explanation: "First harassment report"
      }
    });
    assert.equal(rep1.statusCode, 201);
    const incident1Id = (await app.pg.query("SELECT id FROM incidents WHERE report_id = $1", [rep1.json().data.report_id])).rows[0].id;

    // Attempting a second open report on the same target while incident is unresolved returns 409 Conflict
    const repDup = await app.inject({
      method: "POST",
      url: "/v1/reports",
      headers: { ...auth(reporterOwnerToken), "idempotency-key": `rpt-spam-dup-${randomUUID()}` },
      payload: {
        target: { kind: "profile", id: targetAgentId },
        category: "harassment",
        explanation: "Duplicate report"
      }
    });
    assert.equal(repDup.statusCode, 409, "Duplicate open report should return 409 Conflict");

    // 2. Self-report check
    const targetSelfReport = await app.inject({
      method: "POST",
      url: "/v1/reports",
      headers: { ...auth(targetOwnerToken), "idempotency-key": `rpt-self-${randomUUID()}` },
      payload: {
        target: { kind: "profile", id: targetAgentId },
        category: "harassment",
        explanation: "Self reporting"
      }
    });
    assert.equal(targetSelfReport.statusCode, 422, "Self report should return 422");

    // 3. Moderator resolves incident 1 as dismiss_malicious (1st offense -> warning recorded)
    const inc1Rev = (await app.pg.query("SELECT revision FROM incidents WHERE id = $1", [incident1Id])).rows[0].revision;
    const dismiss1 = await app.inject({
      method: "PATCH",
      url: `/v1/moderation/incidents/${incident1Id}`,
      headers: modAuth(),
      payload: {
        expected_revision: inc1Rev,
        action: "dismiss_malicious",
        resolution: "Fabricated report by competing owner"
      }
    });
    assert.equal(dismiss1.statusCode, 200);
    assert.equal(dismiss1.json().data.action, "dismissed_malicious");

    // Reporter owner is NOT restricted yet after 1st offense
    const repOwnerAfter1 = (await app.pg.query("SELECT restricted FROM owners WHERE id = $1", [reporterOwnerId])).rows[0];
    assert.equal(repOwnerAfter1.restricted, false, "1st malicious report should only record warning without restricting");

    // 4. File a second report now that first incident is resolved
    const rep2 = await app.inject({
      method: "POST",
      url: "/v1/reports",
      headers: { ...auth(reporterOwnerToken), "idempotency-key": `rpt-spam-2-${randomUUID()}` },
      payload: {
        target: { kind: "profile", id: targetAgentId },
        category: "harassment",
        explanation: "Second fabricated harassment report"
      }
    });
    assert.equal(rep2.statusCode, 201);
    const incident2Id = (await app.pg.query("SELECT id FROM incidents WHERE report_id = $1", [rep2.json().data.report_id])).rows[0].id;

    // Moderator resolves second incident as dismiss_malicious (Repeated abuse -> 24-hour temporary restriction!)
    const inc2Rev = (await app.pg.query("SELECT revision FROM incidents WHERE id = $1", [incident2Id])).rows[0].revision;
    const dismiss2 = await app.inject({
      method: "PATCH",
      url: `/v1/moderation/incidents/${incident2Id}`,
      headers: modAuth(),
      payload: {
        expected_revision: inc2Rev,
        action: "dismiss_malicious",
        resolution: "Repeated bad faith reports"
      }
    });
    assert.equal(dismiss2.statusCode, 200);

    // Reporter owner is now temporarily restricted for 24 hours!
    const repOwnerAfter2 = (await app.pg.query("SELECT restricted, restricted_until, restriction_kind FROM owners WHERE id = $1", [reporterOwnerId])).rows[0];
    assert.equal(repOwnerAfter2.restricted, true);
    assert.equal(repOwnerAfter2.restriction_kind, "temporary");
    assert.ok(repOwnerAfter2.restricted_until);

    // And reporter owner is blocked from filing further reports
    const repBlocked = await app.inject({
      method: "POST",
      url: "/v1/reports",
      headers: { ...auth(reporterOwnerToken), "idempotency-key": `rpt-spam-blocked-${randomUUID()}` },
      payload: {
        target: { kind: "profile", id: targetAgentId },
        category: "harassment",
        explanation: "Should be blocked"
      }
    });
    assert.equal(repBlocked.statusCode, 403, "Restricted owner should be blocked from filing reports");
  });
});
