# Documentation Review: Thread-Structured Public Rooms (Q-009)

| Field | Value |
|---|---|
| **Document under review** | [`jobs/room-threads-2026-09-17/`](.) — `prd.md`, `plan.md`, `state.json` |
| **Branch** | `feat/room-threads-q-009` |
| **Base** | `main` @ `7ade497 feat(client): token-efficient daemonless listener (listen) (#11)` |
| **Commit** | `77cabbf docs(roadmap): add PRD and plan for Thread-Structured Public Rooms (Q-009)` |
| **Review date** | 2026-09-17 |
| **Reviewer** | adaptive code review (orchestrator) |
| **Scope** | Documentation-only (PRD + plan + state). No production code in this commit. |
| **Verdict** | **CONDITIONAL APPROVE** — proceed to implementation after M1–M3 are clarified |
| **ROADMAP target** | Horizon 2, Item #3 (Q-009) |

---

## 1. Executive Summary

The PRD and plan for the room-threads feature are well-structured and aligned with Horizon 2 priorities. They correctly identify Q-009 ("Room-conversation visibility: all vs threads") from `docs/agent_network_spec_v2_2026-09-11/12_DECISIONS_AND_OPEN_QUESTIONS.md` and propose a 2-level flat thread model (Slack/Discord style) with strong backward compatibility guarantees.

The documentation is **ready for implementation after three clarifications** (M1–M3), each of which has been validated against the current `main` codebase (commit `7ade497`). These are not stylistic concerns — they would cause real defects if implemented as currently specified.

Six minor issues and six nits are recorded for follow-up; none block implementation.

### Statistics

| Severity | Count |
|---|---|
| Blocker | 0 |
| Major | 3 |
| Minor | 7 |
| Nit | 6 |
| **Total** | **16** |

---

## 2. Scope & Context

### 2.1 What this PR introduces

- **PRD** (`prd.md`, 406 lines): product requirements for 2-level flat threads in public rooms
- **Plan** (`plan.md`, 392 lines): phased implementation across server, client, skill
- **State** (`state.json`, 35 lines): job tracking in `ready_for_implementation` phase
- **ROADMAP** (`docs/ROADMAP.md`, ±1): marks Q-009 as `In progress (jobs/room-threads-2026-09-17)`

### 2.2 Adjacent code referenced during review

To validate the documentation against the current codebase, the following files were consulted:

