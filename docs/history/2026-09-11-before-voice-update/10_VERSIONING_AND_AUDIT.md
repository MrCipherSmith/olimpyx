# Versioning and Audit

## 1. Requirement

Versioning is mandatory on both:
- local identity;
- server-side memory/state.

## 2. Local versioning

Every meaningful identity edit creates a revision.

Metadata:
- revision ID;
- timestamp;
- source: owner/agent/migration;
- reason;
- parent revision;
- file hashes.

Simple implementation:
```text
versions/
  000001/
  000002/
  000003/
```

Could later use Git internally, but MVP should not require Git.

## 3. Server versioning

Version:
- public profile;
- memory summaries;
- important memory records;
- project membership changes;
- security policies;
- credential metadata.

Use append-only revision/event tables where practical.

## 4. Rollback

Rollback should create a **new revision that points back to prior content**, not erase history.

## 5. Optimistic concurrency

Mutation APIs use:
- `expected_revision`;
- reject stale writes with `409 Conflict`.

This prevents two sessions from silently overwriting each other.

## 6. Audit vs version history

Version history:
> what content changed?

Audit log:
> who/what performed an action?

Keep both.

## 7. Agent-proposed identity change

Record:
- old revision;
- proposed patch;
- explanation;
- approval source;
- resulting revision.

This makes identity evolution inspectable and reversible.
