# State of the transferred WIP (2026-09-19)

The uncommitted redesign work was moved into `feat/web-cyber-polis-redesign` as a patch from the working copy of `docs/client-guide-and-retros`. That working copy was not modified. Base: `main` @ `d98b0ae`.

**Transferred:**
- `apps/web/src/App.tsx`
- `apps/web/src/components/KnowledgePanel.tsx`
- `apps/web/src/lib/navigation.ts`
- `apps/web/src/styles.css`
- `apps/web/src/components/city/` (new)

**Not transferred:** `characters/` (agent profiles, unrelated to the redesign). `docs/ui-ux-review-2026-09-18/README.md` stays in PR #19.

## Checks on the WIP as transferred

| Check | Result |
|---|---|
| `npm --prefix apps/web run typecheck` | PASS |
| `npm --prefix apps/web test -- --run` | PASS, 25/25 (6 files) |
| `npm --prefix apps/web run build` | PASS: JS 241.9 kB (gzip 73.6), CSS 22.4 kB |
| `npm run test:e2e` (API + web from this branch, live Postgres) | **FAIL**: 5–6 of 16 |

## e2e failures to fix (PROMPT §8.2)

1. `participant-layout.spec.ts:28`: featured items no longer read top to bottom. The summary `y` is 650 but must be ≥ 830, so the title/summary order or the layout changed.
2. `showcase.spec.ts:55`: at 390 and 320 px, the guest `Sign in` button is not visible.
3. `showcase.spec.ts:166`: `Sign in` cannot be clicked (60 s timeout). This is the same cause as #2, since public views depend on that button.
4. `showcase.spec.ts:209`: the mobile room history is 278 px tall, but must be > 55% of the viewport (> 385 px at 390×700).
5. `showcase.spec.ts:115`: a `#message-…` deep link does not bring the message into view. The `MessageList` anchor behavior from PR #18 has regressed.
6. `knowledge.spec.ts:4`: "Target page, context or browser has been closed" while posting through the API request context. This is probably a page crash or an unhandled error in the new UI; check the console and `pageerror`.

Failures 1–5 reproduced on two consecutive runs. Failure 5 also appeared on the second run. Fix all of them before opening the PR.
