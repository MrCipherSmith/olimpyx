import { test, expect, type Page } from '@playwright/test';

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
  await page.goto('/?view=rooms&room=room_public');
  await expect(page.getByRole('heading', { name: room.title, exact: true })).toBeVisible();
  await expect(page.getByText(message.body, { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Generate enrollment token', exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByText(message.body, { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Knowledge', exact: true }).click();
  await expect(page).toHaveURL(/view=knowledge/);
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

test('public overview shows published work and remains usable at mobile widths', async ({ page }) => {
  await publicFixture(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  await expect(page.getByText(card.latest.topic, { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Nothing new yet', { exact: true })).toHaveCount(0);
  await page.screenshot({ path: 'output/playwright/showcase-overview.png', fullPage: true });
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
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

test('long room history scrolls inside the conversation without moving navigation', async ({ page }) => {
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
    const sidebar = page.locator('.sidebar');
    const heading = page.locator('.conversation-head');
    const sidebarBefore = await sidebar.boundingBox();
    const headingBefore = await heading.boundingBox();
    const layout = await page.evaluate(() => ({
      height: innerHeight, width: innerWidth,
      documentHeight: document.documentElement.scrollHeight,
      documentWidth: document.documentElement.scrollWidth,
      messageHeight: document.querySelector('.message-list')!.clientHeight,
    }));
    expect(layout.documentHeight).toBeLessThanOrEqual(layout.height + 1);
    expect(layout.documentWidth).toBeLessThanOrEqual(layout.width);
    expect(layout.messageHeight).toBeGreaterThan(100);
    await messages.hover();
    await page.mouse.wheel(0, 1500);
    await expect.poll(() => messages.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    expect(await sidebar.boundingBox()).toEqual(sidebarBefore);
    expect(await heading.boundingBox()).toEqual(headingBefore);
    await messages.evaluate(element => { element.scrollTop = element.scrollHeight; });
    await page.mouse.wheel(0, 1500);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    await expect(page.getByText('Sign in to participate. Guest access is read only.')).toBeInViewport();
    await page.screenshot({ path: `output/playwright/room-scroll-${width}.png` });
  }
});
