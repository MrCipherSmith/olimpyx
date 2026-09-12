# Post-test Improvement Plan

## Prioritized backlog

| Priority | Item | Evidence | Acceptance signal | Dependencies |
|----------|------|----------|-------------------|--------------|
| P0 | Session-scoped watcher/helper without LLM | Claude scenario had bounded polling only; sessions ended with subagents | Helper survives task completion while host lives and exits with host | session lifecycle API |
| P0 | Local lease/liveness | Heartbeat must represent dispatch liveness, not only process existence | Single owner; stale/zombie session becomes offline | watcher |
| P0 | Inbox queue/cursor/dedupe | Reconnect must preserve at-least-once delivery | Restart resumes from acknowledged cursor and duplicate events are harmless | event store |
| P0 | `room.message.created` event stream | Room broadcasts did not wake `wait` | Room participant receives broadcast event without direct recipient | room memberships, inbox |
| P0 | Knowledge review notifications | Author learned review only by peer message | Review emits owner/subscriber event | knowledge event publisher |
| P1 | CLI generic GET option parser | `--caller-id` parsed as GET body | GET with options and no body succeeds | client tests |
| P1 | Structured knowledge status/counts | Proposal status encoded in card text | API fields expose status, confirmations, refutations and relations | API migration |
| P1 | Embeddings + backfill | readiness reported embedding unavailable | Semantic query uses backfilled embeddings | embedding config/job |
| P1 | Portable paths | Claude artifacts used `/Users/Goodea/...` | Same instructions work on Geekom clone | docs and scripts |
| P2 | `.metaproject/data` hygiene | Tool wrappers created unrelated untracked files | Runtime artifacts ignored or isolated | repository hygiene |

## CI/CD contract

| Area | Decision |
|------|----------|
| CI | Reusable workflow following Deprecated pattern, validates server and web |
| Trigger | `push` to `main`; deploy gates on successful CI |
| Executor | Dedicated repo-scoped self-hosted runner on Geekom, label `olimpyx-deploy` |
| Source | Exact triggering SHA, checked out in a dedicated release checkout |
| Runtime | Docker Compose with server and web healthchecks |
| Verification | Private readiness plus public Cloudflare health endpoint |
| Failure | Atomic rollback to last known-good SHA, repeat health verification, retain logs |
| Secrets | Minimal GitHub repository secrets; Cloudflare token rotation is an independent operations task |

## Execution sequence

1. Implement and test watcher, liveness and resumable inbox semantics.
2. Implement room and knowledge review event publishing/consumption.
3. Repair CLI parser and portable local state/instructions.
4. Add structured knowledge fields and embedding/backfill capabilities.
5. Add reusable CI, self-hosted deploy workflow, healthchecks and rollback.
6. Review security, execute verification and clean runtime artifacts.

---

<!-- Document Metadata -->
| Key | Value |
|-----|-------|
| Created | 2026-09-12T09:29:46Z |
| Agent | job-documenter |
| Task | Post-test improvement plan and CI/CD plan |
| Job | post-test-hardening-and-ci-2026-09-12 |
| Version | 1.0 |
| Status | final |
