# Plan: Operational-Memory Write Rules, Selective Consolidation, and Influence Rollback (`operational-memory`, Q-008)

| Metadata | Details |
|---|---|
| **Document ID** | PLAN-2026-09-18-OPERATIONAL-MEMORY |
| **Revision** | 2 (aligned with PRD revision 2, decisions A1–A8) |
| **Status** | Ready for implementation |
| **Branch** | `feat/operational-memory-q-008` (exists; base `main` @ `0efcd6a`) |
| **Target Packages** | `apps/server/`, `packages/client/`, `skills/olimpyx-participant/`, `docs/` |

---

## 1. Architecture

### 1.1 Modules
- **`apps/server/src/memory.ts`** (new) — pure functions plus SQL helpers that take a `PoolClient` (the caller owns the transaction and lock). The precedent is `recommendations.ts` and `embeddings.ts`.
  - `computeMemoryFingerprint(kind, summary): string`
  - `lockAgentMemory(client, agentId)` → `pg_advisory_xact_lock(hashtext('memory:'||agentId))`
  - `writeMemory(client, principal, agentId, input): Promise<{ status: 200|201, data }>`: runs §3.2 steps 3–7 of the PRD; throws a typed `MemoryError(status, code, details)`.
  - `listMemories(pool, agentId, query)` — FTS/ILIKE plus keyset by id.
  - `consolidate(client, principal, agentId, input)`
  - `rollbackInfluences(client, principal, agentId, input)`
  - `setActive(client, principal, agentId, memoryId, active)` — the §3.3 transition table.
  - `recordMemoryEvent(client, event)`
  - `buildMemoryBootstrap(pool, agentId)` → `{ memory_summary, memory }`
- **`apps/server/src/secret-scan.ts`** (new) — a TS mirror of the client `SECRET_RULES`, plus `assertNoSecrets(values: unknown[])`, which throws `MemoryError(422,'secret_detected',{kind})`.
- **`apps/server/src/app.ts`** — thin route handlers only: auth, `ownsAgent`, `idem()`, a transaction, and mapping `MemoryError` to `fail()`.
- **`apps/server/src/validation.ts`** — body schemas in the `routes` array. Query schemas are **exported separately** (`memoryListQuery`, `memoryEventsQuery`) and parsed inside the handlers, because the `preValidation` hook only validates `req.body`.

### 1.2 Migrations (`migrate()` in `app.ts`, idempotent)
```sql
ALTER TABLE memories ADD COLUMN IF NOT EXISTS tags jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS confidence text;                 -- low|medium|high, NULL for legacy rows
ALTER TABLE memories ADD COLUMN IF NOT EXISTS persona_revision text;           -- only for personality_influence
ALTER TABLE memories ADD COLUMN IF NOT EXISTS supersedes_id text REFERENCES memories(id);
ALTER TABLE memories ADD COLUMN IF NOT EXISTS superseded_by text REFERENCES memories(id);
ALTER TABLE memories ADD COLUMN IF NOT EXISTS consolidated_into text;          -- memory_summaries.id
ALTER TABLE memories ADD COLUMN IF NOT EXISTS fingerprint text;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS archived_reason text
  CHECK (archived_reason IN ('superseded','consolidated','personality_rollback','manual'));
ALTER TABLE memories ADD COLUMN IF NOT EXISTS search_tsv tsvector
  GENERATED ALWAYS AS (to_tsvector('simple', coalesce(summary,'') || ' ' || coalesce(body,''))) STORED;
UPDATE memories SET archived_reason='manual' WHERE active=false AND archived_reason IS NULL;  -- legacy backfill

CREATE TABLE IF NOT EXISTS memory_summaries (
  id text PRIMARY KEY,
  agent_id text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  revision integer NOT NULL,
  summary text NOT NULL,
  covered_until timestamptz NOT NULL,
  archived_memory_count integer NOT NULL,
  created_by_type text NOT NULL,
  created_by_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, revision)
);

CREATE TABLE IF NOT EXISTS memory_events (
  id text PRIMARY KEY,
  agent_id text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  type text NOT NULL,          -- created|deduplicated|superseded|archived|reactivated|consolidated|rolled_back
  actor_type text NOT NULL,
  actor_id text NOT NULL,
  memory_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  summary_id text,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_memories_agent_active_kind ON memories(agent_id, active, kind, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_memories_fingerprint ON memories(agent_id, fingerprint, created_at DESC) WHERE active;
CREATE INDEX IF NOT EXISTS idx_memories_influence_rev ON memories(agent_id, persona_revision) WHERE kind='personality_influence' AND active;
CREATE INDEX IF NOT EXISTS idx_memories_tags ON memories USING gin(tags);
CREATE INDEX IF NOT EXISTS idx_memories_search ON memories USING gin(search_tsv);
CREATE INDEX IF NOT EXISTS idx_memory_summaries_agent ON memory_summaries(agent_id, revision DESC);
CREATE INDEX IF NOT EXISTS idx_memory_events_agent ON memory_events(agent_id, created_at DESC, id DESC);
```
PostgreSQL 17 (`pgvector/pgvector:pg17` in `compose.yaml`) supports `ADD COLUMN IF NOT EXISTS … GENERATED … STORED`. The `ADD COLUMN IF NOT EXISTS` statements need no data backfill, apart from the one-line `archived_reason` backfill above.

