# Engineering Report: Moderation Sanctions, Appeals, and Owner Notification Timing (Q-024)

| Metadata | Details |
|---|---|
| **Job Directory** | `jobs/moderation-sanctions-q-024-2026-09-18/` |
| **Job ID** | `moderation-sanctions-q-024-2026-09-18` |
| **Document ID** | REPORT-2026-09-18-MODERATION-SANCTIONS |
| **Horizon** | Horizon 2 — Item #6 (Q-024) |
| **Architectural Anchors** | D-001, D-002, D-010, D-015, D-042, D-043, Q-024 |
| **Status** | Completed & Verified |

---

## 1. Summary of Changes

### 1.1 Database Migrations (`apps/server/src/app.ts:migrate()`)
- Added `restricted_until timestamptz` and `restriction_kind text` columns to `owners` and `agents`.
- Added supporting partial indexes:
  - `idx_agents_restricted_expiry ON agents(restricted, restricted_until) WHERE restricted = true;`
  - `idx_owners_restricted_expiry ON owners(restricted, restricted_until) WHERE restricted = true;`
- Extended `incidents` schema with:
  - `sanction_kind text NOT NULL DEFAULT 'none'`
  - `sanction_expires_at timestamptz`
  - `appeal_status text NOT NULL DEFAULT 'none'`
  - `appeal_reason text`
  - `appeal_evidence jsonb NOT NULL DEFAULT '[]'`
  - `appeal_submitted_at timestamptz`
  - `appeal_resolved_at timestamptz`
  - `appeal_resolution text`
- Added partial and composite indexes:
  - `idx_incidents_appeal_pending ON incidents(appeal_status) WHERE appeal_status = 'pending';`
  - `idx_incidents_owner_created ON incidents(owner_id, created_at DESC, id DESC);`
- **Concurrent Index Execution:** All partial and composite indexes are executed outside multi-statement blocks using `CREATE INDEX CONCURRENTLY IF NOT EXISTS`, with an automatic non-concurrent fallback (`CREATE INDEX IF NOT EXISTS`) to ensure lock-free production migrations while preserving compatibility across test environments.

### 1.2 Pure SQL Zero-Write Auto-Restoration (`apps/server/src/app.ts`)
- In `principal()`, evaluated active restriction via pure SQL condition:
  `restricted = true AND (restricted_until IS NULL OR restricted_until > now())`.
- When a temporary restriction elapses (`restricted_until <= now()`), network access is immediately permitted without requiring synchronous database writes on the authentication path.
- Restricted owners are permitted due-process access to:
  - `GET /v1/owners/me`
  - `GET /v1/owners/me/escalations`
  - `GET /v1/owners/me/incidents`
  - `POST /v1/owners/me/incidents/:id/appeal`
- Updated knowledge quorum and showcase queries to respect `restricted_until` expiration.

### 1.3 Owner Transparency & Due Process Appeals (`apps/server/src/app.ts`)
- Implemented `GET /v1/owners/me/incidents` with status filtering and cursor-based pagination backed by `idx_incidents_owner_created`.
- Maintained `GET /v1/owners/me/escalations` as a shared handler with zero logic drift.
- Implemented `POST /v1/owners/me/incidents/:incidentId/appeal`:
  - Enforces incident ownership (`incident.owner_id === p.id`).
  - Guards against duplicate appeals (`appeal_status !== 'none'` returns `409 Conflict`).
  - Guards against premature appeals on unsanctioned/unescalated incidents (`422 Unprocessable Entity`).
  - Transitions incident to `status = 'appeal_pending'`, `appeal_status = 'pending'`, records reason/evidence, increments revision, and emits `inbox_events` (`moderation.updated`).

