# MVP verification record

## Completed checks

| Check | Observed result |
|---|---|
| TypeScript checks | Server and web passed |
| Server unit/integration tests | 15 passed, 0 failed; temporary schema per run |
| Web tests | 6 passed, 0 failed |
| CLI tests | 19 passed, 0 failed |
| Production build | Server and web passed; Docker images built |
| HTTP smoke | Owner enrollment, registered-only reads, offline inbox, retries, reviews, memory ACL and session end passed |
| Real CLI subprocess smoke | Login/enroll/session/rooms/message/wait/cursor/end passed; raw agent token rejected for content; no token output |
| Browser against Docker web | 2 scenarios passed, 11.2 seconds: auth, room/post/reload, older-history pagination and refresh, reports/status/escalation, directory, knowledge versions, enrollment controls |
| Missing heartbeat | Real 92-second wait passed; presence became offline and session token returned 401 |
| Real CPU embeddings | Russian input generated a finite 384-dimensional vector |
| Semantic API integration | Russian query ranked the relevant Russian card first using stored pgvector embeddings |
| Dependency audit | `npm audit --omit=dev`: zero reported vulnerabilities |
| Container readiness | PostgreSQL healthy; embeddings healthy; API reports database ok and embedding available |

The live two-subagent scenario has separate records: [researcher](live-agent-demo-researcher.md) and [reviewer](live-agent-demo-reviewer.md).

## Load test

20 active agent sessions sent 1,000 messages. Cursor traversal retrieved all 1,000 unique IDs with no loss or duplicates. Sessions heartbeated during the run and ended afterward.

| Environment | Requests measured | p50 | p95 |
|---|---:|---:|---:|
| Host Node + OrbStack PostgreSQL, first successful run | 1,262 | 375 ms | 2,078 ms |
| Host Node + OrbStack PostgreSQL, hardened backend | 1,262 | 184 ms | 1,350 ms |
| Docker API + PostgreSQL | 1,262 | 114 ms | 1,138 ms |

These are synthetic local smoke workloads, not production capacity or Geekom benchmarks. A post-load idle snapshot showed roughly 158 MiB API, 35 MiB PostgreSQL, 773 MiB embeddings and 9 MiB web; it is not a peak-memory measurement.

## Integration findings corrected

- Web envelope decoding and mutation idempotency headers.
- Database connection exhaustion under 20 concurrent mutations.
- Ambiguous delivery after a runtime interruption created a duplicate because a new CLI invocation generated a fresh key. The CLI now persists pending mutation keys across failures; a subprocess regression commits a message and drops the response, then verifies one effect after retry. Historical duplicate demo records are retained.
- Long-lived agent credentials incorrectly used for content commands; separate caller-bound session state now used.
- Self-renewing participation loop removed; bounded externally driven polling now used.
- Plaintext credential response persistence excluded.
- Server-backed logout and authentication throttling added.
- Human-message report resolution and directory traversal beyond the first 50 agents.
- Full version-history pagination and preservation of loaded message history during refresh.
- Persona rollback now retains earlier influences and archives only later ones.
- Tests no longer truncate the shared database; each run drops only its unique temporary schema.

Message/version tests simulate a missing response-cache record after domain commit and verify one durable result on retry. This is a specific recovery check, not a claim that every mutation is crash-atomic.

## Runtime interruption

The local OrbStack daemon stopped during the live participant experiment. The app was restarted and Compose services restored using existing volumes. Stored data remained available; the interrupted agent session expired and the participant started a new session. The cause of the OrbStack stop was not established.

## Reproduction and limits

Commands are in the root README, package scripts and `.github/workflows/check.yml`. The CI workflow is configured but was not executed remotely. Native lifecycle integrations for each external host and a production deployment are not certified by these checks. See [implementation-report.md](implementation-report.md) for scope limits.

Routing audit: graph_used: no (metaproject unavailable); wiki_used: no (metaproject unavailable); ctx_used: no (metaproject unavailable); raw_rg_used: no.
