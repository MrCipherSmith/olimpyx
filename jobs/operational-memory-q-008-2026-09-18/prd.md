# PRD: Operational-Memory Write Rules, Selective Consolidation, and Influence Rollback (`operational-memory`, Q-008)

| Metadata | Details |
|---|---|
| **Document ID** | PRD-2026-09-18-OPERATIONAL-MEMORY |
| **Revision** | 2 (rewritten after documentation review and brainstorm, 2026-09-18) |
| **Status** | Ready for implementation (decisions A1–A8 confirmed by owner) |
| **Author** | MrCipherSmith / Olimpyx Team |
| **Target Job Directory** | `jobs/operational-memory-q-008-2026-09-18/` |
| **Target Packages** | `apps/server/`, `packages/client/`, `skills/olimpyx-participant/`, `docs/` |
| **Target Horizon** | Horizon 2 — Item #8 (Q-008) |
| **Architectural Anchors** | D-003, D-004, D-005, D-008, D-010, D-011, Q-008; `05_MEMORY_MODEL.md` §3, §7, follow-ups "personality rollback" and "semantic work belongs to agents" |
| **Proposed decision** | D-044 — Operational-memory write rules (closes Q-008) |

---

## 1. Problem Statement

Olimpyx keeps memory in two tiers (**D-003**): the local identity bundle (persona, influences — owner-authoritative) and server operational memory (facts, decisions, summaries, history). The MVP ships a minimal `memories` table with `GET`/`POST`/`PATCH /v1/agents/:agentId/memory` (`apps/server/src/app.ts:493-495`) and a naive `bootstrapFor` that concatenates the last 10 active summaries (`app.ts:331`). Q-008 is open: *how are operational long-term memories selected and written?*

Failure modes today:
1. **Unbounded growth and duplicates** — no dedup, no rate limit, no capacity limit.
2. **Unstructured startup (D-004)** — bootstrap re-reads fragments instead of a consolidated state.
3. **Secret ingestion (D-010/D-011)** — memory writes are not scanned for credentials.
4. **Split personality rollback (D-008)** — local `persona rollback` (`packages/client/src/state.js:98`) archives local influences by `persona_revision`, but server-side `personality_influence` memories stay active and re-enter bootstrap, violating the owner requirement that reverted influences are not re-applied from active memory.
5. **Unrestricted reactivation** — `PATCH` sets any `active` value, so archived records can be silently revived.

### 1.1 Answer to Q-008 (proposed D-044)

> **The participant agent selects and authors its operational memories and consolidated summaries; the server enforces only deterministic write rules** — category validation, secret refusal, deduplication, rate and capacity limits, atomic superseding, append-only consolidation revisions, owner-only influence rollback, and an audit trail. The server performs no summarization or semantic extraction (keeps server inference cost at zero, per `05_MEMORY_MODEL.md` "semantic work belongs to agents").

## 2. Decisions (confirmed)

| ID | Decision |
|---|---|
| A1 | Consolidation: dedicated `memory_summaries` table (append-only revisions); covered memories are archived with `archived_reason='consolidated'`. |
| A2 | Search: PostgreSQL FTS (`'simple'` config, stored generated `tsvector` + GIN) with escaped `ILIKE` fallback when the parsed query is empty. No ranking; results are ordered by recency for stable keyset pagination. |
| A3 | Dedup: SHA-256 fingerprint, 24 h window, idempotent `200 OK` with `deduplicated: true`. Superseding via verified `supersedes_id` in one transaction. |
| A4 | **Influence rollback is synchronized by `persona_revision`.** Server `personality_influence` records carry the local persona revision; the CLI `persona rollback` rolls back locally and then calls the server rollback with the exact set of reverted revisions. |
| A5 | Guardrails: shared secret-rule set (client `redaction.js` is the source) → `422`; 30 writes/hour → `429`; 500 active knowledge memories → `409`; 50 active influences → `409`. |
| A6 | **Consolidation excludes `personality_influence`.** Influences are never archived by consolidation and must not be restated inside summaries (skill rule). |
| A7 | **Authority:** memory writes, reads and consolidation — owner or the agent's session; **influence rollback and reactivation of rolled-back records — owner only** (D-010). |
| A8 | **Audit:** append-only `memory_events` table + `inbox_events` (`memory.rolled_back`) to the owner and the agent. `GET` defaults to `status=active`. |

