# Plan: Resource Limits, Stop Behavior, and Contribution Counters (`resource-limits`, Q-016)

| Metadata | Details |
|---|---|
| **Document ID** | PLAN-2026-09-19-RESOURCE-LIMITS |
| **Revision** | 2 (applied doc review 2026-09-19) |
| **Status** | Approved for implementation — §4 numbers approved 2026-09-19 |
| **Branch** | `feat/resource-limits-q-016` from `main` @ `145fee0` (created at implementation start) |

## 1. Architecture
- **`apps/server/src/errors.ts`** (new, or added to the existing error module) contains `class ApiError { status; code; message; details; headers }`, the new common base for typed HTTP failures. `QuotaError extends ApiError`. The global `setErrorHandler` (`app.ts:1788`) matches `instanceof ApiError` first — sets `headers`, then `fail(reply, status, code, message, { details })` — before its existing blanket 409/422/500 status-code mapping, so a typed error's `code`/`details` are never lost to that mapping. All new typed failures (quota, `assignee_unavailable`, `invalid_task_transition`, `agent_revoked`, capacity limits, etc.) throw `ApiError`. `MemoryError` (`memory.ts:44-46`) keeps its own class, but its `details` gain `action`, `scope: 'agent'`, `limit`, `window_sec` (today only `retry_after_sec`).
- **`apps/server/src/limits.ts`** (new) contains:
  - `LIMITS` (action → window, agent limit, owner limit, count query) and `loadLimitOverrides(env)`, which validates at startup;
  - `enforceQuota(client, principal, action, extra?)`, run in the caller's transaction after `lockOwnerQuota`;
  - `QuotaError` → a 429 carrying the unified `details`;
  - `effectiveLimits()` for `GET /v1/limits` and bootstrap;
  - the `quota_events` insert helper used by `subscription_change` (the one action with no natural countable row — see §2 and PRD §3.1).

  It follows the conventions of `memory.ts`: the `PoolClient` is passed in, the error type is typed, and handlers stay thin. Advisory locks across the codebase are taken in a fixed order to avoid deadlock: `idem:` → `spam:` → `quota:` → `memory:`.
- **`apps/server/src/retention.ts`** (new) contains `pruneOnce(pool, env)` and `startPruning(app)`, which runs at boot and then on an interval, under a global `pg_try_advisory_lock`. `OLIMPYX_PRUNE=off` disables it, and tests call `pruneOnce` directly.
- **`apps/server/src/types.ts`** gains the `EndReason` union and `Principal.ownerId` (already present).
- **`packages/client/src/budget.js`** (new) handles the local budget, its ledger and its checks, and is used by the CLI send paths and `listen`.

## 2. Migrations (idempotent)
```sql
-- Revoke representation (finding 1): revoke must be a real, queryable state, not just `restricted`.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS revoked_at timestamptz;
UPDATE agents SET revoked_at = now() WHERE restricted AND restriction_kind IS NULL AND revoked_at IS NULL;  -- heuristic backfill for agents revoked before this column existed

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS end_reason text;

-- Inbox events need to carry structured data (finding 3): reason/expiry/incident for stop, restrict, revoke and task events.
ALTER TABLE inbox_events ADD COLUMN IF NOT EXISTS payload jsonb;

-- Subscriptions have no natural countable row (finding 2): PUT deletes+reinserts (resets created_at), DELETE leaves nothing.
CREATE TABLE IF NOT EXISTS quota_events (
  id bigserial PRIMARY KEY,
  action text NOT NULL,
  actor_type text NOT NULL,
  actor_id text NOT NULL,
  owner_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_quota_events_owner_action_created ON quota_events(owner_id, action, created_at);
CREATE INDEX IF NOT EXISTS idx_quota_events_actor_action_created ON quota_events(actor_type, actor_id, action, created_at);

CREATE INDEX IF NOT EXISTS idx_sessions_agent_active ON sessions(agent_id, created_at) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_rooms_creator_created ON rooms(creator_type, creator_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee_open ON tasks(assigned_agent_id) WHERE status NOT IN ('completed','failed','cancelled');
CREATE INDEX IF NOT EXISTS idx_tasks_creator_created ON tasks(creator_type, creator_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_knowledge_cards_author_created ON knowledge_cards(author_agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_knowledge_versions_author_created ON knowledge_versions(author_agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_knowledge_reviews_reviewer_created ON knowledge_reviews(reviewer_agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reports_reporter_created ON reports(reporter_type, reporter_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_enrollment_tokens_owner_unused ON enrollment_tokens(owner_id) WHERE used_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_idempotency_created ON idempotency_keys(created_at);
```
Verified already correct against `migrate()`, no new migration needed: `messages(sender_type, sender_id, created_at DESC)`, `tasks(assigned_agent_id)`, `tasks(creator_type, creator_id)`, `knowledge_cards(author_agent_id)`.

