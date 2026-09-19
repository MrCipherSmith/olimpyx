# Job report: Cyber-Polis web redesign

## Summary
- **Intent:** implement [`PROMPT.md`](PROMPT.md) rev 2, starting from the transferred WIP ([`WIP_BASELINE.md`](WIP_BASELINE.md)).
- **Branch:** `feat/web-cyber-polis-redesign`, worktree `../olimpyx-redesign`, based on `main` @ `d98b0ae`.
- **Final status:** ready for PR. Not pushed; waiting for owner confirmation.
- **Review:** 3 parallel reviews (security/logic, performance, frontend/a11y) found 0 blockers, 5 majors, about 25 minors. After fixes, a re-review returned APPROVE_WITH_SUGGESTIONS. Its 5 remaining findings are closed.

## Waves

| Wave | Agent | Result | Commit |
|---|---|---|---|
| Transfer | orchestrator | WIP moved as a patch; the main copy was not touched | `89ff378` |
| W1 | Opus | Fixed 6 e2e regressions (features, guest Sign in, mobile room, deep link, nav rename). Added design tokens, self-hosted fonts, reduced motion and AA contrast | `c2799ae` |
| W2 | Opus | Split `App.tsx` from 496 to 100 lines with no DOM change (24-state diff was empty) | `25ad851` |
| W3b | Sonnet | Owner controls on the Q-016 endpoints (stop, revoked, usage, limits, 429 handling) | `3bf6d2c` |
| W3a | Opus | Isometric city: extra rings beyond 30 rooms, deterministic archetypes with a strict whitelisted prefix, accessible building list, reduced motion, guest/participant data separation | `a7d18e2` |
| W4 | Sonnet | Page redesigns, real network status, http(s)-only source links (closes a `javascript:` hole) with XSS tests, and after-screenshots | `5fafca2` |
| Review fixes | Opus (city) and Sonnet (app) | City perf (glow sprites, static layer, 30 fps cap, culling) and a11y (focus trap, contrast, roles, stale-response guards, idempotency per intent) | `c6e8e4e`, `724a702` |
| Re-review fixes | Sonnet | Network status semantics, dialog controls while sending, `retry_after_sec: null`, halo culling, no cache rebuild while the camera moves | `92fda96` |

## Delivered against PROMPT.md
- **§1** No fake telemetry: network status comes from real loads and the room poll. Untrusted text is never rendered as HTML.
- **§2** All colours come from tokens, with none hard-coded outside `tokens.css`. Contrast is AA and enforced by `contrast.test.ts`. Fonts are self-hosted (Space Grotesk and JetBrains Mono, woff2, about 80 kB). Glass panels have a fallback. Reduced motion is respected.
- **§3** City:
  - isometric math, painter's sort and ring layout;
  - Library and Pantheon;
  - one rAF loop that pauses when hidden or off screen, respects DPR, and caps decorative frames at about 30 fps;
  - an accessible building list, `role="img"` on the canvas, and keyboard control;
  - guests see the city built from the snapshot only.
- **§4** 4×3 archetypes, assigned deterministically from `room_id`. An explicit choice is stored as a whitelisted `[archetype:<id>] ` prefix, which is hidden across the UI and counts toward the 1000-character limit.
- **§5** The pages are redesigned. `App.tsx` is split into components. Knowledge search offers Hybrid, Lexical and Semantic, falling back to Lexical on a 503.
- **§6** `stopAgent`, `revoked`, `usage` and `limits` are wired up. 429 responses show a friendly message.
- **§7** Nothing uses `dangerouslySetInnerHTML`. Source links must be absolute http(s). XSS tests cover `linkedBody`, `safeUrl` and `SourceLink`.
- **§8** The e2e-guarded classes and accessible names are kept. One e2e line changed: `knowledge.spec.ts` now looks for the nav link `Agents` instead of `Agent directory`, because §5.1 renames it.

## Checks
- `npm --prefix apps/web run typecheck`: PASS.
- `npm --prefix apps/web test -- --run`: 155/155 in 21 files (was 18 before the redesign, 25 in the WIP).
- `npm --prefix apps/web run build`: PASS. JS 251.5 kB (78.7 kB gzip), CSS 47.9 kB (9.1 kB gzip), fonts about 80 kB.
- **e2e, smoke and live are deferred to CI** (`check.yml` runs on the PR). For reference, e2e passed 16/16 several times locally during W1–W4, before the owner asked to stop duplicating CI.

## Notes for the PR description
- Agents and the CLI see the `[archetype:…] ` prefix in the raw room description. Any author can write that prefix. It is whitelisted, and the UI hides it.
- Rooms created with the WIP's older, non-whitelisted prefix ids (for example `curia_senate`) fall back to the deterministic archetype. Their prefix stays visible as ordinary text.
- The e2e nav link was renamed from `Agent directory` to `Agents`. The page heading is still `Agent directory`.
- Space Grotesk has no Cyrillic, so Russian headings use the system fallback font. The Russian building labels carry `lang="ru"`.
- The after-screenshots in `docs/ui-ux-review-2026-09-18/screenshots-after/` (3.2 MB) are guest routes only, captured from local data.

## Remaining steps
- Push and open a PR after owner confirmation. CI then runs e2e, smoke and live, and the CI monitor handles failures.
