# Documentation Review: Moderation Sanctions, Appeals, and Owner Notification Timing (Q-024)

| Field | Value |
|---|---|
| **Document under review** | [`jobs/moderation-sanctions-q-024-2026-09-18/prd.md`](prd.md) (118 lines, Approved) |
| **Job folder** | `jobs/moderation-sanctions-q-024-2026-09-18/` (only `prd.md` exists locally) |
| **Branch** | `feat/moderation-sanctions-q-024` based on `main` |
| **Base** | `main` @ `6f921c5 feat(knowledge): quorum, independent reviewers, and conflict resolution (Q-020) (#14)` |
| **Review date** | 2026-09-18 |
| **Reviewer** | adaptive code review (orchestrator) — documentation review |
| **Scope** | Horizon 2 Item #6 (Q-024). Aligned with D-010, D-042, D-043. |
| **Verdict** | **CONDITIONAL APPROVE** — proceed to implementation after M1–M8 are addressed |

---

## 1. Executive Summary

The Q-024 PRD correctly identifies the three missing pieces (graduated sanctions, owner transparency, appeals) and proposes a coherent moderation lifecycle aligned with D-043 (server monitoring → automatic resolution → human escalation). The graduated sanction spectrum (`warning | temporary_restriction | permanent_restriction`) and lazy auto-restoration pattern are sound.

The PRD is **ready for implementation after eight clarifications** (M1–M8), each validated against the current `main` codebase. M2 (moderator role) and M3 (auto-restoration race conditions) are the most important — without them, the system would either have broken access control (M2) or write-on-read on the hot path (M3).

### Statistics

| Severity | Count |
|---|---|
| Blocker | 0 |
| Major | 8 |
| Minor | 11 |
| Nit | 3 |
| **Total** | **22** |

---

## 2. Scope & Context

### 2.1 What this PRD introduces

- **Graduated sanctions**: `warning | temporary_restriction | permanent_restriction`
- **Auto-restoration**: in `principal()`, lazy expiry check on `restricted_until`
- **Owner transparency**: `GET /v1/owners/me/incidents`
- **Appeals workflow**: `POST /v1/owners/me/incidents/:id/appeal`
- **Moderator actions**: `PATCH /v1/moderation/incidents/:id` with 8 action kinds
- **Malicious report mitigation**: `dismiss_malicious` resolution
- **SDK + CLI**: `client.getOwnerIncidents`, `appealIncident`, `createReport`, `olimpyx incidents/appeal/report`

### 2.2 Adjacent code referenced during review

- `apps/server/src/app.ts` — read lines around 33 (owners schema), 36 (agents schema), 62–63 (reports+incidents schema), 103–113 (principal), 173 (owner-restricted), 178 (agent-restricted), 182 (session-restricted), 227 (inbox counts), 300 (revoke endpoint), 301 (`/escalations` endpoint), 479–481 (platform-watcher creates reports+incidents+inbox_event)
- `apps/server/src/app.ts:74-75` — `tokenType: "owner" | "session" | "agent"` (no `moderator` type)
- `apps/server/src/app.ts:301` — `GET /v1/owners/me/escalations` already exists

### 2.3 Specification sources

- `docs/agent_network_spec_v2_2026-09-11/12_DECISIONS_AND_OPEN_QUESTIONS.md`:
  - **D-010** (line 47): "The local owner defines sandbox/permissions. Remote agents can request work but cannot grant themselves local authority."
  - **D-042** (line 177): "A server-operated moderation agent evaluates incidents and attempts resolution. ... Platform moderation is distinct from session-scoped user agents."
  - **D-043** (line 181): "Server-side watchers/rules monitor messages and produce incidents or alerts. An internal server moderation agent attempts to resolve them. Unresolved cases escalate to a human moderator or server owner. Peer reports are supplementary inputs, not the only detection path. Detection rules, automatic actions, evidence standards, sanctions and appeal procedures remain unspecified; this decision establishes the escalation path only."
  - **Q-024** (line 283): "Server monitoring produces incidents; internal moderation attempts resolution, then unresolved cases reach a human moderator/server owner (D-043). Automatic action powers, evidence requirements, malicious-report handling, sanctions, appeal path and moderation execution resources remain open."
  - **Risks** (line 304): "False moderation alerts, malicious reports and unresolved escalations."

### 2.4 What is NOT in scope for this review

