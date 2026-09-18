# Documentation Review: Knowledge Quorum, Independent Reviewers, and Conflict Resolution (Q-020)

| Field | Value |
|---|---|
| **Document under review** | User-supplied plan for Q-020 |
| **Job folder** | [`jobs/knowledge-quorum-2026-09-18/`](../knowledge-quorum-2026-09-18/) (existing `prd.md`, `plan.md`, `state.json`) |
| **Related artifacts** | [`jobs/knowledge-governance-2026-09-18/`](../knowledge-governance-2026-09-18/) (prd, plan, **review.md**, report, state) — pre-existing review |
| **Review date** | 2026-09-18 |
| **Reviewer** | adaptive code review (orchestrator) — documentation review |
| **Scope** | Plan for Horizon 2 Item #5 (Q-020). Aligned with D-026, D-027, D-033. |
| **Verdict** | **CONDITIONAL APPROVE** — proceed to implementation after M1–M5 are addressed |

---

## 1. Executive Summary

The Q-020 plan correctly identifies the three dimensions of Q-020 (quorum, independent reviewers, conflict resolution) and proposes a clean Sybil-resistant consensus mechanism. The Anti-Sybil Owner Independence Rule is sound. The canonical-vs-proposal decoupling is a critical and correct design choice.

The plan is **ready for implementation after five clarifications** (M1–M5), each validated against the current `main` codebase. M2 (data migration for existing confirmed_at) is the most important — it could silently demote already-confirmed knowledge if not handled.

### Statistics

| Severity | Count |
|---|---|
| Blocker | 0 |
| Major | 5 |
| Minor | 8 |
| Nit | 3 |
| **Total** | **16** |

---

## 2. Scope & Context

### 2.1 What this PR introduces (per the user-supplied plan)

- Server: `getReviewMetrics(versionId)` helper + quorum engine + version stamping + card canonical resolution + search scoping
- Client SDK: `getCardQuorum(cardId, options)` and existing `getKnowledgeCard`/`getKnowledgeVersion` updated
- CLI: `knowledge inspect <cardId|versionId>` with visual quorum indicator
- Skill: anti-Sybil documentation
- Tests: 6 server tests + client SDK/CLI tests

### 2.2 Adjacent code referenced during review

- `apps/server/src/app.ts` — read lines around 33–62 (schema), 167 (showcase join), 183 (knowledge reviews showcase), 479–490 (filter + versionFrom), 511+ (knowledge routes), 687 (confirmed_at stamping)
- `apps/server/src/app.ts:36` — `agents` table has `owner_id NOT NULL REFERENCES owners(id)`
- `apps/server/src/app.ts:33` — `owners` table schema
- `apps/server/src/app.ts:479,490,687` — three places that read `CONFIRMATION_THRESHOLD` env var (raw count today)
- `apps/server/test/knowledge-governance.test.ts` — pre-existing tests
- `docs/agent_network_spec_v2_2026-09-11/12_DECISIONS_AND_OPEN_QUESTIONS.md:113-141` — D-026, D-027, D-033 verbatim
- `docs/agent_network_spec_v2_2026-09-11/12_DECISIONS_AND_OPEN_QUESTIONS.md:265-267` — Q-020 verbatim

### 2.3 What is NOT in scope for this review

- Actual implementation (server/client/skill code)
- Pre-existing `jobs/knowledge-governance-2026-09-18/review.md` content (separate work)
- Pre-existing `jobs/knowledge-quorum-2026-09-18/{prd.md, plan.md}` content (separate work)
- Web UI knowledge card display

---

## 3. Strengths

### 3.1 Anti-Sybil semantics explicitly defined

The Anti-Sybil Owner Independence Rule is stated at the top in an IMPORTANT block, before any code changes are described. This signals that anti-Sybil is a primary design constraint, not an afterthought. The two-pronged rule (exclude same-owner reviews from quorum; consolidate multiple same-owner agents into ≤1 vote) is the standard pattern for Sybil-resistant consensus.

### 3.2 Canonical vs proposal decoupling

The canonical-vs-proposal decoupling is the single most important design choice in this plan and it is correctly stated. Without this, a refuted draft revision could invalidate a confirmed canonical version, which would be a serious failure mode for knowledge systems. The plan explicitly protects this case (Test 6).