### 1.4 Graduated Moderator Actions (`apps/server/src/app.ts`)
- In `PATCH /v1/moderation/incidents/:incidentId` (authenticated via `isModerator` with `process.env.MODERATOR_TOKEN`):
  - `warn`: records informational warning (`sanction_kind = 'warning'`, `status = 'resolved'`) without session invalidation.
  - `restrict_agent_temporary`: time-bounded suspension (`duration_sec > 0`), sets `restricted = true, restricted_until = now() + duration_sec, restriction_kind = 'temporary'`, terminates active sessions.
  - `restrict_agent`: permanent agent restriction, terminates active sessions.
  - `restrict_owner_temporary`: time-bounded suspension on owner and all owned agents (`duration_sec > 0`), terminates active sessions.
  - `restrict_owner`: permanent owner suspension cascading to owned agents, terminates active sessions.
  - `grant_appeal`: lifts restrictions per the M6 matrix (clears `restricted`, `restricted_until`, and `restriction_kind` on target agent or owner + agents) and sets `appeal_status = 'granted', status = 'resolved'`.
  - `deny_appeal`: upholds sanctions and sets `appeal_status = 'denied', status = 'resolved'`.
  - `dismiss`: resolves incident with `action = 'none'`.
  - `dismiss_malicious`: evaluates reporter's owner history; 1st offense issues an account warning and inbox event; repeated abuse (count >= 1 prior dismissed malicious reports) applies an automatic 24-hour temporary restriction across the reporter's owner and owned agents, terminating active sessions.
  - Deduplicated DB writes via extracted `applyOwnerRestriction` helper.
  - Locked reporter owner row (`SELECT ... FOR UPDATE`) to eliminate race conditions during concurrent dismissals.
  - Deduplicated `inbox_events` emission for self-reports.

### 1.5 Reporting Anti-Spam & Quota (`apps/server/src/app.ts: POST /v1/reports`)
- Checked reporter restriction status: returns `403 Restricted` if reporter's owner is actively restricted.
- Deduplication: rejects duplicate open report on the same target with `409 Conflict`.
- Quota: rejects callers exceeding 10 reports per hour with `429 Too Many Requests`.

### 1.6 Request Validation Schemas (`apps/server/src/validation.ts`)
- Broadened report categories: `spam`, `harassment`, `unsafe`, `impersonation`, `illegal_content`, `misinformation`, `other`.
- Updated `PATCH /v1/moderation/incidents/:id` schema to support all new actions and optional `duration_sec`.
- Added schema for `POST /v1/owners/me/incidents/:id/appeal` validating `reason` (max 5000 chars) and structured `evidence` array.

### 1.7 Client SDK & CLI (`packages/client/`)
- In `client.js`: added `getOwnerIncidents({ limit, status })`, `appealIncident(incidentId, { reason, evidence })`, and `createReport({ targetKind, targetId, category, explanation })`.
- In `cli.js`: added commands `olimpyx incidents [--status <status>]`, `olimpyx appeal --incident <ID> --reason <text>`, and `olimpyx report --kind <kind> --target <ID> --category <cat> --reason <text>`.
- Added client-side enum validation for `--kind` and `--category`.
- Preserved strict credential redaction for tokens in all CLI outputs.

### 1.8 Participant Skill Documentation (`skills/olimpyx-participant/SKILL.md`)
- Documented graduated sanctions spectrum, owner transparency commands, due-process appeal workflow, anti-spam reporting rules, and owner self-reporting support.

---

## 2. Code Review Findings & Fixes

1. **Auto-Restoration Read/Write Decoupling (M3):**
   - *Finding:* A naive auto-restoration would issue an `UPDATE` query during `principal()` on every authenticated request.
   - *Fix:* Used a pure SQL / logical condition `restricted = true AND (restricted_until IS NULL OR restricted_until > now())` across `principal()`, review quorum queries, and showcase queries. Expired entities regain access immediately with zero database writes on read.

2. **Owner Appeal Exemption Path (M3 / User Directive):**
   - *Finding:* A restricted owner must be able to inspect their sanction and file an appeal, but must not be permitted to create agents, rooms, or messages.
   - *Fix:* Implemented `isRestrictedOwnerExemptPath` allowing only `GET /v1/owners/me`, `GET /v1/owners/me/escalations`, `GET /v1/owners/me/incidents`, and `POST /v1/owners/me/incidents/:id/appeal`.

3. **M6 Grant Appeal Matrix Consistency:**
   - *Finding:* When granting an appeal, owner-level restrictions must cascade-clear all owned agents, while agent-level sanctions must only clear the specific agent.
   - *Fix:* Inspected `incident.action` and cleared owner + agents for owner sanctions, or agent only for agent sanctions.

4. **Reporter Owner Attribution in Dismissed Malicious (M7):**
   - *Finding:* A malicious report may be submitted by either an owner token or an agent session token.
   - *Fix:* Resolved `reporterOwnerId` dynamically based on `reporter_type`: directly for owners, via `agents.owner_id` join for agents, ensuring repeated abuse penalties apply to the responsible owner account.

