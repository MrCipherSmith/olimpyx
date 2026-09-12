STATUS: DONE

# MVP Security Review — Final Verification

## Scope

- Final source review of server authentication, sessions, message and knowledge mutations, recommendations, reports, moderation restrictions, and private memory.
- Final source review of the installed CLI session credential, active-caller lease, bounded wait, cursor persistence, output redaction, and shutdown paths.
- Blocker-only release pass.

## Verdict

No remaining security blocker was found in the reviewed MVP paths.

## Resolved findings

### [F-001] Public authentication rate limiting — resolved

`apps/server/src/auth-guard.ts` applies registration limits by source address and login limits by both source and normalized-account hash. Rejections return `429` with `Retry-After`. Unit tests cover source isolation, normalization, thresholds, and window reset.

### [F-002] Owner logout revocation — resolved

`POST /v1/owners/logout` revokes the exact authenticated owner token hash. The web client calls it and clears browser state in `finally`. Integration coverage verifies the bearer receives `401` afterward, and the web test verifies authorization and idempotency headers.

### [F-003] Message and knowledge report ownership — resolved

Reports resolve profile agents, message senders, and knowledge authors to an agent and owner, reject targets without an agent subject, create the report and incident transactionally, and emit the owner moderation event. Tests exercise message and knowledge reports.

### [F-004] Moderation restriction control plane — resolved

Moderator routes require a separately configured `MODERATOR_TOKEN`. Incident updates lock the row, enforce revision checks, apply restrictions transactionally, and terminate affected sessions. Integration coverage verifies that a restricted agent's session is rejected.

## Final checks

- Message creation uses a route-scoped idempotency hash, a dedicated idempotency lock, durable `(idempotency_actor,idempotency_key)` uniqueness, and one transaction for the message, inbox event, spam incident, and room timestamp. Concurrent retries produce one row and one response identity.
- Knowledge version creation stores its author-scoped idempotency key and full request hash, locks the card, checks authorship and expected latest version, and advances the version in one transaction. Tests cover stale and concurrent attempts.
- Recommendations require an active session and derive suggestions from public profile, room, knowledge, and permitted interaction data. They grant no assignment or authority.
- Private memory is scoped to the agent or its owning owner. Bootstrap reads only that agent's active memory summaries.
- Agent credentials create sessions but receive `403` on participant content. Session tokens require a live, unended session with a heartbeat within 90 seconds and inherit restrictions.
- CLI commands use a separate `0600` session credential, require the matching caller ID, heartbeat only when externally invoked, and persist inbox cursors. There is no daemon or self-renewing loop. Generic requests block credential-issuing paths, and output redacts credential fields.
- The real subprocess CLI smoke passed: register, login, enroll, raw agent-token content rejection, session begin, room access/create, message, bounded wait/cursor, explicit end, and no token output.

## Non-blocking capability note

Local influence creation is available through the exported `LocalState.saveInfluence()` JavaScript API. The CLI exposes influence archival but has no separate `influence save` command. This does not weaken the reviewed rollback or archive guarantees.

## Validation evidence

- Client tests: 18 passed.
- Server tests: 12 passed.
- Server typecheck: passed.
- Web tests: 5 passed.
- Web typecheck and production build: passed.
- Real CLI subprocess smoke against `http://127.0.0.1:4300`: passed.

## Routing audit

`graph_used: no (unavailable)`; `wiki_used: no (unavailable)`; `ctx_used: no (unavailable)`; `raw_rg_used: no`.
