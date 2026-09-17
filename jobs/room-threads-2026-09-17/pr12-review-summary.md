# Adaptive Review Summary: PR #12 — feat(threads): thread-structured public rooms (Q-009)

| Field | Value |
|---|---|
| **PR URL** | https://github.com/MrCipherSmith/olimpyx/pull/12 |
| **PR Title** | feat(threads): thread-structured public rooms (Q-009) |
| **Branch** | `feat/room-threads-q-009` based on `main` |
| **Author** | MrCipherSmith |
| **Diff size** | +2082 / −7 across 12 files |
| **Review date** | 2026-09-18 |
| **Reviewer** | adaptive review (orchestrator): verifier wave + coder-style wave |
| **Source artifacts** | [`verifier-review-pr12.json`](verifier-review-pr12.json), [`coder-review-pr12.json`](coder-review-pr12.json) |
| **Final verdict** | **FAIL** — one blocker (red CI) + 4 majors; implementation itself is functionally correct |
| **Recommendation** | Do not merge until blocker and 4 majors are addressed |

---

## 1. Files reviewed

### Code

| File | Change |
|---|---|
| `apps/server/src/app.ts` | +170 / −3 |
| `packages/client/src/client.js` | +16 |
| `packages/client/src/cli.js` | +29 / −2 |

### Tests

| File | Change |
|---|---|
| `apps/server/test/threads.test.ts` | NEW (+249) |
| `packages/client/test/threads.test.js` | NEW (+221) |

### Docs & state

| File | Change |
|---|---|
| `docs/ROADMAP.md` | ±1 |
| `jobs/room-threads-2026-09-17/plan.md` | NEW (+417) |
| `jobs/room-threads-2026-09-17/prd.md` | NEW (+406) |
| `jobs/room-threads-2026-09-17/report.md` | NEW (+70) |
| `jobs/room-threads-2026-09-17/review.md` | NEW (+451) |
| `jobs/room-threads-2026-09-17/state.json` | NEW (+45) |

### Skill

| File | Change |
|---|---|
| `skills/olimpyx-participant/SKILL.md` | +7 / −1 |

---

## 2. Headline findings

### 2.1 Blocker — test fails in CI

`apps/server/test/threads.test.ts:60` uses `password: "password123"` (11 chars).
`apps/server/src/validation.ts:11` requires `z.string().min(12)`.
`/v1/owners/register` returns HTTP 400, the test then crashes at `.data.access_token` (undefined).

**CI run #35268837963:** `not ok 16`, `tests 17 fail 1`.

The PR body claims "0 errors" and "41/41 client tests passing", which is true for the client side but ignores the server-side test failure.

**Fix:** change the literal to a ≥12-char string (e.g., `"password1234"`).

### 2.2 M1/M2/M3 from prior review — all correctly addressed

The PR body claims M1/M2/M3 are fixed. Both review waves confirmed static correctness:

- **M1 (idempotency collision)** — option (a) implemented. ON CONFLICT clause has `WHERE messages.reply_to_message_id IS NOT DISTINCT FROM EXCLUDED.reply_to_message_id AND messages.body = EXCLUDED.body`. App-layer `idem()` bodyHash returns HTTP 409 on collision.
- **M2 (inbox event shape)** — new `INSERT INTO inbox_events(id, agent_id, type, resource_kind, resource_id)` populates every column read by `/v1/inbox/events` (`event_id, cursor, type, occurred_at, resource.kind, resource.id`); `occurred_at` filled via `DEFAULT now()`. Compatible with PR #11 `listen` command.
- **M3 (cursor robustness)** — option (a) implemented. Mode C pre-flight `SELECT id FROM messages WHERE id=$1 AND room_id=$2 AND (id=$3 OR root_message_id=$3)`; returns 400 "Cursor does not belong" on cross-thread cursors.

---

## 3. Deduplicated findings table

| # | Severity | Location | Problem | Wave agreement |
|---|---|---|---|---|
| 1 | **blocker** | `apps/server/test/threads.test.ts:60` | 11-char password violates `validation.ts:11` min(12). Test crashes, CI red. | verifier (reproduced) |
| 2 | **major** | `apps/server/src/app.ts:43` | `CREATE INDEX IF NOT EXISTS` is **not** CONCURRENTLY. On populated `messages` table takes ACCESS EXCLUSIVE and may exceed the 120s `compose up --wait-timeout` in `deploy/deploy-geekom.sh`. | verifier |
| 3 | **major** | `docs/ROADMAP.md:40` | Q-009 still reads "In progress"; should be "✅ Resolved by PR #12" after merge. | verifier + coder |
| 4 | **major** | `jobs/room-threads-2026-09-17/state.json` | `verification.status="completed" / passing=true` contradicts the CI failure. | verifier + coder |
| 5 | **major** | `apps/server/src/app.ts` GET/POST + `messageFrom` | New handlers reformatted multi-line; 51 surrounding handlers stay one-line. Style break. | coder |
| 6 | **major** | `apps/server/src/app.ts` POST handler | Inbox event INSERT SQL duplicated twice; not factored into a helper. | coder |
| 7 | **major** | `jobs/room-threads-2026-09-17/report.md` | Test inventory inaccurate. Claims `dlp.test.js: 2/2 passed` (file **does not exist**) and `session.test.js: 9/9 passed` (real: 3). The total of 41 coincidentally adds up because phantom dlp balances omitted redaction+state. | coder |
| 8 | minor | `apps/server/test/threads.test.ts` | ECONNREFUSED skip pattern is unique; `mvp.test.ts` does not use it. | coder |
| 9 | minor | `app.ts` reply edge case | Broken `root_message_id` reference → opaque 422 instead of clear 400/404. | coder |
| 10 | minor | `threads.test.ts` | Test 1 (Migration & Invariant) from plan §3 has no explicit assertion (only implicit). | coder |
| 11 | minor | `app.ts` GET handler | `thread_id` and `root_only` query params are read raw from `req.query as any`, no Zod validation. | coder |
| 12 | minor | `apps/server/test/threads.test.ts` | Test 12b (nonexistent parent via POST) partial — exists in client test but not as 404 assertion in server test. | verifier + coder |
| 13 | minor | `SKILL.md` | Does not mention 2-level flatten semantics. | coder |
| 14 | minor | `app.ts` | Inbox event INSERT appears in 4 sites total (this PR adds 2, original code has 2). | coder |
| 15 | minor | `app.ts` `messageFrom` | Refactored from inline arrow to multi-line function declaration. Style break. | coder |

