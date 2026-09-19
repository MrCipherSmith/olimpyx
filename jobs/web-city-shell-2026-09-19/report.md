# Job report: City Shell (the whole app as the city)

## Summary
- **Spec:** [`PROMPT.md`](PROMPT.md) rev 3, approved by the owner. Reference: [`prototype.html`](prototype.html).
- **Branch:** `feat/web-city-shell`, worktree `../olimpyx-city-shell`, based on `main` @ `e2d1d69`.
- **Status:** ready for PR. Not pushed; waiting for owner confirmation.
- **Models:** Opus 5 for the shell, forum, dive and review work; Sonnet 5 for inhabitants, mobile, e2e and CSS.
- **Review:**
  1. The first review returned REQUEST_CHANGES: 0 blockers, 3 majors, 17 minors, 6 info.
  2. All of those were fixed.
  3. The re-review returned REQUEST_CHANGES: 1 medium, 4 minors.
  4. Those were fixed too.

## Waves

| Wave | Commit | Result |
|---|---|---|
| W1 shell and routing (Opus) | `dd2dc96` | The city is the full-screen app. A floating HUD shows nav counters from real data, a legend and the camera. Screens open as full-screen layers with Back to the city, URL/history routing, focus management and Escape. |
| W2 forum and buildings (Opus) | `ee550fc` | Library and Pantheon sit side by side on a screen-horizontal line of a square plaza (equal isoY, \|isoX\| = 216). The owner-only Praetorium is added, archetypes are richer, hover cards show real-data sublines, and labels avoid HUD panels and each other. |
| W3 dive and back (Opus) | `3c7ea8a`, `f18a108` | A pure dive state machine drives focus (650 ms), dive (550 ms), inside and exit, with an overlay and target lock. Deep links and Back/Forward are instant, and reduced motion and phones skip the dive. The camera fit keeps clear of the HUD. Clicking a label opens its building. |
| W4 inhabitants (Sonnet) | `2d3d5f0` | Only real agents appear. Online agents walk between the Pantheon and rooms linked to them by real activity; offline agents stand dimmed at the Pantheon. The count is capped at 40 (12 on phones) with a +N badge. |
| W5 phones and tablets (Sonnet) | `d692603` | Phones get a compact top bar, a bottom tab bar, a directory sheet, a zoom-only camera and a collapsible room description. Tablets get a compact, non-overlapping HUD. |
| W6 e2e and docs (Sonnet) | `9134d33` | Five specs were rewritten with their intents kept, and a new `city-shell-nav.spec.ts` was added. [`E2E_CHANGES.md`](E2E_CHANGES.md) lists every changed assertion. Adds after-screenshots and layout doc notes. |
| Review fixes (Opus/Opus/Sonnet) | `6bf6185`, `edfe982`, `e53edc3` | Inhabitants keep their phase and glide. History is deduplicated. The room poll stops off-screen. `inert` is set via ref. Dive names are bidi-safe. Label layout is cached. The phone HUD panels stack. The reduced-motion fade is kept. e2e runs on a virtual clock. |
| Re-review fixes (Sonnet) | `c6347ac` | The main HUD and tab bar are now measured as occluders. Sign-out returns to the guest city. The compact button has a CSS fallback. The overlay label assertion is restored. |

## Checks
- `npm --prefix apps/web run typecheck`: PASS.
- `npm --prefix apps/web test -- --run`: 316/316 in 31 files (156 on `main`).
- `npm --prefix apps/web run build`: PASS. JS 276.1 kB (88.4 kB gzip), CSS 47.4 kB (9.3 kB gzip).
- e2e: 26/26 locally while the specs were being written. The changed specs were repeated 2–3×. Final verification runs in PR CI (`check.yml`).

## Behaviour changes for the PR description
- There is no separate Overview page any more: Overview *is* the city. The guest intro, the activity feed and the latest-room/card links were removed; they could come back as a HUD panel.
- While a screen is open, the HUD is inert. To switch screens you go back to the city first, as in the prototype.
- The room header reads "N of M agents online in the network". The API has no per-room presence.
- Old class names and headings used by e2e changed: `.sidebar`, `.content`, `.conversation-head`, and "Network overview", "Public rooms", "Knowledge record". See [`E2E_CHANGES.md`](E2E_CHANGES.md).

## Known limitations
- The Rooms list dives into the plaza centre; there is no dedicated Forum building yet.
- There is no e2e test for clicking a canvas hover label. It would need a DOM hook exposing building screen rects. The behaviour is covered by unit tests.
- Inhabitant room links on the participant side come from the loaded room's messages. There is no activity feed for participants yet.
- Browsers without `inert` support expose the HUD under an open screen.
- A HUD panel that moves without resizing leaves the label cache stale until the next resize. This existed before this branch.

## Remaining steps
- Push and open a PR after owner confirmation. CI runs e2e, smoke and live; the CI monitor handles failures.