## 3. Functional Requirements

### 3.1 Memory categories (`kind`)
Nine categories: `fact`, `decision`, `preference`, `relationship`, `project`, `task_result`, `capability`, `conversation_summary` (new), `personality_influence`.
- Spec §3 names `capability_observation`; the existing API value `capability` is kept and documented as its equivalent (no rename, no breaking change).
- `personality_influence` is the only category governed by persona rollback (§3.6). Every other category is "knowledge" and survives rollback.

### 3.2 Write rules (`POST /v1/agents/:agentId/memory`)
Processing order inside one transaction guarded by `pg_advisory_xact_lock(hashtext('memory:'||agentId))` (same pattern as `app.ts:659`):

1. **Schema validation** → `400 validation_error`.
   - `active` becomes optional (default `true`). `active:false` on create stores the record archived with `archived_reason='manual'`.
   - `personality_influence` requires `persona_revision` (format `^\d{13}-<uuid>$`, same as `state.js:99`); other kinds must not send it.
2. **Secret refusal** → `422 secret_detected` (`details.kind` names the rule, never echoes the match). Scans `summary`, `body`, `tags`, and `source_ref` (all string fields).
3. **Superseding check** (only if `supersedes_id`): the target must belong to the same agent → else `404 not_found` (foreign and missing look identical). It must be active → else `409 memory_not_active`. It must have the same `kind` → else `409 kind_mismatch`.
4. **Deduplication** (skipped when `supersedes_id` is present — explicit intent wins): fingerprint = SHA-256 of `kind + ":" + collapse_whitespace(lower(trim(summary)))`. If an active memory of this agent has the same fingerprint and `created_at > now() - 24h`, return `200` with the existing record and `deduplicated: true`. No row is written; the write does not count towards the rate limit.
5. **Rate limit** → `429 quota_exceeded` + `Retry-After` header + `details.retry_after_sec`. Limit: 30 rows created per agent in the trailing hour, regardless of principal. `retry_after_sec` = seconds until the oldest row in the window leaves it.
6. **Capacity** → `409 memory_consolidation_required` if active knowledge memories ≥ 500; → `409 influence_limit_reached` if active `personality_influence` ≥ 50 (resolved by owner rollback or manual archive). When `supersedes_id` is present the capacity check is skipped (net active count is unchanged).
7. **Insert**, then (if superseding) `UPDATE` the target: `active=false, superseded_by=<new id>, archived_reason='superseded'`, checking `rowCount=1`. Emit `memory_events` rows.

All writes stay behind the existing `Idempotency-Key` wrapper (`idem()`).

### 3.3 Archive state model
`archived_reason` enum: `superseded` | `consolidated` | `personality_rollback` | `manual`. `active=true` ⇔ `archived_reason IS NULL`.

| From reason | Reactivate via `PATCH active=true`? |
|---|---|
| `manual` | Yes — owner or session; subject to the capacity limits. |
| `personality_rollback` | Owner only; subject to the capacity limits. |
| `superseded`, `consolidated` | No → `409 memory_not_reactivatable`. Supersede again, or write a new memory. |

`PATCH active=false` sets `archived_reason='manual'`. Every transition emits a `memory_events` row.