- Implementation (server/client/skill code)
- Web UI for incident inspection
- Out-of-band audit log retention policy

---

## 3. Strengths

### 3.1 Explicit graduated sanction spectrum

The four-level FSM (`none | warning | temporary_restriction | permanent_restriction`) is well-defined and corresponds to real operational needs:
- `warning` is informational — `restricted` stays false, no session termination
- `temporary_restriction` is time-bounded — `restricted_until` enables auto-restoration
- `permanent_restriction` is indefinite — only appeal can lift it

This matches the D-043 escalation path: warnings for soft infractions, temporary for repeated, permanent for severe.

### 3.2 Lazy auto-restoration

Restoration in `principal()` on next request is elegant: no background sweep needed, no cron, no missed deadlines. If `restricted_until <= now()`, the flag is auto-cleared. This is the standard pattern for time-bounded suspensions in stateless API servers.

### 3.3 Agent vs Owner sanction targets

Two-tier targeting (agent vs owner) is correctly modeled. Owner-level sanction should cascade to all agents owned by that owner — already supported by the existing schema (`owners` JOIN `agents` in `principal()`).

### 3.4 Reuse of existing reports+incidents schema

The PRD does not propose new tables. It extends the existing `reports` and `incidents` schema with new columns. This is a minimal-footprint design — easy to iterate, easy to roll back.

### 3.5 Appeals lifecycle with double-appeal guard

The `appeal_status == 'none'` precondition in `POST .../appeal` correctly prevents double-appeals. Once an appeal is decided (`granted` or `denied`), the owner cannot re-open it through this endpoint.

### 3.6 Malicious report handling

The `dismiss_malicious` action closes a documented risk path (D-042 + Risks §12_DECISIONS_AND_OPEN_QUESTIONS.md:304). Without it, malicious agents could weaponize `POST /v1/reports` to harass competing agents.

### 3.7 Explicit CLI surface

`olimpyx incidents / appeal / report` is consistent with existing CLI nouns (`message`, `rooms`, `knowledge`). Easy to discover, easy to document.

### 3.8 Strong alignment with D-043

The PRD implements the escalation path that D-043 explicitly calls for: platform watcher → automatic resolution attempt → escalation to incident → moderator action. The existing `incidents.status = 'owner_escalation'` default is exactly this entry point.

---

## 4. Findings

### 4.1 Major findings (must be addressed before implementation)

#### M1 — `restricted_until` and `restriction_kind` columns do not exist in schema

**Location:** PRD §2.1; current schema at `app.ts:33,36,62,63`
**Severity:** Major

**Problem:**
PRD §2.1 references two new columns:
- `restricted_until timestamptz`
- `restriction_kind text` (`'temporary' | 'permanent'`)

These do **not** exist in the current schema. `owners` (line 33) and `agents` (line 36) only have `restricted boolean NOT NULL DEFAULT false`. The migration is not specified in the PRD.

Without the migration:
- `principal()` cannot read `restricted_until`
- Auto-restoration cannot work
- `restriction_kind` cannot be persisted

**Suggested fix:**
Add a §2.1.1 "Schema Migration" subsection with concrete SQL:

```sql
ALTER TABLE owners ADD COLUMN IF NOT EXISTS restricted_until timestamptz;
ALTER TABLE owners ADD COLUMN IF NOT EXISTS restriction_kind text;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS restricted_until timestamptz;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS restriction_kind text;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_agents_restricted_expiry
  ON agents(restricted, restricted_until)
  WHERE restricted = true;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_owners_restricted_expiry
  ON owners(restricted, restricted_until)
  WHERE restricted = true;
```

Use `CREATE INDEX CONCURRENTLY` per the PR #12 lesson (deploy lockout avoidance).

---

#### M2 — Moderator role and authentication are undefined

**Location:** PRD §2.4 "Moderator Actions (`PATCH /v1/moderation/incidents/:id`)"
**Severity:** Major (potential broken access control)

**Problem:**
Every moderator action requires authentication as a moderator. But:
- Current `tokenType` enum (`app.ts:74-75`) is `"owner" | "session" | "agent"` — no `moderator`
- No `is_moderator` flag on `owners`
- No `moderators` table
- No `POST /v1/moderation/login` or equivalent

Without explicit moderator authentication, the implementation risks:
- (a) Accepting owner-tokens for moderator actions → any owner can sanction anyone else
- (b) Bypassing auth entirely → critical security hole
- (c) Adding ad-hoc check like `if (req.headers['x-moderator-secret'] === process.env.MODERATOR_SECRET)` → works but undocumented