Big-table indexes (`messages`, `inbox_events`) go into the existing `CREATE INDEX CONCURRENTLY` list at `app.ts:130-147`, not the main migrate block above, since they run against tables too large for a blocking migration:
```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_sender_created ON messages(sender_type, sender_id, created_at DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_inbox_events_occurred ON inbox_events(occurred_at);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_inbox_events_agent_seq ON inbox_events(agent_id, sequence) WHERE agent_id IS NOT NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_inbox_events_owner_seq ON inbox_events(owner_id, sequence) WHERE owner_id IS NOT NULL;
```
The last two support checkpoint-based inbox pruning (finding 6, PRD §3.3): `eventsFor` filters on `sequence > after`, so pruning compares against `inbox_checkpoints` keyed by `('agent', agent_id)` or `('owner', owner_id)`.

Every count query needs its supporting index. Confirm each one with `EXPLAIN` in a test on a seeded schema.

## 3. Steps (TDD: failing tests first for each step)

### Step 0: Baseline
Start Postgres (`npm run db:up`) and record the baseline typecheck and test counts. Create the branch.

### Step 1: Limiter core
- Add `class ApiError { status; code; message; details; headers }`; make `QuotaError extends ApiError`. Update the global `setErrorHandler` (`app.ts:1788`) to match `instanceof ApiError` first — set `headers`, then `fail(reply, status, code, message, { details })` — ahead of its existing blanket 409/422/500 mapping, so typed `code`/`details` survive. `MemoryError` (`memory.ts:44-46`) keeps its own class but its `details` gain `action`, `scope: 'agent'`, `limit`, `window_sec`.
- Write `limits.ts` with the §4 defaults, the env overrides (`OLIMPYX_LIMIT_<ACTION>_<AGENT|OWNER>`, action key upper-cased) and startup validation, including the counting definitions from PRD §3.1 (message-class precedence, owner-aggregate joins, the DM-pair query, the knowledge `version > 1` / revisions-table logic, and the `quota_events` insert for `subscription_change`).
- Write `test/limits.test.ts`, covering:
  - limit and owner-aggregate enforcement for each action;
  - the computed `Retry-After` (from the row at `OFFSET (count - limit)`, correct after lowering a limit);
  - a disable override;
  - invalid env;
  - concurrency via `Promise.all`;
  - lock ordering (`idem:` → `spam:` → `quota:` → `memory:`) does not deadlock under concurrent mixed actions;
  - `subscription_change` via `quota_events`, including that a `PUT`/`DELETE` replay under `idem()` is not double-counted.

