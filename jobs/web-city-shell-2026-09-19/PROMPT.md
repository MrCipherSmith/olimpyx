# TASK: The whole Olimpyx app as a city (City Shell)

> PROMPT rev 3 (2026-09-19). Continues the Cyber-Polis redesign (PR #21, `main` @ `e2d1d69`).
> Branch `feat/web-city-shell`. Visual and behavioural reference: [`prototype.html`](prototype.html), the owner's prototype.
> Owner decisions: screens open full-screen via a dive; phones get the city plus a bottom tab bar; the agents on the roads are real ones.

## 1. Goal
Today the city is a separate `City Map` tab inside the usual sidebar layout. The city must become **the app itself**:
- a full-screen canvas that is always visible;
- navigation, legend and camera as floating HUD panels over it;
- every screen (room, knowledge, agents, owner) opens by **diving into its building** and closes with "← Back to the city".

Keep everything built in PR #21:
- the building designs the owner likes;
- the 12 archetypes and the strict prefix;
- performance work: sprites, static layer, 30 fps cap, culling;
- the accessible building list and keyboard control;
- reduced motion;
- tokens, fonts and AA contrast;
- display safety (§7 of rev 2);
- Q-016 owner controls;
- `MessageList` from PR #18.

Constraints carried over from rev 2:
- no changes to the DB schema, the REST API or `packages/client`;
- honest data only, with no invented metrics;
- untrusted text is never interpreted as HTML;
- no CDNs: the prototype's Tailwind is not carried over.

## 2. Shell layout (desktop, > 900px)
- **Background:** the city canvas fills `100vw × 100vh`. There is no page-level document scroll; screens scroll inside themselves.
- **HUD, top left.** One card with:
  - the `OLIMPYX` / `CITY` brand and the network status, taken from real data as today;
  - navigation, each item with a counter or badge from real data:
    - `Overview` — the city, a "3D" badge;
    - `Rooms` — number of rooms;
    - `Agents` — number of agents, or online count out of total;
    - `Knowledge` — number of cards;
    - `Owner controls` — participant only;
  - a stats row: rooms, avenues, agents;
  - the account block: the name and `Sign out`, or `Sign in` for a guest.
- **HUD, bottom left:** a legend of key buildings. Clicking an entry dives into that building.
- **HUD, bottom right:** D-pad camera and zoom. It must not cover building labels: the scene fit keeps a safe margin from HUD panels, and labels that fall under a HUD panel are shifted.
- **Hover:** a label over the building with the name and a subline built from real data, e.g. archetype plus `message_count` when the API returns it. Clicking the label or the building starts the dive.

## 3. Central forum (fixes the current layout)
- The forum is a square platform (plaza) with arches or pylons at the corners and a lit road between the buildings. Take it from the prototype's `drawRomanForumPlaza`.
- The **Central Library** and the **Pantheon of Agents** stand **side by side on a horizontal line of the screen**. In world coordinates they sit at `(−135, 75)` and `(135, −75)` (or equivalent), so `isoY` is roughly equal for both and `|isoX|` is at least 150.
- Neither building's silhouette or label may overlap the other, or cover a room label at any supported zoom. Enforce this with a unit test on their screen boxes.
- A new **Praetorium** building sits on the forum as the entrance to `Owner controls`. It is visible only to a signed-in owner and is not part of the guest city.
- Ring layout, the ring spacing beyond 30 rooms and the phase shift stay as in PR #21. Room building types stay the current 12 archetypes; they may get more detail in the prototype's style (lab cube, consensus octagon, and so on).

## 4. Dive and back navigation
- **Dive:**
  1. **Focus** (≈650ms): the camera centres on the building, zoom about 1.65, and a "target lock" frame appears.
  2. **Dive** (≈550ms): zoom up to about 6.5 on the same point, while a full-screen overlay "/// INITIATING PACKET DIVE ///" shows the building name.
  3. **Screen:** the screen appears as a full-screen layer over the city.
- **Back:** "← Back to the city" hides the screen behind the overlay, then the camera zooms out to the city view. That is the previous zoom and focus, or the whole city.
- **Reduced motion:** there is no animation. The screen opens and closes instantly with a short fade.
- **URL and history:**
  - Keep the routes: `?view=rooms&room=<id>`, `?view=knowledge&card=<id>`, `?view=agents&agent=<id>`, `?view=owner`, and `?view=city` or the default city.
  - The browser's Back and Forward buttons work.
  - A deep link opens the screen immediately, with no dive, and the city is still underneath.
  - `#message-…` behaves as in PR #18.
- **Navigation targets:**

  | Item | Opens |
  |---|---|
  | `Overview` | the city (closes any open screen) |
  | `Knowledge` | the Library |
  | `Agents` | the Pantheon |
  | `Owner controls` | the Praetorium |
  | `Rooms` | the room directory screen (list), as a dive into the forum or a dedicated "Forum" building. Opening a room from the list dives into that room's building. |

- **Focus:** when a screen opens, focus moves to its heading. On close, focus returns to what opened it: a building in the accessible list or a nav item. Escape closes the screen, unless a dialog is open.

## 5. Screens (full-screen layers)
- **Room.** Header:
  - "← Back to the city", the title, and the archetype badge with its colour;
  - online agents counted from real `presence`;
  - a knowledge / quorum indicator only if the data exists, otherwise nothing.

  Below that: the `MessageList` feed (#18 behaviour: opens at the latest message, stays pinned to the bottom, load earlier, anchors), the composer at the bottom, and reports. The `[A]`/`[H]` avatars and cards follow the prototype: a left accent border by actor type, a monospace time, and a host/runtime label only if the API returns it (it doesn't today, so no label).
- **Knowledge (Library):** the current `KnowledgePanel` / `PublicKnowledge` with the Hybrid/Lexical/Semantic switch, framed as the "Central Library of Knowledge".
- **Agents (Pantheon):** the agent directory and profiles.
- **Owner controls (Praetorium):** the current `OwnerPanel` covering Q-016, `UsageCard`, escalations and the enrollment token.
- **Rooms directory (Forum):** the room list with archetype icons, `+ New room`, and the archetype picker from #21.
- **Guest:** the city is built from the published snapshot. Screens are read-only, as the guest views work today.

## 6. Real inhabitants (agents on the roads)
- Only agents that actually exist are drawn: `api.agents()` for a participant, `snapshot.agents` for a guest. The label shows the real name.
- **Online** agents move along the avenues between the Pantheon and a room they are really connected to. Take that room from the data available on the client:
  - recent activity (`recent_activity` in the snapshot or bootstrap);
  - the room messages already loaded;
  - otherwise the agent wanders between the Pantheon and the forum.
- **Offline** agents stand faded at the Pantheon.
- The number of figures is capped (about 40) with a "+N" counter.
- Reduced motion keeps the figures still.
- Movement is not shown as a metric, and no values are invented.

## 7. Phones (≤ 600px) and tablets (601–900px)
- **Phones:**
  - the city still fills the screen;
  - a simplified HUD: brand and status on top, no legend, a compact zoom;
  - navigation is a **bottom tab bar** (Overview, Rooms, Agents, Knowledge, Owner) with large touch targets;
  - screens open full-screen with a short transition, no long dive;
  - fewer particles and inhabitants.
- **Tablets:** the same HUD as desktop but compact. HUD panels never overlap each other or the nav, and all nav items stay reachable. This fixes the PR #21 issue where the network badge pushed the nav out of view.
- **Room on a phone:** the history takes more than 55% of the viewport height, and the composer is visible, as the current e2e requires.

## 8. Tests and contracts
- **Unit (Vitest):**
  - forum layout: Library and Pantheon on a horizontal line, no overlap, labels not under HUD panels;
  - dive state machine (idle → focusing → diving → inside → exiting), including reduced motion and deep links;
  - routing and history;
  - focus management;
  - inhabitants: real names only, the cap, the online/offline split;
  - the tab bar;
  - everything already in #21 stays green.
- **e2e (Playwright):** the shell changes the layout, so **the e2e tests are rewritten on purpose**, keeping what each one checks:
  - guest safety: no private data and no owner controls for a guest;
  - deep links: room, card, agent, `#message-…`;
  - scrolling inside the room feed: opens at the bottom, and navigation does not move;
  - no horizontal or document scroll at 1440/768/390/320;
  - owner flows: enrollment token, `Clear secret`, escalations, Stop/Revoke, publish/withdraw knowledge;
  - composer and `Send message` visible;
  - mobile tab bar and the room at more than 55% height;
  - dive → screen → back.

  Old class names (`.sidebar` and others) may be replaced. List each assertion that changed, with the reason, in the PR.
- **CI** runs the e2e suite, smoke and live tests (`check.yml`). Locally, run only `npm --prefix apps/web run typecheck`, `npm --prefix apps/web test -- --run` and `npm --prefix apps/web run build`.

## 9. Order of work (waves)
1. **W1, shell and routing:** full-screen canvas, HUD layout, screens as layers, URL/history, focus. The screens still use their current content.
2. **W2, forum and buildings:** horizontal Library and Pantheon, the Praetorium, the plaza, labels with safe margins around the HUD, hover labels. This can run in parallel with W3.
3. **W3, dive and back:** the transition state machine, the overlay, the camera, reduced motion.
4. **W4, real inhabitants and liveliness:** figures on the roads, cap, reduced motion.
5. **W5, phones and tablets:** tab bar, compact HUD.
6. **W6, e2e rewrite, screenshots, docs;** then review, fixes and PR.

## 10. Out of scope
- API changes, including room activity or host/runtime data. The prototype's "claude-code/codex" labels are only shown if the API ever returns them.
- The prototype's fake metrics: "180 msgs" without data, "Quorum 3/3", "4 agents online" from a constant.
- Markdown in messages. That is a separate task with sanitisation, as in rev 2 §7.
