# Public Spectator Showcase UX

**Status:** completed
**Created:** 2026-09-12T19:34:01Z
**Updated:** 2026-09-12T19:42:00Z

## Context

| Field | Value |
|---|---|
| Intent | Implement a public, read-only spectator showcase |
| Project | `/Users/Goodea/goodea/olimpyx-showcase-ux` |
| Branch | `codex/showcase-ux` |
| Base | `main` at `f32a310` |
| Scope | Sections, rooms, cards, agents, conversations, knowledge outcomes, accessibility |

## Outcome sought

Give unauthenticated visitors a useful and shareable view of explicitly published showcase content: a meaningful overview, observed conversation and knowledge outcomes, readable reviewer and entity links, agent-contribution navigation, and accurate offline/live status. Owner controls and every mutation remain authenticated.

## Guardrails

- Publication is deployment-curated by `SHOWCASE_AGENT_IDS`, `SHOWCASE_ROOM_IDS`, and `SHOWCASE_CARD_IDS`; every allowlist defaults to empty. This job adds no publication-management UI or schema.
- Public DTOs are allowlisted read models and omit private identities, credentials/session data, owner workflows, moderation data, exact last-seen timestamps, and profile revisions.
- Public views are read-only. Existing owner and mutation authorization remains in place.
- Status labels must reflect actual live/offline state; no simulated-live language.
- Desktop and mobile accessibility will be improved, but the UI audit did not verify search or mobile defects because CUA capture failed. Those defects must not be asserted as established facts.
- No deployment or public-data publication is part of this job.
- The original worktree `/Users/Goodea/goodea/olimpyx` remains untouched.

## Delivered

Implemented and independently reviewed. Typecheck and build pass; 53 workspace tests and 8 browser tests pass. No production deployment or publication configuration was performed.

## Documents

| Document | Purpose | Status |
|---|---|---|
| [report.md](report.md) | Итоговый отчёт на русском | final |
| [results/verification.md](results/verification.md) | Quality gate results | final |
| [review.md](review.md) | Independent review | approved |
| [spec.md](spec.md) | Product, privacy, and acceptance requirements | final |
| [plan.md](plan.md) | Staged implementation and verification plan | final |
| [server-implementation.md](server-implementation.md) | Approved anonymous read contract and deployment allowlist boundary | final |

## Completed work

- [x] Scope existing server and web surfaces without changing code.
- [x] Approve the empty-by-default deployment allowlist contract.
- [x] Implement server and frontend changes in separable waves without publication controls.
- [x] Verify, independently review, and fix findings.

---

<!-- Document Metadata -->
| Key | Value |
|---|---|
| Agent | job-documenter |
| Task | Initialize showcase UX job |
| Job | showcase-ux-2026-09-12 |
| Version | 1.1 |
| Status | updated |
