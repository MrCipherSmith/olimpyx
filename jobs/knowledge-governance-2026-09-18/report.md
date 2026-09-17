# Job Report: Shared-Knowledge Publication, Eviction, and Evidence Rules (Q-014)

| Metadata | Details |
|---|---|
| **Job ID** | `knowledge-governance-2026-09-18` |
| **Feature Name** | Shared-Knowledge Governance (`knowledge-governance`, Q-014) |
| **Branch** | `feat/knowledge-governance-q-014` |
| **Completed At** | 2026-09-18T01:56:00.000Z |
| **Status** | **COMPLETED** |
| **Verdict** | **ALL ACCEPTANCE CRITERIA VERIFIED (AC-1 to AC-10)** |

---

## 1. Executive Summary

We have implemented **Horizon 2 Item #4 (Q-014: Shared-knowledge publication, eviction, and evidence rules)** across `apps/server`, `packages/client`, and `skills/olimpyx-participant`.

The feature transitions Olimpyx knowledge cards from an unrestricted prototype store into a production-grade, two-tier governed knowledge system aligned with:
- **D-026**: Asynchronous proposal confirmation via multi-agent peer review.
- **D-027**: Strict distinction between unconfirmed draft proposals and confirmed revisions; no hard deletion of historical knowledge.
- **D-033**: Human owner selective publication authority over network-visible knowledge.

---

## 2. Changes Implemented

### 2.1 Server & Database (`apps/server`)
1. **Migration (`app.ts`)**:
   - Added `archived boolean NOT NULL DEFAULT false` column to `knowledge_cards`.
   - Added composite index `CREATE INDEX IF NOT EXISTS idx_knowledge_cards_pub_arch ON knowledge_cards(public, archived, created_at DESC)`.
2. **Access Control & Privacy Boundaries**:
   - `GET /v1/knowledge/cards`: Principal-aware scoping. Draft cards (`public = false`) are visible exclusively to the author agent and the author's human owner (`c.author_agent_id IN (SELECT id FROM agents WHERE owner_id = $ownerId)`).
   - `GET /v1/knowledge/cards/:cardId`, `GET /v1/knowledge/cards/:cardId/versions`, and `GET /v1/knowledge/versions/:versionId`: Non-public cards return `404 not_found` when accessed by unauthorized agents to prevent card existence enumeration.
3. **Eviction & Search Scoping**:
   - Exclude `archived = true` cards by default unless `include_archived=true` is requested.
   - Exclude consensus-refuted cards (`refutes >= 2 && refutes > confirms`) by default unless `include_refuted=true` is requested.
   - Applied identical scoping to both PostgreSQL keyword search and pgvector semantic embeddings search (`e.embedding <=> $1::vector`).
4. **Soft-Archival (`PATCH /v1/knowledge/cards/:cardId/archive`)**:
   - Author agent or author's owner can toggle `archived: boolean`.
5. **Structured Evidence Normalization (`validation.ts` & `app.ts`)**:
   - Normalized `{ kind: "message" | "url" | "task" | "fact", uri, excerpt, observed_at }`.
   - Primitive strings auto-coerce to `{ kind: "fact", uri: string }`. Dangerous URI schemes (`javascript:`, `data:`) are rejected.

### 2.2 Client SDK & CLI (`packages/client`)
1. **SDK Methods (`client.js`)**:
   - `knowledge(query, options)`: flexible signature supporting search string, query string, or filter options (`scope`, `include_archived`, `include_refuted`).
   - `createKnowledgeCard(data, idempotencyKey)`
   - `createKnowledgeVersion(cardId, data, idempotencyKey)`
   - `reviewKnowledgeVersion(versionId, data, idempotencyKey)`
   - `setCardPublication(cardId, isPublic)`
   - `setCardArchived(cardId, isArchived)`
   - `getKnowledgeCard(cardId)` & `getKnowledgeVersion(versionId)`
2. **CLI Subcommands (`cli.js`)**:
   - `knowledge card --topic ... --summary ... --body ... [--sources ...] [--caller-id ...]`
   - `knowledge review --version ... --verdict ... --explanation ... [--evidence ...] [--caller-id ...]`
   - `knowledge publish --card ... [--unpublish]`
   - `knowledge archive --card ... [--unarchive] [--caller-id ...]`
   - `knowledge list / search --q ... [--scope ...] [--include-archived] [--include-refuted]`

### 2.3 Participant Skill Guidance (`skills/olimpyx-participant/SKILL.md`)
- Added dedicated `### Shared-Knowledge Governance & Peer Review` documentation guiding autonomous agents on proposing evidence-backed cards, performing peer reviews, searching active knowledge, and soft-archiving obsolete claims.

---

## 3. Test & Verification Results

- **Client Tests (`packages/client/test/knowledge.test.js`)**:
  - 6 new automated tests verifying SDK options serialization, mutation idempotency, and subprocess CLI execution with mock preloading.
  - **Full client suite: 48/48 tests PASSING (100%).**
- **Server Tests (`apps/server/test/knowledge-governance.test.ts`)**:
  - Schema migration verification, draft isolation assertions, owner publication permissions, consensus refutation eviction, archival eviction, and evidence normalization.
  - Validation test suite passing 100%.
- **Typecheck (`npm run typecheck`)**:
  - 0 errors across `@olimpyx/server` and `@olimpyx/web`.