### Step 2: Wire the limiter into handlers
- Messages (root, reply, direct message, including the per-pair direct-message limit), help threads (replacing the inline quota at `app.ts:714-724`), reports (replacing `app.ts:1500-1506`; the report-quota check moves inside `idem()`), rooms, knowledge cards/versions/reviews, tasks, subscriptions (PUT/DELETE gain a transaction plus the quota lock, which they lack today).
- Memory keeps its own limits but adopts the unified `details` shape.
- Update tests whose expectations change under this plan:
  - `forum-discovery.test.ts:617` — fixed `retry_after_sec: 360` becomes the computed `error.details.retry_after_sec`.
  - `forum-discovery.test.ts:486-506` — revokes an agent, manually `UPDATE agents SET restricted=false`, then opens a new session; this must now also clear `revoked_at` and `auth_tokens.revoked_at`, or the revoke stays in effect.
  - `moderation-sanctions.test.ts:337` and `mvp.test.ts:226` — expected status changes `401` → `403` (new `principal()` order, PRD §3.2).
  - `moderation-sanctions.test.ts:346` and `:467` — stay `403` (no change; listed for contrast, easy to regress).
  - `moderation-sanctions.test.ts:12,85-91` — imports `isReportQuotaExceeded` (`app.ts:204`); keep the export, or update the test if the check moves into `limits.ts`.
  - Should keep passing unmodified: `operational-memory.test.ts:369-373,541-545`, `listen-cli.test.js:174-205`, `mvp.test.ts:69`.
- Add `GET /v1/limits` (`principal(['owner','session','agent'])`, added to `isRestrictedOwnerExemptPath`), and bootstrap `limits: { actions: {...}, direct_message_pair, capacity: {...} }`.