D-043 says "human moderator or server owner" — implying the server operator (Geekom admin) is the moderator. This points to a single shared-secret approach.

**Suggested fix:**
Three options:

(a) **Shared secret in env** (simplest, matches D-043 "server owner as moderator"):
```typescript
const moderatorSecret = process.env.MODERATOR_SECRET;
if (!moderatorSecret) { fail(reply, 503, "moderation_unavailable", "Server owner has not configured moderation"); return; }
const provided = req.headers['x-moderator-secret'];
if (provided !== moderatorSecret) { fail(reply, 403, "forbidden", "Moderator access required"); return; }
```
Pros: zero schema change, aligns with D-043. Cons: shared secret rotation requires deploy.

(b) **`is_moderator` flag on owners**:
```sql
ALTER TABLE owners ADD COLUMN IF NOT EXISTS is_moderator boolean NOT NULL DEFAULT false;
```
Pros: per-owner moderator identity, rotatable. Cons: spec ambiguity about who can grant `is_moderator` (chicken-and-egg).

(c) **Separate `moderators` table**:
```sql
CREATE TABLE moderators (id text PRIMARY KEY, email text UNIQUE NOT NULL, password_hash text NOT NULL, display_name text, created_at timestamptz NOT NULL DEFAULT now(), restricted boolean NOT NULL DEFAULT false);
CREATE TABLE moderator_tokens (token_hash text PRIMARY KEY, moderator_id text NOT NULL REFERENCES moderators(id), expires_at timestamptz NOT NULL);
```
Pros: cleanest separation. Cons: parallel auth system to maintain.

**Recommendation:** option (a) for v1. Document explicitly in PRD §2.4. Keep `MODERATOR_SECRET` env-only, log who calls moderator actions via IP/user-agent for audit.

---

#### M3 — Auto-restoration in `principal()` is write-on-read on the hot path

**Location:** PRD §2.2
**Severity:** Major

**Problem:**
PRD §2.2 says: *"In `principal()`: When checking `restricted`: if `restricted_until` is set and `restricted_until <= now()`, the temporary restriction is considered expired. Automatically resets `restricted = false`, `restricted_until = null`, `restriction_kind = null`."*

`principal()` is called on **every** authenticated API request. Adding a write to a hot path:
- Increases tail latency for every request (UPDATE in critical path)
- Creates race conditions: two concurrent requests both see expired → both UPDATE → WAL bloat
- Complicates transaction semantics if the request handler relies on `restricted` being read-only

**Evidence:**
`principal()` is implemented at `app.ts:173, 178, 182-186` and called from many handlers. Adding a write here affects every authenticated call.

**Suggested fix:**
Three options:

(a) **Pure SQL condition** (recommended): don't write, just filter:
```sql
-- in principal():
SELECT ..., NOT (a.restricted = true AND (a.restricted_until IS NULL OR a.restricted_until > now())) AS access_allowed
FROM ...
```
The expired row stays `restricted=true` until a background sweep or moderator action clears it. Access is still granted because the condition evaluates to true at query time. No writes on the hot path.

(b) **Background sweep**: cron job or `pg_cron` every 60s:
```sql
UPDATE agents SET restricted=false, restricted_until=NULL, restriction_kind=NULL
WHERE restricted=true AND restricted_until IS NOT NULL AND restricted_until <= now();
```
Pros: writes only happen in batch. Cons: requires pg_cron extension or external scheduler.

(c) **Hybrid**: lazy SQL condition (a) + best-effort background sweep (b) for cleanup. Most robust.

**Recommendation:** option (a) for v1 — minimal change, no new infrastructure. Add a TODO for future batch sweep.

---

#### M4 — Appeals columns do not exist in schema

**Location:** PRD §2.3; current schema at `app.ts:63`
**Severity:** Major

**Problem:**
PRD §2.3 references new incident columns:
- `appeal_status text` (`'none' | 'pending' | 'granted' | 'denied'`)
- `appeal_reason text`
- `appeal_submitted_at timestamptz`

The current `incidents` table does not have these. The migration is not specified.

**Suggested fix:**
Add a §2.3.1 "Schema Migration" subsection:

