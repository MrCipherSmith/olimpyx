# Room scroll containment

> **Update (City Shell, 2026-09-19):** the app shell described below (a persistent sidebar with a
> `.content` column and a two-pane room view) was replaced by the City Shell: a full-screen city canvas
> with a floating HUD, and every screen — including the room — opening as a full-screen layer over it
> (`apps/web/src/components/shell/`). The room screen's header is now `.screen-header` (was
> `.conversation-head`), it always starts with "← Back to the city", and on a phone the old "Rooms link,
> Refresh and guest Sign in" toolbar is gone — "All rooms" and the guest "Sign in" action are hidden
> there, and the bottom tab bar (`.tab-bar`) is the primary nav instead. The scroll-containment guarantees
> below (history scrolls, header/navigation stay put, no document scroll, mobile description disclosure,
> the >55%-of-viewport history contract) still hold and are covered by `tests/e2e/showcase.spec.ts` and
> `tests/e2e/participant-layout.spec.ts`; see `jobs/web-city-shell-2026-09-19/E2E_CHANGES.md` for the
> full list of what changed in those tests.

The room screen must fit the viewport. Long message history must scroll inside
the conversation while navigation, the room heading and participation controls
remain in place. Long room directories scroll independently. Other views scroll
inside the content column, keeping the application navigation in place.

The room-specific shell uses a bounded dynamic viewport height and allows its
grid and flex children to shrink. Desktop displays the directory and conversation
side by side; tablet and mobile allocate separate rows within the same workspace.
Exceptionally long room descriptions have their own bounded header overflow.

Validation: the public showcase e2e suite checks 40 long messages at 1440, 768,
390 and 320 pixel viewport widths. It verifies document dimensions, actual message
scrolling, unchanged navigation/header positions, and visible participation text.
Web build and component tests also pass.

## Mobile conversation focus

At widths up to 600 pixels, the room directory and the selected conversation are
separate screens. The directory uses the available workspace height. Opening a
room hides the directory, global navigation and repeated page heading. A compact
toolbar provides a Rooms link, Refresh and guest Sign in. Returning to Rooms
restores the normal application navigation; browser Back and Forward work too.

The room description is collapsed behind an accessible native details/summary
control. Room title, access badge and history remain visible. Participant compose
controls stay at the bottom with a compact Send action. Wider screens retain the
existing two-pane layout.

Regression checks cover direct links, returning to the directory, reopening the
same room, browser history, description disclosure, actual scrolling and message
height greater than 55% of 390x700 and 320x568 guest viewports. Signed-in navigation
and visible compose controls are also checked. This is viewport emulation, not
an on-device iOS Safari verification.
