# W6 — e2e rewrite changes (PROMPT rev 3 §8)

Every assertion below changed because the shell (W1–W5) replaced the old sidebar-tab layout with a
full-screen city and screens that open as layers over it. Line numbers on the "old" side refer to each
spec file as it stood on `HEAD` (`d692603`) before this wave; "new" line numbers refer to the rewritten
file. Each test's original intent (guest safety, deep links, scroll containment, owner flows, mobile
contract, dive/back) was kept — only the selectors and navigation steps changed.

## Cross-cutting changes (apply to most files)

| Old assertion | New assertion | Reason |
|---|---|---|
| `getByRole('heading', { name: 'Network overview' })` | `getByRole('heading', { name: 'Olimpyx city', exact: true })` (visually-hidden `<h1>` in `CityView.tsx`), or no heading check at all | The overview dashboard screen is gone; the overview *is* the city canvas. |
| `getByRole('heading', { name: 'Public rooms' })` | `getByRole('heading', { name: 'Rooms', exact: true })` | `ScreenLayer` title renamed (`App.tsx`/`PublicShowcase.tsx`, `title="Rooms"`). |
| `getByRole('heading', { name: 'Agent directory' })` | `getByRole('heading', { name: 'Pantheon of Agents', exact: true })` | Screen renamed to the Pantheon landmark; `AgentsPanel`'s own `<h2>Agent directory</h2>` still exists one level down but is no longer the assertion target. |
| `getByRole('heading', { name: 'Knowledge record' })` / `card.latest.topic` | `getByRole('heading', { name: 'Central Library of Knowledge', exact: true })`, plus an `<h2>`-level check for the selected card's topic where the test needs to prove the right card loaded | Screen renamed to the Central Library landmark; the topic is no longer the screen's own `<h1>`. |
| Clicking a second HUD nav link (e.g. `Owner controls`, `Sign out`, `Agents`) while another screen is already open | Click `getByRole('link', { name: 'Back to the city', exact: true })` first, then the next nav link/tab | `CityShell.tsx` makes the entire HUD (`.city-shell-hud`) `inert` + removed from the a11y tree while a screen covers the city (`CityShell.test.tsx` asserts this directly), so a second screen is unreachable without closing the first. |
| `.sidebar` / `.content` bounding-box or scroll checks | `.screen-header` bounding-box checks; the page-level `.content` scroll check has no replacement | The two-column sidebar layout is gone; the room screen's header (`ScreenLayer`'s `<header class="screen-header">`) is the thing that must stay put while the feed scrolls. There is no more scrollable dashboard pane to test — the city canvas doesn't scroll, and that's already covered by the existing no-horizontal/vertical-document-scroll checks. |
| `.conversation-head` | `.screen-header` | Renamed as part of the room screen becoming a full `ScreenLayer` instead of a panel inside the sidebar. |
| `getByRole('link', { name: '← Rooms' })` | `getByRole('link', { name: 'All rooms', exact: true })` (desktop/tablet) — hidden (`toBeHidden()`) at phone widths, where the only way back is `Back to the city` | Wording changed and, per W5, `.screen-room .screen-actions a` (which includes "All rooms") is `display:none` on phones — redundant with the tab bar's Rooms tab. |
| `.room-list` visibility toggling directly off a `'← Rooms'`/`'All rooms'` click while inside a room, on a phone | Click `Back to the city` (closes to the city), assert `.screen-layer` has count 0, then click the `Rooms` tab/nav link to reopen the directory before asserting `.room-list` | "All rooms" is hidden on phones (see above), so the only path from a room back to the directory is via the city. |
| `.mobile-room-description` click-to-toggle button | `page.getByText('Description', { exact: true }).click()` on the native `<summary>`, then assert `.room-description-details p` visible/hidden | `RoomHeader.tsx`'s `RoomSubline` now collapses the description behind a native `<details>`/`<summary>` disclosure instead of a custom toggle button. |
| `getByRole('navigation')).toBeHidden()` (phone, room open) | `getByRole('navigation')).toHaveCount(0)` | The tab bar isn't just visually hidden — it's `inert` and removed from the accessibility tree while a screen is open, same as the desktop HUD nav; `toHaveCount(0)` asserts that precisely instead of relying on `toBeHidden()`'s zero-match fallback. |

## `tests/e2e/showcase.spec.ts`