```sql
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS appeal_status text NOT NULL DEFAULT 'none';
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS appeal_reason text;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS appeal_evidence jsonb NOT NULL DEFAULT '[]';
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS appeal_submitted_at timestamptz;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS appeal_resolved_at timestamptz;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS appeal_resolution text;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_incidents_appeal_pending
  ON incidents(appeal_status)
  WHERE appeal_status = 'pending';
```

---

#### M5 — Sanction cascade semantics not specified

**Location:** PRD §2.4 (`restrict_owner`, `restrict_owner_temporary`)
**Severity:** Major

**Problem:**
PRD says `restrict_owner_temporary` "Sets owner and agents `restricted_until`". But not specified:

1. **What happens to agents that already had `restricted=true`?** Override (set new `restricted_until`) or accumulate (keep existing)?
2. **What happens to active sessions of those agents?** Terminate (like `revoke` endpoint at `app.ts:300`)? Just rely on principal() check?
3. **What happens to agents created AFTER owner was restricted?** Existing schema (`app.ts:103, 178`) checks `o.restricted`, so they would be auto-restricted on creation. OK.
4. **Race condition**: owner restricted → user logs out → user logs in. New session must be rejected. Currently `app.ts:182` checks `s.restricted OR s.owner_restricted` — but if owner is restricted, the `agents` JOIN will reflect it. OK.

**Suggested fix:**
Add a §2.4.1 "Cascade Behavior" subsection. Specify:

- `restrict_owner`: `UPDATE owners SET restricted=true, restricted_until=null, restriction_kind='permanent' WHERE id=$1; UPDATE agents SET restricted=true, restricted_until=null, restriction_kind='permanent' WHERE owner_id=$1; UPDATE sessions SET ended_at=now() WHERE agent_id IN (SELECT id FROM agents WHERE owner_id=$1) AND ended_at IS NULL;`
- `restrict_owner_temporary`: similar but with `restricted_until = now() + $duration_sec` and `restriction_kind='temporary'`.
- `grant_appeal` (owner-level): same in reverse — clear `restricted` on owner and all owned agents.

---

#### M6 — `grant_appeal` semantics for all 4 sanction levels not specified

**Location:** PRD §2.4 (`grant_appeal`)
**Severity:** Major

**Problem:**
PRD says `grant_appeal`: *"sets `appeal_status = 'granted'`, `status = 'resolved'`, resets `restricted = false` on target."*

But:
- What if `permanent_restriction` was set on **owner**? Cascade-clear all agents (M5)?
- What if `permanent_restriction` was set on **agent**? Clear that one agent.
- What if `temporary_restriction` was set? Clear `restricted_until` (set to NULL) too, or leave for normal expiry?
- What if `warning` was the sanction? `restricted` was already false — anything to reset?
- After `grant_appeal`, what is `restriction_kind`? NULL? `'none'`?

**Suggested fix:**
Add a §2.4.2 "Grant Appeal Behavior" subsection with a clear table:

| Sanction kind | Target | After grant_appeal |
|---|---|---|
| warning | agent/owner | `appeal_status='granted'`, `status='resolved'`. No state change on `restricted`. (Warning has no persistent state.) |
| temporary_restriction | agent | `restricted=false`, `restricted_until=NULL`, `restriction_kind=NULL`, `appeal_status='granted'`, `status='resolved'` |
| temporary_restriction | owner | Same + cascade-clear all owned agents + terminate their active sessions |
| permanent_restriction | agent | `restricted=false`, `restricted_until=NULL`, `restriction_kind=NULL`, `appeal_status='granted'`, `status='resolved'` |
| permanent_restriction | owner | Same + cascade |

---

#### M7 — `dismiss_malicious` penalty on reporter is undefined

**Location:** PRD §2.4
**Severity:** Major

**Problem:**
PRD says `dismiss_malicious`: *"closes the incident and penalizes the reporter."* Four reasonable interpretations:

(a) **No action** — just close the incident with `action='dismissed_malicious'`. Reporter suffers no consequence.

(b) **Issue warning to reporter** — same as sanction `warning`, recorded on reporter's record.

(c) **Temporary restrict reporter** — `temporary_restriction` with short duration (e.g., 24h).

(d) **Permanent restrict reporter** — same as `permanent_restriction`. Severe, may be too punitive.

D-042 emphasizes anti-spam, so (a) is insufficient — it doesn't deter. But (d) is excessive for a single bad report. (b) or (c) are reasonable.

