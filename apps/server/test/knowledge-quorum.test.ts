import assert from "node:assert/strict";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { createApp, migrate, evaluateReviewQuorum, type ReviewVerdictRow } from "../src/app.js";

describe("Knowledge Quorum Unit Tests (Anti-Sybil & Consensus Logic)", () => {
  test("AC-1: Author self-review and same-owner agent reviews do NOT increment independent confirms", () => {
    const authorOwner = "owner_a";
    const reviews: ReviewVerdictRow[] = [
      { verdict: "confirm", reviewer_owner_id: authorOwner, author_owner_id: authorOwner },
      { verdict: "confirm", reviewer_owner_id: authorOwner, author_owner_id: authorOwner }
    ];

    const result = evaluateReviewQuorum(reviews, 2, null);
    assert.deepEqual(result.raw, { confirm: 2, refute: 0, comment: 0 });
    assert.deepEqual(result.independent, { confirm: 0, refute: 0 });
    assert.equal(result.quorum.independent_confirms, 0);
    assert.equal(result.quorum.confirms_needed, 2);
    assert.equal(result.quorum.reached, false);
    assert.equal(result.status, "unconfirmed");
  });

  test("AC-2: Multiple agents under Owner B consolidate into at most 1 independent vote", () => {
    const authorOwner = "owner_a";
    const reviewerOwnerB = "owner_b";
    const reviews: ReviewVerdictRow[] = [
      // Author self review
      { verdict: "confirm", reviewer_owner_id: authorOwner, author_owner_id: authorOwner },
      // 3 different agents under Owner B all confirming
      { verdict: "confirm", reviewer_owner_id: reviewerOwnerB, author_owner_id: authorOwner },
      { verdict: "confirm", reviewer_owner_id: reviewerOwnerB, author_owner_id: authorOwner },
      { verdict: "confirm", reviewer_owner_id: reviewerOwnerB, author_owner_id: authorOwner }
    ];

    const result = evaluateReviewQuorum(reviews, 2, null);
    assert.equal(result.raw.confirm, 4);
    assert.equal(result.independent.confirm, 1, "Owner B should consolidate to at most 1 independent confirm");
    assert.equal(result.quorum.independent_confirms, 1);
    assert.equal(result.quorum.reached, false);
    assert.equal(result.quorum.confirms_needed, 1);
    assert.equal(result.status, "unconfirmed");
  });

  test("AC-3: Distinct independent owners (Owner B + Owner C) reaching CONFIRMATION_THRESHOLD trigger confirmed status", () => {
    const authorOwner = "owner_a";
    const reviews: ReviewVerdictRow[] = [
      { verdict: "confirm", reviewer_owner_id: "owner_b", author_owner_id: authorOwner },
      { verdict: "confirm", reviewer_owner_id: "owner_c", author_owner_id: authorOwner }
    ];

    const result = evaluateReviewQuorum(reviews, 2, null);
    assert.equal(result.independent.confirm, 2);
    assert.equal(result.quorum.independent_confirms, 2);
    assert.equal(result.quorum.reached, true);
    assert.equal(result.quorum.confirms_needed, 0);
    assert.equal(result.status, "confirmed");
  });

  test("AC-4: Contested owner stance: agents of Owner B submitting conflicting verdicts treat owner as refuting/contested", () => {
    const authorOwner = "owner_a";
    const reviews: ReviewVerdictRow[] = [
      { verdict: "confirm", reviewer_owner_id: "owner_b", author_owner_id: authorOwner },
      { verdict: "refute", reviewer_owner_id: "owner_b", author_owner_id: authorOwner },
      { verdict: "confirm", reviewer_owner_id: "owner_c", author_owner_id: authorOwner }
    ];

    const result = evaluateReviewQuorum(reviews, 2, null);
    // Owner B has both confirm and refute -> counts as 1 refute, 0 confirms
    // Owner C has confirm -> 1 confirm
    assert.equal(result.independent.confirm, 1);
    assert.equal(result.independent.refute, 1);
    assert.equal(result.status, "unconfirmed");
  });

  test("AC-4 / m8 generalization: N+M agents under same owner (3 confirm, 2 refute) -> contested/refuting", () => {
    const authorOwner = "owner_a";
    const reviews: ReviewVerdictRow[] = [
      { verdict: "confirm", reviewer_owner_id: "owner_b", author_owner_id: authorOwner },
      { verdict: "confirm", reviewer_owner_id: "owner_b", author_owner_id: authorOwner },
      { verdict: "confirm", reviewer_owner_id: "owner_b", author_owner_id: authorOwner },
      { verdict: "refute", reviewer_owner_id: "owner_b", author_owner_id: authorOwner },
      { verdict: "refute", reviewer_owner_id: "owner_b", author_owner_id: authorOwner }
    ];

    const result = evaluateReviewQuorum(reviews, 2, null);
    assert.equal(result.independent.confirm, 0);
    assert.equal(result.independent.refute, 1);
  });

  test("Grandfather clause: existing confirmed_at timestamp preserves confirmed status", () => {
    const authorOwner = "owner_a";
    // 0 reviews, but confirmed_at exists historically in DB
    const result = evaluateReviewQuorum([], 2, "2026-09-01T00:00:00Z");
    assert.equal(result.status, "confirmed");
    assert.equal(result.quorum.reached, true);

    // But consensus refutation overrides grandfathered confirmation
    const refutedReviews: ReviewVerdictRow[] = [
      { verdict: "refute", reviewer_owner_id: "owner_b", author_owner_id: authorOwner },
      { verdict: "refute", reviewer_owner_id: "owner_c", author_owner_id: authorOwner }
    ];
    const refutedResult = evaluateReviewQuorum(refutedReviews, 2, "2026-09-01T00:00:00Z");
    assert.equal(refutedResult.status, "refuted");
  });

  test("Comments (verdict = 'comment') are discussion-only and excluded from independent quorum counts", () => {
    const authorOwner = "owner_a";
    const reviews: ReviewVerdictRow[] = [
      { verdict: "comment", reviewer_owner_id: "owner_b", author_owner_id: authorOwner },
      { verdict: "comment", reviewer_owner_id: "owner_c", author_owner_id: authorOwner }
    ];

    const result = evaluateReviewQuorum(reviews, 2, null);
    assert.deepEqual(result.raw, { confirm: 0, refute: 0, comment: 2 });
    assert.deepEqual(result.independent, { confirm: 0, refute: 0 });
    assert.equal(result.status, "unconfirmed");
  });

  test("Restricted agent and restricted owner reviews are excluded from independent counts", () => {
    const authorOwner = "owner_a";
    const reviews: ReviewVerdictRow[] = [
      // Restricted agent
      { verdict: "confirm", reviewer_owner_id: "owner_b", author_owner_id: authorOwner, reviewer_agent_restricted: true },
      // Restricted owner
      { verdict: "confirm", reviewer_owner_id: "owner_c", author_owner_id: authorOwner, reviewer_owner_restricted: true },
      // Valid unrestricted owner
      { verdict: "confirm", reviewer_owner_id: "owner_d", author_owner_id: authorOwner }
    ];

    const result = evaluateReviewQuorum(reviews, 2, null);
    assert.equal(result.raw.confirm, 3);
    assert.equal(result.independent.confirm, 1, "Only owner_d should count");
  });
});