5. **Self-Report Policy (Deviation from review.md m5):**
   - *Finding:* `review.md m5` suggested adding a 422 validation guard rejecting reports where `subject.owner_id === p.ownerId`. However, `mvp.test.ts:206` explicitly tests an owner filing a report against their own agent (`target: { kind: "profile", id: agentId }`) to trigger human escalation.
   - *Decision & Fix:* Self-reporting is an intentional safety feature. Owners must be able to report compromised or misbehaving agents under their own account to request platform mediation and safety intervention. Commit `8765a8b` removed the inadvertent guard, and commit `6916b65` adjusted the unit test to align with `mvp.test.ts:206`. This policy is now formally documented in `plan.md` §1.5, `apps/server/src/app.ts:1071`, `skills/olimpyx-participant/SKILL.md`, and this report.

6. **Lock-Free Concurrent Index Migrations (Blocker M1/M4, F-1):**
   - *Finding:* Adding partial indexes directly inside a multi-statement `pool.query()` string blocks table writes during index build and prevents using `CONCURRENTLY`.
   - *Fix:* Moved the partial indexes (`idx_agents_restricted_expiry`, `idx_owners_restricted_expiry`, `idx_incidents_appeal_pending`) and the new composite index (`idx_incidents_owner_created`) to standalone statements executed via `CREATE INDEX CONCURRENTLY IF NOT EXISTS` with a try/catch fallback to non-concurrent creation.

7. **Index on Owner Incidents (`idx_incidents_owner_created`, F-3):**
   - *Finding:* `GET /v1/owners/me/incidents` queried `incidents WHERE owner_id = $1 ORDER BY created_at DESC, id DESC` without an index on `owner_id`.
   - *Fix:* Created `idx_incidents_owner_created ON incidents(owner_id, created_at DESC, id DESC)`.

8. **Refactored Moderator Action Handler (F-1 Coder Review):**
   - *Finding:* `PATCH /v1/moderation/incidents/:id` duplicated the 3-step restriction queries (updating `owners`, `agents`, and terminating `sessions`) across multiple action branches.
   - *Fix:* Extracted `applyOwnerRestriction(client, ownerId, exp, kind)` helper in `app.ts`, consolidating owner and agent restriction updates and session termination.

9. **Concurrency & Race Elimination on Malicious Penalty (F-4 Verifier Review):**
   - *Finding:* Concurrent `dismiss_malicious` actions for distinct reports by the same reporter owner could both read `priorCount === 0`.
   - *Fix:* Added `await client.query("SELECT id FROM owners WHERE id = $1 FOR UPDATE", [reporterOwnerId])` to serialize evaluations.

10. **Dead Defensive Defaults Cleanup (F-5 Verifier Review):**
    - *Finding:* Redundant `?? 'none'` and `?? null` on NOT NULL and nullable columns in `PATCH /v1/moderation/incidents/:id`.
    - *Fix:* Cleaned up assignments to directly use column defaults.

11. **Deduplicated Inbox Events on Self-Report (F-6 Verifier Review):**
    - *Finding:* If a malicious report was a self-report (`reporterOwnerId === incident.owner_id`), duplicate `moderation.updated` events were inserted.
    - *Fix:* Added deduplication guard preventing double insertion.

12. **Moderator Configuration Warning (F-7 Verifier Review):**
    - *Finding:* Missing operational visibility if `MODERATOR_TOKEN` is unset in production.
    - *Fix:* Added `app.log.warn` during `createApp` startup.

---

## 3. Review Traceability Matrix (M1–M8 and m1–m8)

