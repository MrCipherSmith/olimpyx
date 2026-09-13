import { test, expect, type Page } from '@playwright/test';

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

test('signed-in overview, rooms, agents, knowledge and owner controls retain usable layouts', async ({ page }) => {
  await participantFixture(page);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/');
    await expect(page.getByRole('heading', { name: version.topic, exact: true })).toBeVisible();
    for (const link of await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link').all()) await expect(link).toBeInViewport();
    // Each featured item must read vertically, even with a realistic long title.
    for (const feature of await page.locator('.featured-panel>div').all()) {
      const label = await feature.locator('.eyebrow').boundingBox();
      const title = await feature.locator('h2').boundingBox();
      const summary = await feature.locator('p:not(.eyebrow)').boundingBox();
      expect(title!.y).toBeGreaterThanOrEqual(label!.y + label!.height);
      expect(summary!.y).toBeGreaterThanOrEqual(title!.y + title!.height);
    }
    await page.screenshot({ path: `output/playwright/participant-overview-${width}.png`, fullPage: true });
    const sidebarBefore = await page.locator('.sidebar').boundingBox();
    await page.locator('.content').hover();
    await page.mouse.wheel(0, 1500);
    await expect.poll(() => page.locator('.content').evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    expect(await page.locator('.sidebar').boundingBox()).toEqual(sidebarBefore);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    await page.getByRole('link', { name: /Open latest room/ }).click();
    const messages = page.locator('.message-list');
    await expect(messages.locator('.message')).toHaveCount(40);
    const heading = await page.locator('.conversation-head').boundingBox();
    await messages.hover();
    await page.mouse.wheel(0, 1800);
    await expect.poll(() => messages.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    expect(await page.locator('.conversation-head').boundingBox()).toEqual(heading);
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(845);
    await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeInViewport();
    await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeInViewport();
    await page.screenshot({ path: `output/playwright/participant-room-${width}.png` });
    if (width <= 600) {
      expect(await messages.evaluate(element => element.clientHeight)).toBeGreaterThan(844 * .45);
      await page.getByRole('link', { name: '← Rooms', exact: true }).click();
      await expect(page.locator('.room-list')).toBeVisible();
      await expect(page.locator('.conversation')).toBeHidden();
      await page.goBack();
      await expect(messages).toBeVisible();
      await page.getByRole('link', { name: '← Rooms', exact: true }).click();
    }
    await page.getByRole('button', { name: /New room/ }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    for (const [route, title] of [
      ['/?view=agents', 'Agent directory'], ['/?view=agents&agent=agt_layout', agent.name],
      ['/?view=knowledge&card=knw_layout', version.topic], ['/?view=owner', 'Owner controls'],
    ]) {
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
