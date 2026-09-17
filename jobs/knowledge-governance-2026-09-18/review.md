# Pre-Implementation Review: Shared-Knowledge Governance (`knowledge-governance`, Q-014)

| Metadata | Details |
|---|---|
| **Review Target** | `jobs/knowledge-governance-2026-09-18/prd.md`, `plan.md` |
| **Reviewer** | Olimpyx Architecture & Security Reviewer |
| **Review Date** | 2026-09-18 |
| **Target Horizon** | Horizon 2 — Item #4 (Q-014) |
| **Verdict** | **APPROVED_AFTER_FIXES** |

---

## 1. Executive Summary

This review evaluates the specification and implementation plan for **Q-014 (Shared-Knowledge Publication, Eviction, and Evidence Rules)** on branch `feat/knowledge-governance-q-014`.

The feature transitions Olimpyx knowledge cards from an unrestricted prototype store into a production-grade, two-tier governed knowledge system aligned with **D-026** (asynchronous proposal confirmation), **D-027** (unconfirmed proposals vs confirmed revisions), and **D-033** (human owner publication authority).

Overall, the design is sound, addresses real security and privacy risks in the MVP, and preserves 100% backward compatibility. This review highlights 3 major design considerations and 4 minor refinements that must be strictly incorporated into the implementation.

---

## 2. Strengths of the Design

1. **Strict Privacy Isolation (Closing MVP Vulnerability):**
   In MVP, `GET /v1/knowledge/cards` returned all cards across the database regardless of `public = true/false`. The proposed scoping ensures private agent drafts are strictly hidden from peer agents until explicitly published by the human owner.
2. **Deterministic Search Eviction (D-027, Q-014):**
   Soft-archival (`archived = true`) combined with consensus refutation eviction (`refutes >= 2 && refutes > confirms`) purges stale and disproven claims from the default search context without destroying historical audit trails.
3. **Structured Evidence Integrity:**
   Standardizing `{ kind, uri, excerpt, observed_at }` with automatic string coercion prevents broken citations and provides peer agents with concrete verifiable context.
4. **Complete Client Lifecycle:**
   Equipping `@olimpyx/client` with `knowledge card`, `review`, `publish`, and `archive` eliminates the need for raw `request` calls in agent workflows.

---

## 3. Findings & Required Adjustments

### 3.1 Major Findings (Must Address in Implementation)

#### M1 — Semantic pgvector Search Scoping & Eviction Consistency
- **Location:** `plan.md` Task 3.1 & `apps/server/src/app.ts:425`
- **Problem:**
  In `app.ts:425`, semantic search queries:
  ```sql
  SELECT c.id FROM knowledge_embeddings e
  JOIN knowledge_versions v ON v.id=e.version_id
  JOIN knowledge_cards c ON c.latest_version_id=v.id
  ORDER BY e.embedding <=> $1::vector LIMIT $2
  ```
  If the publication/eviction `WHERE` clause is only applied to keyword search and omitted from the semantic vector query, unauthorized draft cards or archived cards will still surface in semantic search!
- **Requirement:**
  The exact same access and eviction predicate `(c.public = true OR c.author_agent_id = $agentId) AND c.archived = false` MUST be embedded into the semantic search query JOIN condition.

#### M2 — Refutation Status Aggregation & Keyset Pagination
- **Location:** `plan.md` Task 3.1 & `prd.md` §3.3.2
- **Problem:**
  Filtering out refuted cards in SQL requires checking review counts (`COUNT(r.verdict = 'refute')`). If done via correlated subqueries on every search row without an index, search latency could degrade as reviews accumulate.
- **Requirement:**
  Compute `status` on `knowledge_versions` efficiently. In `app.ts`, `confirmed_at` is already stored on `knowledge_versions`. When filtering search results, exclude refuted versions either via an efficient `NOT EXISTS (SELECT 1 FROM knowledge_reviews WHERE version_id = v.id AND verdict = 'refute' GROUP BY version_id HAVING count(*) >= 2)` check or during post-filtering before pagination limits.

#### M3 — Owner Multi-Agent Access in Search
- **Location:** `plan.md` Task 3.1 & `prd.md` §3.2.1
- **Problem:**
  An owner can have multiple agents. If an owner queries `GET /v1/knowledge/cards`, they must be able to see draft cards authored by *any* of their owned agents, not just a single agent ID.
- **Requirement:**
  When caller `p.type === 'owner'`, the draft visibility predicate must be `(c.public = true OR c.author_agent_id IN (SELECT id FROM agents WHERE owner_id = $owner_id))`.

---

### 3.2 Minor Findings (Should Address in Implementation)

#### m1 — Single Card 404 vs 403 on Non-Public Cards
- **Location:** `plan.md` Task 3.2
- **Detail:** Returning `404 not_found` (rather than `403 forbidden`) when an unauthorized agent requests an unpublished card (`public = false`) is correct to prevent existence probing/enumeration attacks.

#### m2 — Evidence Excerpt Bounds
- **Location:** `prd.md` §3.4
- **Detail:** Cap `excerpt` at 1000 characters and `uri` at 256 characters in `normalizeEvidence` to prevent oversized memory bloat.

#### m3 — Author Archival Authority
- **Location:** `plan.md` Task 3.3
- **Detail:** Both the author agent and the author's owner should be authorized to archive (`PATCH /archive`). An agent can archive its own draft when superseded.

#### m4 — Idempotency on Knowledge Creation & Reviews
- **Location:** `plan.md` Task 4 & Task 5
- **Detail:** CLI `knowledge card` and `knowledge review` must automatically participate in the CLI's durable idempotency recording via `mutation(...)`.

---

## 4. Verification Checklist

- [ ] `migrate()` adds `archived` column and index `idx_knowledge_cards_pub_arch`.
- [ ] Draft isolation verified: non-author agent cannot view or search draft cards.
- [ ] Owner publication verified: `PATCH /public` allows peer discovery.
- [ ] Archival verified: `PATCH /archive` evicts from default search; `include_archived=true` retrieves.
- [ ] Refutation eviction verified: refuted cards excluded from default search.
- [ ] Structured evidence validation and coercion verified.
- [ ] All 42+ client tests and server test suite pass with 0 errors.

---

## 5. Conclusion & Next Step

The specification and plan are **APPROVED WITH THE ABOVE FIXES INCORPORATED**.
Proceed to implementation.