Also: PRD does not specify whether the "reporter" is the **owner** or **agent** who filed the report. Different consequences.

**Suggested fix:**
Pick option (c) by default with a duration parameter, OR define as (b) warning + a counter (e.g., 3 malicious reports → temporary_restriction). Document explicitly in §2.4.

A reasonable concrete rule:
- First `dismiss_malicious`: warning recorded on reporter's owner record.
- Second within 30 days: 24-hour temporary_restriction on reporter's owner.
- Third: 7-day temporary_restriction.

Or simpler: parameterized duration per moderator decision.

---

#### M8 — No rate limit on `POST /v1/reports`

**Location:** PRD §2.5 (CLI `report`); new endpoint inferred
**Severity:** Major

**Problem:**
PRD introduces user-facing `report` capability (CLI). Without rate-limiting:
- Agent A reports Agent B's 100 messages → 100 incidents on Agent B's owner
- Owner of Agent B sees 100 spam reports in `/incidents`
- Moderator queue flooded

D-042 explicitly requires anti-spam. The PRD does not implement rate-limiting on reports.

**Suggested fix:**
Add a §2.5.1 "Rate Limiting" subsection. Two complementary rules:

(a) **Per (reporter, target) deduplication**: only 1 unresolved report per (reporter_id, target_kind, target_id) tuple. Re-submission while previous is unresolved → 409 Conflict or 200 with note "already reported".

(b) **Per-reporter quota**: max N reports per hour per reporter. N could be 10 by default, env-configurable.

Pick (a) at minimum. (b) is a stronger guarantee.

---

### 4.2 Minor findings

#### m1 — `warning` sanction: where is it persisted?

**Location:** PRD §2.1
**Severity:** Minor

**Problem:**
`warning` is described as "informational infraction notification. `restricted` remains `false`." But where is the warning stored? Options:

(a) `incidents.action = 'warning'` — but `incidents` is for incidents, not warnings. Multiple warnings per agent?
(b) New column on agents: `agents.warnings jsonb DEFAULT '[]'` — array of `{at, by_moderator, reason}`
(c) New table: `warnings(id, target_kind, target_id, issued_at, moderator_id, reason)`

The current schema has no warning storage. Without specification, the implementation will invent one.

**Suggested fix:**
Pick option (b) for simplicity, or option (c) for proper audit. Document in PRD §2.1.

---

#### m2 — Pre-expiry notification not specified

**Location:** PRD §2.3
**Severity:** Minor

**Problem:**
`GET /v1/owners/me/incidents` returns `restricted_until`. Owner sees expiry. But how does owner know a temporary restriction is **about to expire** (e.g., 1 hour before)? No notification mechanism specified.

**Suggested fix:**
Optional inbox event `moderation.lifted_pending` 1 hour before `restricted_until`. Or omit — owner can poll. Document the choice.

---

#### m3 — Multiple sanctions on one incident not specified

**Location:** PRD §2.4
**Severity:** Minor

**Problem:**
`incidents.action` is a single field (`action text NOT NULL DEFAULT 'none'`). What if moderator wants to escalate warning → temporary_restriction on the same incident?

(a) Update `incidents.action` and `action_history` (audit trail needed).
(b) Create a new incident each time.

**Suggested fix:**
Pick option (a). Add `incidents_actions` audit table or rely on `incidents.updated_at` + `incidents.revision`.

---

#### m4 — Sanction audit trail is shallow

**Location:** PRD (whole)
**Severity:** Minor

**Problem:**
Sanctions are serious. Audit must capture: who (moderator_id), when (timestamp), what action, what evidence/reason. Currently `incidents.updated_at` and `revision` exist, but no audit log of each moderator decision.

**Suggested fix:**
Add `incident_actions` table:

```sql
CREATE TABLE incident_actions (
  id text PRIMARY KEY,
  incident_id text NOT NULL REFERENCES incidents(id),
  moderator_id text,  -- or 'system' for automated
  action_kind text NOT NULL,
  reason text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now()
);
```

Or document that `incidents.updated_at` is sufficient for MVP.

---

#### m5 — `POST /v1/reports` is new — schema for handler unspecified

**Location:** PRD §2.5
**Severity:** Minor

**Problem:**
PRD lists CLI `report --kind ... --target ... --category ... --reason ...`. The endpoint (`POST /v1/reports`?) is not specified. The handler must validate:

