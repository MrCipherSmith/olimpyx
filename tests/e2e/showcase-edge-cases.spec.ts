import { expect, test, type Page } from '@playwright/test';

const createdAt = '2026-09-12T12:00:00.000Z';
const actor = { actor_type: 'agent' as const, agent_id: 'agt_deep', display_name: 'Deep link agent' };
const agent = { agent_id: actor.agent_id, name: actor.display_name, role: 'Researcher', bio: 'Available through a stable public URL.', interests: ['routing'], capabilities: [], presence: 'offline' as const, created_at: createdAt };
const room = { room_id: 'rom_deep', slug: 'deep-link-room', title: 'Deep link room', description: 'Published outside the bounded overview.', created_at: createdAt, updated_at: createdAt, message_count: 1 };
const message = { message_id: 'msg_deep', room_id: room.room_id, sender: actor, recipient_agent_id: null, reply_to_message_id: null, body: 'This message came from the selected room detail endpoint.', created_at: createdAt };
const card = { card_id: 'knw_deep', created_at: createdAt, latest: { version_id: 'knv_deep', version: 2, topic: 'Deep link knowledge', summary: 'Published outside the bounded overview.', body: 'The canonical public detail route resolves this card.', sources: [], status: 'confirmed' as const, review_counts: { confirm: 1, refute: 0, comment: 0 }, author: actor, reviews: [] } };
const emptySnapshot = { generated_at: createdAt, counts: { agents: 0, rooms: 0, messages: 0, knowledge_cards: 0 }, agents: [], rooms: [], knowledge_cards: [], recent_activity: [], relationships: [] };

async function routePublicDetails(page: Page) {
  await page.route('**/v1/showcase**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === `/v1/showcase/agents/${agent.agent_id}`) return route.fulfill({ json: { data: agent } });
    if (path === `/v1/showcase/rooms/${room.room_id}`) return route.fulfill({ json: { data: room } });
    if (path === `/v1/showcase/rooms/${room.room_id}/messages`) return route.fulfill({ json: { data: [message], page: { next_cursor: null } } });
    if (path === `/v1/showcase/knowledge/cards/${card.card_id}`) return route.fulfill({ json: { data: card } });
    if (path === '/v1/showcase') return route.fulfill({ json: { data: emptySnapshot } });
    return route.fulfill({ status: 404, json: { error: { code: 'not_found', message: 'Showcase resource not found' } } });
  });
}

test('selected published resources resolve through detail endpoints when absent from the bounded snapshot', async ({ page }) => {
  await routePublicDetails(page);

  await page.goto(`/?view=rooms&room=${room.room_id}`);
  await expect(page.getByRole('heading', { name: room.title, exact: true })).toBeVisible();
  await expect(page.getByText(message.body, { exact: true })).toBeVisible();

  await page.goto(`/?view=knowledge&card=${card.card_id}`);
  await expect(page.getByRole('heading', { name: card.latest.topic, exact: true })).toBeVisible();

  await page.goto(`/?view=agents&agent=${agent.agent_id}`);
  await expect(page.getByRole('heading', { name: agent.name, exact: true })).toBeVisible();
});

test('unpublished selected resource shows safe recovery without revealing metadata', async ({ page }) => {
  await routePublicDetails(page);
  await page.goto('/?view=knowledge&card=knw_unpublished');

  await expect(page.getByText('knw_unpublished', { exact: false })).toHaveCount(0);
  await expect(page.getByText(/not found|not available|unavailable/i)).toBeVisible();
  const recovery = page.getByRole('link', { name: /knowledge|overview|back/i }).or(page.getByRole('button', { name: /knowledge|overview|back/i }));
  await expect(recovery.first()).toBeVisible();
});

test('guest owner route recovers to public navigation or sign in instead of rendering empty owner content', async ({ page }) => {
  await routePublicDetails(page);
  await page.goto('/?view=owner');

  await expect(page.getByRole('heading', { name: 'Owner controls', exact: true })).toHaveCount(0);
  await expect.poll(async () => {
    const normalized = !new URL(page.url()).searchParams.has('view');
    const signInForm = await page.getByRole('heading', { name: /sign in to olimpyx/i }).isVisible().catch(() => false);
    const publicOverview = await page.getByRole('heading', { name: 'Network overview', exact: true }).isVisible().catch(() => false)
      && await page.getByRole('navigation', { name: 'Showcase navigation', exact: true }).isVisible().catch(() => false);
    return normalized || signInForm || publicOverview;
  }).toBe(true);
});

test('authenticated read 401 clears private shell and previously rendered owner data', async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem('olimpyx.session', JSON.stringify({ token: 'expired-owner-token', user: { id: 'own_old', email: 'old-owner@example.com', displayName: 'Old owner' } })));
  let rejectProtectedReads = false;
  await page.route('**/v1/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith('/v1/showcase')) return route.fulfill({ json: { data: emptySnapshot } });
    if (rejectProtectedReads) return route.fulfill({ status: 401, json: { error: { code: 'unauthorized', message: 'Authentication required' } } });
    if (path === '/v1/rooms') return route.fulfill({ json: { data: [{ room_id: 'rom_private', slug: 'private', title: 'Previous owner private room', description: '', created_by: { actor_type: 'owner', actor_id: 'own_old', display_name: 'Old owner' }, created_at: createdAt, updated_at: createdAt }], page: { next_cursor: null } } });
    return route.fulfill({ json: { data: [], page: { next_cursor: null } } });
  });

  await page.goto('/?view=rooms');
  await expect(page.getByText('Previous owner private room', { exact: true })).toBeVisible();
  rejectProtectedReads = true;
  await page.getByRole('button', { name: /refresh/i }).click();

  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('olimpyx.session'))).toBeNull();
  await expect(page.getByText('Previous owner private room', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Guest view', { exact: true })).toBeVisible();
});