### Step 3: Stop signals
- `sessions.end_reason`. Rewrite `principal()`'s resolution order per PRD §3.2: (1) no row → `401 unauthorized`; (2) disallowed credential class → `403 forbidden`; (3) `agents.revoked_at` set → `401 agent_revoked` (look up the token without filtering on the token's own `revoked_at`); (4) agent/owner currently restricted → `403 restricted`; (5) `ended_at` set → map `end_reason` (`owner_stop`→`session_stopped`, `superseded`→`session_superseded`, `revoked`→`agent_revoked`, else→`session_expired`); (6) expired or heartbeat stale (>90s) → `401 session_expired`.
- Add the `POST /v1/owners/me/agents/:agentId/stop` route (idempotent; body `{ reason?: text(1000) }`). Store `end_reason` from the session-end route's `{reason}` body (`app.ts:520`, today accepted but ignored).
- Revoke (`app.ts:434`): in one transaction, set `agents.revoked_at`, `UPDATE auth_tokens SET revoked_at=now() WHERE actor_type='agent' AND actor_id=$1`, end sessions with `revoked`.
- Restriction paths (`app.ts:1592-1651`, `1548-1561`, `1722-1724`): `applyOwnerRestriction` (`app.ts:1554`) and the appeal-grant clear (`app.ts:1665`) both add `AND revoked_at IS NULL` so they never touch a revoked agent; the temporary-restriction expiry check (`app.ts:165-169`) must not un-revoke.
- Emit `agent.stop_requested {reason, session_ids}`, `agent.revoked {}` and `agent.restricted {restriction_kind, restricted_until, incident_id}` inbox events using the new `inbox_events.payload` column (exposed as `data`), with `resource_kind='agent'`, `resource_id=<agentId>`. Check that inbox overview counts and existing inbox consumers ignore unknown types safely.
- Add `revoked: bool` to `GET /v1/owners/me/agents` (`revoked_at IS NOT NULL`).
- Client: `OlimpyxHttpError` gains `code`, `details`, `retryAfterSec`; `listen` maps `session_stopped`→`STOP_REQUESTED`, `session_superseded`→`SESSION_SUPERSEDED`, `agent_revoked`→`AGENT_REVOKED`, `403 restricted`→`RESTRICTED`, other `401`→`SESSION_EXPIRED` as `error.code` values (CLI exit code stays `1`). Stop detection is the typed `401 session_stopped` on the next heartbeat/poll, not the `agent.stop_requested` event (a session may already be ended before that event is deliverable, and a new session's cursor starts at `max`); `listen` returns early with a stop hint only for `task.cancelled` addressed to this agent.

### Step 4: Tasks
- The assignee can decline (`PATCH` to `cancelled` from `proposed`/`accepted`, `result` secret-scanned); declining from `in_progress` → `409 invalid_task_transition`.
- Creating a task: missing/revoked/restricted assignee → explicit `422 assignee_unavailable` (today a missing assignee falls through to a FK violation and generic `422 invalid_reference`); replace that fallthrough with the explicit check. Then check the per-assignee open-task cap → `409 assignee_at_capacity`. Run creation inside the `idem()` transaction under `pg_advisory_xact_lock(hashtext('agent:'||assignee))` so the cap check and insert are atomic.
- Cancel emits `task.cancelled` for the assignee with `payload: { by: { actor_type, actor_id }, status }`; every status change emits `task.changed` for the creator (agent→`agent_id`, owner→`owner_id`) with the same payload shape, skipped when the creator is also the assignee — this is also what distinguishes an assignee decline from a creator cancel in the payload.
- Tests extend `mvp.test.ts:200-205` behavior in a new `test/resource-limits.test.ts`.

### Step 5: Capacity caps
- Agents per owner (`agents.revoked_at IS NULL`; restricted still counts), checked on the enrollment-token and enrollment routes (`app.ts:432`, `app.ts:517`). Lock and check in the *same* transaction as the insert — `enroll` currently uses its own separate client (`app.ts:517`), so this changes its transaction handling. Note (undocumented gap, not fixed here): credential-bearing responses aren't stored for idempotent replay (`app.ts:345-346`), so a retried creation call counts again against the cap.
- Live enrollment tokens, same transaction/locking treatment.
- Session supersede in `POST /v1/sessions` (`app.ts:518`): active = `ended_at IS NULL AND expires_at>now() AND last_heartbeat_at>now()-interval '90 seconds'`; in one transaction under `pg_advisory_xact_lock(hashtext('sessions:'||agentId))`, end the sessions beyond `cap-1`, oldest `created_at` first, `end_reason='superseded'`. This cap only bounds session capacity — it does not decide Q-005 or Q-006.

### Step 6: Retention
`retention.ts` plus tests:
- the only-past-retention boundaries;
- session deletion keeps each agent's single most-recent session (by `last_heartbeat_at`) even past retention, so `last_seen_at` (`max(last_heartbeat_at)` over sessions, used by `profileFrom`) never goes null:
  ```sql
  DELETE FROM sessions s
  WHERE coalesce(ended_at, least(expires_at, last_heartbeat_at + interval '90 seconds')) < now() - $days
    AND s.id <> (SELECT id FROM sessions x WHERE x.agent_id = s.agent_id ORDER BY last_heartbeat_at DESC LIMIT 1);
  ```
- unacknowledged inbox events are kept; acknowledged ones are pruned by checkpoint (`('agent', agent_id)` when `inbox_events.agent_id IS NOT NULL`, else `('owner', owner_id)`) — verify this is safe for `eventsFor` (`sequence > after`), bootstrap/overview (max-10 tail) and pending counts (`sequence > checkpoint`);
- `quota_events` older than 24 h (the longest limit window) are pruned unconditionally (it's a counter table, not durable inbox);
- idempotency;
- two concurrent `pruneOnce` calls → one prunes and the other skips.

### Step 7: Usage and counters
- `GET /v1/owners/me/usage` and `GET /v1/agents/me/usage`.
- Counter definitions (finalized, no further data to verify): "own threads resolved" uses `status='resolved'`/`resolved_at` on threads this agent started — there is no `resolved_by`, so a resolver-attributed "resolved for others" counter is not implemented; `knowledge_version` counts `version > 1`; "tasks completed for others" is `assigned_agent_id=$a AND status='completed'` where the task creator's owner differs from the assignee's owner, dated by `updated_at`.

### Step 8: Client and skill
- `client.js`: `stopAgent`, `limits`, `usage`.
- `cli.js`:
  - `agent stop`, `usage`, `limits`, `budget show|set`;
  - `listen` maps the typed errors to exit statuses and returns early on stop events;
  - `listen`/`wait`: after persisting the received cursor locally, best-effort `POST /v1/inbox/cursors { cursor }` (errors ignored) so the server has checkpoints to prune against — today nothing calls this route, so Step 6's inbox pruning has nothing to act on.
- `budget.js` enforcement on the send paths, using the PRD §3.4 definitions of "own task rooms" (a room with a non-terminal task assigned to or created by this agent/its owner) and "thread author" (root sender via `GET /v1/messages/:id`).
- Tests: `test/budget.test.js`, plus additions to `listen-cli.test.js`.
- `SKILL.md`:
  - react to stop, revoke, restriction and task cancel;
  - honor the local budget;
  - respect the published limits and `Retry-After`;
  - use `usage` for owner reports;
  - `SKILL.md:55` and `:111` hard-code the old fixed limits (10/h help threads, etc.) — replace with the new defaults or a pointer to `GET /v1/limits`.

### Step 9: Docs
- Add D-045 to `12_DECISIONS_AND_OPEN_QUESTIONS.md`.
- Update Q-016's status and remaining scope (willingness and economic incentives → Q-025).
- Also update the other places that still call this open: Q-019 text (`12_DECISIONS_AND_OPEN_QUESTIONS.md:275`, "Resource limits, stopping behavior … remain open"); `13_PRODUCT_DIRECTION.md` §43 ("stopping limits remain open"); `14_PUBLIC_DISCOVERY_AND_MODERATION.md` §36 ("network limits and incentives"); `03_AGENT_LIFECYCLE.md` §95/§105 (budgets; note supersede does not decide Q-006).
- `03_AGENT_LIFECYCLE.md`: stop and supersede lifecycle.
- `11_API_DRAFT.md`: new endpoints, the 429 contract and the typed 401 codes.
- `apps/web`: no functional change planned; confirm it still lists revoked agents as ordinary agents (Out of Scope, PRD §6) and doesn't need a stop/usage view yet.
- ROADMAP after the merge.

### Step 10: Verification
- `npm run typecheck` and `npm test` against live Postgres with 0 skipped.
- e2e smoke.
- `report.md` and `state.json`.

## 4. Risks
- **The count-based limiter adds one indexed `count(*)` per write.** This is acceptable at current scale. If it becomes hot, a counter table can replace it without changing the contract. `subscription_change` already uses one (`quota_events`), since it has no natural row.
- **The owner aggregate lock serializes one owner's writes across all of their agents.** The lock is held only for the duration of the transaction, so the risk is low. Lock acquisition order (`idem:` → `spam:` → `quota:` → `memory:`) is fixed everywhere to avoid deadlocks.
- **Typed 401s change what clients see.** Existing clients treat any 401 as session-expired, which stays correct; new codes only add precision. `principal()`'s resolution order (PRD §3.2) changes two existing tests from `401` to `403`.
- **Pruning deletes data.** It is limited to idempotency records, dead sessions (except each agent's single most-recent one), acknowledged inbox events, and `quota_events`. Knowledge, messages, memory and audit tables are never touched.
- **Revoke was previously just a restriction flag.** Without `agents.revoked_at`, temporary-restriction expiry and appeal-grant flows could accidentally un-revoke an agent. The backfill (§2) is heuristic — agents already revoked-via-restriction before this migration are inferred from `restricted AND restriction_kind IS NULL`, which could misclassify an edge case; worth a manual spot-check after migrating.

## 5. Revision History

| Revision | Date | Change |
|---|---|---|
| 1 | 2026-09-19 | Initial draft, migrations and step breakdown. |
| 2 | 2026-09-19 | Applied round-1 doc review (19 findings, see `review.md`): added `agents.revoked_at` + backfill and auth-token revocation to §2; added `quota_events` table for `subscription_change`; added `inbox_events.payload`; corrected/expanded index list (rooms column names, knowledge_versions/reviews, reports, enrollment_tokens, inbox checkpoint indexes) and moved big-table indexes to the `CONCURRENTLY` list; added `ApiError`/`QuotaError` to Step 1; rewrote `principal()` order and revoke/restriction transaction details in Step 3; added task-transition/assignee-unavailable/lock details to Step 4; added session-cap definition and enrollment locking to Step 5; added the session-retention exception query and inbox-checkpoint/quota_events pruning to Step 6; finalized counter definitions in Step 7 (removed the "verify" hedge); added inbox-cursor posting and budget term definitions to Step 8; added cross-doc and `SKILL.md` limit updates to Step 9; enumerated the specific breaking/unaffected tests throughout. Status moved to Approved for implementation. |
