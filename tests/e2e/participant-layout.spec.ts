import { test, expect, type Page } from '@playwright/test';

// City Shell: reduced motion keeps every screen open/close instant, which this layout sweep relies on
// to stay fast across four viewports.
test.use({ reducedMotion: 'reduce' });

const createdAt = '2026-09-12T12:00:00.000Z';
const agent = { agent_id: 'agt_layout', name: 'Athena', role: 'Researcher', bio: 'Research and verification', interests: ['Coordination'], capabilities: [], presence: 'offline', last_seen_at: createdAt };
const sender = { actor_type: 'agent', actor_id: agent.agent_id, agent_id: agent.agent_id, display_name: agent.name };
const room = { room_id: 'rom_layout', slug: 'layout-lab', title: 'Olimpyx Lab', description: 'Public room for testing agent collaboration, knowledge exchange, and the Olimpyx MVP lifecycle.', created_by: sender, created_at: createdAt, updated_at: createdAt };
const version = { version_id: 'knv_layout', version: 1, topic: 'Presence/heartbeats vs. end-to-end acks for reliable agent-to-agent messaging', summary: 'Bounded-heartbeat presence is not necessary for reliability in general. '.repeat(5), body: 'The evidence and limitations remain readable. '.repeat(10), author_agent_id: agent.agent_id, created_at: createdAt, status: 'unconfirmed', review_counts: { confirm: 0, refute: 0, comment: 0 }, sources: [], references: [] };
const card = { card_id: 'knw_layout', created_at: createdAt, public: false, latest: version, challenge_of: null, challenged_by: [] };

async function participantFixture(page: Page) {
  await page.addInitScript(() => sessionStorage.setItem('olimpyx.session', JSON.stringify({ token: 'layout-fixture-token', user: { id: 'own_layout', email: 'layout@example.test', displayName: 'Layout owner' } })));
  let published = false;
  await page.route('**/v1/**', async route => {
    const path = new URL(route.request().url()).pathname;
    let data: unknown = [];
    if (path === '/v1/rooms') data = [room];
    else if (path.endsWith('/messages')) data = Array.from({ length: 40 }, (_, index) => ({ message_id: `msg_${index}`, room_id: room.room_id, sender, body: `Message ${index}. ${version.body}`, created_at: createdAt, recipient_agent_id: null, reply_to_message_id: null }));
    else if (path === '/v1/agents' || path === '/v1/owners/me/agents') data = [agent];
    else if (path === '/v1/knowledge/cards') data = [{ ...card, public: published }];
    else if (path.endsWith('/public')) { published = route.request().postDataJSON().public; data = { card_id: card.card_id, public: published }; }
    else if (path.endsWith('/versions')) data = [version];
    else if (path === '/v1/knowledge/cards/knw_layout') data = { ...card, public: published };
    else if (path.endsWith('/enrollment-tokens')) data = { enrollment_token: 'synthetic-layout-token', expires_at: createdAt };
    await route.fulfill({ json: { data, page: { next_cursor: null } } });
  });
}

test('signed-in city, screens and mobile shell retain usable layouts', async ({ page }) => {
  await participantFixture(page);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/');
    // The overview is the city itself; the new finding/room appear as buildings, not an overview list.
    await expect(page.getByRole('heading', { name: 'Olimpyx city', exact: true })).toBeAttached();
    for (const link of await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link').all()) await expect(link).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.screenshot({ path: `output/playwright/participant-overview-${width}.png`, fullPage: true });

    await page.getByRole('link', { name: 'Rooms', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Rooms', exact: true })).toBeVisible();
    await page.locator('.room-list .room-row').filter({ hasText: room.title }).click();
    const messages = page.locator('.message-list');
    await expect(messages.locator('.message')).toHaveCount(40);
    await expect.poll(() => messages.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(2);
    await messages.evaluate(element => { element.scrollTop = 0; });
    // The screen header (back link, title, badges) replaces the old .conversation-head: it must stay put
    // while the feed inside it scrolls.
    const header = page.locator('.screen-header');
    const headerBefore = await header.boundingBox();
    await messages.hover();
    await page.mouse.wheel(0, 1800);
    await expect.poll(() => messages.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    expect(await header.boundingBox()).toEqual(headerBefore);
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(845);
    await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeInViewport();
    await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeInViewport();
    await page.screenshot({ path: `output/playwright/participant-room-${width}.png` });

    if (width <= 600) {
      // Phones (PROMPT §7): the history clears 55% of the viewport, and "All rooms" is dropped — the
      // tab bar's Rooms tab already says where "back to the list" goes, but it too is inert while a
      // screen is open, so only "Back to the city" can close the room.
      expect(await messages.evaluate(element => element.clientHeight)).toBeGreaterThan(844 * .55);
      await expect(page.getByRole('link', { name: 'All rooms', exact: true })).toBeHidden();
      // "All rooms" is dropped on a phone, so the only way back is "Back to the city" (closing fully),
      // then reopening the Rooms directory from the tab bar.
      await page.getByRole('link', { name: 'Back to the city', exact: true }).click();
      await expect(page.locator('.screen-layer')).toHaveCount(0);
      await page.goBack();
      await expect(messages).toBeVisible();
      await page.getByRole('link', { name: 'Back to the city', exact: true }).click();
      await page.getByRole('link', { name: 'Rooms', exact: true }).click();
      await expect(page.locator('.room-list')).toBeVisible();
    } else {
      await page.getByRole('link', { name: 'All rooms', exact: true }).click();
      await expect(page.locator('.room-list')).toBeVisible();
      await expect(page.locator('.conversation')).toHaveCount(0);
      await page.goBack();
      await expect(messages).toBeVisible();
      await page.getByRole('link', { name: 'All rooms', exact: true }).click();
    }

    await page.getByRole('button', { name: /New room/ }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('link', { name: 'Back to the city', exact: true }).click();

    for (const [route, title] of [
      ['/?view=agents', 'Pantheon of Agents'], ['/?view=agents&agent=agt_layout', agent.name],
      ['/?view=knowledge&card=knw_layout', 'Central Library of Knowledge'], ['/?view=owner', 'Owner controls'],
    ] as const) {
      await page.goto(route);
      await expect(page.getByRole('heading', { name: title, exact: true }).first()).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await page.screenshot({ path: `output/playwright/participant-${width}-${encodeURIComponent(route)}.png`, fullPage: true });
    }
  }
  await page.goto('/?view=knowledge&card=knw_layout');
  await page.getByRole('button', { name: 'Publish to public showcase', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Withdraw from public showcase', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Withdraw from public showcase', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Publish to public showcase', exact: true })).toBeVisible();
  await page.goto('/?view=owner');
  await page.getByRole('button', { name: 'Generate enrollment token' }).click();
  await page.getByRole('button', { name: 'Clear secret' }).click();
  await expect(page.getByText('synthetic-layout-token')).toHaveCount(0);
  expect(errors).toEqual([]);
});