- `target_kind` ∈ {`profile`, `message`, `knowledge_version`}
- `target_id` exists and matches `target_kind`
- `category` ∈ {`spam`, `harassment`, `impersonation`, `illegal_content`, `other`}? (m8)
- `explanation` length limit
- Reporter authorization (agent or owner)
- Reporter not also being the target (no self-reports)

**Suggested fix:**
Specify endpoint, validation rules, and authorization. Use Zod schema for the body.

---

#### m6 — `/escalations` vs `/incidents` URL inconsistency

**Location:** PRD §2.3 vs `app.ts:301`
**Severity:** Minor

**Problem:**
PRD introduces `GET /v1/owners/me/incidents`. Existing endpoint is `GET /v1/owners/me/escalations` (line 301). Backward compatibility:

(a) Rename `/escalations` → `/incidents` (breaking change for existing clients).
(b) Add `/incidents` as the new canonical, keep `/escalations` as legacy redirect.
(c) Both coexist with different semantics (e.g., `/escalations` = open only, `/incidents` = all).

**Suggested fix:**
Pick (b) — add `/incidents` and have `/escalations` redirect to it with deprecation header.

---

#### m7 — `Evidence[]` schema is not defined

**Location:** PRD §2.3
**Severity:** Minor

**Problem:**
Appeal payload: `{ reason: string, evidence?: Evidence[] }`. What is `Evidence[]`? Same as `knowledge_reviews.evidence` JSON structure? Or simpler `{ url: string, type: 'link' | 'screenshot' }[]`?

**Suggested fix:**
Define:

```typescript
const EvidenceSchema = z.array(z.object({
  type: z.enum(['link', 'document', 'screenshot']),
  url: z.string().url(),
  description: z.string().max(500).optional()
}));
```

---

#### m8 — `category` enum for reports is not defined

**Location:** PRD §2.5; current schema uses `'spam'`
**Severity:** Minor

**Problem:**
CLI `--category <cat>` accepts any string. No validation. For moderation analytics and moderator UX, a fixed enum is preferable.

**Suggested fix:**
```typescript
const ReportCategorySchema = z.enum([
  'spam', 'harassment', 'impersonation',
  'illegal_content', 'misinformation', 'other'
]);
```

---

#### m9 — `category` vs `reason` confusion

**Location:** PRD §2.5
**Severity:** Minor

**Problem:**
CLI: `--category <cat> --reason <text>`. Existing `reports` schema has `(category, explanation)`. Is `reason` = `explanation`? Why two fields if so?

**Suggested fix:**
Rename one for clarity. Suggest: `--category` (enum) + `--explanation` (free-text). Update CLI flag accordingly.

---

#### m10 — Migration data consistency not addressed

**Location:** PRD (whole)
**Severity:** Minor

**Problem:**
Migration adds `restricted_until`, `restriction_kind`, `appeal_*` columns. Existing data:
- `incidents` rows with `status='owner_escalation'` and `action='none'` — these are pre-existing stuck incidents. After this PR, moderator actions can resolve them. OK.
- But: should existing escalated incidents get a default `appeal_status='none'`? Yes, by the migration default. OK.

No major inconsistency, but worth a one-line confirmation in the migration.

---

#### m11 — D-010 (security owner-controlled) not reflected in PRD

**Location:** PRD §1 "Architectural Anchors"
**Severity:** Minor

**Problem:**
D-010 is listed in anchors but not discussed. D-010: "The local owner defines sandbox/permissions. Remote agents can request work but cannot grant themselves local authority."

How does this intersect with moderator actions? Moderator is a "remote" principal from the owner's perspective. The owner does not control the moderator's sandbox. This is intentional (server-side moderation), but the relationship should be explicit.

**Suggested fix:**
Add one sentence to §2.4 explaining: "Moderator actions override owner authority by design (D-010 + D-043). Server-side moderators operate outside the owner's local sandbox."

---

### 4.3 Nit findings

#### n1 — CLI command naming: `incidents` vs `incidents list`

**Observation:**
PRD §2.5: `olimpyx incidents [--status <status>]`. Other commands use nouns without verbs (`message`, `rooms`). `incidents` as a single noun is OK, but `incidents list` is more conventional.

**Suggested fix:**
Accept either form. Document both in CLI usage.

---

#### n2 — Visual feedback for `appeal` CLI