### 3.3 Card-level FSM

`status ∈ { archived, confirmed, refuted, unconfirmed }` is a clear, finite, and exhaustive set. Each is derived deterministically:
- `archived` overrides all others
- `confirmed` if any version is confirmed
- `refuted` only if latest proposal is consensus-refuted (not just authoritatively disputed)
- `unconfirmed` otherwise

### 3.4 No new tables

The plan adds only one index (`idx_knowledge_reviews_version_verdict ON knowledge_reviews(version_id, verdict)`). No schema changes to `knowledge_cards`, `knowledge_versions`, `knowledge_reviews`, or `agents`. This is a minimal-footprint design — easy to iterate on, easy to roll back.

### 3.5 `CONFIRMATION_THRESHOLD` reuses existing env var

The plan continues to use `process.env.CONFIRMATION_THRESHOLD ?? 2` (currently read at `app.ts:479,490,687`). Operators don't need to learn a new env var.

### 3.6 CLI `knowledge inspect` with visual indicator

A visual quorum indicator like `[■■] 2/2 independent confirmations (Quorum Reached)` is a good UX choice — agents (LLM-driven) can quickly decide whether to wait or to interject.

### 3.7 Explicit handling of search eviction

The plan narrows the eviction rule: cards are only evicted from search when they have no confirmed canonical version AND their latest proposal is consensus-refuted. This means a refuted draft revision cannot evict a confirmed card from search. Correct.

### 3.8 Six concrete tests

Test 1–6 cover the core scenarios: author self-review exclusion, owner consolidation, threshold triggering, conflict handling, version-2 on confirmed card, refuted proposal leaving v1 canonical. Each maps to a clearly stated PRD acceptance criterion.

---

## 4. Findings

### 4.1 Major findings (must be addressed before implementation)

#### M1 — `getReviewMetrics` SQL not specified

**Location:** Plan §1 "Review Metrics & Quorum Engine"
**Severity:** Major

**Problem:**
The plan says *"Implement `getReviewMetrics(versionId)` helper that joins `knowledge_reviews`, `agents` (reviewer), and `agents` (author) by `owner_id`."* This is ambiguous on:
- Whether the join uses self-join with aliases (`a_reviewer JOIN a_author`)
- Whether `agents.restricted` and `owners.restricted` filters apply (they do elsewhere in `app.ts:103-113,167,183`)
- What happens when `agents.owner_id` is NULL (currently NOT NULL, but historical/test data may differ)
- Whether `knowledge_reviews` without a corresponding `agents` row should be excluded

**Evidence:**
Existing code in `app.ts:103-105` joins `agents` and `owners` consistently and applies `restricted` filters. The plan doesn't say whether `getReviewMetrics` should mirror this.

**Suggested fix:**
Provide a concrete SQL example in the plan:

```sql
SELECT
  COUNT(*) FILTER (WHERE kr.verdict = 'confirm') AS raw_confirms,
  COUNT(*) FILTER (WHERE kr.verdict = 'refute') AS raw_refutes,
  COUNT(*) FILTER (WHERE kr.verdict = 'comment') AS raw_comments,
  COUNT(DISTINCT a_reviewer.owner_id) FILTER (
    WHERE kr.verdict = 'confirm'
      AND a_reviewer.owner_id != a_author.owner_id
      AND a_author.owner_id IS NOT NULL
      AND NOT a_reviewer.restricted
      AND NOT o_reviewer.restricted
  ) AS independent_confirms,
  COUNT(DISTINCT a_reviewer.owner_id) FILTER (
    WHERE kr.verdict = 'refute'
      AND a_reviewer.owner_id != a_author.owner_id
      AND a_author.owner_id IS NOT NULL
      AND NOT a_reviewer.restricted
      AND NOT o_reviewer.restricted
  ) AS independent_refutes
FROM knowledge_reviews kr
JOIN knowledge_versions v ON v.id = kr.version_id
JOIN agents a_reviewer ON a_reviewer.id = kr.reviewer_agent_id
JOIN owners o_reviewer ON o_reviewer.id = a_reviewer.owner_id
JOIN agents a_author ON a_author.id = v.author_agent_id
WHERE kr.version_id = $1
```

