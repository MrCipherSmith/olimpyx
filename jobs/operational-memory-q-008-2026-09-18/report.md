# Job Report: Operational-Memory Write Rules, Selective Consolidation, and Influence Rollback (Q-008)

## Summary
- **Intent:** implement (resumed from an approved PRD/plan, revision 2)
- **Source:** [`prd.md`](prd.md), [`plan.md`](plan.md); decision D-044 closes Q-008
- **Branch:** `feat/operational-memory-q-008` (base `main` @ `0efcd6a`; worked in the main checkout at the owner's request)
- **Review iterations:** 2 (REQUEST_CHANGES → APPROVE_WITH_SUGGESTIONS)
- **Final status:** READY FOR PR (not pushed; awaiting owner confirmation)

## Execution

| Step | Agent | Result |
|---|---|---|
| Baseline | orchestrator | typecheck pass; server 49/49, client 63/63, web 18/18; Postgres (pgvector pg17) started through OrbStack |
| W1 server | subagent (Opus), TDD | 11/13 new tests RED → GREEN; `2eccaff` |
| W1 client + skill | subagent (Sonnet), TDD | 7 RED → GREEN; `ab64f8b` |
| W1 docs | subagent (Sonnet) | D-044, Q-008 resolved, 05/11 updates; `27542f1` |
| Verify | code-verifier (Sonnet) | PASS; 161/161, 0 skipped; no runtime import cycles |
| Review | review (Opus, backend+security) | REQUEST_CHANGES: 3 major, 6 minor, 5 info |
| Fix server | subagent (Opus), TDD | 11 fixes; `fa50ce3` |
| Fix client | subagent (Sonnet), TDD | 5 fixes; `09fb050` |
| Docs note | orchestrator | API behavior changes; `082f418` |
| Verify post-fix | orchestrator | typecheck pass; server 68/68, client 91/91, web 18/18, 0 skipped |
| Re-review | review (Opus) | APPROVE_WITH_SUGGESTIONS; all prior findings resolved, 3 nits |

## Delivered (PRD rev 2)
- **Server** (`apps/server/src/memory.ts`, `secret-scan.ts`, `types.ts`, `app.ts`, `validation.ts`)
  - Nine memory categories.
  - Shared secret rules, with a parity test against the client.
  - Write rules, in this order: secrets → verified supersede → dedup → 30/h rate limit → 500 knowledge / 50 influence capacity.
  - Every write runs under a per-agent advisory lock. The memory change and the idempotency record commit in one transaction. Timestamps are read after the lock is taken.
  - Archive state model enforced by a CHECK constraint.
  - FTS search with an escaped ILIKE fallback, paged by a `memory_id` cursor.
  - Consolidation revisions: they exclude influences and are rate-limited to 10/h.
  - Owner-only rollback by `persona_revision`.
  - `memory_events` audit trail and `memory.rolled_back` inbox events.
  - Selective bootstrap with `memory` pointers. With no summary, the output is identical to the MVP.
- **Client** (`packages/client`)
  - `SECRET_RULES` export, including the Olimpyx token rule. Auth request bodies are scanned with only their credential fields stripped.
  - Memory SDK methods and `memory save|list|get|archive|restore|consolidate|rollback [--sync]|events`.
  - `persona rollback` syncs to the server, keyed on the new local revision. When that fails, a pending entry is saved and a retry report is printed.
- **Skill:** operational-memory rules, scanner false-positive guidance, re-bootstrap on `memory.rolled_back`.
- **Docs:** D-044, Q-008 resolved (open remainder listed), `05_MEMORY_MODEL.md` and `11_API_DRAFT.md` updates including API behavior changes.

## Review Results
- **Round 1:**
  - M1: the rollback idempotency key collided.
  - M2: `memory save` without a body failed.
  - M3: the enroll path exemption skipped the profile scan.
  - Minors: lock-time clock, influence fingerprint, dedup audit rows, consolidate limit, empty rollback events, split transactions, index, CHECK constraint, upgrade test, type cycle, pending-sync robustness.
  - All were fixed.
- **Round 2:** all resolved. Also fixed as a side effect: `idem()` previously returned a pooled connection with an open transaction when the reply had already been sent.

## Unresolved (nits, follow-up)
- [ ] `packages/client/src/cli.js:257`: `persona rollback` checks for the missing `agentId` only after the local rollback. Validate before mutating local state.
- [ ] `apps/server/src/memory.ts:118`: influence fingerprints written before deploy lack `persona_revision`. Worst case is one duplicate within 24 h. Optionally recompute them in the migration.
- [ ] `apps/server/src/app.ts:112-113`: the CHECK constraint is dropped and re-added on every boot, which is a full-table validation. Add it only when it is missing (`pg_constraint`).
- [ ] Info: the scanner can refuse base64url 43-char digests and "basic <token-like word>" prose. This is documented in the skill.

## Final Checks
- Lint: no lint tooling configured.
- Type check: PASS (server, web).
- Tests: server 68/68, client 91/91, web 18/18; 0 skipped (live Postgres).

## Changes
- 6 commits, 18 files, +1980 / −22 (see `git log main..HEAD`).
- New: `apps/server/src/memory.ts`, `apps/server/src/secret-scan.ts`, `apps/server/src/types.ts`, `apps/server/test/operational-memory.test.ts`, `packages/client/test/memory.test.js`.

## Remaining steps
- `docs/ROADMAP.md` Horizon 2 #8 → mark resolved with the PR number after merge.
- Push and open a PR only after owner confirmation.

## Notes outside the job scope
- The room scroll-to-latest UX fix was committed separately on `fix/room-scroll-to-latest` (`381ebb9`, worktree `../olimpyx-room-scroll`), based on `main`.
- Untracked files were left alone and not committed: `enroll-result.json`, `*-profile.json`, `enroll.sh`, `scratch/`, `ui-ux-review/`, `scripts/*.mjs`, `.claude/launch.json`.
