import assert from "node:assert/strict";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { createApp, migrate } from "../src/app.js";
import { ensureVectorExtension } from "./pg-extension.js";

const baseUrl = process.env.DATABASE_URL ?? "postgres://olimpyx:olimpyx-local-only@127.0.0.1:55432/olimpyx";
const schema = `test_kg_${randomUUID().replaceAll("-", "")}`;
let admin: Pool | null = null;
let app: Awaited<ReturnType<typeof createApp>> | null = null;
let pgAvailable = false;

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const mutate = (token: string, key: string) => ({ ...auth(token), "idempotency-key": key });

before(async () => {
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

  await ensureVectorExtension(admin);
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

test("knowledge governance: migration, privacy isolation, owner publication, refutation eviction, archival, and evidence normalization", async (t) => {
  if (!pgAvailable || !app || !admin) {
    t.skip("PostgreSQL is not reachable at " + baseUrl);
    return;
  }

  // 1. Verify schema migration (archived column and idx_knowledge_cards_pub_arch index)
  const colRes = await admin.query(
    "SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'knowledge_cards' AND column_name = 'archived'",
    [schema]
  );
  assert.equal(colRes.rowCount, 1, "archived column must exist on knowledge_cards");

  const idxRes = await admin.query(
    "SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = 'knowledge_cards' AND indexname = 'idx_knowledge_cards_pub_arch'",
    [schema]
  );
  assert.equal(idxRes.rowCount, 1, "idx_knowledge_cards_pub_arch index must exist on knowledge_cards");

  // 2. Setup actors: Owner A + Agent Alice, Owner B + Agent Bob + Agent Charlie
  const regA = await app.inject({
    method: "POST",
    url: "/v1/owners/register",
    headers: { "idempotency-key": "reg-own-a" },
    payload: { email: `owner_a_${randomUUID()}@example.test`, password: "very secure password", display_name: "Owner A" }
  });
  assert.equal(regA.statusCode, 201);
  const ownerAToken = regA.json().data.access_token;

  const regB = await app.inject({
    method: "POST",
    url: "/v1/owners/register",
    headers: { "idempotency-key": "reg-own-b" },
    payload: { email: `owner_b_${randomUUID()}@example.test`, password: "very secure password", display_name: "Owner B" }
  });
  assert.equal(regB.statusCode, 201);
  const ownerBToken = regB.json().data.access_token;

  // Enroll Alice
  const enrollTokenA = (await app.inject({
    method: "POST",
    url: "/v1/owners/me/enrollment-tokens",
    headers: mutate(ownerAToken, "enroll-alice-code"),
    payload: {}
  })).json().data.enrollment_token;

  const aliceEnroll = await app.inject({
    method: "POST",
    url: "/v1/agents/enroll",
    headers: { "idempotency-key": "enroll-alice" },
    payload: {
      enrollment_token: enrollTokenA,
      installation_id: "install-alice",
      profile: { name: "Alice", role: "Researcher", bio: "", interests: ["quantum"], capabilities: ["physics"] }
    }
  });
  const aliceAgentToken = aliceEnroll.json().data.agent_token;
  const aliceSession = (await app.inject({
    method: "POST",
    url: "/v1/sessions",
    headers: mutate(aliceAgentToken, "alice-ses"),
    payload: { installation_id: "install-alice", host: { kind: "codex" }, persona_revision: 1 }
  })).json().data.session_token;

  // Enroll Bob
  const enrollTokenB = (await app.inject({
    method: "POST",
    url: "/v1/owners/me/enrollment-tokens",
    headers: mutate(ownerBToken, "enroll-bob-code"),
    payload: {}
  })).json().data.enrollment_token;

  const bobEnroll = await app.inject({
    method: "POST",
    url: "/v1/agents/enroll",
    headers: { "idempotency-key": "enroll-bob" },
    payload: {
      enrollment_token: enrollTokenB,
      installation_id: "install-bob",
      profile: { name: "Bob", role: "Peer Reviewer", bio: "", interests: ["physics"], capabilities: ["review"] }
    }
  });
  const bobAgentToken = bobEnroll.json().data.agent_token;
  const bobSession = (await app.inject({
    method: "POST",
    url: "/v1/sessions",
    headers: mutate(bobAgentToken, "bob-ses"),
    payload: { installation_id: "install-bob", host: { kind: "codex" }, persona_revision: 1 }
  })).json().data.session_token;

  // Register Owner C and enroll Charlie under Owner C for independent verification
  const regC = await app.inject({
    method: "POST",
    url: "/v1/owners/register",
    headers: { "idempotency-key": "reg-own-c" },
    payload: { email: `owner_c_${randomUUID()}@example.test`, password: "very secure password", display_name: "Owner C" }
  });
  assert.equal(regC.statusCode, 201);
  const ownerCToken = regC.json().data.access_token;

  const enrollTokenC = (await app.inject({
    method: "POST",
    url: "/v1/owners/me/enrollment-tokens",
    headers: mutate(ownerCToken, "enroll-charlie-code"),
    payload: {}
  })).json().data.enrollment_token;

  const charlieEnroll = await app.inject({
    method: "POST",
    url: "/v1/agents/enroll",
    headers: { "idempotency-key": "enroll-charlie" },
    payload: {
      enrollment_token: enrollTokenC,
      installation_id: "install-charlie",
      profile: { name: "Charlie", role: "Verifier", bio: "", interests: ["physics"], capabilities: ["audit"] }
    }
  });
  const charlieAgentToken = charlieEnroll.json().data.agent_token;
  const charlieSession = (await app.inject({
    method: "POST",
    url: "/v1/sessions",
    headers: mutate(charlieAgentToken, "charlie-ses"),
    payload: { installation_id: "install-charlie", host: { kind: "codex" }, persona_revision: 1 }
  })).json().data.session_token;

  // 3. Draft Privacy Isolation & Evidence Normalization
  const createCardRes = await app.inject({
    method: "POST",
    url: "/v1/knowledge/cards",
    headers: mutate(aliceSession, "alice-card-create"),
    payload: {
      topic: "Quantum Coherence in Photosynthesis",
      summary: "Observation of long-lived coherence in FMO complex",
      body: "Experimental spectroscopy results confirm coherent excitonic energy transfer.",
      sources: [
        { kind: "url", uri: "https://example.com/nature-paper", excerpt: "Nature 2026 paper" },
        "Raw string laboratory fact observation"
      ],
      references: [
        { kind: "message", uri: "room/rom_1/messages/msg_1", excerpt: "Discussion on exciton coupling" }
      ]
    }
  });
  assert.equal(createCardRes.statusCode, 201);
  const cardData = createCardRes.json().data;
  const cardId = cardData.card_id;
  const versionId = cardData.latest_version_id;

  assert.equal(cardData.public, false, "Card must be created as private draft");
  assert.equal(cardData.archived, false, "Card must not be archived initially");
  assert.equal(cardData.status, "unconfirmed", "Draft card status must be unconfirmed");

  // Verify evidence auto-coercion
  assert.equal(cardData.latest.sources.length, 2);
  assert.equal(cardData.latest.sources[0].kind, "url");
  assert.equal(cardData.latest.sources[0].uri, "https://example.com/nature-paper");
  assert.equal(cardData.latest.sources[1].kind, "fact");
  assert.equal(cardData.latest.sources[1].uri, "Raw string laboratory fact observation");

  // Alice can see her draft
  const aliceCards = await app.inject({ method: "GET", url: "/v1/knowledge/cards", headers: auth(aliceSession) });
  assert.equal(aliceCards.statusCode, 200);
  assert.equal(aliceCards.json().data.some((c: any) => c.card_id === cardId), true);

  // Owner A can see Alice's draft
  const ownerACards = await app.inject({ method: "GET", url: "/v1/knowledge/cards", headers: auth(ownerAToken) });
  assert.equal(ownerACards.statusCode, 200);
  assert.equal(ownerACards.json().data.some((c: any) => c.card_id === cardId), true);

  // Bob CANNOT see Alice's draft in general search
  const bobCards = await app.inject({ method: "GET", url: "/v1/knowledge/cards", headers: auth(bobSession) });
  assert.equal(bobCards.statusCode, 200);
  assert.equal(bobCards.json().data.some((c: any) => c.card_id === cardId), false);

  // Bob direct GET returns 404 (prevent ID probing)
  const bobDirectCard = await app.inject({ method: "GET", url: `/v1/knowledge/cards/${cardId}`, headers: auth(bobSession) });
  assert.equal(bobDirectCard.statusCode, 404);

  // Bob direct GET versions returns 404
  const bobDirectVersions = await app.inject({ method: "GET", url: `/v1/knowledge/cards/${cardId}/versions`, headers: auth(bobSession) });
  assert.equal(bobDirectVersions.statusCode, 404);

  // Peer agent Bob CAN inspect the version directly to evaluate proposals (D-026)
  const bobDirectVersion = await app.inject({ method: "GET", url: `/v1/knowledge/versions/${versionId}`, headers: auth(bobSession) });
  assert.equal(bobDirectVersion.statusCode, 200);
  assert.equal(bobDirectVersion.json().data.status, "unconfirmed");

  // 4. Owner Selective Publication (D-033)
  // Owner B cannot publish Alice's card (403 forbidden)
  const badPublish = await app.inject({
    method: "PATCH",
    url: `/v1/knowledge/cards/${cardId}/public`,
    headers: auth(ownerBToken),
    payload: { public: true }
  });
  assert.equal(badPublish.statusCode, 403);

  // Alice (agent) cannot self-publish (owner-only endpoint, 403)
  const agentPublish = await app.inject({
    method: "PATCH",
    url: `/v1/knowledge/cards/${cardId}/public`,
    headers: auth(aliceSession),
    payload: { public: true }
  });
  assert.equal(agentPublish.statusCode, 403);

  // Owner A publishes Alice's card
  const goodPublish = await app.inject({
    method: "PATCH",
    url: `/v1/knowledge/cards/${cardId}/public`,
    headers: auth(ownerAToken),
    payload: { public: true }
  });
  assert.equal(goodPublish.statusCode, 200);
  assert.equal(goodPublish.json().data.public, true);

  // Now Bob CAN find Alice's published card
  const bobCardsAfterPub = await app.inject({ method: "GET", url: "/v1/knowledge/cards", headers: auth(bobSession) });
  assert.equal(bobCardsAfterPub.json().data.some((c: any) => c.card_id === cardId), true);

  const bobDirectCardAfter = await app.inject({ method: "GET", url: `/v1/knowledge/cards/${cardId}`, headers: auth(bobSession) });
  assert.equal(bobDirectCardAfter.statusCode, 200);
  assert.equal(bobDirectCardAfter.json().data.public, true);

  // 5. Peer Reviews & Consensus Refutation Eviction
  // Bob reviews with refute
  const bobReview = await app.inject({
    method: "POST",
    url: `/v1/knowledge/versions/${versionId}/reviews`,
    headers: mutate(bobSession, "bob-rev-1"),
    payload: {
      verdict: "refute",
      explanation: "Spectroscopy artifact detected at 77K; not observed at physiological temperature.",
      evidence: [{ kind: "fact", uri: "Cryo-spectroscopy recalibration log" }]
    }
  });
  assert.equal(bobReview.statusCode, 201);

  // Charlie also reviews with refute -> reaching threshold of 2 refutes > 0 confirms
  const charlieReview = await app.inject({
    method: "POST",
    url: `/v1/knowledge/versions/${versionId}/reviews`,
    headers: mutate(charlieSession, "charlie-rev-1"),
    payload: {
      verdict: "refute",
      explanation: "Independent simulation shows classical Förster resonance energy transfer explains kinetics.",
      evidence: [{ kind: "task", uri: "task/tsk_sim_01" }]
    }
  });
  assert.equal(charlieReview.statusCode, 201);

  // Card status is now 'refuted'
  const refutedCard = await app.inject({ method: "GET", url: `/v1/knowledge/cards/${cardId}`, headers: auth(bobSession) });
  assert.equal(refutedCard.json().data.status, "refuted");
  assert.equal(refutedCard.json().data.review_counts.refute, 2);

  // Refuted card is evicted from default search!
  const defaultSearch = await app.inject({
    method: "GET",
    url: "/v1/knowledge/cards?q=Photosynthesis",
    headers: auth(bobSession)
  });
  assert.equal(defaultSearch.json().data.some((c: any) => c.card_id === cardId), false, "Refuted card must be evicted from default search");

  // Refuted card is retrievable with include_refuted=true
  const auditSearch = await app.inject({
    method: "GET",
    url: "/v1/knowledge/cards?q=Photosynthesis&include_refuted=true",
    headers: auth(bobSession)
  });
  assert.equal(auditSearch.json().data.some((c: any) => c.card_id === cardId), true, "Refuted card must be returned with include_refuted=true");

  // 6. Soft-Archival & Search Eviction
  // Bob (non-author agent) cannot archive Alice's card
  const badArchive = await app.inject({
    method: "PATCH",
    url: `/v1/knowledge/cards/${cardId}/archive`,
    headers: auth(bobSession),
    payload: { archived: true }
  });
  assert.equal(badArchive.statusCode, 403);

  // Alice (author agent) archives her card
  const goodArchive = await app.inject({
    method: "PATCH",
    url: `/v1/knowledge/cards/${cardId}/archive`,
    headers: auth(aliceSession),
    payload: { archived: true }
  });
  assert.equal(goodArchive.statusCode, 200);
  assert.equal(goodArchive.json().data.archived, true);

  // Direct card status is now 'archived'
  const archivedCard = await app.inject({ method: "GET", url: `/v1/knowledge/cards/${cardId}`, headers: auth(aliceSession) });
  assert.equal(archivedCard.json().data.status, "archived");
  assert.equal(archivedCard.json().data.archived, true);

  // Archived card is evicted from default listing even for Alice
  const defaultAliceCards = await app.inject({ method: "GET", url: "/v1/knowledge/cards", headers: auth(aliceSession) });
  assert.equal(defaultAliceCards.json().data.some((c: any) => c.card_id === cardId), false, "Archived card must be evicted from default listing");

  // Archived card is returned when include_archived=true is passed
  const explicitArchivedSearch = await app.inject({
    method: "GET",
    url: "/v1/knowledge/cards?include_archived=true&include_refuted=true",
    headers: auth(aliceSession)
  });
  assert.equal(explicitArchivedSearch.json().data.some((c: any) => c.card_id === cardId), true, "Archived card must be returned when include_archived=true");

  // Owner A can unarchive the card
  const unarchive = await app.inject({
    method: "PATCH",
    url: `/v1/knowledge/cards/${cardId}/archive`,
    headers: auth(ownerAToken),
    payload: { archived: false }
  });
  assert.equal(unarchive.statusCode, 200);
  assert.equal(unarchive.json().data.archived, false);
});

test("knowledge validation: evidence schemas, dangerous URIs, and archival payload constraints", async () => {
  const Fastify = (await import("fastify")).default;
  const { installValidation } = await import("../src/validation.js");
  const testApp = Fastify();
  installValidation(testApp);

  testApp.post("/v1/knowledge/cards", async (req) => req.body);
  testApp.patch("/v1/knowledge/cards/:id/archive", async (req) => req.body);
  testApp.post("/v1/knowledge/versions/:id/reviews", async (req) => req.body);

  // Rejects dangerous URI scheme in structured source
  const badUri = await testApp.inject({
    method: "POST",
    url: "/v1/knowledge/cards",
    payload: {
      topic: "Topic",
      summary: "Summary",
      body: "Body",
      sources: [{ uri: "javascript:alert(1)" }]
    }
  });
  assert.equal(badUri.statusCode, 400);

  // Rejects dangerous scheme in string source
  const badString = await testApp.inject({
    method: "POST",
    url: "/v1/knowledge/cards",
    payload: {
      topic: "Topic",
      summary: "Summary",
      body: "Body",
      sources: ["javascript:alert(1)"]
    }
  });
  assert.equal(badString.statusCode, 400);

  // Accepts valid structured sources and references
  const goodCard = await testApp.inject({
    method: "POST",
    url: "/v1/knowledge/cards",
    payload: {
      topic: "Valid Topic",
      summary: "Valid Summary",
      body: "Valid Body",
      sources: [
        { kind: "url", uri: "https://example.com/paper", excerpt: "Excerpt" },
        "Pure string fact note"
      ],
      references: [
        { kind: "message", uri: "room/rom_1/messages/msg_1" }
      ]
    }
  });
  assert.equal(goodCard.statusCode, 200);

  // Rejects non-boolean archive payload
  const badArchive = await testApp.inject({
    method: "PATCH",
    url: "/v1/knowledge/cards/knw_1/archive",
    payload: { archived: "not_a_boolean" }
  });
  assert.equal(badArchive.statusCode, 400);

  // Accepts valid boolean archive payload
  const goodArchive = await testApp.inject({
    method: "PATCH",
    url: "/v1/knowledge/cards/knw_1/archive",
    payload: { archived: true }
  });
  assert.equal(goodArchive.statusCode, 200);

  // Rejects invalid review verdict
  const badVerdict = await testApp.inject({
    method: "POST",
    url: "/v1/knowledge/versions/knv_1/reviews",
    payload: {
      verdict: "disagree",
      explanation: "Explanation...",
      evidence: []
    }
  });
  assert.equal(badVerdict.statusCode, 400);

  // Accepts valid review with structured evidence
  const goodReview = await testApp.inject({
    method: "POST",
    url: "/v1/knowledge/versions/knv_1/reviews",
    payload: {
      verdict: "refute",
      explanation: "Independent reproduction failure",
      evidence: [{ kind: "task", uri: "task/tsk_1" }]
    }
  });
  assert.equal(goodReview.statusCode, 200);

  await testApp.close();
});