describe("Knowledge Quorum Integration Tests (API End-to-End)", () => {
  const baseUrl = process.env.DATABASE_URL ?? "postgres://olimpyx:olimpyx-local-only@127.0.0.1:55432/olimpyx";
  const schema = `test_kq_${randomUUID().replaceAll("-", "")}`;
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

  test("AC-1 through AC-6: End-to-end consensus, Sybil exclusion, canonical resolution, and eviction", async (t) => {
    if (!pgAvailable || !app || !admin) {
      t.skip("PostgreSQL is not reachable at " + baseUrl);
      return;
    }

    // Register owners: Owner A (Author), Owner B (Multi-agent reviewer), Owner C (Second independent reviewer), Owner D (Third independent reviewer)
    async function createOwner(name: string) {
      const email = `${name.toLowerCase()}_${randomUUID()}@example.test`;
      const reg = await app!.inject({
        method: "POST",
        url: "/v1/owners/register",
        headers: { "idempotency-key": `reg-${name}` },
        payload: { email, password: "very secure password", display_name: name }
      });
      return reg.json().data.access_token as string;
    }

    async function enrollAgent(ownerToken: string, agentName: string) {
      const code = (await app!.inject({
        method: "POST",
        url: "/v1/owners/me/enrollment-tokens",
        headers: mutate(ownerToken, `code-${agentName}`),
        payload: {}
      })).json().data.enrollment_token;

      const enrolled = await app!.inject({
        method: "POST",
        url: "/v1/agents/enroll",
        headers: { "idempotency-key": `enroll-${agentName}` },
        payload: {
          enrollment_token: code,
          installation_id: `inst-${agentName}`,
          profile: { name: agentName, role: "Researcher", bio: "", interests: ["science"], capabilities: ["review"] }
        }
      });
      const agentToken = enrolled.json().data.agent_token;

      const session = await app!.inject({
        method: "POST",
        url: "/v1/sessions",
        headers: mutate(agentToken, `ses-${agentName}`),
        payload: { installation_id: `inst-${agentName}`, host: { kind: "codex" }, persona_revision: 1 }
      });
      return { agentToken, sessionToken: session.json().data.session_token as string };
    }

    const ownerAToken = await createOwner("OwnerA");
    const ownerBToken = await createOwner("OwnerB");
    const ownerCToken = await createOwner("OwnerC");
    const ownerDToken = await createOwner("OwnerD");

    const alice = await enrollAgent(ownerAToken, "Alice");
    const alex = await enrollAgent(ownerAToken, "Alex"); // same owner as Alice
    const bob1 = await enrollAgent(ownerBToken, "Bob1");
    const bob2 = await enrollAgent(ownerBToken, "Bob2"); // same owner as Bob1
    const charlie = await enrollAgent(ownerCToken, "Charlie");
    const dave = await enrollAgent(ownerDToken, "Dave");

    // Alice creates knowledge card 1
    const createCard = await app.inject({
      method: "POST",
      url: "/v1/knowledge/cards",
      headers: mutate(alice.sessionToken, "card-1-create"),
      payload: {
        topic: "Ribosome Translation Fidelity",
        summary: "Kinetic proofreading mechanism in protein synthesis",
        body: "Detailed kinetic analysis showing EF-Tu GTPase activation...",
        sources: [{ kind: "url", uri: "https://example.com/translation" }],
        references: []
      }
    });
    assert.equal(createCard.statusCode, 201);
    const cardId = createCard.json().data.card_id;
    const v1Id = createCard.json().data.latest_version_id;

    // Publish card so peers can discover it
    await app.inject({
      method: "PATCH",
      url: `/v1/knowledge/cards/${cardId}/public`,
      headers: auth(ownerAToken),
      payload: { public: true }
    });

    // --- AC-1: Author self-review and same-owner review do NOT increment independent confirms ---
    await app.inject({
      method: "POST",
      url: `/v1/knowledge/versions/${v1Id}/reviews`,
      headers: mutate(alice.sessionToken, "rev-alice-self"),
      payload: { verdict: "confirm", explanation: "Self verification" }
    });
    await app.inject({
      method: "POST",
      url: `/v1/knowledge/versions/${v1Id}/reviews`,
      headers: mutate(alex.sessionToken, "rev-alex-affiliated"),
      payload: { verdict: "confirm", explanation: "Affiliated same-owner endorsement" }
    });

    const v1AfterOwnerA = (await app.inject({
      method: "GET",
      url: `/v1/knowledge/versions/${v1Id}`,
      headers: auth(alice.sessionToken)
    })).json().data;

    assert.equal(v1AfterOwnerA.review_counts.confirm, 2, "Raw confirm count should be 2");
    assert.equal(v1AfterOwnerA.independent_review_counts.confirm, 0, "Independent confirm count must be 0");
    assert.equal(v1AfterOwnerA.quorum.independent_confirms, 0);
    assert.equal(v1AfterOwnerA.quorum.reached, false);
    assert.equal(v1AfterOwnerA.status, "unconfirmed");

    // --- AC-2: Multiple agents under Owner B consolidate into <= 1 independent vote ---
    await app.inject({
      method: "POST",
      url: `/v1/knowledge/versions/${v1Id}/reviews`,
      headers: mutate(bob1.sessionToken, "rev-bob1-confirm"),
      payload: { verdict: "confirm", explanation: "Owner B agent 1 confirmation" }
    });
    await app.inject({
      method: "POST",
      url: `/v1/knowledge/versions/${v1Id}/reviews`,
      headers: mutate(bob2.sessionToken, "rev-bob2-confirm"),
      payload: { verdict: "confirm", explanation: "Owner B agent 2 confirmation" }
    });

    const v1AfterOwnerB = (await app.inject({
      method: "GET",
      url: `/v1/knowledge/versions/${v1Id}`,
      headers: auth(alice.sessionToken)
    })).json().data;

    assert.equal(v1AfterOwnerB.review_counts.confirm, 4, "Raw confirm count: 2 from Owner A + 2 from Owner B");
    assert.equal(v1AfterOwnerB.independent_review_counts.confirm, 1, "Owner B must consolidate to exactly 1 independent confirm");
    assert.equal(v1AfterOwnerB.quorum.independent_confirms, 1);
    assert.equal(v1AfterOwnerB.quorum.reached, false);
    assert.equal(v1AfterOwnerB.quorum.confirms_needed, 1);
    assert.equal(v1AfterOwnerB.status, "unconfirmed");

    // --- AC-3: Distinct independent owners (Owner B + Owner C) reach CONFIRMATION_THRESHOLD -> confirmed ---
    await app.inject({
      method: "POST",
      url: `/v1/knowledge/versions/${v1Id}/reviews`,
      headers: mutate(charlie.sessionToken, "rev-charlie-confirm"),
      payload: { verdict: "confirm", explanation: "Owner C independent confirmation" }
    });

    const v1AfterOwnerC = (await app.inject({
      method: "GET",
      url: `/v1/knowledge/versions/${v1Id}`,
      headers: auth(alice.sessionToken)
    })).json().data;

    assert.equal(v1AfterOwnerC.independent_review_counts.confirm, 2, "Owner B + Owner C = 2 independent confirms");
    assert.equal(v1AfterOwnerC.quorum.independent_confirms, 2);
    assert.equal(v1AfterOwnerC.quorum.reached, true);
    assert.equal(v1AfterOwnerC.status, "confirmed");

    const cardAfterConfirm = (await app.inject({
      method: "GET",
      url: `/v1/knowledge/cards/${cardId}`,
      headers: auth(alice.sessionToken)
    })).json().data;

    assert.equal(cardAfterConfirm.status, "confirmed");
    assert.equal(cardAfterConfirm.canonical_version_id, v1Id);
    assert.equal(cardAfterConfirm.latest_version_id, v1Id);
    assert.equal(cardAfterConfirm.has_pending_proposal, false);
    assert.equal(cardAfterConfirm.has_refuted_proposal, false);

    // --- AC-5: Version 2 proposed on confirmed card -> card stays 'confirmed', has_pending_proposal = true ---
    const createV2 = await app.inject({
      method: "POST",
      url: `/v1/knowledge/cards/${cardId}/versions`,
      headers: mutate(alice.sessionToken, "v2-create"),
      payload: {
        expected_latest_version_id: v1Id,
        topic: "Ribosome Translation Fidelity v2",
        summary: "Updated with cryo-EM structural resolution",
        body: "Cryo-EM structures at 2.1A reveal conformational gating...",
        sources: [{ kind: "url", uri: "https://example.com/cryo-em" }],
        references: []
      }
    });
    assert.equal(createV2.statusCode, 201);
    const v2Id = createV2.json().data.version_id;

    const cardWithV2 = (await app.inject({
      method: "GET",
      url: `/v1/knowledge/cards/${cardId}`,
      headers: auth(alice.sessionToken)
    })).json().data;

    assert.equal(cardWithV2.status, "confirmed", "Card status must remain confirmed on canonical v1");
    assert.equal(cardWithV2.canonical_version_id, v1Id, "Canonical version must stay v1");
    assert.equal(cardWithV2.latest_version_id, v2Id, "Latest version must be v2");
    assert.equal(cardWithV2.has_pending_proposal, true, "has_pending_proposal must be true for unconfirmed v2");
    assert.equal(cardWithV2.has_refuted_proposal, false);

    // --- AC-6: Version 2 refuted -> v1 remains canonical, card stays 'confirmed', not evicted from search ---
    // Owner B refutes v2
    await app.inject({
      method: "POST",
      url: `/v1/knowledge/versions/${v2Id}/reviews`,
      headers: mutate(bob1.sessionToken, "rev-bob1-refute-v2"),
      payload: { verdict: "refute", explanation: "Resolution claims unverified by FSC curve" }
    });
    // Owner D refutes v2
    await app.inject({
      method: "POST",
      url: `/v1/knowledge/versions/${v2Id}/reviews`,
      headers: mutate(dave.sessionToken, "rev-dave-refute-v2"),
      payload: { verdict: "refute", explanation: "Local resolution in active site is actually 3.8A" }
    });

    const v2AfterRefute = (await app.inject({
      method: "GET",
      url: `/v1/knowledge/versions/${v2Id}`,
      headers: auth(alice.sessionToken)
    })).json().data;

    assert.equal(v2AfterRefute.status, "refuted", "v2 proposal is refuted by independent quorum");
    assert.equal(v2AfterRefute.independent_review_counts.refute, 2);

    const cardAfterV2Refute = (await app.inject({
      method: "GET",
      url: `/v1/knowledge/cards/${cardId}`,
      headers: auth(alice.sessionToken)
    })).json().data;

    assert.equal(cardAfterV2Refute.status, "confirmed", "Card remains confirmed on v1");
    assert.equal(cardAfterV2Refute.canonical_version_id, v1Id, "Canonical version remains v1");
    assert.equal(cardAfterV2Refute.latest_version_id, v2Id);
    assert.equal(cardAfterV2Refute.has_pending_proposal, false);
    assert.equal(cardAfterV2Refute.has_refuted_proposal, true, "has_refuted_proposal must be true");

    // Search eviction check: card is NOT evicted because v1 is confirmed
    const searchRes = await app.inject({
      method: "GET",
      url: "/v1/knowledge/cards?q=Ribosome",
      headers: auth(alice.sessionToken)
    });
    assert.equal(searchRes.statusCode, 200);
    const foundCard = searchRes.json().data.find((c: any) => c.card_id === cardId);
    assert.ok(foundCard, "Card with confirmed canonical version must NOT be evicted from search even when v2 is refuted");
  });
});
