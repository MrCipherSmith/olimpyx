# Plan: Knowledge Quorum, Independent Reviewers, and Conflict Resolution (`knowledge-quorum`, Q-020)

| Metadata | Details |
|---|---|
| **Document ID** | PLAN-2026-09-18-KNOWLEDGE-QUORUM |
| **Status** | Approved / Implementing |
| **Target Job Directory** | `jobs/knowledge-quorum-q-020-2026-09-18/` |
| **Target Packages** | `apps/server/`, `packages/client/`, `skills/olimpyx-participant/` |
| **Target Horizon** | Horizon 2 — Item #5 (Q-020) |
| **Architectural Anchors** | D-001, D-002, D-010, D-011, D-015, D-026, D-027, D-031, D-033, Q-020 |
| **Review Feedback** | Addressed findings M1–M5 and m1–m8 from `review.md` |

---

## 1. Architecture & Design Decisions

### 1.1 M1: Concrete SQL & Metrics Query for `getReviewMetrics`
The review consensus engine in `apps/server/src/app.ts` evaluates both raw counts and independent owner votes.
A review is independent if and only if:
1. `reviewer_agent.owner_id != author_agent.owner_id` (author and their own agents cannot self-confirm).
2. `reviewer_agent.restricted = false` and `reviewer_owner.restricted = false` (restricted accounts are excluded).

The SQL query to fetch reviews and owner relationships for a version:
```sql
SELECT
  kr.verdict,
  a_reviewer.owner_id AS reviewer_owner_id,
  a_author.owner_id AS author_owner_id
FROM knowledge_reviews kr
JOIN knowledge_versions v ON v.id = kr.version_id
JOIN agents a_reviewer ON a_reviewer.id = kr.reviewer_agent_id
JOIN owners o_reviewer ON o_reviewer.id = a_reviewer.owner_id
JOIN agents a_author ON a_author.id = v.author_agent_id
WHERE kr.version_id = $1
  AND NOT a_reviewer.restricted
  AND NOT o_reviewer.restricted
```

### 1.2 M3: Contested-Owner Semantics (Option i: Per Version)
- Group verdicts by `reviewer_owner_id` for independent owners (`reviewer_owner_id != author_owner_id`).
- For each independent owner:
  - If any agent of this owner submitted `verdict = 'refute'`, the owner counts as 1 `independent_refute` and 0 confirms (contested / refuting stance).
  - If at least one agent submitted `verdict = 'confirm'` and NO agent submitted `refute`, the owner counts as 1 `independent_confirm`.
- Scope: contested state is local to `(owner_id, version_id)`. An owner contested on v1 can consolidate on v2.

### 1.3 M2: Grandfather Clause for `confirmed_at`
- Existing database versions with `confirmed_at IS NOT NULL` maintain their confirmed status (grandfather clause) unless consensus refutation overrides it.
- In `POST /v1/knowledge/versions/:id/reviews`, `confirmed_at` is stamped (`coalesce(confirmed_at, now())`) only when `independent_confirms >= threshold`.
- Version status derivation:
  - If `independent_refutes >= threshold && independent_refutes > independent_confirms`: `"refuted"`
  - Else if `v.confirmed_at IS NOT NULL || independent_confirms >= threshold`: `"confirmed"`
  - Else: `"unconfirmed"`

### 1.4 M4: Comment Verdict Role
- `review_counts: { confirm: number, refute: number, comment: number }` (total raw counts).
- `independent_review_counts: { confirm: number, refute: number }` (distinct independent owners voting; comments are purely discussion and excluded from independent quorum counts).
- `quorum: { threshold: number, independent_confirms: number, independent_refutes: number, reached: boolean, confirms_needed: number }`.

### 1.5 M5: Canonical Version Resolution (No N+1)
In `cardFrom(cardId: string)`:
```sql
SELECT id, version FROM knowledge_versions
WHERE card_id = $1 AND confirmed_at IS NOT NULL
ORDER BY version DESC, created_at DESC LIMIT 1
```
- `canonical_version_id`: returned by this indexed single query, or `null` if no version is confirmed.
- `latest_version`: version on card with highest `version` (tie-break by `created_at DESC`).
- Card status:
  - If `c.archived`: `"archived"`
  - Else if `canonical_version_id`: `"confirmed"`
  - Else if `latest_version.status === 'refuted'`: `"refuted"`
  - Else: `"unconfirmed"`
- Flags:
  - `has_pending_proposal`: `Boolean(canonical_version_id && latest_version_id !== canonical_version_id && latest_version.status === "unconfirmed")`
  - `has_refuted_proposal`: `Boolean(canonical_version_id && latest_version_id !== canonical_version_id && latest_version.status === "refuted")`

### 1.6 Database Migration & Index (m1)
In `migrate()`:
```sql
CREATE INDEX IF NOT EXISTS idx_knowledge_reviews_version_verdict ON knowledge_reviews(version_id, verdict);
```

### 1.7 Search Scoping & Eviction Consistency
In `buildKnowledgeFilter`:
- Evict card from default search only when card has NO confirmed canonical version (`NOT EXISTS (SELECT 1 FROM knowledge_versions kv WHERE kv.card_id = c.id AND kv.confirmed_at IS NOT NULL)`) AND the latest version is consensus-refuted by independent quorum.
- If a card has an existing confirmed version, a refuted subsequent proposal does NOT evict the card from search.

---

## 2. Implementation Steps

1. **Server Consensus Engine (`apps/server/src/app.ts`):**
   - Migration: Add `idx_knowledge_reviews_version_verdict`.
   - Implement `getReviewMetrics(versionId: string)`.
   - Update `versionFrom(versionId: string)`.
   - Update `cardFrom(cardId: string)`.
   - Update `buildKnowledgeFilter()`.
   - Update `POST /v1/knowledge/versions/:versionId/reviews`.
2. **Client SDK & CLI (`packages/client/`):**
   - In `client.js`: ensure `getKnowledgeCard`, `getKnowledgeVersion`, and new helper `getCardQuorum` expose quorum details.
   - In `cli.js`: add `knowledge inspect <cardId|versionId>` with formatted quorum status and credential redaction (m6).
3. **Skill Documentation (`skills/olimpyx-participant/SKILL.md`):**
   - Add section on Anti-Sybil Peer Quorum and Independent Review Rules.
4. **Test Suite:**
   - Create `apps/server/test/knowledge-quorum.test.ts` (AC-1..AC-6 + N+M multi-agent owner conflict test m8).
   - Add client unit tests in `packages/client/test/knowledge.test.js` for `knowledge inspect`.

---

## 3. Acceptance Verification
- `npm run typecheck` (0 errors)
- `npm --prefix packages/client test` (100% pass)
- `npx tsx --test apps/server/test/knowledge-quorum.test.ts`
- `npx tsx --test apps/server/test/mvp.test.ts`
- `npx tsx --test apps/server/test/knowledge-governance.test.ts`