### 3.1 Statistics

| Wave | Verdict | Blockers | Majors | Minors | Nits |
|---|---|---|---|---|---|
| Verifier | FAIL | 1 | 3 | — | — |
| Coder | PARTIAL | 0 | 4 | 7 | 5 |
| **Merged (deduplicated)** | **FAIL** | **1** | **6** | **8** | **5** |

---

## 4. What is good (do not regress)

Both review waves agreed on these positives:

- **Implementation is functionally correct.** M1/M2/M3 fixes from prior review are sound.
- **SQL design is sound.** Mode B `LEFT JOIN LATERAL` works with the new index; Mode C cursor pre-flight validates thread membership.
- **Idempotency collision fix is elegant** — slightly more graceful than option (a) proposed in `review.md`.
- **Inbox event payload fully compatible with PR #11 listener** — no shape drift between server and client.
- **Cursor validation handles both directions** — root-as-cursor or reply-as-cursor.
- **Backward compatibility preserved.** Default `GET /v1/rooms/:roomId/messages` is unchanged when no query params.
- **Migration is idempotent** — `ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`.
- **41/41 client tests passing** — actual sum is correct (5+10+8+4+3+2+3+6); only the per-file breakdown in `report.md` is wrong.
- **TypeScript clean.** 0 errors.

---

## 5. Recommended fix plan

### 5.1 Minimum to unblock merge (5 fixes, ~15 min)

| # | File | Change |
|---|---|---|
| 1 | `apps/server/test/threads.test.ts:60` | `password: "password1234"` (≥12 chars) |
| 2 | `apps/server/src/app.ts:43` | `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_root` |
| 3 | `docs/ROADMAP.md:40` | Q-009 → `✅ Resolved by PR #12` |
| 4 | `jobs/room-threads-2026-09-17/state.json` | `verification.status` → `in_progress` until CI passes |
| 5 | `jobs/room-threads-2026-09-17/report.md` | Remove `dlp.test.js` (does not exist), correct `session.test.js: 3` (not 9), add `redaction: 2/2` and `state: 6/6` |

After these, CI should pass. PR can be reviewed and merged.

### 5.2 Recommended follow-up (after merge)

- Split threads logic into `apps/server/src/threads.ts` to reduce 170-line addition to `app.ts`.
- Restore one-line handler style in `app.ts` GET/POST and `messageFrom`.
- Factor `INSERT INTO inbox_events` into a shared `emitInboxEvent(agentId, kind, resourceKind, resourceId)` helper.
- Add explicit Test 1 (Migration & Invariant) assertion in `threads.test.ts`.
- Add Zod validation for `thread_id` and `root_only` query params.
- Document 2-level flatten in `SKILL.md`.
- Improve broken-root error path to return 400/404 instead of opaque 422.

### 5.3 Out of scope for this review

- Performance benchmarking of Mode B LATERAL JOIN
- Concurrency stress testing (parallel replies to same thread)
- UI/UX gap analysis (deferred per PRD §8 #4)
- Production migration on live traffic (Plan §4 covers rollback only)

---

## 6. Open questions for the author

1. **Why "password123"?** Was this typed from memory, copied from an older test, or generated without verifying the validation constraint? Worth noting because the same mistake could appear in future tests.
2. **Why non-CONCURRENT index?** Was the trade-off of deploy-time lock considered? `deploy/deploy-geekom.sh:62` uses `--wait-timeout 120`, which is tight.
3. **Why expand handler formatting?** The 51 surrounding handlers are one-line. Was this intentional or accidental?
4. **Why is `dlp.test.js` referenced in `report.md`?** Was it renamed, removed, or hallucinated? `git log -- packages/client/test/dlp.test.js` returns nothing.
5. **Should `verification` phase in `state.json` be left `in_progress` until CI is observed green?** Currently it claims `completed` while CI is failing.

---

## 7. References

- **PR**: https://github.com/MrCipherSmith/olimpyx/pull/12
- **Branch**: `feat/room-threads-q-009` (origin and local)
- **Diff**: `git diff origin/main..origin/feat/room-threads-q-009` (2082 / −7)
- **CI run**: #35268837963 (`not ok 16`)
- **Prior review**: [`jobs/room-threads-2026-09-17/review.md`](review.md) (M1/M2/M3 origin)
- **Verbatim findings**:
  - [`jobs/room-threads-2026-09-17/verifier-review-pr12.json`](verifier-review-pr12.json) — 4 findings (1 blocker, 3 majors), FAIL
  - [`jobs/room-threads-2026-09-17/coder-review-pr12.json`](coder-review-pr12.json) — 16 findings (4 majors, 7 minors, 5 nits), PARTIAL
- **Related PR**: #11 (PR #11 listener at `7ade497`) — inbox event consumer

---

*Review complete. Summary written 2026-09-18. Awaiting author decision on fix scope.*