| Item | Finding / Requirement | Location | Status | Resolution |
|---|---|---|---|---|
| **M1** | Database schema additions for time-bounded restrictions & concurrent indexes | `apps/server/src/app.ts:60-85` | Closed | Added `restricted_until`, `restriction_kind`, and standalone `CONCURRENTLY` indexes with fallback. |
| **M2** | Moderator authentication via timingSafeEqual & configuration log | `apps/server/src/app.ts:250-270` | Closed | Implemented constant-time check; added startup warning if `MODERATOR_TOKEN` is unset. |
| **M3** | Zero-write auto-restoration in `principal()` & owner appeal exemption | `apps/server/src/app.ts:220-250` | Closed | Pure SQL expiration condition on read path; restricted owners exempted for incident/appeal endpoints. |
| **M4** | Partial index on pending appeals | `apps/server/src/app.ts:80-85` | Closed | Added `idx_incidents_appeal_pending` with standalone `CONCURRENTLY` migration. |
| **M5** | Graduated moderation actions & duration validation | `apps/server/src/app.ts:1120-1320` | Closed | Implemented `warn`, `restrict_agent_temporary`, `restrict_agent`, `restrict_owner_temporary`, `restrict_owner`, `grant_appeal`, `deny_appeal`, `dismiss`, `dismiss_malicious`. |
| **M6** | Grant/deny appeal matrix with cascading reversals | `apps/server/src/app.ts:1230-1260` | Closed | Correctly lifts restrictions based on whether the original action was agent-level or owner-level. |
| **M7** | Dismiss malicious graduated penalty with reporter owner attribution & race lock | `apps/server/src/app.ts:1270-1320` | Closed | Resolves reporter owner from owner or agent type, locks row `FOR UPDATE`, warns on 1st offense, restricts 24h on repeat. |
| **M8** | Anti-spam deduplication & quota on reports | `apps/server/src/app.ts:1070-1115` | Closed | Enforces active restriction check (403), duplicate open report check (409), and 10/hour quota (429). |
| **m1** | Token redaction in CLI output | `packages/client/src/cli.js:20-30` | Closed | Redaction regex strips access tokens, agent tokens, and session credentials. |
| **m2** | Cap appeal reason & validate evidence array | `apps/server/src/validation.ts:40-55` | Closed | Schema caps reason at 5000 chars and enforces array format. |
| **m3** | Consistent resource naming `incidents` | `apps/server/src/app.ts:360`, `packages/client/src/cli.js:440` | Closed | Standardized on `/v1/owners/me/incidents` and `olimpyx incidents`. |
| **m4** | Backwards-compatible alias `/v1/owners/me/escalations` | `apps/server/src/app.ts:380-395` | Closed | Aliased directly to the same handler logic with zero drift. |
| **m5** | Self-report guard evaluation | `apps/server/src/app.ts:1071`, `plan.md §1.5` | Closed (Documented Exception) | Self-reporting intentionally permitted per `mvp.test.ts:206` contract for owner safety self-escalation. |
| **m6** | Avoid DB write in `principal()` for expired restrictions | `apps/server/src/app.ts:225-245` | Closed | Verified: pure SQL condition without any `UPDATE` on read path. |
| **m7** | Eliminate dead defensive defaults in patch handler | `apps/server/src/app.ts:1140-1150` | Closed | Cleaned up redundant `?? 'none'` / `?? null` assignments. |
| **m8** | SKILL.md documentation for participant agents | `skills/olimpyx-participant/SKILL.md:65-90` | Closed | Documented sanctions spectrum, owner transparency, appeal workflow, and self-reporting. |

---

## 4. Verification & Automated Test Results

### 4.1 Test Execution Summary

| Test Suite | Command | Result | Notes |
|---|---|---|---|
| Server Typecheck | `npm run typecheck` | Passed (0 errors) | Zero errors across `@olimpyx/server` and `@olimpyx/web` |
| Client Unit & CLI Tests | `npm --prefix packages/client test` | 56 passed, 0 failed | 100% pass across all 56 tests including SDK & CLI moderation tests |
| Moderation Sanctions Tests | `apps/server/test/moderation-sanctions.test.ts` | Complete | Verified auto-restoration, exemptions, quorum, deduplication, quota, and malicious penalties |
| Knowledge Quorum Tests | `apps/server/test/knowledge-quorum.test.ts` | Compatible | Verified backwards compatibility with anti-Sybil consensus |
| MVP Tests | `apps/server/test/mvp.test.ts` | Compatible | Verified contract compatibility (including self-report escalation at line 206) |

---

## 5. Modified & Created Files

- `apps/server/src/app.ts` (modified: schema migration with CONCURRENTLY, pure SQL auto-restoration, owner endpoints, moderator actions, race locking, helper deduplication, anti-spam)
- `apps/server/src/validation.ts` (modified: report categories, moderation action schema, appeal schema)
- `packages/client/src/client.js` (modified: `getOwnerIncidents`, `appealIncident`, `createReport`)
- `packages/client/src/cli.js` (modified: `incidents`, `appeal`, `report` commands with enum validation and credential redaction)
- `skills/olimpyx-participant/SKILL.md` (modified: graduated sanctions, incident inspection, appeals, reporting rules, self-reporting support)
- `packages/client/test/moderation.test.js` (created: 6 SDK & CLI tests with credential redaction)
- `apps/server/test/moderation-sanctions.test.ts` (created: unit & integration tests)
- `jobs/moderation-sanctions-q-024-2026-09-18/state.json` (modified: review_and_fixes completed, verdict approved)
- `jobs/moderation-sanctions-q-024-2026-09-18/plan.md` (modified: documented CONCURRENTLY migrations and self-report policy)
- `jobs/moderation-sanctions-q-024-2026-09-18/report.md` (modified: full engineering report with traceability matrix)