**Observation:**
CLI `appeal --incident <ID> --reason <text>` is a write operation. Raw JSON output may be hostile. Compare to `knowledge inspect` from the Q-020 PRD which has a visual indicator. A confirmation message ("Appeal submitted for incident X. Status: pending.") would be friendlier.

**Suggested fix:**
Add a one-line confirmation output for `appeal`.

---

#### n3 — `Evidence` capitalization inconsistency

**Observation:**
PRD §2.3: `Evidence[]` (capitalized), §2.4: `evidence jsonb` (lowercase). API consistency.

**Suggested fix:**
Use lowercase `evidence[]` in JSON payload, matching the SQL column name.

---

## 5. Coverage Matrix

| Requirement | PRD coverage | Gap |
|---|---|---|
| Q-024 (sanctions, appeals, malicious reports) | ✅ all three aspects | None in high-level |
| D-010 (security owner-controlled) | ⚠️ in Anchors only | m11 |
| D-042 (anti-spam + auto moderation) | ⚠️ anti-spam claim, no rate-limit | M8 |
| D-043 (server monitoring → human escalation) | ✅ aligned | OK |
| Existing reports+incidents schema reuse | ✅ | Migration not described (M1, M4) |
| Auto-restoration | ✅ §2.2 | Race conditions (M3) |
| Moderator role | ❌ | M2 |
| Sanction target cascade | ⚠️ mentioned | M5, M6 |
| `dismiss_malicious` semantics | ⚠️ mentioned | M7 |
| Backward compat with `/escalations` | ❌ | m6 |
| Audit trail | ❌ | m4 |
| Test coverage | AC-1..5, no detailed plan | Need `plan.md` |
| Rate limiting on reports | ❌ | M8 |
| `evidence` schema | ❌ | m7 |
| `category` enum | ❌ | m8 |

---

## 6. Cross-document consistency

| Claim | Source | Verified |
|---|---|---|
| Q-024 explicitly leaves sanctions, appeal path, malicious reports open | spec | ✅ matches PRD scope |
| D-043 mentions "human moderator or server owner" | spec | ✅ — implies server-operator-as-moderator (M2 option a) |
| Existing `incidents.status='owner_escalation'` is the entry point | `app.ts:63` | ✅ |
| Existing `/v1/owners/me/escalations` is precedent | `app.ts:301` | ⚠️ m6 — URL collision |
| `restricted` is enforced in `principal()` for owner, agent, session | `app.ts:173, 178, 186` | ✅ |
| Reports already created by platform watcher | `app.ts:479-481` | ✅ — schema precedent is correct |
| `inbox_events` for `moderation.updated` already emitted | `app.ts:481` | ✅ — appeals can reuse this pattern |
| `agents.restricted` is currently a single boolean | `app.ts:36` | ✅ — confirms M1 migration needed |

---

## 7. Recommendation

### 7.1 Verdict

**CONDITIONAL APPROVE.** The PRD is conceptually sound and aligned with D-043. Implementation may proceed after M1–M8 are clarified. M2 (moderator auth) and M3 (auto-restoration strategy) are the most critical — without them, the system is either insecure or has hot-path performance issues.

### 7.2 Required changes before implementation

| # | Severity | Effort | Owner | Action |
|---|---|---|---|---|
| M1 | Major | 15 min | PRD author | Specify migration: `restricted_until`, `restriction_kind` on owners+agents + `CREATE INDEX CONCURRENTLY` |
| M2 | Major | 30 min | PRD author | Specify moderator authentication (recommend: shared secret env, align with D-043) |
| M3 | Major | 15 min | PRD author | Specify auto-restoration strategy (recommend: pure SQL condition, no write-on-read) |
| M4 | Major | 10 min | PRD author | Specify migration: `appeal_*` columns on `incidents` |
| M5 | Major | 15 min | PRD author | Specify cascade behavior for `restrict_owner_*` |
| M6 | Major | 20 min | PRD author | Specify `grant_appeal` behavior matrix for all 4 sanction levels |
| M7 | Major | 15 min | PRD author | Specify `dismiss_malicious` penalty (recommend: graduated — warning → 24h temp → 7d temp) |
| M8 | Major | 15 min | PRD author | Specify rate limiting on `POST /v1/reports` (recommend: 1 unresolved report per (reporter, target)) |

### 7.3 Suggested changes (not blocking)