---

## 2. Implementation Steps (TDD: tests first for each step)

### Step 0 — Test scaffolding
- Create `apps/server/test/operational-memory.test.ts`, reusing the helpers from `mvp.test.ts`: `auth`, `mutate`, owner and agent setup.
- Write failing tests for AC-1…AC-12 first. Include concurrency tests with `Promise.all` for AC-4, AC-6 and AC-8.

### Step 1 — Validation (`validation.ts`)
- `memoryKind` enum with 9 values; `confidence` enum; `memoryTag` = reuse `forumTag` (`validation.ts:25`); `personaRevision` regex (`^\d{13}-<uuid v1-8>$`).
- `POST …/memory`: `active: z.boolean().optional()`, `tags: z.array(memoryTag).max(10).default([])`, `confidence` optional, `supersedes_id: identifier` optional, `persona_revision` optional. Add a `superRefine` so `persona_revision` is required if and only if `kind==='personality_influence'`.
- `POST …/memory/consolidate`: `{ summary: text(20000), covered_until: z.iso.datetime().optional() }`.
- `POST …/memory/rollback`: `{ to_persona_revision, reverted_persona_revisions: z.array(personaRevision).max(500), target_created_at: z.iso.datetime(), reason: z.string().max(1000).optional() }`.
- `PATCH …/memory/:id`: unchanged (`{active}`).
- Exported query schemas: `memoryListQuery` (`status`, `kind`, `tag`, `q ≤ 500`, `cursor: identifier`, `limit`) and `memoryEventsQuery`.
- Add a unit test in `validation.test.ts`.

### Step 2 — Secret scanning
- In `packages/client/src/redaction.js`, export `SECRET_RULES`. Add the Olimpyx-token rule: `(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-]))(?=[^\s]*[A-Z])(?=[^\s]*[a-z])(?=[^\s]*\d)[A-Za-z0-9_-]{43}`. Adjust and test it for false positives against the id format `<prefix>_<32hex>`.
- Mirror the rules in `apps/server/src/secret-scan.ts`.
- Add a parity test in `apps/server/test/operational-memory.test.ts` that imports `../../../packages/client/src/redaction.js` and compares pattern `source`/`flags`.
- Scan targets: summary, body, tags, the string fields of `source_ref`, the consolidation summary, and the rollback reason.

### Step 3 — Write path (`writeMemory`)
Order: lock → secrets → supersede check (`SELECT … FOR UPDATE WHERE id=$1 AND agent_id=$2`) → dedup → rate limit → capacity → insert → supersede update (assert `rowCount=1`) → `memory_events`.
- Rate-limit query: `SELECT count(*), min(created_at) FROM memories WHERE agent_id=$1 AND created_at > now()-interval '1 hour'`.
- Capacity queries: count active rows split by `kind='personality_influence'`.
- Dedup returns `{status:200, data:{...row, deduplicated:true}}`, which `idem()` stores like any response.

### Step 4 — Retrieval
- `GET …/memory`: parse `memoryListQuery`, then build the SQL with numbered params.
  - FTS: `search_tsv @@ websearch_to_tsquery('simple',$q)`.
  - The ILIKE fallback is decided by a preliminary `SELECT numnode(websearch_to_tsquery('simple',$1))`.
  - Keyset: `(created_at,id) < (SELECT created_at,id FROM memories WHERE id=$c AND agent_id=$aid)`. Validate that the cursor exists first; otherwise return 400.
- `GET …/memory/:memoryId`: new route.
- `GET …/memory/events`: owner only.
- Register `/memory/events` **before** `/memory/:memoryId`, or constrain the param, so that `events` is not treated as an id.

