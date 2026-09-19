import { test, expect, type Page } from '@playwright/test';

// City Shell (PROMPT rev 3): the guest showcase is now the full-screen city with screens as layers.
// Reduced motion keeps every screen open/close instant (§4), so these content-focused tests stay fast
// and deterministic; the dive transition itself is covered by tests/e2e/city-shell-nav.spec.ts.
test.use({ reducedMotion: 'reduce' });

const createdAt = '2026-09-12T12:00:00.000Z';
const agent = { agent_id: 'agt_public', name: 'Public researcher', role: 'Researcher', bio: 'Explores coordination', interests: ['Coordination'], capabilities: [], presence: 'offline', created_at: createdAt };
const actor = { actor_type: 'agent', agent_id: agent.agent_id, display_name: agent.name };
const room = { room_id: 'room_public', slug: 'public-lab', title: 'Public collaboration lab', description: 'A published discussion', created_at: createdAt, updated_at: createdAt, message_count: 1 };
const card = { card_id: 'knw_public', created_at: createdAt, latest: { version_id: 'knv_public', version: 1, topic: 'A falsifiable coordination claim', summary: 'An open question with a concrete counterexample.', body: 'This is a hypothesis, not a verified conclusion.', sources: [], status: 'unconfirmed', review_counts: { confirm: 0, refute: 0, comment: 1 }, author: actor, reviews: [{ review_id: 'rev_public', reviewer: actor, verdict: 'comment', explanation: 'The counterexample needs a narrower claim.', evidence: [], created_at: createdAt }] } };
const message = { message_id: 'msg_public', room_id: room.room_id, sender: actor, recipient_agent_id: null, reply_to_message_id: null, body: 'Our counterexample narrowed the original hypothesis.', created_at: createdAt };
const snapshot = { generated_at: createdAt, counts: { agents: 1, rooms: 1, messages: 1, knowledge_cards: 1 }, agents: [agent], rooms: [room], knowledge_cards: [card], recent_activity: [{ kind: 'message', occurred_at: createdAt, actor, resource: { kind: 'room', id: room.room_id, title: room.title }, summary: message.body }], relationships: [] };

async function publicFixture(page: Page) {
  const protectedReads: string[] = [];
  await page.route('**/v1/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (!path.startsWith('/v1/showcase')) {
      protectedReads.push(path);
      await route.fulfill({ status: 401, json: { error: { message: 'Authentication required' } } });
      return;
    }
    const data = path.endsWith('/messages') ? [message]
      : path.endsWith(`/rooms/${room.room_id}`) ? room
      : path.endsWith(`/agents/${agent.agent_id}`) ? agent
      : path.endsWith(`/knowledge/cards/${card.card_id}`) ? card : snapshot;
    await route.fulfill({ json: { data, ...(Array.isArray(data) ? { page: { next_cursor: null } } : {}) } });
  });
  return protectedReads;
}

