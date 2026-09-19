# Olimpyx City Shell — job report (skeleton)

> Job: `web-city-shell-2026-09-19` · Branch `feat/web-city-shell` · Base `main@e2d1d69`
> Spec: `PROMPT.md` rev 3, approved 2026-09-19.
> This is a skeleton assembled during W6; the orchestrator finalizes wording, links the PR, and fills in
> any `TODO` left below.

## Summary

TODO (orchestrator): one paragraph — the city shell replaces the sidebar/tab layout with a full-screen
isometric city; every screen (room, Library, Pantheon, Praetorium, room directory) opens as a full-screen
layer via a dive transition; phones get a bottom tab bar and a compact HUD.

## W1 — Shell and routing

- Scope: PROMPT §2, §4 (URL/history/focus), §5 (screens as layers).
- Commit: `dd2dc96`.
- Key files: `apps/web/src/components/shell/{CityShell,ScreenLayer,useCityRoute}.tsx/.ts`, `apps/web/src/lib/navigation.ts`.
- TODO (orchestrator): summary of what W1 delivered and any open follow-ups it flagged for later waves
  (it flagged the e2e assertion list that W6 rewrote — see `E2E_CHANGES.md`).

## W2 — Forum and buildings

- Scope: PROMPT §3 (horizontal Library/Pantheon, Praetorium, plaza, HUD-safe labels, hover labels).
- Commit: `ee550fc`. Ran in parallel with W3.
- Key files: `apps/web/src/components/city/{cityScene,cityRenderer,cityTokens}.ts`.
- TODO (orchestrator): summary + any unit-test coverage notes (forum layout overlap/label-safety tests).

## W3 — Dive and back

- Scope: PROMPT §4 (dive/back state machine, overlay, camera, reduced motion).
- Commit: `3c7ea8a` (+ `f18a108` label click).
- Key files: `apps/web/src/components/shell/{diveMachine,diveTargets,DiveOverlay}.ts/.tsx`.
- TODO (orchestrator): summary; note that W6 added `tests/e2e/city-shell-nav.spec.ts` to exercise this
  state machine end-to-end (focus → dive → overlay → screen, Back's exit animation, Escape cancelling an
  in-progress dive, deep links skipping the dive, browser Back/Forward).

## W4 — Real inhabitants

- Scope: PROMPT §6 (real agents walking the roads, online/offline split, figure cap).
- Commit: `2d3d5f0`.
- Key files: `apps/web/src/components/city/inhabitants.ts`.
- TODO (orchestrator): summary.

## W5 — Phones and tablets

- Scope: PROMPT §7 (phone tab bar, compact HUD, tablet layout fix).
- Commit: `HEAD` at the start of W6 (`d692603`).
- Key files: `apps/web/src/components/shell/MobileTabBar.tsx`, `apps/web/src/styles/shell.css`
  (`@media (max-width: 600px)` block).
- TODO (orchestrator): summary. Note a small gap W6 found and fixed while writing e2e coverage for this
  wave's phone contract — see "Bugs found" below.

## W6 — e2e rewrite, screenshots, docs

- Scope: PROMPT §8 (e2e rewrite keeping intent, screenshots, docs).
- Specs rewritten: `tests/e2e/showcase.spec.ts`, `tests/e2e/showcase-edge-cases.spec.ts`,
  `tests/e2e/participant-layout.spec.ts`, `tests/e2e/knowledge.spec.ts`, `tests/e2e/observatory.spec.ts`.
- Spec added: `tests/e2e/city-shell-nav.spec.ts` (HUD nav dive/instant open, "Back to the city", browser
  Back/Forward, Escape, building label/list click).
- Full assertion-by-assertion change list: `jobs/web-city-shell-2026-09-19/E2E_CHANGES.md`.
- Local e2e result (authoring only, per owner policy — CI runs the real verification): **25/25 passed**,
  including a `--repeat-each=2` rerun of the new dive-timing spec to check for flakiness.
- Screenshots ("after", guest routes, local data only): `docs/ui-ux-review-2026-09-18/screenshots-after-city-shell/`
  — city, room, knowledge, agents, sign-in at 1440 and 390px, plus one dive mid-frame at 1440px.
- Docs updated (brief, not rewritten): `docs/room-scroll-layout.md`, `docs/ui-layout-verification.md` —
  both got a short "Update (City Shell, …)" note pointing at the new shell and at `E2E_CHANGES.md`,
  since they otherwise describe the pre-shell sidebar layout throughout.
- Local verification run for this wave: `npm --prefix apps/web run typecheck`, `npm --prefix apps/web
  test -- --run`, `npm --prefix apps/web run build` — TODO (fill in pass/fail once the run in this
  session completes; see the wave's own final status message for the numbers at authoring time).

### Bugs found during W6

- **Fixed (trivial):** a guest's room screen at 320×568 could keep two action buttons ("↻ Refresh" and
  "Sign in") after W5 hid "All rooms"; they wrapped to a second row and pushed the message history under
  its 55%-of-viewport contract. Fixed by hiding the room screen's guest-only "Sign in" action on phones
  too (`apps/web/src/components/showcase/PublicShowcase.tsx` + `apps/web/src/styles/shell.css`), since
  it's still one tap away via "Back to the city" → the compact top bar. Full detail in `E2E_CHANGES.md`.
- TODO (orchestrator/review): any other findings from the review wave go here.

## Review

TODO (orchestrator): summary of the review pass and any fix iterations.

## PR

TODO (orchestrator): PR link, once opened (conditional on user confirmation per the job plan).
