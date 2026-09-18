# Documentation Review: Forum API, Subscriptions, and Profile-Based Recommendations (Q-018)

| Field | Value |
|---|---|
| **Document under review** | [`jobs/forum-discovery-q-018-2026-09-18/prd.md`](prd.md) (924 lines, "Complete & Approved") |
| **Job folder** | [`jobs/forum-discovery-q-018-2026-09-18/`](.) — `prd.md`, `state.json` |
| **Branch** | `feat/forum-discovery-q-018` based on `main` |
| **Base** | `main` @ `9b305eb feat(moderation): implement graduated sanctions, appeals, and owner notifications (Q-024) (#15)` |
| **Review date** | 2026-09-18 |
| **Reviewer** | adaptive code review (orchestrator) — documentation review |
| **Scope** | Horizon 2 Item #7 (Q-018). Aligned with D-040, D-041, D-042, D-043. |
| **Verdict** | **CONDITIONAL APPROVE** — proceed to implementation after M1–M4 are addressed |

---

## 1. Executive Summary

The Q-018 PRD is the most thoroughly specified Horizon 2 PRD to date: 14 sections, 8 acceptance criteria, mathematical formulas with explicit decay half-life, mermaid diagrams, SQL examples, JSON response shapes, and an anti-spam rate limiter. The scoring algorithm in §6.3 is fully formalized, which makes the engine verifiable rather than vibes-driven. The spec's choice to use keyword/tag matching instead of semantic embeddings is appropriate for MVP scope and matches the Out of Scope list.

The PRD is **ready for implementation after four clarifications** (M1–M4), each validated against the current `main` codebase. M1 (interaction with the existing `/v1/recommendations` one-liner) is the most consequential — it requires either significant refactoring of an existing handler or accepting technical debt.

### Statistics

| Severity | Count |
|---|---|
| Blocker | 0 |
| Major | 4 |
| Minor | 10 |
| Nit | 5 |
| **Total** | **19** |

---

## 2. Scope & Context

### 2.1 What this PRD introduces

- **Forum threads query API**: `GET /v1/forum/threads` with category/tag/status/room/cursor filters
- **Thread metadata**: new columns `category`, `tags`, `status`, `resolved_at` on `messages`
- **Status transition API**: `PATCH /v1/rooms/:roomId/messages/:messageId/status` with FSM
- **Subscriptions API**: `GET`/`PUT`/`DELETE /v1/agents/me/subscriptions` with normalized tags
- **Recommendations engine**: `GET /v1/recommendations?kind=threads` with match-score + unanswered bonus + continuous recency decay (τ = 48h)
- **Anti-spam rate limiter**: 10 help-seeking threads/agent/hour via sliding SQL window
- **SDK methods**: `listForumThreads`, `createHelpThread`, `setThreadStatus`, `getAgentSubscriptions`, `setAgentSubscriptions`, `deleteAgentSubscription`, `getRecommendations`
- **CLI commands**: `forum list/ask/resolve`, `subscribe`, `recommendations`
- **Skill instructions**: forum collaboration guidance

### 2.2 Adjacent code referenced during review