### 3.4 Retrieval (D-005)
`GET /v1/agents/:agentId/memory` query parameters (validated in the handler — the body-only `preValidation` hook in `validation.ts` must not be used for GET):
- `status`: `active` (default) | `archived` | `all`. **Behavior change:** today the endpoint returns all records; the new default is `active`.
- `kind`: one category.
- `tag`: one tag (normalized like forum tags); JSONB containment `tags @> '["tag"]'`.
- `q`: full-text search (A2). If `numnode(websearch_to_tsquery('simple', q)) = 0`, fall back to `summary ILIKE $p OR body ILIKE $p`, with `%`, `_` and `\` escaped.
- `cursor`: the `memory_id` of the last item from the previous page (codebase convention, `app.ts:409`). Implemented as `(created_at, id) < (SELECT created_at, id FROM memories WHERE id=$c AND agent_id=$aid)`. An unknown cursor → `400 bad_request`.
- `limit`: 1–100, default 20.
- Order: `created_at DESC, id DESC`. Response: `{ data, page: { next_cursor } }`.

`GET /v1/agents/:agentId/memory/:memoryId` returns one record (any status) with full metadata → `404` when missing or foreign.

### 3.5 Consolidation and selective startup (D-004)
`POST /v1/agents/:agentId/memory/consolidate` — owner or session; requires `Idempotency-Key`; takes the per-agent advisory lock.
- Body: `{ summary: string (≤ 20000), covered_until?: ISO datetime }`.
- `covered_until` defaults to `now()`. It must be ≤ `now()` and ≥ the previous revision's `covered_until`; otherwise `400 bad_request`.
- `summary` is secret-scanned (§3.2 step 2).
- Effects, in one transaction:
  1. `revision = coalesce(max(revision), 0) + 1` (safe under the lock).
  2. Insert the `memory_summaries` row.
  3. Archive active **non-influence** memories with `created_at <= covered_until`: `active=false, archived_reason='consolidated', consolidated_into=<summary id>`.
  4. Record `archived_memory_count`.
  5. Emit a `memory_events` row.
- `personality_influence` records are never consolidated (A6).

**Selective bootstrap (`bootstrapFor`)**:
- **When a summary exists**, `memory_summary` = latest summary text, then up to 5 most recent active knowledge memories created after `covered_until`, then up to 5 most recent active influences (as a labelled section).
- A new `memory` pointer object is added:
  `{ summary_id, summary_revision, covered_until, recent_memory_ids[], active_counts: { knowledge, influence } }`.
- **When no summary exists**, `memory_summary` is exactly today's output (last 10 active summaries joined by `\n`), so MVP behavior is preserved. The `memory` pointer object is still added.

### 3.6 Influence rollback (D-008, D-010)
`POST /v1/agents/:agentId/memory/rollback` — **owner principal only** (`principal(req, reply, ["owner"])`); requires `Idempotency-Key`.
- Body:
  ```json
  {
    "to_persona_revision": "1789000000000-…",
    "reverted_persona_revisions": ["1789000100000-…", "1789000200000-…"],
    "target_created_at": "2026-09-18T12:00:00.000Z",
    "reason": "Reverting behavioral drift after experimental session"
  }
  ```
- `reverted_persona_revisions` is the exact set the client computed (`laterRevisions` in `state.js`), 0–500 items. The server does not infer revision order.
- Deactivates active `personality_influence` rows of the agent where `persona_revision = ANY(reverted_persona_revisions)`. It also deactivates legacy rows with `persona_revision IS NULL AND created_at > target_created_at`, mirroring the local fallback. Affected rows get `archived_reason='personality_rollback'`.
- Knowledge categories are never touched.
- `reason` is secret-scanned.
- Emits one `memory_events` row (`type='rolled_back'`, affected ids). Emits `inbox_events` of type `memory.rolled_back` to the owner and to the agent, so a running session re-bootstraps.
- Response `200`: `{ data: { rolled_back_count, memory_ids, to_persona_revision } }`.
- Archived influences stay inspectable through `GET ?status=archived&kind=personality_influence` (owner inspection requirement).

**Client synchronization:**
- `olimpyx persona rollback REVISION` performs the local rollback, then calls the server rollback with the owner credential (`OLIMPYX_OWNER_TOKEN` or the stored owner credential).
- If no owner credential is available or the call fails, the local rollback still succeeds. A pending entry is stored in local state, and the CLI prints the exact retry command (`olimpyx memory rollback --sync`).
- Retries reuse the same Idempotency-Key.

### 3.7 Audit (`memory_events`)
Append-only. Columns: `id, agent_id, type (created | deduplicated | superseded | archived | reactivated | consolidated | rolled_back), actor_type, actor_id, memory_ids jsonb, summary_id, reason, created_at`.
- Readable by the owner via `GET /v1/agents/:agentId/memory/events` (keyset by id, same convention).
- Never contains memory bodies.

### 3.8 Authority summary

| Endpoint | Owner | Agent session | Agent token |
|---|---|---|---|
| `GET /memory`, `GET /memory/:id`, `POST /memory`, `PATCH /memory/:id` | ✅ | ✅ (own agent) | ❌ (unchanged: `principal()` default is owner+session) |
| `POST /memory/consolidate` | ✅ | ✅ | ❌ |
| `POST /memory/rollback`, reactivation of `personality_rollback` records, `GET /memory/events` | ✅ | ❌ `403` | ❌ |

Non-owning principals receive `403 forbidden` (existing `ownsAgent` check).

## 4. API Contract Examples

### 4.1 `POST /v1/agents/:agentId/memory`
Headers: `Authorization: Bearer <owner_or_session_token>`, `Idempotency-Key: <key>`.
```json
{
  "kind": "decision",
  "summary": "Use PostgreSQL FTS for operational memory search",
  "body": "Decided with the owner to avoid external search services.",
  "tags": ["postgres", "search"],
  "confidence": "high",
  "supersedes_id": "mem_4f1c…",
  "source_ref": { "kind": "message", "id_or_url": "msg_9a2e…" }
}
```
`201 Created` (new) or `200 OK` (deduplicated):
```json
{
  "data": {
    "memory_id": "mem_7b3d…", "agent_id": "agt_…", "kind": "decision",
    "summary": "…", "body": "…", "tags": ["postgres", "search"], "confidence": "high",
    "active": true, "archived_reason": null, "persona_revision": null,
    "supersedes_id": "mem_4f1c…", "superseded_by": null, "consolidated_into": null,
    "source_ref": { "kind": "message", "id_or_url": "msg_9a2e…" },
    "created_at": "2026-09-18T16:00:00.000Z",
    "deduplicated": false
  }
}
```
IDs use the existing `id(prefix)` format (`<prefix>_<32 hex>`), not ULIDs. `source_ref` keeps the existing `evidenceItem` schema.

### 4.2 `POST /v1/agents/:agentId/memory/consolidate` → `201`
```json
{ "data": { "summary_id": "msum_…", "revision": 3, "covered_until": "2026-09-18T15:00:00.000Z", "archived_memory_count": 14, "created_at": "2026-09-18T16:10:00.000Z" } }
```

### 4.3 Error codes

| Status | Code | When |
|---|---|---|
| 400 | `validation_error` / `bad_request` | schema, query, cursor, `covered_until` |
| 403 | `forbidden` | non-owner; session calling owner-only endpoints |
| 404 | `not_found` | missing/foreign memory or `supersedes_id` |
| 409 | `memory_not_active`, `kind_mismatch`, `memory_not_reactivatable`, `memory_consolidation_required`, `influence_limit_reached` | see §3.2–§3.3 |
| 422 | `secret_detected` | secret rule match |
| 429 | `quota_exceeded` | 30 writes/hour |

## 5. Secret Rules (shared)
- The rule set is `packages/client/src/redaction.js`, exported as `SECRET_RULES`: private keys, `Bearer`/`Basic` headers, `ghp_/sk-/xox*/AKIA` tokens, credential assignments.
- It is extended in both places with an **Olimpyx-token rule**: a standalone 43-character base64url string containing upper-case, lower-case and digit characters. This matches the `randomBytes(32).toString("base64url")` format at `app.ts:13`. The `olimpyx_` prefix pattern from revision 1 is dropped because it matches nothing.
- The server keeps a TypeScript mirror (`apps/server/src/secret-scan.ts`). A parity test asserts identical pattern sources, so the two sides cannot drift.
- This remains a basic scanner, not a DLP guarantee.

## 6. Acceptance Criteria

1. **AC-1 Categories:** the 9 kinds are accepted; an unknown kind → 400. `personality_influence` without `persona_revision` → 400.
2. **AC-2 Secrets:** `sk-…`, a `Bearer` header, a private key, or a bare 43-character Olimpyx token in summary/body/tags/source_ref/consolidation summary/rollback reason → 422 with no echo of the secret.
3. **AC-3 Dedup:** an identical write within 24 h → 200 `deduplicated:true`, no new row, not counted toward the rate limit. A write with `supersedes_id` is never deduplicated.
4. **AC-4 Supersede:**
   - A valid chain sets `superseded_by` and archives the target atomically.
   - A foreign or missing id → 404, an inactive target → 409, a different kind → 409.
   - Two concurrent supersedes of the same target: exactly one succeeds.
5. **AC-5 Retrieval:**
   - `q`, `kind`, `tag` and `status` filter correctly; the default returns active records only.
   - A punctuation-only `q` uses the ILIKE fallback; `%` and `_` are treated as literals.
   - Paging by `memory_id` cursor returns every record exactly once, including records with equal `created_at`.
   - `GET /memory/:id` works; a foreign id → 404.
6. **AC-6 Consolidation:**
   - It creates revision N+1 and archives only knowledge memories with `created_at <= covered_until`; influences stay active.
   - Concurrent calls produce distinct revisions and no 500.
   - A future `covered_until`, or one earlier than the previous revision → 400.
   - Bootstrap returns the latest summary, recent memories and the `memory` pointers.
   - With no summary, `memory_summary` equals the MVP output.
7. **AC-7 Rollback:**
   - Owner rollback archives only influences whose `persona_revision` is in the reverted set (plus legacy rows after `target_created_at`), and leaves facts and decisions active.
   - A session caller → 403.
   - `memory_events` and `inbox_events` (`memory.rolled_back`) are written for owner and agent.
   - Rolled-back influences disappear from bootstrap and are listed under `status=archived`.
8. **AC-8 Limits:**
   - The 31st write in an hour → 429 with `Retry-After`.
   - 500 active knowledge memories → 409 `memory_consolidation_required`; 50 active influences → 409 `influence_limit_reached`.
   - Concurrent writes cannot exceed either limit.
9. **AC-9 Reactivation:**
   - `PATCH active=true` on a `superseded` or `consolidated` record → 409.
   - On a `personality_rollback` record: session → 403, owner → 200.
   - On a `manual` record → 200, subject to the capacity limits.
10. **AC-10 Access:** a non-owning principal → 403 on every memory endpoint. An agent token → 403 (unchanged).
11. **AC-11 Client/CLI:**
    - The SDK provides `saveMemory`, `listMemories`, `getMemory`, `archiveMemory`, `restoreMemory`, `consolidateMemories`, `rollbackMemories` and `memoryEvents`.
    - The CLI provides `memory save|list|get|archive|restore|consolidate|rollback|events`.
    - `persona rollback` synchronizes with the server, or leaves a retryable pending entry.
    - `saveMemory` runs `assertSafeOutbound` before sending.
12. **AC-12 Compatibility:** existing tests (`mvp.test.ts:79` etc.) pass unchanged. `POST /memory` without `active` succeeds.

## 7. Out of Scope
- Semantic (pgvector) memory search — `embeddings.ts` exists, but memory search stays lexical in this iteration; revisit after Q-016 resource limits.
- Rollback of a consolidation revision (restoring archived memories from a summary) and permanent deletion (`05_MEMORY_MODEL.md` §7 remains open for deletion).
- Server-side summarization or extraction of any kind.
- Multi-device persona synchronization (Q-007).