| Old (old file, line) | New | Reason |
|---|---|---|
| `guest follows a shared room…`, L38 `getByRole('link',{name:'Knowledge'}).click()` straight from an open room | L: click `Back to the city`, assert nav visible, *then* click `Knowledge`; `goBack()` twice (city, then the original room deep link) instead of once | Screen-to-screen switch now requires closing first (see cross-cutting); the extra "Back to the city" push adds one more history entry, so the browser-back assertion now walks city → room instead of room→room directly, which is a stronger regression test of the dive controller's history handling. |
| `public overview shows published work…`, L59 `getByText(card.latest.topic).first()` visible on `/` | `getByRole('button').filter({ hasText: room.title })` visible in the accessible building list on `/` | The overview no longer lists cards/rooms as text; published rooms instead appear as buildings in `CityBuildingList`. |
| same test, L60 `getByText('Nothing new yet')` count 0 | removed (no replacement) | That empty-state string belonged to the old overview dashboard and no longer exists anywhere in the app (`grep` confirms). |
| `long room history scrolls…`, L87–88 `.sidebar` / `.conversation-head` | `.screen-header` only | See cross-cutting `.sidebar`/`.conversation-head` rows. |
| `overview metrics navigate and refresh…` (whole test, L129–148: `getByRole('button', { name: /Published agents/ })` etc., `/Read the latest room/`) | New test `HUD navigation opens each screen, Back returns to the city, and refresh reloads the open room`: loops the HUD nav links themselves (`Agents`/`Knowledge`/`Rooms`) with a `Back to the city` between each, then opens the one room from the directory and exercises Refresh | The clickable per-metric overview buttons and the "Read the latest room" link were part of the removed dashboard; the same intent (nav + refetch-on-refresh) is now expressed through the HUD/tab-bar nav and the room screen's own Refresh action. |
| `all public views…`, L173–176 route/heading table | Updated headings per the table above (`Olimpyx city`, `Rooms`, `Pantheon of Agents`, `Central Library of Knowledge`) | Screen renames. |
| same test, L181–182 `if (width<=600) '← Rooms' inViewport else 'Knowledge' inViewport` | `if (route === '/') 'Showcase navigation' nav inViewport else 'Back to the city' link inViewport` (all widths) | The old branch assumed the HUD nav (`Knowledge`) stayed reachable while any non-room screen was open; it doesn't any more (HUD is inert whenever *any* screen is open, not just for rooms). The one thing that's always reachable, at any width, whenever a screen is open, is "Back to the city". |
| same test, L214 `getByRole('button', { name: 'Sign in' }).click()` right after the route loop | `page.goto('/')` first, then click `Sign in` | The last route in the loop leaves a screen open, so the HUD's "Sign in" button (part of the inert HUD) is unreachable; this previously caused a 60s timeout. |
| `mobile room prioritizes history…` (whole test) | Renamed `mobile room prioritizes history and hides the tab bar, directory and "All rooms" while it is open`; class/selector changes per the cross-cutting table | Same test intent (history >55%, directory/description on demand), rewired for the new phone shell. |

## `tests/e2e/observatory.spec.ts`

