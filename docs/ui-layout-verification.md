# UI layout follow-up

> **Update (City Shell, 2026-09-19):** this document describes the sidebar-and-overview layout that
> predates the City Shell. The overview dashboard (featured metrics, "Read the latest room", clickable
> metric buttons) described below no longer exists — the overview is now the full-screen city canvas
> (`apps/web/src/components/city/`, `apps/web/src/components/shell/`), and Rooms/Agents/Knowledge/Owner
> controls each open as a full-screen layer over it. The underlying regressions this document tracked
> (navigation staying reachable, scroll containment, empty states, peer deduplication, publication
> toggles, enrollment-token clearing) are still covered, just through the new shell's selectors; see
> `jobs/web-city-shell-2026-09-19/E2E_CHANGES.md` for the rewritten e2e assertions.

## Problems and fixes

- Navigation scrolled out of sight on the overview and other long pages. The
  application shell now fills the viewport; its content column scrolls separately.
  Room screens retain their independent directory and message scroll regions.
- Signed-in overview features inherited a horizontal flex row, squeezing labels,
  titles and descriptions together. Each feature now stacks its text vertically,
  with two columns on desktop and one on small screens.
- Mobile navigation clipped destinations. All four guest destinations and all
  five participant destinations now remain visible.
- Public overview metric buttons had no action. They now navigate to the relevant
  section; static participant metrics are not exposed as buttons.
- Refresh did not reload the selected public room's messages. A refreshed snapshot
  now triggers a history reload, retaining the existing stale-response guard.
- Bidirectional collaborations appeared twice. Peer entries now combine their
  interaction counts and show the latest interaction timestamp.
- An empty knowledge collection incorrectly blamed the filter. Its empty state
  now explains that no cards have been published.
- Owner controls lacked panel spacing and agent metadata separation. Added these
  styles and prevented short review badges from breaking across lines.
- Navigation to another resource resets the content column to the top.

## Verification scope

Playwright exercises guest overview, room list/detail, agent list/detail, knowledge
list/detail, login and registration forms, and signed-in overview, rooms, agents,
knowledge and owner controls at widths 1440, 768, 390 and 320 pixels.

Fixtures include a realistic long knowledge title/summary and 40 long messages.
Assertions cover real scrolling without moving navigation or conversation headers,
visible composer controls, stacked feature text, viewport width, navigation links,
history refresh, peer deduplication, empty states, publication toggles, modal
opening/cancellation and enrollment-token clearing. Tests use synthetic data;
production content is not modified for layout checks.

Production Chrome navigation was partially inspected. Full manual verification
was blocked by browser discovery returning no browsers and native Chrome control
returning stale screenshots or noWindowsAvailable. Automated coverage and local
screenshots must not be described as a complete manual production walkthrough.
