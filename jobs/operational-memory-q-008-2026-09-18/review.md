# Documentation Review: Operational-Memory (Q-008)

| Field | Value |
|---|---|
| **Documents under review** | [`prd.md`](prd.md), [`plan.md`](plan.md), [`state.json`](state.json) |
| **Branch** | `feat/operational-memory-q-008` (base `main` @ `0efcd6a`) |
| **Review date** | 2026-09-18 |
| **Compared against** | `apps/server/src/app.ts`, `apps/server/src/validation.ts`, `packages/client/src/{state,redaction,cli,client}.js`, `skills/olimpyx-participant/SKILL.md`, `docs/agent_network_spec_v2_2026-09-11/{05,11,12}_*.md`, `docs/ROADMAP.md` |
| **Round 1 verdict (revision 1)** | **REQUEST_CHANGES** — the earlier "APPROVE" was premature |
| **Round 2 verdict (revision 2)** | **APPROVE** — all blocker/major findings addressed; decisions A1–A8 confirmed by owner after brainstorm |

---

## 1. Round 1 Findings (revision 1) and Resolution

### Blockers

| ID | Finding | Resolution in revision 2 |
|---|---|---|
| B1 | The server `personality_influence` rollback by `since` was disconnected from the existing local rollback (`state.js:98` archives `influences.json` by `persona_revision`). Server influences re-entered bootstrap after `persona rollback`. | A4: server influences carry `persona_revision`; the CLI `persona rollback` calls the server with the exact reverted set; a pending/retry path covers a missing owner credential (PRD §3.6, plan Step 8). |
| B2 | Consolidation archived influences, and an agent-written summary could embed them, so a later rollback could not retract them. | A6: consolidation excludes `personality_influence`; skill rule forbids restating influences in summaries (PRD §3.5, plan Step 9). |
| B3 | Plan Step 1 put GET query schemas into `validation.ts` routes. The `preValidation` hook validates only `req.body` (`validation.ts:54-61`), so every GET would return 400. | Query schemas are exported and parsed in the handlers (plan §1.1, Step 1). |
| B4 | `PATCH` (`app.ts:495`) could reactivate superseded, consolidated or rolled-back records and bypass capacity. | `archived_reason` state model plus a transition table; owner-only reactivation after rollback; capacity is enforced (PRD §3.3). |

### Majors

| ID | Finding | Resolution |
|---|---|---|
| M1 | The `olimpyx_` regex matched nothing: tokens are `randomBytes(32).base64url` without a prefix (`app.ts:13`). The server rules diverged from the client `redaction.js`. | One shared rule set plus a 43-char base64url token rule; a parity test; wider scan targets (PRD §5). |
| M2 | Race conditions on the 30/h and 500 limits and on `max(revision)+1`. | A per-agent `pg_advisory_xact_lock('memory:'+id)`, the same pattern as `app.ts:659`; concurrency ACs. |
| M3 | An unverified `supersedes_id` could link to another agent's memory (the FK checks existence only). | `SELECT … FOR UPDATE` scoped by agent → 404/409, `rowCount` assertion. |
| M4 | A JSON cursor built from `created_at` loses microseconds in JS `Date`. | A cursor equal to `memory_id` with a `(created_at,id)` subquery, the codebase convention (`app.ts:409`). |
| M5 | The search design was inconsistent (A2 FTS vs PRD "ILIKE or tsvector" vs plan ILIKE without a GIN index); no ILIKE escaping. | A generated `search_tsv` plus GIN, a `numnode` fallback to escaped ILIKE, no ranking (A2). |
| M6 | Undocumented contract changes: POST `active` was required; GET returned all records. | `active` becomes optional (default true); `status=active` is the documented default (PRD §3.2, §3.4). |
| M7 | Authority: any session could roll back; the PRD claimed an agent token was accepted. | A7 plus an authority table; rollback is owner-only; the agent token stays rejected (PRD §3.8). |
| M8 | An audit log was promised, but no store existed. | `memory_events` plus `memory.rolled_back` inbox events (A8). |

### Minors (all addressed)
- `covered_until` has a default and bounds. `active_memory_count` is replaced by `archived_memory_count`.
- Consolidate and rollback now use `idem()`.
- There is an `archived_reason` enum with a legacy backfill.
- Dedup is skipped when `supersedes_id` is present.
- `capability` is documented as the equivalent of the spec's `capability_observation`.
- New items: the `GET /memory/:id` route, CLI `get|restore|rollback|events`, skill write rules.
- A docs step was added (D-044, Q-008, ROADMAP, API draft).
- `state.json` and `review.md` statuses are aligned.
- The "branch to be created" note is corrected.

## 2. Residual Risks (accepted)
- **Behavior change:** the default `GET /memory` filter moves from "all" to `status=active`. No current client consumes the endpoint (`packages/client` has no memory methods), and `mvp.test.ts:79` asserts status codes only.
- **Two-phase rollback:** the local and server rollbacks are not one transaction. The pending entry plus a deterministic Idempotency-Key make the retry safe, but the server can lag until `memory rollback --sync` runs.
- **Skill compliance:** keeping influence text out of summaries depends on the agent following the skill rule; the server cannot verify semantics.
- **False positives:** the Olimpyx-token rule may reject legitimate 43-character base64url strings. This is accepted: the 422 message tells the agent to remove or rephrase the value.
- **Out of scope:** pgvector memory search, restoring a consolidation revision, permanent deletion.

Verdict: **APPROVED FOR IMPLEMENTATION** (revision 2).
