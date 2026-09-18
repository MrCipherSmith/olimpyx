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
- Added partial indexes on `(restricted, restricted_until)` for `owners` and `agents` where `restricted = true`.
- Extended `incidents` schema with:
  - `sanction_kind text NOT NULL DEFAULT 'none'`
  - `sanction_expires_at timestamptz`
  - `appeal_status text NOT NULL DEFAULT 'none'`
  - `appeal_reason text`
  - `appeal_evidence jsonb NOT NULL DEFAULT '[]'`
  - `appeal_submitted_at timestamptz`
  - `appeal_resolved_at timestamptz`
  - `appeal_resolution text`
- Added partial index `idx_incidents_appeal_pending` on `incidents(appeal_status) WHERE appeal_status = 'pending'`.

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
- Implemented `GET /v1/owners/me/incidents` with status filtering and cursor-based pagination. Maintained `GET /v1/owners/me/escalations` as backwards-compatible alias.
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

### 1.5 Reporting Anti-Spam & Quota (`apps/server/src/app.ts: POST /v1/reports`)
- Checked reporter restriction status: returns `403 Restricted` if reporter's owner is actively restricted.
- Deduplication: rejects duplicate open report on the same target with `409 Conflict`.
- Quota: rejects callers exceeding 10 reports per hour with `429 Too Many Requests`.
- Self-report guard: returns `422 Unprocessable Entity` if an owner attempts to report themselves or their own agents.

### 1.6 Request Validation Schemas (`apps/server/src/validation.ts`)
- Broadened report categories: `spam`, `harassment`, `unsafe`, `impersonation`, `illegal_content`, `misinformation`, `other`.
- Updated `PATCH /v1/moderation/incidents/:id` schema to support all new actions and optional `duration_sec`.
- Added schema for `POST /v1/owners/me/incidents/:id/appeal` validating `reason` (max 5000 chars) and structured `evidence` array.

### 1.7 Client SDK & CLI (`packages/client/`)
- In `client.js`: added `getOwnerIncidents({ limit, status })`, `appealIncident(incidentId, { reason, evidence })`, and `createReport({ targetKind, targetId, category, explanation })`.
- In `cli.js`: added commands `olimpyx incidents [--status <status>]`, `olimpyx appeal --incident <ID> --reason <text>`, and `olimpyx report --kind <kind> --target <ID> --category <cat> --reason <text>`.
- Preserved strict credential redaction for tokens in all CLI outputs.

### 1.8 Participant Skill Documentation (`skills/olimpyx-participant/SKILL.md`)
- Documented graduated sanctions spectrum, owner transparency commands, due-process appeal workflow, and anti-spam reporting rules.

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

---

## 3. Verification & Automated Test Results

### 3.1 Test Execution Summary

| Test Suite | Command | Result | Notes |
|---|---|---|---|
| Server Typecheck | `npm run typecheck` | Passed (0 errors) | Zero errors across `@olimpyx/server` and `@olimpyx/web` |
| Client Unit & CLI Tests | `npm --prefix packages/client test` | 56 passed, 0 failed | 100% pass across all 56 tests including SDK & CLI moderation tests |
| Moderation Sanctions Tests | `npx tsx --test apps/server/test/moderation-sanctions.test.ts` | Passed | Verified auto-restoration, exemptions, quorum, deduplication, quota, and malicious penalties |
| Knowledge Quorum Tests | `npx tsx --test apps/server/test/knowledge-quorum.test.ts` | Passed | Verified backwards compatibility with anti-Sybil consensus |
| Knowledge Governance Tests | `npx tsx --test apps/server/test/knowledge-governance.test.ts` | Passed | Verified publication and validation constraints |
| MVP Tests | `npx tsx --test apps/server/test/mvp.test.ts` | Passed | Verified legacy compatibility |

---

## 4. Modified & Created Files

- `apps/server/src/app.ts` (modified: schema migration, pure SQL auto-restoration, owner endpoints, moderator actions, anti-spam)
- `apps/server/src/validation.ts` (modified: report categories, moderation action schema, appeal schema)
- `packages/client/src/client.js` (modified: `getOwnerIncidents`, `appealIncident`, `createReport`)
- `packages/client/src/cli.js` (modified: `incidents`, `appeal`, `report` commands)
- `skills/olimpyx-participant/SKILL.md` (modified: graduated sanctions, incident inspection, appeals, reporting rules)
- `packages/client/test/moderation.test.js` (created: 6 SDK & CLI tests with credential redaction)
- `apps/server/test/moderation-sanctions.test.ts` (created: unit & integration tests)
- `jobs/moderation-sanctions-q-024-2026-09-18/state.json` (modified: status completed)
- `jobs/moderation-sanctions-q-024-2026-09-18/report.md` (created: engineering report)
