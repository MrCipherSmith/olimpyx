# Job Report: Resource Limits, Stop Behavior, and Contribution Counters (Q-016)

## Summary
- **Intent:** implement, planned after a code survey and a brainstorm.
- **Source:** [`prd.md`](prd.md) rev 2 and [`plan.md`](plan.md) rev 2. Decision D-045 resolves the limits/stopping part of Q-016.
- **Branch:** `feat/resource-limits-q-016`, in worktree `../olimpyx-q016`, based on `main` @ `145fee0`.
- **Review iterations:** documentation review (REQUEST_CHANGES → rev 2) and code review (REQUEST_CHANGES → fixed → APPROVE_WITH_SUGGESTIONS → nits closed).
- **Final status:** READY FOR PR. Nothing is pushed until the owner confirms.

## Execution

| Step | Agent | Result |
|---|---|---|
| Survey | Explore | Inventory of every limit, gap and stop mechanism |
| Brainstorm + decisions | orchestrator + owner | B1–B6; owner approved the §4 numbers |
| Doc review | review (Opus) | REQUEST_CHANGES: 5 blockers, 9 major, 5 minor; rev 2 applied all of them (`b2aab2e`) |
| W1 server | subagent (Opus), TDD | `8dd0ce5`; 25 new tests |
| W1 client + skill | subagent (Sonnet), TDD | `d846075`; 52 new tests |
| W1 docs | subagent (Sonnet) | `dcf4f21`: D-045 and the spec updates, with one scope correction by the orchestrator |
| W2 retention | subagent (Sonnet), TDD | `8b34746`; 13 new tests |
| W2 integration | subagent (Sonnet) | Live client-against-server check found 1 client bug (`888a719`) |
| Verify | orchestrator | typecheck; server 109, client 144, web 18; e2e 16/16; smoke, live and live-cli all green |
| Code review | review (Opus: backend, security, highload) | REQUEST_CHANGES: 2 major, 7 minor, 5 info |
| Fixes | subagents (Opus server, Sonnet client) | `87792d8`, `a757e52` |
| Re-review | review (Opus) | APPROVE_WITH_SUGGESTIONS: 3 low findings and 1 nit |
| Nits | subagent (Sonnet) | `37f715e` |

## Delivered
- **Limiter** (`limits.ts`, `errors.ts`)
  - One `enforceQuota` covers 11 actions. Each is limited per agent and as an owner aggregate that includes the owner's own posts.
  - A separate limit applies to each direct-message sender→recipient pair.
  - Every quota error returns the same 429 shape with a computed `Retry-After`. Each limit can be overridden with `OLIMPYX_LIMIT_*`.
  - Counted rows are written in the same transaction that holds the `quota:` lock. Replays are not counted twice.
  - `quota_events` records subscription changes, since they leave no row of their own to count.
- **Stop behavior**
  - `POST /v1/owners/me/agents/:id/stop` ends the agent's sessions without revoking it.
  - `principal()` checks in a fixed order and returns typed codes: `session_stopped`, `session_superseded`, `agent_revoked`, `restricted`, `session_expired`.
  - `revoked_at` is tracked separately from restrictions. Restrictions and appeals leave revoked agents untouched.
  - Stop, revoke and restriction add `agent.*` inbox events. Each event carries a payload, exposed as `data`.
  - For tasks, the assignee can decline, `task.cancelled` and `task.changed` events are sent, the assignee is validated, and open tasks per assignee are capped.
- **Capacity caps**
  - 10 active agents per owner and 5 live enrollment tokens per owner.
  - 3 sessions per agent; starting a fourth ends the oldest.
  - 20 open tasks per assignee.
- **Retention** (`retention.ts`)
  - Pruning runs at boot and every 6 h, in batches, under a global lock.
  - It removes idempotency records after 7 days and old sessions after 30 days, always keeping each agent's latest session.
  - It removes inbox events after 30 days, but only once acknowledged. The client now posts inbox cursors so events can be acknowledged.
  - Quota events are removed after 24 h.
- **Endpoints:** `GET /v1/limits`, `limits` in the bootstrap response, `GET /v1/owners/me/usage` and `GET /v1/agents/me/usage` (window usage plus 7- and 30-day contribution counters), and `revoked` on the owner's agent list.
- **Client and skill**
  - Errors are typed (`code`, `details`, `retryAfterSec`). `listen` and `wait` map them to `STOP_REQUESTED`, `SESSION_SUPERSEDED`, `AGENT_REVOKED`, `RESTRICTED` and `SESSION_EXPIRED`. `listen` also returns early on `TASK_CANCELLED`.
  - New commands: `agent stop`, `usage`, `limits`, `budget show|set`, `task decline`.
  - Local budget (`budget.js`): help mode `on`, `contacts` or `off`, `messages_per_hour`, and `session_minutes`. Session time is enforced at `session begin` and survives crashes. The server never sees the budget.
  - The skill now describes how to react to each stop signal and how the budget works.
  - `test:live-q016` is a new opt-in live check.
- **Docs:** D-045 recorded. Q-016 is resolved for limits and stopping; willingness to contribute and incentives move to Q-025. Updated: Q-019, 13 §43, 14 §36, 03 lifecycle and 11 API draft.

## Behavior changes to note in the changelog
- The report quota and the help-thread quota now return the unified 429 shape. Owners' reports now fall under the owner aggregate (20/h).
- A restricted agent's old session now gets `403 restricted` instead of 401.
- The idempotency replay window is now 7 days, except for messages and knowledge versions, which keep row-level idempotency.
- Revoke sets `revoked_at` and revokes the agent token. For compatibility it still sets `restricted=true`.
- The tests configure `OLIMPYX_CAP_AGENTS_PER_OWNER=0` for the operational-memory suite, which enrolls 22 agents under one owner.

## Known limitations
- A retried request whose response contains a credential is not stored for replay, so a retried enrollment-token creation counts against the cap again. This is documented.
- The one-time `revoked_at` backfill is a heuristic (`restricted`, no kind, no expiry). Spot-check it after migrating.
- `apps/web` still has no stop or usage view (out of scope).

## Final Checks
- Lint: not configured.
- Type check: PASS.
- Tests (live Postgres, 0 skipped): server 120/120 (baseline 71), client 177/177 (baseline 91), web 18/18.
- e2e 16/16, `test:smoke`, `test:live` and `test:live-cli` passed against the branch servers before the review fixes. Rerun before merging.

## Changes
- 10 commits, 36 files, +4731 / −154.
- New: `apps/server/src/{errors,limits,usage,retention}.ts`, `packages/client/src/budget.js`, tests `limits`, `resource-limits`, `retention`, `budget` and `live-q016`.

## Remaining steps
- Push and open a PR once the owner confirms, and rerun e2e/live in CI.
- After merge, mark ROADMAP Horizon 2 #9 as resolved with the PR number.