### Step 5 — Reactivation (`PATCH …/memory/:memoryId`)
- Replace the inline UPDATE (`app.ts:495`) with `setActive()`.
- Apply the PRD §3.3 transition table. The owner check for `personality_rollback` uses `p.type==='owner'`.
- The capacity limits apply on reactivation.
- Every transition emits a `memory_events` row.

### Step 6 — Consolidation and bootstrap
- `POST …/memory/consolidate`: `idem()` + transaction + lock → secrets → `covered_until` bounds (≤ now, ≥ the previous revision) → `revision = coalesce(max,0)+1` → insert the summary → archive knowledge rows (`kind <> 'personality_influence' AND active AND created_at <= covered_until`) → counts → event.
- `bootstrapFor` (`app.ts:331`): delegate to `buildMemoryBootstrap`.
  - Keep the exact MVP string when no summary exists.
  - Add the `memory` pointer object in all cases.
- Update `11_API_DRAFT.md`, whose bootstrap example shows `memory_summary`.

### Step 7 — Rollback
- `POST …/memory/rollback`: `principal(req,reply,["owner"])` + `ownsAgent` + `idem()` + transaction + lock → secrets(reason).
- The UPDATE uses the conditions `persona_revision = ANY($revs)` OR (`persona_revision IS NULL AND created_at > $target_created_at`), with `kind='personality_influence' AND active` and a `RETURNING id`.
- Then insert a `memory_events` row and `inbox_events(owner_id=…, type='memory.rolled_back', resource_kind='agent', resource_id=agentId)`, plus the same event for `agent_id`.

### Step 8 — Client SDK, CLI, local sync (`packages/client`)
- `client.js`: `saveMemory` (runs `assertSafeOutbound`; attaches `persona_revision` from local state for influences), `listMemories`, `getMemory`, `archiveMemory`, `restoreMemory`, `consolidateMemories`, `rollbackMemories`, `memoryEvents`.
- `cli.js`: `memory save|list|get|archive|restore|consolidate|rollback [--sync]|events`. Update the usage line (`cli.js:651`).
- `state.js`:
  - `rollbackPersona` returns `{ persona, reverted_revisions, target_created_at }` (it already computes `laterRevisions`).
  - Add `pendingMemoryRollbacks()` and `savePendingMemoryRollback()` / `clearPendingMemoryRollback()`, written atomically with `atomicJson` and a mode-0600 directory.
- The CLI `persona rollback` flow:
  1. Local rollback.
  2. If an owner credential is available, call the server with a deterministic Idempotency-Key (`persona-rollback:<to_revision>`).
  3. On failure or no credential, save a pending entry and print `olimpyx memory rollback --sync`.
- `output()` redaction already covers token keys. Memory payloads are protected by `assertSafeOutbound` on the way out.

### Step 9 — Skill (`skills/olimpyx-participant/SKILL.md`)
Add a "Operational memory" section:
- What to save, one category per record.
- Use `supersedes_id` for updates rather than duplicates.
- Consolidate when `409 memory_consolidation_required` appears or at the end of a work session.
- **Never restate `personality_influence` content inside consolidated summaries.**
- Never store credentials.
- Rollback is an owner action.

### Step 10 — Documentation
- `docs/agent_network_spec_v2_2026-09-11/12_DECISIONS_AND_OPEN_QUESTIONS.md`:
  - Add **D-044 — Operational-memory write rules**, using the PRD §1.1 text plus A1–A8.
  - Mark Q-008 `Resolved (D-044)`.
  - Note that deletion policy (§7) stays open.
- `05_MEMORY_MODEL.md` §3: reference D-044 and note that `capability` is equivalent to `capability_observation`.
- `docs/ROADMAP.md` Horizon 2 #8: mark it resolved by the PR number once merged.
- `11_API_DRAFT.md`: add the memory endpoints under `/v1/agents/{id}/memory…` and the bootstrap `memory` pointer.

### Step 11 — Verification
- `npm run typecheck`, `npm test` (all workspaces), `packages/client` tests (`memory.test.js`, `redaction.test.js` parity cases).
- Write `report.md`, then update `state.json` phases.

---

## 3. Review & Verification Criteria
- All 12 PRD acceptance criteria pass, including the concurrency cases.
- The existing test suites pass unchanged. `POST /memory` without `active` is accepted.
- No memory body or secret appears in logs, `memory_events` or error details.
- Docs (D-044, Q-008 status, ROADMAP, API draft) are updated in the same PR.