test('guest follows a shared room and knowledge link without participant access', async ({ page }) => {
  const protectedReads = await publicFixture(page);
  // A room deep link opens the screen at once, the city still underneath (PROMPT §4).
  await page.goto('/?view=rooms&room=room_public');
  await expect(page.getByRole('heading', { name: room.title, exact: true })).toBeVisible();
  await expect(page.getByText(message.body, { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Generate enrollment token', exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByText(message.body, { exact: true })).toBeVisible();

  // Switching to a different screen now requires closing the current one first: the HUD nav is inert
  // while a screen covers the city (CityShell), so "Knowledge" is unreachable from inside the room.
  await page.getByRole('link', { name: 'Back to the city', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Showcase navigation' })).toBeVisible();
  await page.getByRole('link', { name: 'Knowledge', exact: true }).click();
  await expect(page).toHaveURL(/view=knowledge/);

  // Browser history mirrors the shell: back to the city, then back to the original room deep link.
  await page.goBack();
  await expect(page).not.toHaveURL(/view=/);
  await expect(page.locator('.screen-layer')).toHaveCount(0);
  await page.goBack();
  await expect(page).toHaveURL(/room=room_public/);
  await expect(page.getByText(message.body, { exact: true })).toBeVisible();

  await page.goto('/?view=knowledge&card=knw_public');
  await expect(page.getByRole('heading', { name: card.latest.topic, exact: true })).toBeVisible();
  await expect(page.getByText(card.latest.reviews[0].explanation, { exact: true })).toBeVisible();
  await expect(page.getByText('agt_public', { exact: true })).toHaveCount(0);
  await page.getByRole('textbox', { name: 'Filter published knowledge' }).fill('unmatched topic');
  await expect(page.locator('a.knowledge-row')).toHaveCount(0);
  await page.getByRole('textbox', { name: 'Filter published knowledge' }).fill('coordination');
  await expect(page.locator('a.knowledge-row')).toHaveCount(1);
  expect(protectedReads).toEqual([]);
  await page.screenshot({ path: 'output/playwright/showcase-knowledge.png', fullPage: true });
});

test('the city overview is reachable and usable at desktop and mobile widths', async ({ page }) => {
  await publicFixture(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  // The overview *is* the city (no dashboard screen): a visually-hidden heading names it, and the
  // published room appears as a building in the accessible directory.
  await expect(page.getByRole('heading', { name: 'Olimpyx city', exact: true })).toBeAttached();
  await expect(page.getByRole('button').filter({ hasText: room.title })).toBeVisible();
  // The published knowledge card is reachable from the city too, not only via a direct deep link: the
  // overview's accessible directory only lists buildings (Library, Pantheon, rooms), not individual cards.
  await page.getByRole('link', { name: 'Knowledge', exact: true }).click();
  await expect(page.getByText(card.latest.topic, { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Back to the city', exact: true }).click();
  await expect(page.locator('.screen-layer')).toHaveCount(0);
  await page.screenshot({ path: 'output/playwright/showcase-overview.png', fullPage: true });
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    // Phones (PROMPT §7): the tab bar is the one primary nav.
    await expect(page.getByRole('navigation', { name: /Main navigation|Showcase navigation/ })).toBeVisible();
    await page.screenshot({ path: `output/playwright/showcase-mobile-${width}.png`, fullPage: true });
    const layout = await page.evaluate(() => ({
      viewport: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      overflowing: Array.from(document.querySelectorAll('main, aside, section, header, nav')).filter(element => element.getBoundingClientRect().right > window.innerWidth + 1).map(element => ({ tag: element.tagName, className: element.className, right: element.getBoundingClientRect().right })),
    }));
    expect(layout.documentWidth, JSON.stringify(layout)).toBeLessThanOrEqual(layout.viewport);
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  }
});

test('long room history scrolls inside the conversation without moving the screen header', async ({ page }) => {
  await publicFixture(page);
  await page.route('**/v1/showcase/rooms/*/messages*', route => route.fulfill({ json: {
    data: Array.from({ length: 40 }, (_, i) => ({ ...message, message_id: `msg_${i}`, body: `Message ${i}: ${message.body.repeat(8)}` })),
    page: { next_cursor: null },
  } }));
  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/?view=rooms&room=room_public');
    const messages = page.locator('.message-list');
    await expect(messages.locator('.message')).toHaveCount(40);
    // The screen header (back link, title, badges) replaces the old sidebar/conversation-head: it must
    // stay fixed while the feed inside it scrolls.
    const header = page.locator('.screen-header');
    const headerBefore = await header.boundingBox();
    const layout = await page.evaluate(() => ({
      height: innerHeight, width: innerWidth,
      documentHeight: document.documentElement.scrollHeight,
      documentWidth: document.documentElement.scrollWidth,
      messageHeight: document.querySelector('.message-list')!.clientHeight,
    }));
    expect(layout.documentHeight).toBeLessThanOrEqual(layout.height + 1);
    expect(layout.documentWidth).toBeLessThanOrEqual(layout.width);
    expect(layout.messageHeight).toBeGreaterThan(100);
    await expect.poll(() => messages.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(2);
    await messages.evaluate(element => { element.scrollTop = 0; });
    await messages.hover();
    await page.mouse.wheel(0, 1500);
    await expect.poll(() => messages.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    expect(await header.boundingBox()).toEqual(headerBefore);
    await messages.evaluate(element => { element.scrollTop = element.scrollHeight; });
    await page.mouse.wheel(0, 1500);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    await expect(page.getByText('Sign in to participate. Guest access is read only.')).toBeInViewport();
    await page.screenshot({ path: `output/playwright/room-scroll-${width}.png` });
  }
});

test('a message link opens the room at that message instead of the latest one', async ({ page }) => {
  await publicFixture(page);
  await page.route('**/v1/showcase/rooms/*/messages*', route => route.fulfill({ json: {
    data: Array.from({ length: 40 }, (_, i) => ({ ...message, message_id: `msg_${i}`, body: `Message ${i}: ${message.body.repeat(8)}` })),
    page: { next_cursor: null },
  } }));
  await page.setViewportSize({ width: 1440, height: 844 });
  await page.goto('/?view=rooms&room=room_public#message-msg_30');
  const messages = page.locator('.message-list');
  await expect(messages.locator('.message')).toHaveCount(40);
  await expect(page.locator('#message-msg_30')).toBeInViewport();
  expect(await messages.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeGreaterThan(100);
});

test('HUD navigation opens each screen, Back returns to the city, and refresh reloads the open room', async ({ page }) => {
  await publicFixture(page);
  let revision = 0;
  await page.route('**/v1/showcase/rooms/*/messages*', route => route.fulfill({ json: {
    data: [{ ...message, body: `History revision ${revision}` }], page: { next_cursor: null },
  } }));
  await page.goto('/');
  // Every non-city screen requires "Back to the city" before another HUD nav item is reachable again
  // (the HUD is inert while a screen is open — City Shell §4/CityShell.tsx).
  for (const [label, view] of [['Agents', 'agents'], ['Knowledge', 'knowledge'], ['Rooms', 'rooms']] as const) {
    await page.getByRole('link', { name: label, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`view=${view}`));
    await page.getByRole('link', { name: 'Back to the city', exact: true }).click();
    await expect(page.locator('.screen-layer')).toHaveCount(0);
  }
  await page.getByRole('link', { name: 'Rooms', exact: true }).click();
  await page.locator('.room-list .room-row').filter({ hasText: room.title }).click();
  await expect(page.getByText('History revision 0', { exact: true })).toBeVisible();
  revision = 1;
  // The room screen's own Refresh action reuses the same element reference as the HUD account's copy
  // (App.tsx / PublicShowcase.tsx `refresh`), so both are in the DOM at once; only the HUD's copy is inert
  // while the screen is open, but that isn't reflected in the accessibility tree here (CityShell.tsx sets
  // `inert` via a ref, not aria-hidden), so scope to the open screen to avoid a strict-mode ambiguity.
  await page.locator('.screen-layer').getByRole('button', { name: /Refresh/ }).click();
  await expect(page.getByText('History revision 1', { exact: true })).toBeVisible();
  await expect(page.getByText('History revision 0', { exact: true })).toHaveCount(0);
});

test('agent collaborations combine both directions into one peer entry', async ({ page }) => {
  await publicFixture(page);
  const peer = { ...agent, agent_id: 'agt_peer', name: 'Peer reviewer' };
  await page.route(url => url.pathname === '/v1/showcase', route => route.fulfill({ json: { data: { ...snapshot,
    agents: [agent, peer], relationships: [
      { source_agent_id: agent.agent_id, target_agent_id: peer.agent_id, interaction_count: 4, last_interaction_at: createdAt, room_ids: [room.room_id] },
      { source_agent_id: peer.agent_id, target_agent_id: agent.agent_id, interaction_count: 3, last_interaction_at: createdAt, room_ids: [room.room_id] },
    ],
  } } }));
  await page.goto(`/?view=agents&agent=${agent.agent_id}`);
  await expect(page.getByRole('link', { name: peer.name, exact: true })).toHaveCount(1);
  await expect(page.getByText(/7 interactions/)).toBeVisible();
  await page.getByRole('link', { name: peer.name, exact: true }).click();
  await expect(page.getByRole('heading', { name: peer.name, exact: true })).toBeVisible();
});

test('all public views, detail pages, and auth forms fit desktop and mobile', async ({ page }) => {
  test.setTimeout(60000);
  await publicFixture(page);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    for (const [route, heading] of [
      ['/', 'Olimpyx city'], ['/?view=rooms', 'Rooms'],
      ['/?view=rooms&room=room_public', room.title], ['/?view=agents', 'Pantheon of Agents'],
      ['/?view=agents&agent=agt_public', agent.name], ['/?view=knowledge', 'Central Library of Knowledge'],
      ['/?view=knowledge&card=knw_public', 'Central Library of Knowledge'],
    ] as const) {
      await page.goto(route);
      await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
      if (route.includes('card=')) {
        // The shared screen heading ("Central Library of Knowledge") is the same for every card: it alone
        // doesn't prove this specific card rendered, so also check the card's own topic heading and a bit
        // of its content.
        await expect(page.getByRole('heading', { name: card.latest.topic, exact: true })).toBeVisible();
        // The same summary text also appears in the (still-visible, split-layout) card list row on wider
        // viewports, so scope to the detail panel to avoid a strict-mode ambiguity.
        await expect(page.locator('.card-detail').getByText(card.latest.summary, { exact: true })).toBeVisible();
      }
      if (route === '/') {
        // No screen open: the primary nav (HUD list or, on a phone, the tab bar) is reachable.
        await expect(page.getByRole('navigation', { name: 'Showcase navigation' })).toBeInViewport();
      } else {
        // A screen is open: the HUD/tab bar are inert, so "Back to the city" is the one thing that must
        // always be reachable, at every width.
        await expect(page.getByRole('link', { name: 'Back to the city', exact: true })).toBeInViewport();
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await page.screenshot({ path: `output/playwright/audit-${width}-${encodeURIComponent(route)}.png`, fullPage: true });
    }
    // The account block's "Sign in" is part of the HUD, which is inert while the last route's screen is
    // still open; return to the city first.
    await page.goto('/');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Sign in to Olimpyx' })).toBeVisible();
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Email', exact: true })).toBeFocused();
    await page.getByRole('button', { name: 'Need an owner account? Register' }).click();
    await expect(page.getByRole('textbox', { name: 'Display name' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.getByRole('button', { name: /Back to showcase/ }).click();
    await expect(page.getByRole('navigation', { name: 'Showcase navigation' })).toBeVisible();
  }
  expect(errors).toEqual([]);
});

test('empty knowledge collection explains that no cards have been published', async ({ page }) => {
  await publicFixture(page);
  await page.route(url => url.pathname === '/v1/showcase', route => route.fulfill({ json: {
    data: { ...snapshot, knowledge_cards: [], counts: { ...snapshot.counts, knowledge_cards: 0 } },
  } }));
  await page.goto('/?view=knowledge');
  await expect(page.getByText('No knowledge cards have been published yet.')).toBeVisible();
  await expect(page.getByText('No published knowledge matches this filter.')).toHaveCount(0);
});

test('mobile room prioritizes history and hides the tab bar and directory while it is open', async ({ page }) => {
  await publicFixture(page);
  await page.route('**/v1/showcase/rooms/*/messages*', route => route.fulfill({ json: {
    data: Array.from({ length: 40 }, (_, index) => ({ ...message, message_id: `focus_${index}`, body: message.body.repeat(6) })),
    page: { next_cursor: null },
  } }));
  for (const viewport of [{ width: 390, height: 700 }, { width: 320, height: 568 }]) {
    await page.setViewportSize(viewport);
    await page.goto('/?view=rooms&room=room_public');
    const history = page.locator('.message-list');
    await expect(history.locator('.message')).toHaveCount(40);
    // W5: on a phone the tab bar is the primary nav, and — like the rest of the HUD — it is inert while
    // a screen covers the city; only "Back to the city" (in the screen header) can close it. CityShell.tsx
    // sets `inert` on the HUD via a ref rather than aria-hidden, which a role query does not treat as
    // hidden, so assert the attribute directly instead of expecting zero navigation landmarks.
    await expect(page.locator('.city-shell-hud')).toHaveAttribute('inert', '');
    // "All rooms" collapses to a compact, icon-only button rather than disappearing (shell.css): it
    // duplicates the (inert) tab bar's Rooms tab, but stays the one-tap way back to the room list.
    const allRooms = page.getByRole('link', { name: 'All rooms', exact: true });
    await expect(allRooms).toBeVisible();
    await allRooms.click();
    await expect(page.locator('.room-list')).toBeVisible();
    await page.locator('.room-list .room-row').click();
    await expect(history.locator('.message')).toHaveCount(40);
    expect(await history.evaluate(element => element.clientHeight)).toBeGreaterThan(viewport.height * .55);
    // The room description collapses behind a native <details> disclosure (PROMPT §7 / RoomHeader.tsx).
    await page.getByText('Description', { exact: true }).click();
    await expect(page.locator('.room-description-details p')).toBeVisible();
    await page.getByText('Description', { exact: true }).click();
    await expect(page.locator('.room-description-details p')).toBeHidden();
    await history.hover();
    await page.mouse.wheel(0, 900);
    await expect.poll(() => history.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    await page.screenshot({ path: `output/playwright/mobile-room-focus-${viewport.width}.png` });
    // Closing fully to the city and reopening the Rooms directory from the tab bar still works too.
    await page.getByRole('link', { name: 'Back to the city', exact: true }).click();
    await expect(page.locator('.screen-layer')).toHaveCount(0);
    await expect(page.getByRole('navigation')).toBeVisible();
    await page.getByRole('navigation').getByRole('link', { name: 'Rooms', exact: true }).click();
    await expect(page.locator('.room-list')).toBeVisible();
    await expect(page.locator('.conversation')).toHaveCount(0);
    await page.locator('.room-list .room-row').click();
    await expect(history).toBeVisible();
    await page.goBack();
    await expect(page.locator('.room-list')).toBeVisible();
    await page.goForward();
    await expect(history).toBeVisible();
  }
});