| Old (line) | New | Reason |
|---|---|---|
| L12 `getByRole('heading',{name:'Network overview'})` | `getByRole('heading',{name:'Olimpyx city',exact:true})` (`toBeAttached()`, since it's visually hidden) | Screen removed. |
| L27 `getByRole('link',{name:'Rooms'}).click()` immediately after `page.reload()` while a room screen's URL is current | `getByRole('link',{name:'All rooms',exact:true}).click()` | After a reload the room screen reopens immediately from its own URL; the HUD "Rooms" nav link is inert while it's open. This was the cause of a genuine 60s test timeout during authoring — not a product bug, a test ordering bug. |
| L42 `getByRole('link',{name:'Owner controls'}).click()` directly from an open room, after seeding history | Added `getByRole('link',{name:'Back to the city'}).click()` immediately before it | Same inert-HUD rule. |
| L44 `getByRole('button',{name:'Sign out'}).click()` directly from the Owner controls screen | Added `Back to the city` click first | "Sign out" lives in the HUD account block, inert while Owner controls is open. |

## `tests/e2e/participant-layout.spec.ts`

| Old (line) | New | Reason |
|---|---|---|
| L38–44 `.featured-panel>div` eyebrow/title/summary vertical-order check | Removed | That was the old overview dashboard's own layout invariant; no equivalent element exists in the city shell. |
| L46–50 `.sidebar`/`.content` scroll-without-moving check | Removed (no page-level scrollable content pane exists any more); the room's `.screen-header` fixed-while-scrolling check (see below) covers the surviving part of the intent | The dashboard's scrollable content column doesn't exist; the city canvas itself has no document scroll (already covered elsewhere). |
| L52 `getByRole('link', { name: /Open latest room/ }).click()` | `getByRole('link', { name: 'Rooms', exact: true }).click()` then click the one fixture room in `.room-list .room-row` | "Open latest room" was an overview-dashboard shortcut; opening it through the Rooms screen is the shell's actual path. |
| L57/61 `.conversation-head` | `.screen-header` | Renamed. |
| L66–73 mobile block: `'← Rooms'` click, `.room-list`, `.conversation` | `Back to the city` → assert `.screen-layer` count 0 → `goBack()` → `Back to the city` → `Rooms` tab → `.room-list` | "All rooms" hidden on phones (W5); the round trip now goes through the city. |
| L78–86 route/heading table | `Pantheon of Agents` / `Central Library of Knowledge` names updated; `Owner controls` unchanged | Screen renames. |

## `tests/e2e/knowledge.spec.ts`

| Old (line) | New | Reason |
|---|---|---|
| L24 `getByRole('heading',{name:'Network overview'})` | `getByRole('heading',{name:'Olimpyx city',exact:true})` | Screen removed. |
| L27→31 `Knowledge` link click, then straight to `Agents` link click from the open card | Added `Back to the city` between `Knowledge`→card and `Agents` | Inert HUD while the Knowledge screen is open. |
| L31→33 `Agents` link click, then straight to `Owner controls` | Added `Back to the city` between them | Same. |

## `tests/e2e/showcase-edge-cases.spec.ts`

| Old (line) | New | Reason |
|---|---|---|
| `guest owner route recovers…`, L55–57: poll for `Network overview` heading + `Showcase navigation` nav, or the normalized URL, or the sign-in form | Assert `Owner controls` heading count 0, `.screen-layer` count 0, and `Showcase navigation` nav visible | `?view=owner` for a guest is rewritten to the city *in the displayed route* (PublicShowcase's `guestRoute`), but the browser URL itself is not rewritten via `history.replaceState` — polling for a URL change was never guaranteed to pass and the "Network overview" heading it also polled for no longer exists. The new assertion checks the actually-guaranteed outcome: no owner screen renders, and the city/nav shows instead. |
| `authenticated read 401…`, L75: `getByText('Previous owner private room', { exact: true })` | Same text, scoped to `.room-list` (`page.locator('.room-list').getByText(...)`) | The same room title also appears as a building label in the (inert, aria-hidden) city underneath the open Rooms screen, so the unscoped locator now matches two elements (strict-mode violation) — it didn't before because the old layout had no such background city. |

## New: `tests/e2e/city-shell-nav.spec.ts`

Added per PROMPT §8 to directly exercise the shell mechanics that didn't have a home in the content-focused
specs above:
- opening a screen by diving (focus → target lock → dive → overlay → screen, with the camera and focus
  restored by "Back to the city"), using the accessible building list for deterministic targeting;
- the same opens/closes instantly under `prefers-reduced-motion: reduce`, and via a phone-width viewport
  (which disables the dive regardless of motion preference);
- a deep link opens its screen immediately with the city still mounted (inert) underneath, and "Back to
  the city" still plays the zoom-out/exit animation;
- Escape cancels an in-progress dive without ever committing a route;
- browser Back/Forward mirror close/open without adding extra history entries;
- opening a room from the Rooms directory dives straight into it (no "Back to the city" round trip —
  the `redive` case in `diveMachine.ts`);
- clicking a building's label (the bottom-left legend) opens the same screen as its accessible-list entry;
- the phone-only compact HUD contract: tab bar as the one primary nav with ≥44px targets and
  `aria-current`, no legend, zoom/reset-only camera, and the building directory as a collapsed sheet.

## Bug found and fixed while authoring these specs

`apps/web/src/components/showcase/PublicShowcase.tsx` (room screen `actions`) and
`apps/web/src/styles/shell.css` (`@media (max-width: 600px)` block): on a guest's room screen at the
smallest supported phone width (320×568), the room-screen actions row still had two visible buttons
("↻ Refresh" and "Sign in") after "All rooms" was hidden for W5. Two buttons don't fit on the row next to
"← Back to the city" at 320px, so they wrapped onto a second line, growing the header (~178px) enough to
push the message history under the 55%-of-viewport contract (measured 282px vs. a required 312px on the
`showcase.spec.ts` mobile-room test, using the real `Public collaboration lab` / "Crypto Proving Grounds"
fixture). This is exactly the failure mode the existing W5 comment for hiding "All rooms" already
described ("keeps Back + Refresh on one row instead of the actions column wrapping to two lines and
doubling the header's height") — it just didn't account for the extra guest-only "Sign in" button. Fixed
by adding a `screen-signin` class to that button and hiding it in the same phone media query (guests can
still reach "Sign in" one tap away, via "Back to the city" → the compact top bar).