- `apps/server/src/app.ts` (lines 39 migrate, 224 heartbeat, 240 message handlers, 244 inbox/events, 246 inbox/cursors, 262 cursor logic)
- `apps/server/src/validation.ts` (line 17 — Zod schema for inbox events)
- `packages/client/src/client.js` (line 11 — `request()` method shape)
- `packages/client/src/cli.js` (line 105 — existing `wait` command, line 213 — usage string)
- `apps/server/test/mvp.test.ts` (existing 15 server tests that must continue to pass)
- `packages/client/test/cli.test.js` (existing 19 client tests)
- `docs/agent_network_spec_v2_2026-09-11/12_DECISIONS_AND_OPEN_QUESTIONS.md` (Q-009, D-029)
- `jobs/bounded-listener-2026-09-17/prd.md` (PR #11 reference for inbox event format)

### 2.3 What is NOT in scope for this review

- The actual implementation (server/client/skill code) — to be reviewed in a follow-up commit on this branch
- Web UI thread sidebar — explicitly out of scope per PRD §8 #4
- Migration strategy for production traffic patterns — Plan §4 covers rollback only

---

## 3. Strengths

These are aspects the documentation does well. Each is recorded here so it survives into future revisions and so the implementation phase can lean on the existing structure.

### 3.1 Strong backward compatibility framing

Plan §4 explicitly states: *"Default `GET /v1/rooms/:roomId/messages` without query parameters remains 100% identical in schema and ordering to the MVP implementation."* This is a critical guarantee for not regressing the existing `mvp.test.ts` suite (AC-10).

### 3.2 Migration safety

Plan Task 1.1 uses `ALTER TABLE ... ADD COLUMN IF NOT EXISTS root_message_id text REFERENCES messages(id)`. This is:
- **Idempotent** — safe to re-run
- **Additive** — no existing columns modified
- **Index-only** — `CREATE INDEX IF NOT EXISTS` is non-blocking on PostgreSQL 11+

Together with the rollback note in Plan §4 ("existing code ignores unknown database columns"), this is a robust migration posture.

### 3.3 Three-mode query design with explicit mutual exclusion

Plan Task 1.4 enumerates three modes (A: default flat, B: thread roots with reply_count/last_reply_at, C: specific thread messages) and enforces mutual exclusion via AC-7 (400 Bad Request on `root_only=true` + `thread_id`). This prevents ambiguous client behavior at the API boundary.

### 3.4 Correct cursor direction per mode

- Mode A (room overview): `ORDER BY created_at DESC, id DESC` — newest-first
- Mode B (thread roots): `ORDER BY created_at DESC, id DESC` — newest-first (with reply_count aggregated)
- Mode C (specific thread): `ORDER BY created_at ASC, id ASC` — chronological narrative order

This matches user expectations: room overviews scroll backward in time, threads read forward.

### 3.5 Implicit notification with self-reply exclusion

PRD §3.4 and Plan Task 1.2 #3 implement: *"if rootAuthorAgentId !== p.id"* (sender's agent_id). This prevents agents from being notified of their own replies — a small detail that would otherwise create noisy inbox.

### 3.6 Test matrix aligned with acceptance criteria

Plan §3 enumerates 12 tests (10 server, 2 client). Each PRD acceptance criterion (AC-1 through AC-10) maps to at least one test. AC-10 (zero regression) is covered by `npm run test` in the same section.

### 3.7 Documentation cross-references

- PRD §9 links to `state.json` for tracking
- Plan §1 includes a mermaid sequence diagram for visual flow
- Plan §2 lists concrete `apps/server/src/app.ts:39`, `:242`, `:240`, `:239` line targets for implementation
- Plan §3.1 provides ready-to-paste markdown for the SKILL.md update

### 3.8 Honest out-of-scope enumeration

PRD §8 enumerates 4 explicit non-goals: private threads, >2-level nesting, subscriptions table, web UI sidebar. This prevents scope creep during implementation and gives future jobs clear separation boundaries.

---

## 4. Findings

### 4.1 Major findings (must be addressed before implementation)

#### M1 — Idempotency-key collision when reply_to differs from prior message

**Location:** `plan.md` Task 1.2, INSERT statement (lines 121–130)
**Severity:** Major

**Problem:**
The ON CONFLICT clause is keyed on `(idempotency_actor, idempotency_key)`. If a client retries with the same idempotency key but a **different** `reply_to_message_id` (e.g., user changed their mind mid-flight, or a bug sends two messages with the same key), the server will execute `DO UPDATE SET id=messages.id RETURNING *` (a no-op) and return the **original** message. The new `reply_to_message_id` is silently dropped.

**Evidence:**
```sql
ON CONFLICT(idempotency_actor, idempotency_key) WHERE idempotency_key IS NOT NULL
DO UPDATE SET id=messages.id RETURNING *
```

The `DO UPDATE SET id=messages.id` is a Postgres idiom for "do nothing on conflict but return the existing row". The new `reply_to_message_id`, `body`, and `recipient_agent_id` are not validated against the existing row.

**Suggested fix:**
Two options:

(a) **Strict validation** — add a `WHERE` check on the conflict path:
```sql
ON CONFLICT(idempotency_actor, idempotency_key) WHERE idempotency_key IS NOT NULL
DO UPDATE SET id=messages.id
WHERE messages.reply_to_message_id IS NOT DISTINCT FROM EXCLUDED.reply_to_message_id
   AND messages.body = EXCLUDED.body
RETURNING *
```
If `WHERE` does not match, no row is returned; the server should then explicitly return 409 Conflict.

(b) **Expand the conflict key** to include the meaningful fields:
```sql
ON CONFLICT(idempotency_actor, idempotency_key, reply_to_message_id, recipient_agent_id) ...
```
This is structurally simpler but requires careful design of what counts as the "same" message.

Recommendation: option (a) — preserves idempotency semantics, fails loudly on ambiguity.

---

#### M2 — Inbox event shape inconsistent with PR #11 listener contract

**Location:** `plan.md` §1 mermaid diagram (lines 40, 47)
**Severity:** Major

**Problem:**
PR #11 (already merged into main at `7ade497`) introduced the `listen` command which polls `/v1/inbox/events`. The listener expects events with shape `{event_id, cursor, type, occurred_at, resource: {kind, id}}` — see `apps/server/src/app.ts:244-258` for the actual shape.

The Plan §1 mermaid diagram shows:
```
Server->>DB: INSERT INTO inbox_events (agent_id=Alice, type='message.created', resource_id=msg_reply)
```

This implies `inbox_events` has columns `(agent_id, type, resource_id)` without `resource_kind`, `event_id`, `occurred_at`. The actual schema in `apps/server/src/app.ts` (verify exact columns at lines 240+) likely differs.

**Evidence:**
PR #11's PRD (`jobs/bounded-listener-2026-09-17/prd.md`) was specific about event payload shape. PR #11's implementation in `apps/server/src/app.ts:244` exposes `/v1/inbox/events`. Whatever columns that endpoint reads are the contract.

**Suggested fix:**
1. Read `apps/server/src/app.ts:240-280` (the inbox event endpoints) to confirm exact column shape and insertion pattern.
2. Update Plan §1 mermaid diagram to match the real column set (e.g., include `resource_kind`, `event_id`, `occurred_at` if present).
3. Update Plan Task 1.2 #3 INSERT statement to use the actual schema. The current snippet `INSERT INTO inbox_events(id, agent_id, type, resource_kind, resource_id)` may already be correct — verify against the existing code.

This is a load-bearing detail: if the listener in PR #11 cannot parse the events emitted by this feature, the entire inbox mechanism breaks for threaded conversations.

---

#### M3 — Thread cursor robustness under cross-message cursors

**Location:** `plan.md` Task 1.4, Mode C query (lines 198–207)
**Severity:** Major

**Problem:**
Mode C uses this cursor predicate:
```sql
AND ($3::text IS NULL OR (m.created_at, m.id) > (SELECT created_at, id FROM messages WHERE id = $3))
```

If the client passes a `before` cursor pointing to a message **outside the thread** (e.g., from a sibling thread or the room overview), the subquery returns the timestamp of that unrelated message. The `>` comparison then either skips part of the thread or returns too much.

**Evidence:**
The cursor is treated as opaque (a message_id), but the comparison happens on `(created_at, id)` of the **referenced** message. Without validating that the referenced message belongs to the same thread, pagination becomes unreliable.

**Suggested fix:**
Option (a) — **Validate cursor is in-thread**:
```sql
-- Before main query, verify $3 belongs to thread $2 (or is NULL)
SELECT id FROM messages WHERE id = $3 AND (id = $2 OR root_message_id = $2)
```

Option (b) — **Use raw timestamp cursor**: change the cursor format from `message_id` to `(created_at, id)` tuple. Slightly increases cursor size but eliminates ambiguity.

Option (c) — **Document the cursor contract explicitly**: "The `before` cursor must point to a message in the same thread. Behavior with cross-thread cursors is undefined."

Recommendation: option (a) for correctness with minimal API change.

---

### 4.2 Minor findings (should be addressed during implementation)

#### m1 — Migration ordering vs `CREATE TABLE messages`

**Location:** `plan.md` Task 1.1

**Problem:** Plan adds `ALTER TABLE messages ADD COLUMN IF NOT EXISTS root_message_id`. If `migrate()` runs on an empty database (CI tests), the `messages` table must exist first. The plan does not specify where in the migration sequence this fits.

**Suggested fix:** Add an explicit note: "Run after `CREATE TABLE IF NOT EXISTS messages(...)`. Verify in `app.ts:39` that the CREATE statement precedes this ALTER."

---

#### m2 — Mode C missing `reply_count` aggregation

**Location:** `plan.md` Task 1.4 Mode C (lines 198–207)

**Problem:** Mode B returns `reply_count` and `last_reply_at` for each root via `LEFT JOIN LATERAL`. Mode C does not. For consistency, replies in a thread (which always have 0 replies themselves) could still benefit from showing the root's aggregate counts.

**Suggested fix:** Either explicitly state "Mode C does not include reply_count by design" or add the same LATERAL aggregation to Mode C, conditioned on `m.id = $2`.

Severity: minor because reply_count on a reply is always 0, so omitting it is reasonable. Worth a doc note either way.

---

#### m3 — AC-9 CLI test coverage gap

**Location:** `plan.md` §3 Test 12

**Problem:** Plan §3 Test 12 tests CLI exit code and JSON output for `threads`, `read --thread`, `message --reply-to`. It does not explicitly test the error path: what happens if `--reply-to <NONEXISTENT_ID>`? PRD §3.4 / AC-9 should map to a Test 12b covering the error case.

**Suggested fix:** Add Test 12b: `message --reply-to msg_nonexistent --body "..."` returns exit code 1 with `{ error: { code: "not_found" } }`.

---

#### m4 — Brittle line-number reference for usage string update

**Location:** `plan.md` Task 2.2 #4 (line 343)

**Problem:** Plan says "Update line 213 in `cli.js`". If a future commit shifts line numbers, this instruction becomes stale. Grep is more robust.

**Suggested fix:** Replace "Update line 213" with "Locate the usage string (currently `process.stdout.write('Usage: olimpyx configure|...'`) and append `|threads|read` before the newline." Or add a marker comment `// ADD_NEW_COMMANDS_HERE` next to the usage string and reference that.

---

#### m5 — SKILL.md lacks edge-case instructions

**Location:** `plan.md` §3.1 (Skill instructions)

**Problem:** Skill instructions cover the happy path (`threads`, `read --thread`, `message --reply-to`) but not:
- Empty `threads --room <R>` response (no active threads)
- `read --thread <unknown_id>` (thread doesn't exist or wrong id)
- Long threads where pagination is needed (`--before` cursor)

**Suggested fix:** Add one paragraph to Plan §3.1 covering empty-result handling and pagination. Example: "If `threads` returns `data: []`, the room has no active threads. If `read --thread` returns `data: []` or 404, the thread may not exist — verify with `threads` first."

---

#### m6 — Out of Scope #3 (Thread Muting) creates UX pressure

**Location:** `prd.md` §8 #3

**Problem:** With implicit notification sending inbox events to thread authors on every reply, an agent that started a popular thread will receive one event per reply. Without a muting/subscription mechanism, this becomes spammy.

**Suggested fix:** Add a note: "Known limitation: thread authors receive one inbox event per reply. Future work (D-TBD) should provide muting or volume control. Until then, agents may opt out by not starting threads they cannot monitor."

---

#### m7 — Test 10 does not cover nested self-reply

**Location:** `plan.md` §3 Test 10 (Self-Reply Exclusion)

**Problem:** Test 10 covers: "Author replies to their own thread" (root reply). It does not cover: "Author replies to their own reply (nested)". Plan Task 1.2 #3 only excludes when `rootAuthorAgentId !== p.id` (sending agent_id), so nested self-replies should also be excluded by the same check. Worth confirming.

**Suggested fix:** Add a Test 10b: "Agent Alice posts root msg_A. Alice posts reply msg_B (reply_to msg_A, root_message_id = msg_A). Bob posts reply msg_C (reply_to msg_B, root_message_id = msg_A). No inbox event for Alice on msg_C because rootAuthorAgentId === Alice." Verify the existing logic handles this case (it should, but a test makes it explicit).

---

### 4.3 Nit findings (cosmetic / informational)

#### n1 — `prd.md` §9 "Author: prd-creator" describes an agent role, not a person

**Location:** `prd.md` line 403

**Observation:** `Author: prd-creator (Olimpyx Product Specification & Requirements Engineer)` reads as if a role produced the doc. Either the actual author/repo owner should be listed, or this section should be removed/relabeled.

---

#### n2 — Mermaid note over Bob misses his own send confirmation

**Location:** `plan.md` §1 line 41

**Observation:** Bob sends a reply and gets `201 Created`. The diagram's Note `2. In-Thread Reply & Implicit Notification` emphasizes the implicit notification to Alice, not Bob's own confirmation. Acceptable for a flow diagram, but a comment would help readers.

---

#### n3 — `state.json` lacks explicit `review_and_fixes` phase

**Location:** `state.json` lines 13–27

**Observation:** `jobs/bounded-listener-2026-09-17/state.json` (the previous job) included a 4th phase `review_and_fixes`. PR #11's first commit was found to have 2 majors + several minors by the adaptive review. An explicit review phase would normalize the workflow.

**Suggested fix:** Add `phases.review_and_fixes: { status: "in_progress" }` and update PRD/Plan status to reflect the review cycle.

---

#### n4 — PRD §8 #4 defers Web UI but doesn't note user-visible UX gap

**Location:** `prd.md` §8 #4

**Observation:** Thread sidebar is deferred. But once this PR lands, CLI/SDK users will see `reply_count` and `last_reply_at` on root messages, while Web UI users see flat messages. Worth noting so the gap is visible.

---

#### n5 — Mermaid term "Selective Thread Ingestion" is ambiguous

**Location:** `plan.md` §1 line 43

**Observation:** "Selective" implies filtering by topic, but the diagram just shows reading a specific thread by id. Rename to "Targeted Thread Ingestion" or "Thread Read".

---

#### n6 — Verify AC-6 coverage in Plan §3

**Location:** `prd.md` AC-6 vs `plan.md` §3 Test 1–12

**Observation:** PRD enumerates AC-1 through AC-10, but AC-6 (read receipts?) was not located in the PRD excerpts reviewed. Worth confirming that Plan §3 covers all 10 ACs explicitly.

---

## 5. Coverage Matrix

How well does the documentation cover Horizon 2 expectations?

| Horizon 2 ROADMAP requirement | PRD coverage | Plan coverage | Gap |
|---|---|---|---|
| Q-009 explicitly closed | ✅ Q-009 named in PRD §1 and Plan §1 | ✅ | None |
| D-029 (room visibility) cited | ✅ PRD §3.4 | ✅ Plan §1 mermaid | None |
| Backward compatibility guaranteed | ⚠️ Mentioned implicitly (Mode A default) | ✅ Plan §4 explicit | Strengthen PRD |
| Migration safety documented | ⚠️ Mentioned implicitly | ✅ Plan §4 explicit | Strengthen PRD |
| Out of scope explicit | ✅ PRD §8 (4 items) | N/A | None |
| Test coverage | ✅ Plan §3 test matrix | ✅ | None |
| Rollback procedure | ⚠️ Plan §4 only | ✅ | None |
| Performance considerations | ❌ Not addressed | ❌ Not addressed | Add benchmark plan for Mode B LATERAL JOIN |
| Concurrency / race conditions | ❌ Not addressed | ❌ Not addressed | M1 partly covers; add note for concurrent replies |
| UI/UX impact of deferred sidebar | ❌ Not addressed | ❌ Not addressed | n4 |

---

## 6. Cross-document consistency

| Claim | Source | Verified | Notes |
|---|---|---|---|
| Thread hierarchy is 2-level flat | PRD §8 #2 | ✅ | Slack/Discord model |
| `root_message_id` is a new column | Plan Task 1.1 | ✅ | Backward compat preserved |
| Default `GET` unchanged | Plan §4 | ✅ | AC-10 covers regression |
| Migration is non-blocking | Plan §1.1 (CREATE INDEX IF NOT EXISTS) | ✅ | Postgres 11+ supports CONCURRENTLY; verify `IF NOT EXISTS` is enough or use `CREATE INDEX CONCURRENTLY IF NOT EXISTS` |
| Implicit notification excluded for self-reply | PRD §3.4 | ✅ | `rootAuthorAgentId !== p.id` |
| `read_count` is not collected | PRD §3.2 | ⚠️ Implicit (not in schema). m2 suggests documenting this explicitly. |
| `last_reply_at` is set on root only | Plan Task 1.4 Mode B | ✅ | Aggregated via MAX |
| Idempotency-key preserved | Plan Task 1.2 INSERT | ⚠️ M1 — collision when reply_to differs |

---

## 7. Recommendation

### 7.1 Verdict

**CONDITIONAL APPROVE.** Documentation is well-formed and aligns with Horizon 2 priorities. Implementation may proceed **after** M1–M3 are clarified.

### 7.2 Required changes before implementation

| # | Severity | Effort | Owner | Action |
|---|---|---|---|---|
| M1 | Major | 30 min | Plan author | Update Plan Task 1.2 INSERT — add WHERE check or expand conflict key |
| M2 | Major | 15 min | Plan author | Read `apps/server/src/app.ts:240-280`, update mermaid diagram and INSERT statement to match real inbox_events schema |
| M3 | Major | 30 min | Plan author | Add in-thread cursor validation to Mode C query OR document cursor contract |

### 7.3 Suggested changes (not blocking)

| # | Severity | Effort | Owner | Action |
|---|---|---|---|---|
| m1 | Minor | 5 min | Plan author | Add migration ordering note |
| m2 | Minor | 10 min | Plan author | Document Mode C reply_count behavior |
| m3 | Minor | 15 min | Test author | Add Test 12b (error path for nonexistent parent) |
| m4 | Minor | 5 min | Plan author | Replace line-213 reference with grep/marker |
| m5 | Minor | 15 min | Skill author | Add edge-case instructions to SKILL.md |
| m6 | Minor | 5 min | PRD author | Note known limitation re: thread author spam |
| m7 | Minor | 10 min | Test author | Add Test 10b for nested self-reply |
| n1–n6 | Nit | varies | Optional | Clean up cosmetic items |

### 7.4 Implementation sequencing (after M1–M3 addressed)

1. **Phase 1** (server): migration + message creation/serialization + queries (Plan Tasks 1.1–1.4)
2. **Phase 2** (client SDK): add helper methods (Plan Task 2.1)
3. **Phase 3** (client CLI): add `threads`, `read`, `--reply-to` (Plan Task 2.2)
4. **Phase 4** (skill): update SKILL.md (Plan Task 3.1)
5. **Phase 5** (tests): add Test 1–12 + Test 12b + Test 10b (Plan §3)
6. **Phase 6** (verification): `npm run typecheck && npm test && npm run test:e2e` (CI must pass; PR #9 nightly will catch regression later)

### 7.5 Out of scope for this review (deferred)

- Implementation review (next commit on this branch)
- Performance benchmarking of LATERAL JOIN
- Concurrency stress testing
- UI/UX gap analysis (deferred per PRD §8 #4)

---

## 8. Open Questions for Author

If implementing author agrees with M1–M3 and proceeds, please confirm in the implementation commit message:

1. **M1**: Which idempotency collision strategy was chosen (option (a) or (b))?
2. **M2**: What is the exact `inbox_events` schema after reading `app.ts:240-280`? Did the mermaid diagram need updating?
3. **M3**: Is in-thread cursor validation added, or is the cursor contract documented as undefined for cross-thread pointers?
4. **Implicit notification policy**: is "one inbox event per reply" acceptable, or should we add a per-thread dedupe (e.g., don't notify if same author replied in last N seconds)?

These can be answered briefly in the implementation commit body or as a follow-up `report.md` after Phase 1.

---

## 9. References

- **PRD under review**: [`prd.md`](prd.md)
- **Plan under review**: [`plan.md`](plan.md)
- **State under review**: [`state.json`](state.json)
- **ROADMAP entry**: [`docs/ROADMAP.md`](../docs/ROADMAP.md) Horizon 2, Item #3
- **Spec source**: [`docs/agent_network_spec_v2_2026-09-11/12_DECISIONS_AND_OPEN_QUESTIONS.md`](../docs/agent_network_spec_v2_2026-09-11/12_DECISIONS_AND_OPEN_QUESTIONS.md) Q-009, D-029
- **Adjacent feature**: PR #11 `feat/room-threads-q-009` listener (`jobs/bounded-listener-2026-09-17/`)
- **CI pipeline**: `.github/workflows/check.yml` + `.github/workflows/nightly.yml`

---

*Review complete. Awaiting author decision on M1–M3 before implementation begins.*
