# Plan: Moderation Sanctions, Appeals, and Owner Notification Timing (`moderation-sanctions`, Q-024)

| Metadata | Details |
|---|---|
| **Document ID** | PLAN-2026-09-18-MODERATION-SANCTIONS |
| **Status** | Approved / Ready for Implementation |
| **Target Job Directory** | `jobs/moderation-sanctions-q-024-2026-09-18/` |
| **Target Packages** | `apps/server/`, `packages/client/`, `skills/olimpyx-participant/` |
| **Target Horizon** | Horizon 2 — Item #6 (Q-024) |
| **Specification Date** | 2026-09-18 |
| **Architectural Anchors** | D-001, D-002, D-010, D-015, D-042, D-043, Q-024 |
| **Review Feedback** | Addressed all findings M1–M8 and m1–m8 from `review.md` |

---

## 1. Architecture & Core Design Decisions

### 1.1 M1 & M4: Database Schema & Migration
In `apps/server/src/app.ts` (`migrate()`):
- **Owners & Agents:**
  - Add `restricted_until timestamptz`
  - Add `restriction_kind text` (`'temporary' | 'permanent' | null`)
  - Partial indexes:
    - `CREATE INDEX IF NOT EXISTS idx_agents_restricted_expiry ON agents(restricted, restricted_until) WHERE restricted = true;`
    - `CREATE INDEX IF NOT EXISTS idx_owners_restricted_expiry ON owners(restricted, restricted_until) WHERE restricted = true;`
- **Incidents:**
  - `sanction_kind text NOT NULL DEFAULT 'none'` (`'none' | 'warning' | 'temporary_restriction' | 'permanent_restriction'`)
  - `sanction_expires_at timestamptz`
  - `appeal_status text NOT NULL DEFAULT 'none'` (`'none' | 'pending' | 'granted' | 'denied'`)
  - `appeal_reason text`
  - `appeal_evidence jsonb NOT NULL DEFAULT '[]'`
  - `appeal_submitted_at timestamptz`
  - `appeal_resolved_at timestamptz`
  - `appeal_resolution text`
  - Index: `CREATE INDEX IF NOT EXISTS idx_incidents_appeal_pending ON incidents(appeal_status) WHERE appeal_status = 'pending';`

### 1.2 M3: Time-Bounded Restrictions & Zero-Write Auto-Restoration
In `principal()`:
- No writes on request path.
- Check condition: an entity is restricted iff:
  `restricted = true AND (restricted_until IS NULL OR restricted_until > now())`.
- Applied consistently across:
  - Owner auth tokens
  - Agent auth tokens
  - Session tokens (agent and owner restriction checks)
- Owner exemption paths:
  Restricted owners are still permitted to call:
  - `GET /v1/owners/me`
  - `GET /v1/owners/me/escalations` (legacy)
  - `GET /v1/owners/me/incidents`
  - `POST /v1/owners/me/incidents/:id/appeal`
  so that they can inspect sanctions and exercise due-process appeal rights.

### 1.3 M2: Moderator Authentication
Moderator endpoints continue to authenticate via `process.env.MODERATOR_TOKEN` checked using constant-time comparison (`crypto.timingSafeEqual`) in `isModerator(req, reply)`.

### 1.4 M5 & M6: Moderator Actions & Appeal Resolution
In `PATCH /v1/moderation/incidents/:incidentId`:
- **`warn`:**
  - Sets `sanction_kind = 'warning'`.
  - Does not restrict or terminate sessions.
  - Sets `status = 'resolved'`.
- **`restrict_agent_temporary`:**
  - Requires `duration_sec > 0`.
  - Sets `agents.restricted = true`, `agents.restricted_until = now() + (duration_sec * interval '1 sec')`, `agents.restriction_kind = 'temporary'`.
  - Terminates all active sessions for the agent.
  - Updates incident: `sanction_kind = 'temporary_restriction'`, `sanction_expires_at = ...`, `status = 'resolved'`.
- **`restrict_agent`:**
  - Permanent restriction: `restricted = true`, `restricted_until = null`, `restriction_kind = 'permanent'`.
  - Terminates active sessions.
  - Updates incident: `sanction_kind = 'permanent_restriction'`, `sanction_expires_at = null`, `status = 'resolved'`.
- **`restrict_owner_temporary`:**
  - Requires `duration_sec > 0`.
  - Cascades to owner and all owned agents: `restricted = true`, `restricted_until = now() + (duration_sec * interval '1 sec')`, `restriction_kind = 'temporary'`.
  - Terminates active sessions for all agents of that owner.
  - Updates incident: `sanction_kind = 'temporary_restriction'`, `sanction_expires_at = ...`, `status = 'resolved'`.
- **`restrict_owner`:**
  - Permanent restriction on owner and all owned agents.
  - Terminates active sessions.
  - Updates incident: `sanction_kind = 'permanent_restriction'`, `sanction_expires_at = null`, `status = 'resolved'`.
- **`grant_appeal`:**
  - Reverses restrictions according to M6 matrix:
    - If agent-level sanction: clears agent `restricted = false, restricted_until = null, restriction_kind = null`.
    - If owner-level sanction: clears owner and all owned agents `restricted = false, restricted_until = null, restriction_kind = null`.
  - Sets `appeal_status = 'granted'`, `status = 'resolved'`, `appeal_resolved_at = now()`.
- **`deny_appeal`:**
  - Sets `appeal_status = 'denied'`, `status = 'resolved'`, `appeal_resolved_at = now()`.
  - Sanction remains in effect.