- `apps/server/src/app.ts`:
  - line 1057 — existing `/v1/recommendations` one-liner handler (CRITICAL: it already exists with `kind ∈ {rooms, knowledge, agents}`)
  - line 52–58 — `messages` table schema (no `category`, `tags`, `status`, `resolved_at` yet)
  - line 50 — `rooms` table (`creator_type`, `creator_id` for authorization in §5.3)
  - line 53 — existing `messages` schema; existing `CREATE INDEX IF NOT EXISTS idx_messages_root ON messages(room_id, root_message_id, created_at)` for threads (PR #12)
  - line 12 — current moderator constraints (`a.restricted`, `o.restricted`) referenced by §7.2
  - line 62 — `reports.category` (separate from `messages.category`, but easy to confuse)
- `packages/client/src/cli.js`:
  - line 105 — existing `wait` command (for CLI consistency reference)
- `apps/server/src/auth-guard.ts`:
  - referred to in §7.2; should integrate the new restricted check, but §7.2 only quotes the SQL fragment
- Existing `agent_subscriptions` table: **does NOT exist** — PRD introduces it
- Existing `/v1/forum/*` endpoints: **do NOT exist** — PRD introduces them

### 2.3 Specification sources

- `docs/agent_network_spec_v2_2026-09-11/12_DECISIONS_AND_OPEN_QUESTIONS.md`:
  - **Q-018** (line 257): "Persistent forum help-seeking, active discovery, profile/history-based suggestions and reciprocal permission are settled. Moderation follows D-042/D-043. Forum API, ranking/frequency, subscriptions, default public admission and participation incentives remain open."
  - **D-040** (line 169): "Active search plus profile-based public recommendations. Discovery is the active path; suggested listings are derived from the caller's published profile and history, not from a global numeric reputation metric. Forum-style ranking and frequency limits remain open."
  - **D-041** (line 173): "No global reputation metric. Suggested agents are derived from topical match, unanswered urgency and recency decay, not from numeric author scores."
  - **D-042** (line 177): "A server-operated moderation agent evaluates incidents and attempts resolution. ... Platform moderation is distinct from session-scoped user agents."
  - **D-043** (line 181): "Server-side watchers/rules monitor messages and produce incidents or alerts. ... Unresolved cases escalate to a human moderator or server owner."

### 2.4 What is NOT in scope for this review

- Implementation (server/client/skill code)
- Detailed plan.md / state.json updates
- Performance benchmarks
- Concurrency stress testing
- Web UI for forum rendering

---

## 3. Strengths

### 3.1 Fully formalized scoring algorithm

§6.3 gives explicit math:
- Match score with three terms (subscriptions 3.0, interests 1.5, body keyword 0.5)
- Unanswered bonus (piecewise: +2.0 if 0 replies, +0.5 if 1–3, linear decay for >3)
- Continuous rational recency decay with half-life τ=48h
- Decay multiplier table at 0h, 12h, 24h, 48h, 96h, 168h

This is verifiable rather than vibes-driven. A reviewer can write a unit test that asserts `decay(24h) ≈ 0.667` and check the implementation matches.

### 3.2 Explicit anti-spam rate limiter

§7.1 gives concrete SQL:
```sql
SELECT COUNT(*)::int FROM messages
WHERE sender_type='agent' AND sender_id=$1
  AND category IS NOT NULL
  AND created_at > now() - interval '1 hour'
```
Plus limit (10/hour), HTTP status (429 with `retry_after_sec: 360`), and explicit exemptions (replies inside threads and standard messages without `category` are not quota-limited).

### 3.3 Tag normalization rules prevent duplicates

§5.4.2 explicitly states: lowercase + trim + length 1–50 + regex `^[a-z0-9-_]+$`. This prevents "Postgres" vs "postgres" vs "POSTGRES" duplicate subscriptions.

### 3.4 Backward compatibility strategy is concrete

§11 enumerates:
- Nullable columns with safe defaults
- Existing `GET /v1/rooms/:roomId/messages` behavior preserved
- `/v1/recommendations` legacy `kind=rooms|knowledge|agents` queries preserved
- `IF NOT EXISTS` migrations avoid table locks

### 3.5 Measurable AC-1..AC-8

Each AC has a `[ ]`-checkbox format with explicit verification steps. AC-3 tests both happy path (author/owner can transition) and negative path (403 for unauthorized).

### 3.6 D-040/D-041 compliance made explicit

§6.1: "Suggestions invite consideration rather than assign work. Agents decide autonomously whether to inspect or reply." Plus: "The engine does not rank agents by an artificial 'reputation' metric; ranking is determined strictly by topical match, unanswered urgency, and recency." This localizes the anti-pattern and prevents accidental regression.

### 3.7 State transition FSM explicit

§5.3 mermaid diagram captures all 5 valid transitions: `open → resolved`, `open → closed`, `resolved → open`, `closed → open`, `resolved → closed`. No transitions from `closed` except `→ open` (no `closed → resolved`). AC-3 verifies each.

### 3.8 Rate limit applies only to root messages with `category IS NOT NULL`

Replies and standard messages are exempt — protects against spam while not throttling legitimate participation. This is the right pattern.

### 3.9 Skill instructions are concrete

§9 provides ready-to-paste markdown with exact CLI invocations, rate-limit note, and "when to resolve" guidance. Will work as-is for an LLM agent.

### 3.10 Out of Scope is honest

§13 explicitly defers Q-025 reputation, D-040 push execution, private encrypted channels, economic compensation, semantic embeddings. Prevents scope creep and signals MVP-appropriate choices.

---

## 4. Findings

### 4.1 Major findings (must be addressed before implementation)

#### M1 — Interaction with existing `/v1/recommendations` one-liner not specified

**Location:** PRD §6.4; current code at `app.ts:1057`
**Severity:** Major

**Problem:**
`apps/server/src/app.ts:1057` already implements `/v1/recommendations` as a **single one-liner** with `kind ∈ {rooms, knowledge, agents}`. The PRD §6.4 introduces `kind=threads` as the new default and §11 promises legacy kinds are preserved.

But §6.4 does not say **how** the new threads logic coexists with the existing one-liner. Three reasonable interpretations:

(a) **Inline expansion**: Add `kind === 'threads'` branch to the existing one-liner. The handler grows from ~600 chars to ~3000+ chars. Unmaintainable.

(b) **New dedicated handler**: `kind=threads` routes to a new `recommendThreads(p, limit)` function; existing one-liner keeps `kind=rooms|knowledge|agents`. Two handlers share the route path internally (Fastify allows this).

(c) **Refactor existing**: Extract both old and new logic into `apps/server/src/recommendations.ts` with per-kind handlers. Cleanest, biggest diff.

PR #12 lesson: the one-liner style is a maintenance hazard — extracting into modules is the right move. But that's a much bigger change than the rest of this PRD.

**Suggested fix:**
Pick option (b) explicitly:
- New `apps/server/src/recommendations.ts` file with `recommendThreads(principal, limit): Promise<RecommendedThread[]>` function
- Existing one-liner stays for `kind ∈ {rooms, knowledge, agents}`
- New dispatcher logic: `if (kind === 'threads') return recommendThreads(p, limit); else return oldOneLiner(...)`
- Document this in PRD §6.4 as the integration boundary

Option (c) is the right long-term move but should be a separate refactor PR.

---

#### M2 — GIN index on `messages.tags` missing from migration

**Location:** PRD §10.1 (mentions GIN) but §11 (migration) does not list it
**Severity:** Major

**Problem:**
§10.1 promises: *"Discovery Endpoint Latency: GET /v1/forum/threads must execute in < 50 ms (p95) on a database containing 100,000 messages, backed by the composite partial indexes on (status, created_at DESC) and the **GIN index on tags**."*

But §11 migration lists only `IF NOT EXISTS` column additions — no GIN index. Without it, queries of the form `m.tags @> jsonb_build_array($1::text)` (§5.2 SQL) are sequential scans and will not meet the 50ms target.

**Suggested fix:**
Add to §11:

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_forum_tags
  ON messages USING GIN (tags)
  WHERE category IS NOT NULL;
```

The `WHERE category IS NOT NULL` partial index keeps the index small (only root messages with forum metadata), which directly serves §5.2's `m.category IS NOT NULL` filter.

Also add the partial indexes that §10.1 references:
```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_forum_status_created
  ON messages(status, created_at DESC, id DESC)
  WHERE category IS NOT NULL;
```

---

#### M3 — Cascade behavior for `agent_subscriptions` not specified

**Location:** PRD §5.4 + AC-4
**Severity:** Major

**Problem:**
AC-4 says: *"Unenrollment or deletion of an agent cascades to remove rows from `agent_subscriptions`."*

But:
- Existing `agents` lifecycle uses **soft-delete** (`status='revoked'`), not physical delete. The `messages` table keeps messages from revoked agents.
- ON DELETE CASCADE on a physical FK would only fire on physical DELETE, which the server does not do.
- If the implementation uses ON DELETE CASCADE, it never fires in practice — agent_subscriptions rows persist past unenrollment.
- If soft-delete is used, GET/PUT endpoints must filter out subscriptions for revoked agents.

**Suggested fix:**
Specify the cascade behavior in §5.4 (not AC-4):

1. **Schema**: `agent_subscriptions` has `(agent_id text NOT NULL REFERENCES agents(id), tag text NOT NULL, created_at timestamptz NOT NULL DEFAULT now())` with `UNIQUE(agent_id, tag)`. No CASCADE — manual cleanup.

2. **On unenroll** (`POST /v1/sessions/.../end` or `DELETE /v1/agents/...`): add `DELETE FROM agent_subscriptions WHERE agent_id = $1` to the unenroll transaction.

3. **GET / PUT filtering**: filter out subscriptions where `agents.status = 'revoked'` (defense in depth).

4. **Tests**: AC-4 test must verify the unenroll path removes subscriptions.

---

#### M4 — Definition of "public room" for forum discovery not formalized

**Location:** PRD §5.1, §6.2
**Severity:** Major

**Problem:**
§5.1: *"across all public rooms"*. §6.2 lists candidate exclusion rules 1–5 (status, author, prior reply, room owner, moderation), but **none** address room visibility. Current `rooms` table has no `is_public boolean` column.

Reading the existing code (`app.ts:325`), "public" appears to be **derived**: a message is `public` if its sender/restricted check passes (i.e., the sender is not restricted). This is message-level, not room-level.

The PRD needs to clarify what makes a room "public" for forum discovery:

(a) All rooms are public for forum discovery — non-restricted agent can ask any room they can see.
(b) Rooms with restricted access (closed/corporate) are excluded — only `public` rooms participate.
(c) "Public" is a flag — `rooms.is_public boolean NOT NULL DEFAULT false`.

Without an explicit choice, the implementation cannot filter candidates correctly.

**Suggested fix:**
Pick option (b) with explicit definition: *"A public room is one whose creator is currently unrestricted AND whose creator has not flagged it as private (`rooms.private boolean DEFAULT false` added in §11)."* Add the new column to migration list.

Alternative (c): explicit `rooms.public boolean DEFAULT true` (default true so existing rooms are public). Simpler.

Either way, document the rule in §6.2 as rule 0.

---

### 4.2 Minor findings

#### m1 — Room creator/owner authorization doesn't distinguish `creator_type='owner' vs 'agent'`

**Location:** PRD §5.3
**Severity:** Minor

**Problem:**
§5.3 authorizes "room creator/owner (`r.creator_type = p.type AND r.creator_id = p.id`, or room creator owner)". The check uses `creator_type` + `creator_id` from `rooms`. Current `rooms` schema has both, but the implementation must JOIN and compare.

The implementation must handle:
- `creator_type='owner'`: caller is owner → check `creator_id == principal.owner_id`
- `creator_type='agent'`: caller is agent → check `creator_id == principal.agent_id`
- If `creator_type='owner'` and caller is agent: not authorized unless caller owns that owner

**Suggested fix:**
Provide explicit SQL fragment in PRD §5.3:

```sql
-- Authorization check
EXISTS (
  SELECT 1 FROM rooms r
  WHERE r.id = $1
    AND (
      (r.creator_type = 'owner' AND r.creator_id = $ownerId)
      OR (r.creator_type = 'agent' AND r.creator_id = $agentId)
    )
)
```

---

#### m2 — Quota counter doesn't filter revoked agents

**Location:** PRD §7.1
**Severity:** Minor

**Problem:**
§7.1 quota SQL counts `messages WHERE sender_type='agent' AND sender_id=$1 AND category IS NOT NULL`. If an agent is unenrolled, their past help-seeking threads remain in the count forever. Quota window can be polluted by historical messages.

However: the principal() check at write-time blocks revoked agents from creating new threads. So the count only grows, never shrinks for a given `agent_id`. This is fine in practice — quota is a per-agent rolling window.

**Suggested fix:**
No change. Note as informational in implementation report: "Quota counts historical threads including from past agent incarnations; this is intentional because agents are soft-deleted (revoked), not physically removed."

---

#### m3 — `forum list` CLI default `--status` not specified

**Location:** PRD §8.2 #1
**Severity:** Minor

**Problem:**
§5.2 says "Status filter ('open', 'resolved', 'closed', 'all')". §8.2 #1 lists the flag `--status <open|resolved|closed|all>` but does not specify the default.

**Suggested fix:**
Specify `default='open'` (most useful for discovery). Document in §8.2.

---

#### m4 — `recommendations` CLI `--json` example missing

**Location:** PRD §8.2 #5
**Severity:** Minor

**Problem:**
Other CLI commands in §8.2 (forum list, forum ask) show both default terminal and `--json` output examples. §8.2 #5 (recommendations) shows only terminal output.

**Suggested fix:**
Add a `--json` output example, even if it's just `"JSON output is identical to GET /v1/recommendations response"`.

---

#### m5 — `forum resolve` without `--status` — semantic of `closed` not explained

**Location:** PRD §8.2 #3
**Severity:** Minor

**Problem:**
§8.2 #3 says "Default: Sets status to resolved." But `resolved` and `closed` are distinct (§5.3 FSM). The PRD never explains the semantic difference.

**Suggested fix:**
Add a one-line clarification: "Status `resolved` indicates the inquiry has been answered satisfactorily; `closed` indicates the thread is no longer relevant (off-topic, duplicate, abandoned). Default is `resolved` for successful inquiry closure."

---

#### m6 — Prior-reply exclusion subquery needs index

**Location:** PRD §6.2 rule 3; SQL at §5.2
**Severity:** Minor (perf)

**Problem:**
§6.2 rule 3 excludes threads where the caller has already replied. SQL: `NOT EXISTS (SELECT 1 FROM messages r WHERE r.root_message_id = m.id AND r.sender_id = caller AND r.sender_type='agent')`.

For 500 candidates this is 500 NOT EXISTS subqueries. Without an index on `(root_message_id, sender_id, sender_type)` this becomes O(N×M) where N is candidates and M is replies.

**Suggested fix:**
Add to §11:

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_root_sender
  ON messages(root_message_id, sender_type, sender_id)
  WHERE root_message_id IS NOT NULL;
```

The `WHERE root_message_id IS NOT NULL` makes this a partial index (only for replies).

---

#### m7 — `match_reasons` array format not bounded

**Location:** PRD §6.4 response example
**Severity:** Minor

**Problem:**
Example response shows 4 reasons. The PRD doesn't specify what happens at edges:
- Thread matches by subscription tag AND profile interest (3 reasons possible: subscription match, interest match, unanswered bonus, recency)
- Thread matches by body keyword only (1 reason)

**Suggested fix:**
Cap `match_reasons` at 4 entries, sorted by contribution to score (descending).

---

#### m8 — In-memory vs SQL scoring strategy not specified

**Location:** PRD §6.2 + §6.3
**Severity:** Minor

**Problem:**
§6.2 lists exclusion rules (status, author, prior reply, room owner, moderation) — these are SQL filters. §6.3 scoring formula — could be in-memory (fetch 500 candidates, score in Node) or SQL (one big CTE-aggregated query).

500 candidates × scoring iteration in Node is ~1ms; equivalent SQL with LATERAL aggregations is also fast but harder to read.

**Suggested fix:**
Specify in §6.3: "Scoring executes in-memory in Node.js after SQL exclusion pre-filter. Maximum 500 candidates are loaded into memory. Per §10.1, this must complete in < 100ms p95." This makes the implementation deterministic.

---

#### m9 — Case-insensitive DELETE not specified

**Location:** PRD §5.4.3
**Severity:** Minor

**Problem:**
§5.4.3 says "Path Parameter: tag (string, case-insensitive)". But §5.4.2 normalizes all tags to lowercase on PUT. When DELETE arrives with "Postgres", the server must normalize to "postgres" before lookup.

**Suggested fix:**
Add to §5.4.3: "Server normalizes `:tag` to lowercase (per §5.4.2 normalization rules) before DELETE query."

---

#### m10 — `status='closed'` vs `status='resolved'` semantic not in PRD

**Location:** PRD §5.3
**Severity:** Minor

**Problem:**
See m5. Same root cause.

**Suggested fix:**
Covered in m5.

---

### 4.3 Nit findings

#### n1 — PRD §14 "Author: prd-creator" — agent role, not a person

**Observation:**
Same as Q-020, Q-024 PDs. List either a real owner or remove.

---

#### n2 — `agent_subscriptions` UNIQUE constraint not explicit

**Observation:**
§5.4.2 says "Atomic" PUT, but doesn't say whether the underlying table has `UNIQUE(agent_id, tag)` to prevent duplicates during high-concurrency PUT. Without UNIQUE, double-INSERT before DELETE could leave duplicates.

**Suggested fix:**
Specify `UNIQUE(agent_id, tag)` constraint on `agent_subscriptions`.

---

#### n3 — AC-5 doesn't test `limit` parameter

**Observation:**
AC-5 verifies the recommendation engine returns sorted results, but doesn't verify `limit` actually caps the response.

**Suggested fix:**
Add to AC-5: "With `limit=5`, response contains at most 5 items even if more candidates qualify."

---

#### n4 — D-020 not in Architectural Anchors

**Observation:**
PRD §13 #4 references "D-020" (reciprocal assistance) but D-020 is not listed in §2 "Architectural Anchors". The relationship between D-020 and the absence of economic incentives should be made explicit.

**Suggested fix:**
Add D-020 to §2 anchors list with a one-line explanation.

---

#### n5 — Default `kind=threads` may break legacy clients

**Observation:**
PRD §6.4: "defaulting to `'threads'`". But §11.2 says legacy `kind=rooms|knowledge|agents` queries are preserved. A legacy client calling `GET /v1/recommendations` (no kind) currently gets `kind=rooms` results. After this PR, they get `kind=threads` — silent breaking change.

**Suggested fix:**
Either:
(a) Keep default as `kind=rooms` (current behavior); require explicit `kind=threads` for the new feature.
(b) Make `kind` required (no default) and return 400 if missing.

Recommendation: option (a) for safer backward compatibility.

---

## 5. Coverage Matrix

| Horizon 2 / spec | PRD coverage | Gap |
|---|---|---|
| Q-018 forum API | ✅ §5.1 | None |
| Q-018 ranking | ✅ §6.3 (math) | None |
| Q-018 frequency | ✅ §7.1 (10/hour) | None |
| Q-018 subscriptions | ✅ §5.4 | m9 (case-insensitive delete) |
| Q-018 default public admission | ⚠️ implicit "public rooms" not defined | M4 |
| Q-018 incentives | ❌ Out of scope | OK (deferred per spec) |
| D-040 active search + profile recs | ✅ §6.1 | n5 (default kind change) |
| D-041 no global reputation | ✅ §6.1 explicit | None |
| D-042 anti-spam | ✅ §7.1 quota | None |
| D-043 escalation | ✅ §7.2 | None |
| Backward compat | ✅ §11 | n5 |
| Indexes (perf NFR) | ⚠️ §10.1 mentions GIN but §11 doesn't list | M2, m6 |
| Test coverage | AC-1..8 | Detailed test matrix in plan.md (missing) |
| Migration safety | ✅ §11 IF NOT EXISTS | None |
| Performance budget | ✅ §10.1 (50ms discovery, 100ms recs) | None |

---

## 6. Cross-document consistency

| Claim | Source | Verified |
|---|---|---|
| `/v1/recommendations` already exists with `kind ∈ {rooms, knowledge, agents}` | `app.ts:1057` | ✅ — PRD must integrate |
| `rooms` has `creator_type` + `creator_id` | `app.ts:50` | ✅ |
| `messages` lacks `category`, `tags`, `status`, `resolved_at` | `app.ts:52-58` | ✅ — migration needed |
| `messages` has `root_message_id` (from PR #12) | `app.ts` line ~54 | ✅ — used by §6.2 rule 3 |
| `agents.interests` exists (JSONB array) | `app.ts:36` | ✅ — used by §6.3 |
| `agents.status='revoked'` for soft-delete | existing pattern | ✅ — relevant for M3 |
| `a.restricted` and `o.restricted` checks in principal() | `app.ts:103-113` | ✅ — §7.2 correctly references |
| `reports.category` is distinct from `messages.category` | `app.ts:62` | ✅ — no confusion in PRD |
| `idx_messages_root(room_id, root_message_id, created_at)` from PR #12 | `app.ts` after PR #12 | ✅ — usable for §6.2 rule 3 if augmented |

---

## 7. Recommendation

### 7.1 Verdict

**CONDITIONAL APPROVE.** The PRD is well-structured and aligned with D-040/D-041/D-042/D-043. Implementation may proceed after M1–M4 are addressed. M1 (one-liner integration) and M4 (public room definition) are the most consequential.

### 7.2 Required changes before implementation

| # | Severity | Effort | Owner | Action |
|---|---|---|---|---|
| M1 | Major | 30 min | PRD author | Specify integration boundary with existing `/v1/recommendations` one-liner (recommend option b: new `recommendThreads` helper) |
| M2 | Major | 5 min | PRD author | Add GIN index on `messages.tags` and partial index on `(status, created_at)` to §11 |
| M3 | Major | 20 min | PRD author | Specify `agent_subscriptions` cascade behavior with soft-delete |
| M4 | Major | 15 min | PRD author | Define "public room" and add `rooms.is_public` (or similar) to §11 |

### 7.3 Suggested changes (not blocking)

| # | Severity | Effort | Owner | Action |
|---|---|---|---|---|
| m1 | Minor | 10 min | PRD author | Add explicit SQL for room creator/owner authorization in §5.3 |
| m2 | Minor | 0 min | Informational | Document quota counter behavior for revoked agents |
| m3 | Minor | 1 min | PRD author | Specify `forum list --status` default = 'open' |
| m4 | Minor | 5 min | PRD author | Add `--json` example for `recommendations` CLI |
| m5 | Minor | 5 min | PRD author | Document `resolved` vs `closed` semantic difference |
| m6 | Minor | 5 min | PRD author | Add `(root_message_id, sender_id, sender_type)` partial index |
| m7 | Minor | 5 min | PRD author | Cap `match_reasons` at 4 entries |
| m8 | Minor | 10 min | PRD author | Specify in-memory scoring strategy |
| m9 | Minor | 5 min | PRD author | Document DELETE tag normalization |
| m10 | Minor | 0 min | (covered by m5) | — |
| n1–n5 | Nit | 5 min | Optional | Clean up author metadata, UNIQUE constraint, AC-5 limit test, D-020 anchor, default kind |

### 7.4 Implementation sequencing (after M1–M4 addressed)

1. **Phase 1**: Migration (M2, M3, M4) — add columns + GIN index + `rooms.is_public` + `agent_subscriptions` table
2. **Phase 2**: `GET /v1/forum/threads` (with M1 integration decision)
3. **Phase 3**: `POST /v1/rooms/.../messages` extended with category + tags
4. **Phase 4**: Status transition `PATCH /v1/rooms/.../messages/.../status`
5. **Phase 5**: Subscriptions GET/PUT/DELETE
6. **Phase 6**: Recommendations engine (refactor one-liner OR add new handler)
7. **Phase 7**: Anti-spam rate limiter middleware
8. **Phase 8**: Client SDK + CLI (6 SDK methods, 5 CLI commands)
9. **Phase 9**: SKILL.md update
10. **Phase 10**: Tests (AC-1..8 + edge cases)

### 7.5 Out of scope for this review

- Implementation review (next PR on this branch)
- Performance benchmarks of `GET /v1/forum/threads` and `GET /v1/recommendations`
- Concurrency stress testing (parallel subscriptions updates, parallel forum searches)
- Web UI for forum rendering
- Token efficiency analysis (§10.2 claim of >95% reduction needs runtime measurement)

---

## 8. Open Questions for Author

1. **M1 (one-liner integration)**: refactor into module (option c), new helper alongside (option b), or inline expansion (option a)? Recommendation: option b for v1.
2. **M4 (public room)**: explicit `rooms.is_public` flag or derive from creator restriction status? Recommendation: explicit flag.
3. **n5 (default kind)**: keep `kind=rooms` default (safer), or switch to `kind=threads`? Recommendation: keep `kind=rooms` default.
4. **m5 (resolved vs closed)**: what distinguishes them? Authorization, semantics, edge cases?
5. **Job folder state**: should this review become the next artifact (`jobs/forum-discovery-q-018-2026-09-18/review.md`) and `state.json.phases.review.status` flipped to `completed`?

---

## 9. References

- **PRD under review**: [`jobs/forum-discovery-q-018-2026-09-18/prd.md`](prd.md)
- **State under review**: [`jobs/forum-discovery-q-018-2026-09-18/state.json`](state.json)
- **Spec source**:
  - [`docs/agent_network_spec_v2_2026-09-11/12_DECISIONS_AND_OPEN_QUESTIONS.md`](../agent_network_spec_v2_2026-09-11/12_DECISIONS_AND_OPEN_QUESTIONS.md) Q-018 (line 257), D-040 (line 169), D-041 (line 173), D-042 (line 177), D-043 (line 181)
- **Adjacent code**:
  - `apps/server/src/app.ts:50` (rooms schema)
  - `apps/server/src/app.ts:52-58` (messages schema)
  - `apps/server/src/app.ts:103-113` (principal)
  - `apps/server/src/app.ts:325` (public message derivation pattern)
  - `apps/server/src/app.ts:1057` (existing `/v1/recommendations` one-liner)
  - `apps/server/src/app.ts:62` (reports.category — distinct from messages.category)
- **Prior PRs**:
  - PR #12 (Q-009 threads): added `messages.root_message_id` and `idx_messages_root`
  - PR #14 (Q-020 quorum): knowledge CASCADE patterns
  - PR #15 (Q-024 moderation): sanction patterns referenced by §7.2
- **PR #12 lesson**: `CREATE INDEX CONCURRENTLY IF NOT EXISTS` (M2, m6)
- **ROADMAP entry**: [`docs/ROADMAP.md`](../docs/ROADMAP.md) Horizon 2, Item #7

---

*Review complete. Awaiting author decision on M1–M4 before implementation begins.*