| # | Severity | Effort | Owner | Action |
|---|---|---|---|---|
| m1 | Minor | 5 min | PRD author | Specify `warning` storage location |
| m2 | Minor | 5 min | PRD author | Specify pre-expiry notification (or skip) |
| m3 | Minor | 10 min | PRD author | Specify multi-sanction escalation path |
| m4 | Minor | 15 min | PRD author | Add `incident_actions` audit table or document `incidents.updated_at` sufficiency |
| m5 | Minor | 15 min | PRD author | Specify `POST /v1/reports` endpoint + validation |
| m6 | Minor | 10 min | PRD author | Specify `/escalations` ↔ `/incidents` migration path |
| m7 | Minor | 10 min | PRD author | Define `evidence[]` schema |
| m8 | Minor | 5 min | PRD author | Define `category` enum |
| m9 | Minor | 5 min | PRD author | Clarify `category` vs `explanation` |
| m10 | Minor | 5 min | PRD author | One-line note on data consistency post-migration |
| m11 | Minor | 5 min | PRD author | Document D-010 vs moderator authority |
| n1–n3 | Nit | 5 min | Optional | Polish CLI naming, feedback, capitalization |

### 7.4 Implementation sequencing (after M1–M8 addressed)

1. **Phase 1**: Migration (M1, M4) + index CONCURRENTLY
2. **Phase 2**: `principal()` updated for SQL-condition expiry check (M3)
3. **Phase 3**: Moderator auth middleware (M2)
4. **Phase 4**: New endpoints — `POST /v1/reports` (M8), `GET /v1/owners/me/incidents` (m6), `POST .../appeal`, `PATCH /v1/moderation/incidents/:id`
5. **Phase 5**: Cascade logic (M5, M6)
6. **Phase 6**: `dismiss_malicious` graduated penalty (M7)
7. **Phase 7**: SDK methods (`getOwnerIncidents`, `appealIncident`, `createReport`)
8. **Phase 8**: CLI commands
9. **Phase 9**: SKILL.md update
10. **Phase 10**: Tests (AC-1..5 + edge cases)

### 7.5 Out of scope for this review

- Implementation review (next PR on this branch)
- Performance benchmarking
- Concurrency stress testing
- Web UI for incident inspection
- Audit log retention policy

---

## 8. Open Questions for Author

1. **M2 (moderator auth)**: shared secret in env, owner flag, or separate moderators table? Recommendation: shared secret.
2. **M3 (auto-restoration)**: pure SQL condition, background sweep, or hybrid? Recommendation: SQL condition.
3. **M7 (malicious reporter penalty)**: graduated warning → 24h → 7d, or fixed-duration per call? Recommendation: graduated with config knob.
4. **M8 (rate limit)**: per (reporter, target) deduplication, per-reporter quota, or both? Recommendation: both.
5. **m6 (URL migration)**: keep `/escalations` as legacy redirect, or break it? Recommendation: keep as redirect with deprecation header.

---

## 9. References

- **PRD under review**: [`jobs/moderation-sanctions-q-024-2026-09-18/prd.md`](prd.md)
- **Spec source**:
  - [`docs/agent_network_spec_v2_2026-09-11/12_DECISIONS_AND_OPEN_QUESTIONS.md`](../agent_network_spec_v2_2026-09-11/12_DECISIONS_AND_OPEN_QUESTIONS.md) Q-024 (line 283), D-010 (line 47), D-042 (line 177), D-043 (line 181)
- **Adjacent code**:
  - `apps/server/src/app.ts:33` (owners schema)
  - `apps/server/src/app.ts:36` (agents schema)
  - `apps/server/src/app.ts:62-63` (reports+incidents schema)
  - `apps/server/src/app.ts:74-75` (tokenType enum)
  - `apps/server/src/app.ts:103-113` (principal)
  - `apps/server/src/app.ts:173, 178, 186` (restricted checks)
  - `apps/server/src/app.ts:300` (revoke endpoint)
  - `apps/server/src/app.ts:301` (`/escalations` endpoint)
  - `apps/server/src/app.ts:479-481` (platform watcher creates reports+incidents+inbox_event)
- **PR #12 lesson**: `CREATE INDEX CONCURRENTLY IF NOT EXISTS` (m1)
- **ROADMAP entry**: [`docs/ROADMAP.md`](../docs/ROADMAP.md) Horizon 2, Item #6

---

*Review complete. Awaiting author decision on M1–M8 before implementation begins.*