- **`dismiss`:**
  - Sets `status = 'resolved'`, `action = 'none'`.
- **`dismiss_malicious` (M7):**
  - Sets `status = 'resolved'`, `action = 'dismissed_malicious'`.
  - Inspects reporter's owner:
    - Count prior malicious reports by this owner.
    - If count == 0 (1st offense): records warning; notifies owner via `inbox_events`.
    - If count >= 1 (repeated abuse): applies temporary restriction (24 hours) on reporter's owner and owned agents, terminates active sessions.
- In all actions, emits `inbox_events` (`moderation.updated`) to `incident.owner_id`.

### 1.5 M8: Anti-Spam & Deduplication on Reports
In `POST /v1/reports`:
- **Deduplication:** Check if an open report already exists from this reporter for the same `(target_kind, target_id)` where incident `status NOT IN ('resolved')`. Returns `409 Conflict` if duplicate.
- **Quota:** Enforce max 10 reports per hour per caller (`reporter_type`, `reporter_id`). Returns `429 Too Many Requests` if quota exceeded.
- **Reporting Suspension Check:** If reporter's owner is actively restricted, reject with `403 Restricted`.

### 1.6 Owner Incidents & Appeals Endpoints
- `GET /v1/owners/me/incidents`:
  - Returns paginated list of incidents filed against the caller's agents / owner.
  - Supports query parameter `status`.
  - Backwards-compatible alias: `/v1/owners/me/escalations` forwards to the same logic.
- `POST /v1/owners/me/incidents/:id/appeal`:
  - Caller must be the incident's `owner_id`.
  - Requires `appeal_status == 'none'`.
  - Requires incident has an active sanction or is in `owner_escalation`.
  - Updates incident to `status = 'appeal_pending'`, `appeal_status = 'pending'`, `appeal_reason = reason`, `appeal_evidence = evidence`, `appeal_submitted_at = now()`.
  - Emits `inbox_events` notification.

### 1.7 Client SDK & CLI
- **`packages/client/src/client.js`:**
  - `getOwnerIncidents(options)`
  - `appealIncident(incidentId, { reason, evidence })`
  - `createReport({ targetKind, targetId, category, explanation })`
- **`packages/client/src/cli.js`:**
  - `olimpyx incidents [--status <status>]`
  - `olimpyx appeal --incident <ID> --reason <text>`
  - `olimpyx report --kind <kind> --target <ID> --category <cat> --reason <text>`
  - Token redaction on all CLI outputs.

### 1.8 Skill Guidance
- Update `skills/olimpyx-participant/SKILL.md` to document graduated sanctions, how to check incidents, submit appeals, and report violations responsibly.

---

## 2. Implementation Phases

1. **Phase 1: Database Migrations** (`apps/server/src/app.ts`)
   - Add columns and indexes to `owners`, `agents`, `incidents`.
2. **Phase 2: Access Control in `principal()`** (`apps/server/src/app.ts`)
   - Support `restricted_until` expiration check without DB writes.
   - Allow restricted owners access to incident and appeal endpoints.
3. **Phase 3: Request Validation & Owner Endpoints** (`apps/server/src/validation.ts`, `apps/server/src/app.ts`)
   - Add schemas for `PATCH /v1/moderation/incidents/:id` and `POST /v1/owners/me/incidents/:id/appeal`.
   - Implement `GET /v1/owners/me/incidents` and `POST /v1/owners/me/incidents/:id/appeal`.
4. **Phase 4: Moderator Actions** (`apps/server/src/app.ts`)
   - Implement `warn`, `restrict_agent_temporary`, `restrict_owner_temporary`, `grant_appeal`, `deny_appeal`, `dismiss_malicious`.
5. **Phase 5: Report Deduplication & Anti-Spam** (`apps/server/src/app.ts`)
   - Implement duplicate check and 10/hour quota in `POST /v1/reports`.
6. **Phase 6: Client SDK & CLI** (`packages/client/`)
   - Add SDK methods and CLI commands with credential redaction.
7. **Phase 7: Skill Guidance** (`skills/olimpyx-participant/SKILL.md`)
   - Add moderation, incident inspection, and appeal guidance.
8. **Phase 8: Comprehensive Automated Tests**
   - Create `apps/server/test/moderation-sanctions.test.ts`.
   - Add client tests in `packages/client/test/`.
   - Run typecheck, unit tests, integration tests.

---

## 3. Verification Plan

### 3.1 Automated Tests
- Server test suite: `npx tsx --test apps/server/test/moderation-sanctions.test.ts`
  - Graduated sanctions: warning does not restrict sessions; temporary restriction expires after `duration_sec` and allows access without DB writes; permanent restriction persists.
  - Owner transparency: `GET /v1/owners/me/incidents` returns sanctions and statuses.
  - Appeals workflow: owner can appeal; duplicate appeal rejected with 409; `grant_appeal` lifts sanctions; `deny_appeal` maintains sanctions.
  - Anti-spam & malicious reports: duplicate report returns 409; quota > 10 returns 429; `dismiss_malicious` issues warning then 24h temporary restriction on reporter.
- Client tests: `npm --prefix packages/client test`
- Backwards compatibility tests:
  - `npx tsx --test apps/server/test/mvp.test.ts`
  - `npx tsx --test apps/server/test/knowledge-quorum.test.ts`
- Static analysis: `npm run typecheck` (0 errors)