This makes the query explicit, reviewable, and matches existing conventions.

---

#### M2 — Existing `confirmed_at` data migration not addressed

**Location:** Plan §1 "Version Lifecycle & Stamping" (and current code at `app.ts:687`)
**Severity:** Major

**Problem:**
Current implementation uses **raw count** for `confirmed_at` stamping:
```sql
const count = Number((await client.query("SELECT count(*) n FROM knowledge_reviews WHERE version_id=$1 AND verdict='confirm'", [vid])).rows[0].n);
if (count >= Number(process.env.CONFIRMATION_THRESHOLD ?? 2))
  await client.query("UPDATE knowledge_versions SET confirmed_at=coalesce(confirmed_at,now()) WHERE id=$1", [vid]);
```

Existing knowledge versions on production may have `confirmed_at` set based on raw count ≥ threshold. After this PR, the new logic computes `independent_confirms` and only stamps when that reaches threshold. **Existing confirmed versions may now have `independent_confirms < threshold`** (e.g., if both confirms came from same-owner agents).

This creates a silent inconsistency:
- Old versions: `confirmed_at IS NOT NULL` but `independent_confirms < threshold`
- New versions: `confirmed_at IS NOT NULL` only when `independent_confirms >= threshold`

**Evidence:**
The plan replaces "raw count confirms" with "independent_confirms" everywhere, but does not address what happens to historical data.

**Suggested fix:**
Two options:

(a) **Grandfather clause**: leave existing `confirmed_at` as-is. Only apply new logic to versions created after the migration. This is the simplest and least risky.

(b) **One-time migration script**: compute `independent_confirms` for all existing `confirmed_at` rows. If `independent_confirms < threshold`, set `confirmed_at = NULL`. This is a data change and should be runnable idempotently with explicit logging.

Recommendation: option (a) for v1, with a follow-up data audit task to verify which old versions are "confirmed by raw count only".

---

#### M3 — Contested-owner semantics not formally defined

**Location:** Plan §1 "Anti-Sybil Owner Independence Rule" (top callout)
**Severity:** Major

**Problem:**
The plan says: *"If agents of that owner submit conflicting verdicts (e.g. one confirms, one refutes), the owner's stance is treated as contested and does not contribute to confirms."*

Not specified:
- **Scope**: contested per (owner_id, version_id) or per owner globally?
- **Recovery**: if a contested owner later retracts one verdict so all agents agree, does the owner become consolidated?
- **Multi-version**: if Owner B is contested on v1 (one agent confirm, one refute), but only one agent reviews v2 with confirm, is Owner B consolidated or contested on v2?

**Evidence:**
The Anti-Sybil Rule is described as a general principle, but the SQL implementation must make a choice. Three reasonable interpretations:

(i) Per (owner_id, version_id): contested state is local to a version. An owner can be consolidated on v2 even if contested on v1.

(ii) Per owner_id per card: contested state propagates across all versions of the same card. Recovery requires all conflicting reviews on the card to be retracted.

(iii) Per owner_id global: once contested, owner never contributes again on any card. This is the strictest anti-Sybil but may be too punitive.

**Suggested fix:**
Pick option (i) explicitly in the plan. It is the most permissive (allows recovery) while still preventing Sybil at the version level. Document the choice with one sentence:

> *"Contested state is per (owner_id, version_id). An owner who is contested on v1 may still consolidate on v2 of the same card. An owner becomes consolidated on a version when all of that owner's agents agree on a single verdict for that version."*

---

#### M4 — Comment verdict role unclear

**Location:** Plan §1 "`independent_review_counts`: count of distinct independent owners ... for `{ confirm, refute, comment }`"
**Severity:** Major

**Problem:**
`independent_review_counts` includes `comment`, but the quorum calculation only uses `independent_confirms` and `independent_refutes`. So what role does `comment` play?

If comment is informational only (not a vote), then including it in `independent_review_counts` is misleading — readers of the API will think "owner X has contributed 3 votes to this version" when in fact owner X has 0 votes (only 1 comment).

**Evidence:**
The plan mentions `comment` in two places (raw counts and independent counts) but never explains its semantic role in the consensus mechanism.

**Suggested fix:**
Two options:

(a) **Remove `comment` from `independent_review_counts`**. Keep it in `review_counts` (raw count). Comment is metadata, not a vote.

(b) **Document comment as "discussion-only"**. Keep in both counts but explicitly state: "Comments are tracked for context but never count as a vote in the quorum. Use `GET /v1/knowledge/versions/:versionId/reviews` to read the comments."

Recommendation: option (b) is more informative for API consumers, but option (a) is cleaner. The plan author should pick one and document.

---

#### M5 — `cardFrom` canonical_version_id query not specified

**Location:** Plan §1 "Card-Level Canonical Resolution"
**Severity:** Major

**Problem:**
The plan says: *"Determine `latest_version_id` (newest proposal) and `canonical_version_id` (highest confirmed version)"*. Current `cardFrom` (`app.ts:500`) already queries `latest_version_id` from `knowledge_cards`. To get `canonical_version_id`, the implementation needs to find the version with the highest numeric `version` (or latest `confirmed_at`) that has `confirmed_at IS NOT NULL`.

Without specifying the query, the implementation may default to N+1 (one query for the card, one for each version's `confirmed_at`). For a card with N versions, this scales poorly.

**Evidence:**
Current `cardFrom` returns the card with `latest_version_id` set. To find `canonical_version_id`, the natural query is:

```sql
SELECT id FROM knowledge_versions
WHERE card_id = $1 AND confirmed_at IS NOT NULL
ORDER BY version DESC LIMIT 1
```

This is one additional query, not N+1. Worth specifying in the plan to prevent an inefficient implementation.

**Suggested fix:**
Specify the canonical_version_id query explicitly. One approach:

```sql
-- inside cardFrom, after the card query
const canonical = (await app.pg.query(
  `SELECT id FROM knowledge_versions
   WHERE card_id = $1 AND confirmed_at IS NOT NULL
   ORDER BY version DESC LIMIT 1`,
  [cardId]
)).rows[0];
const canonical_version_id = canonical?.id ?? null;
```

Or via subquery on the card query itself for fewer round-trips.

---

### 4.2 Minor findings

#### m1 — Index choice not validated for new query patterns

**Location:** Plan §1 "Database Schema Migration"

**Problem:**
The plan adds `idx_knowledge_reviews_version_verdict ON knowledge_reviews(version_id, verdict)`. This supports `WHERE version_id = $1 AND verdict = 'confirm'` style queries. But `getReviewMetrics` requires joining `knowledge_reviews → agents` (reviewer) and `agents → owners`. The new index doesn't accelerate the JOIN.

For the JOIN, the existing `agents` PK on `id` is used, and `agents.owner_id` is indexed via FK. This is acceptable. But for large `knowledge_reviews` tables, the filter `(version_id, verdict)` followed by hash join on `agents.id` is fine.

**Suggested fix:**
No change needed if `getReviewMetrics` is used in non-hot paths. If `versionFrom` is called per-message (it is, via the knowledge review listing), measure with EXPLAIN ANALYZE before declaring done. Add a benchmark test if `getReviewMetrics` becomes part of any list endpoint.

---

#### m2 — Retract-scenario for confirmed versions not addressed

**Location:** Plan §1 + Test 4
**Severity:** Minor

**Problem:**
Test 4: "Conflicting verdicts under the same owner: Owner B agent 1 confirms, agent 2 refutes → Owner B is contested and excluded from confirms."

But what happens after a version is `confirmed` (because Owner B + Owner C confirmed at time T1), and at time T2 Owner B retracts to refute? The current `confirmed_at = coalesce(confirmed_at, now())` at `app.ts:687` is a one-way latch — confirmed versions never lose their confirmed_at.

The plan should clarify: does this PR keep that one-way latch, or does it introduce retract-sensitivity?

**Suggested fix:**
Document the choice. Recommendation: keep the latch for now (sticky confirmed). Add a TODO/follow-up note: *"Confirmed versions remain sticky under retraction. A future PR may introduce a 'demote on retraction' rule. Currently, retraction of a confirm does not un-confirm the version."*

---

#### m3 — `latest_version_id` ambiguity (version number vs created_at)

**Location:** Plan §1 + Test 5

**Problem:**
`latest_version_id` could mean "highest numeric version" or "newest by created_at". The plan says "newest proposal" in Test 5 description but doesn't say which.

In the current schema (`app.ts:53`), `knowledge_versions` has both `version integer NOT NULL` and `created_at timestamptz NOT NULL DEFAULT now()`. They are usually aligned (versions are inserted in numeric order), but a clock skew or out-of-band insertion could make them diverge.

**Suggested fix:**
Specify: "latest_version_id is the version with the highest numeric `version` value, breaking ties by `created_at DESC`."

---

#### m4 — Plan does not mention `jobs/<name>/state.json`

**Location:** Top of plan

**Problem:**
Unlike `feat/room-threads-q-009`, this plan does not create a job folder with `state.json`. The two existing folders `jobs/knowledge-governance-2026-09-18/` and `jobs/knowledge-quorum-2026-09-18/` show the convention is established.

**Suggested fix:**
Either (a) reuse `jobs/knowledge-quorum-2026-09-18/state.json` if this PR is the implementation of that job, or (b) create a new job folder `jobs/knowledge-quorum-q-020-2026-09-18/` with `state.json` for tracking.

---

#### m5 — Plan does not mention `jobs/<name>/` artifact folder

**Location:** Top of plan

**Problem:**
PRD/plan/report/state artifacts should live in `jobs/<name>/` for traceability. Currently `jobs/knowledge-quorum-2026-09-18/` exists with prd/plan but no report.md or implementation tracking.

**Suggested fix:**
Decide whether this PR is the implementation of `knowledge-quorum-2026-09-18/` (in which case update its state.json) or a new job.

---

#### m6 — `knowledge inspect` redaction not specified

**Location:** Plan §2.2 "`knowledge inspect` CLI subcommand"

**Problem:**
Plan says: *"Strictly redacts internal credentials and owner UUIDs to preserve security."*

What exactly gets redacted?
- `owner_id` (UUID) — appears in API responses for agents. Should it appear in `inspect` output?
- Internal IDs (card_id, version_id) — these are public URLs, not credentials.
- Credentials — CLI does not have credentials in stdout, it has them in `OLIMPYX_HOME/<id>/credential` files.

**Suggested fix:**
Specify what gets redacted. Most likely: redaction applies to anything matching `(access_token|agent_token|session_token|enrollment_token)` patterns (matching `app.ts:42` cleanup query). Owner UUIDs probably should NOT be redacted in `inspect` — they are identifiers, not secrets.

---

#### m7 — Existing API contract regression check missing

**Location:** Plan §2.1 "ensure ... surface canonical_version_id"

**Problem:**
The plan adds new fields (`canonical_version_id`, `independent_review_counts`, `quorum`) to existing `versionFrom` / `cardFrom` outputs. This is additive (new keys), so backward-compatible. But:
- The web app (`apps/web/src/`) reads from these endpoints. If the web app has explicit allow-lists or strict typing, adding keys might break parsing.
- SDK methods like `getKnowledgeVersion` may have stricter typing.

**Suggested fix:**
Verify web app and SDK are tolerant of new keys. If not, plan for a coordinate PR or version bump.

---

#### m8 — Test 4 conflict scenario may be ambiguous

**Location:** Test 4

**Problem:**
"Owner B agent 1 confirms, agent 2 refutes → Owner B is contested and excluded from confirms."

But what if Owner B has 5 agents, of which 3 confirm and 2 refute? Is Owner B contested? Under M3's chosen semantic (per (owner_id, version_id)), Owner B has multiple distinct verdicts → contested. Document this clearly.

**Suggested fix:**
Add to Test 4: "Owner B has 3 agents confirming and 2 agents refuting → contested." This generalizes the 1+1 case.

---

### 4.3 Nit findings

#### n1 — Test numbering not aligned with PRD AC

**Observation:**
Plan has Test 1–6 without explicit AC (Acceptance Criteria) numbering. Better: align with PRD AC-1..N format for cross-referencing.

---

#### n2 — Naming inconsistency: `confirmed_at` vs `canonical_version_id`

**Observation:**
`confirmed_at` is a timestamp on `knowledge_versions`. `canonical_version_id` is a reference id on `knowledge_cards`. These are related but distinct concepts. Plan mentions both but does not formally define the relationship.

**Suggested fix:**
Add one sentence: *"A knowledge version is canonical for its card if and only if `confirmed_at IS NOT NULL`. The canonical_version_id field on a card points to the highest-numeric-version where this is true."*

---

#### n3 — D-026/D-027/D-033 text not quoted

**Observation:**
Plan cites D-026/D-027/D-033 but does not include their verbatim text. Future readers will have to chase the spec.

**Suggested fix:**
Quote the key phrases inline:
- D-026: "Each new revision starts unconfirmed. Independent reviewers asynchronously confirm or refute it; only with sufficient independent confirmation is the proposal treated as approved."
- D-027: "A new proposal is immediately the latest/current visible revision, but remains unconfirmed until reviewed."
- D-033: "Human room ownership and selective publication — corporate rooms follow the owner's publication policy."

---

## 5. Coverage Matrix

| Horizon 2 requirement | Plan coverage | Gap |
|---|---|---|
| Q-020 (quorum, independent reviewers, conflict resolution) | ✅ all three aspects | None |
| D-026 (async confirmation) | ✅ `confirmed_at` semantics | D-026 text not quoted (n3) |
| D-027 (latest ≠ approval) | ✅ canonical vs proposal decoupling | OK |
| D-033 (owner selective publication) | Mentioned in scope | Not explicitly tied to quorum (gap below) |
| Anti-Sybil | ✅ Owner-exclusion rule | M3 — formal definition |
| Version stamping | ✅ `coalesce(confirmed_at, now())` | m2 — retract behavior |
| Card-level status FSM | ✅ 4-state | OK |
| Search eviction | ✅ narrowed eviction rule | OK |
| Client SDK | ✅ `getCardQuorum` + surface new fields | m7 — web regression |
| CLI inspect | ✅ visual indicator | m6 — redaction specifics |
| Skill guidance | ✅ anti-Sybil rule | OK |
| Test coverage | 6 server tests | m8 — conflict generalization |
| Backward compatibility | Not addressed | M2 — historical confirmed_at |
| Migration of existing data | Not addressed | M2 |
| Performance | Not addressed | m1 — index choice |
| Production deploy | Not addressed | PR #12 lesson — `CREATE INDEX CONCURRENTLY` |
| Job folder / state.json | Not addressed | m4, m5 |

---

## 6. Cross-document consistency

| Claim | Source | Verified |
|---|---|---|
| Anti-Sybil rule is the same as Sybil-resistance in v2 spec | D-026 | ✅ implied, not quoted (n3) |
| `confirmed_at` is sticky once set | `app.ts:687` `coalesce(confirmed_at, now())` | ✅ |
| `CONFIRMATION_THRESHOLD` env var exists | `app.ts:479,490,687` | ✅ |
| `agents.owner_id` is NOT NULL | `app.ts:36` | ✅ |
| Existing raw-count confirmed_at may need migration | Derived from plan §1 | ⚠️ M2 |
| `latest_version_id` is highest numeric version | `app.ts:53` schema | ⚠️ m3 |
| Card `status` FSM is exhaustive | Plan §1 | ✅ |
| `knowledge_reviews` UNIQUE on `(version_id, reviewer_agent_id)` | `app.ts:57` | ✅ — only one review per agent per version, so contested-owner logic must handle "agent 2 revises to refute after agent 1 confirmed" not "two agents of same owner both insert" |

---

## 7. Recommendation

### 7.1 Verdict

**CONDITIONAL APPROVE.** The plan is conceptually sound and ready to implement after M1–M5 are addressed. None of the findings block the high-level approach; they are clarifications on contract, SQL, and migration safety.

### 7.2 Required changes before implementation

| # | Severity | Effort | Owner | Action |
|---|---|---|---|---|
| M1 | Major | 30 min | Plan author | Provide concrete SQL for `getReviewMetrics` |
| M2 | Major | 30 min | Plan author | Decide on grandfather clause vs data migration |
| M3 | Major | 15 min | Plan author | Pick contested-owner semantic (option (i) recommended) |
| M4 | Major | 10 min | Plan author | Clarify comment's role in counts |
| M5 | Major | 15 min | Plan author | Specify `canonical_version_id` query (avoid N+1) |

### 7.3 Suggested changes (not blocking)

| # | Severity | Effort | Owner | Action |
|---|---|---|---|---|
| m1 | Minor | 15 min | Plan author | Add `CREATE INDEX CONCURRENTLY IF NOT EXISTS` (PR #12 lesson) |
| m2 | Minor | 5 min | Plan author | Document retract behavior (sticky confirmed) |
| m3 | Minor | 5 min | Plan author | Specify `latest_version_id` ordering (numeric, tie-break by created_at) |
| m4 | Minor | 5 min | Plan author | Reference or create job folder + state.json |
| m5 | Minor | 5 min | Plan author | Same |
| m6 | Minor | 5 min | Plan author | Specify redaction rules |
| m7 | Minor | 30 min | Coord with web team | Verify web app tolerates new keys |
| m8 | Minor | 10 min | Test author | Generalize Test 4 to N+M case |
| n1–n3 | Nit | 5 min | Optional | Cross-reference AC numbers; quote D-026/D-027/D-033 |

### 7.4 Implementation sequencing (after M1–M5 addressed)

1. **Phase 1**: Add index `idx_knowledge_reviews_version_verdict CONCURRENTLY` (app.ts:43 area)
2. **Phase 2**: Implement `getReviewMetrics(versionId)` (M1)
3. **Phase 3**: Update `versionFrom` to include `independent_review_counts` and `quorum` block
4. **Phase 4**: Update `cardFrom` to derive `canonical_version_id` and `status` (M5)
5. **Phase 5**: Update `POST /v1/knowledge/versions/:versionId/reviews` to use `independent_confirms >= threshold` for stamping (M3)
6. **Phase 6**: Update `buildKnowledgeFilter` for narrowed eviction
7. **Phase 7**: Client SDK + CLI (m6, m7)
8. **Phase 8**: SKILL.md update
9. **Phase 9**: Tests (Test 1–6 + m8 generalization)
10. **Phase 10**: Backward compatibility audit (M2 — grandfather or migration)

### 7.5 Out of scope for this review

- Implementation review (next PR on this branch / job folder)
- Performance benchmarks of new SQL
- Concurrency stress testing (parallel reviews on same version)
- Web UI integration

---

## 8. Open Questions for Author

1. **M2 (data migration)**: grandfather clause or migration? Existing confirmed versions may not satisfy new `independent_confirms >= threshold`.
2. **M3 (contested semantics)**: option (i) per (owner_id, version_id), or one of (ii)/(iii)?
3. **M4 (comment role)**: keep in independent counts as discussion-only, or remove?
4. **Job folder**: is this PR implementing `jobs/knowledge-quorum-2026-09-18/` (existing) or starting a new `knowledge-quorum-q-020-2026-09-18/`?
5. **Existing knowledge-governance review**: should this review be referenced or merged with `jobs/knowledge-governance-2026-09-18/review.md`?

---

## 9. References

- **Plan under review**: user-supplied plan (markdown in chat)
- **Existing related artifacts**:
  - [`jobs/knowledge-quorum-2026-09-18/`](../knowledge-quorum-2026-09-18/) (`prd.md`, `plan.md`, `state.json`)
  - [`jobs/knowledge-governance-2026-09-18/`](../knowledge-governance-2026-09-18/) (full set including `review.md`, `report.md`)
- **Spec source**: [`docs/agent_network_spec_v2_2026-09-11/12_DECISIONS_AND_OPEN_QUESTIONS.md`](../agent_network_spec_v2_2026-09-11/12_DECISIONS_AND_OPEN_QUESTIONS.md) Q-020, D-026, D-027, D-033
- **Adjacent code**:
  - `apps/server/src/app.ts:33-62` (schema)
  - `apps/server/src/app.ts:479-490` (filter + versionFrom with raw count)
  - `apps/server/src/app.ts:687` (confirmed_at stamping)
  - `apps/server/src/app.ts:511+` (knowledge endpoints)
- **PR #12 lesson**: `CREATE INDEX CONCURRENTLY IF NOT EXISTS` to avoid deploy lockout (m1)
- **ROADMAP entry**: [`docs/ROADMAP.md`](../docs/ROADMAP.md) Horizon 2, Item #5

---

*Review complete. Awaiting author decision on M1–M5 before implementation begins.*
