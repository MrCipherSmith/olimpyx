import { expect, test, type Page } from '@playwright/test';

/**
 * The city shell itself (PROMPT rev 3 §4): HUD nav opening a screen by diving or instantly, "Back to the
 * city", browser Back/Forward, Escape, and opening a building from the accessible list. Content specs
 * (showcase.spec.ts, participant-layout.spec.ts, ...) force reduced motion for speed; this spec is the
 * one place the dive transition's timing and camera/overlay behaviour are exercised directly.
 */

const createdAt = '2026-09-12T12:00:00.000Z';
const agent = { agent_id: 'agt_shell', name: 'Shell agent', role: 'Researcher', bio: 'Exercises the city shell.', interests: ['navigation'], capabilities: [], presence: 'online', created_at: createdAt };
const actor = { actor_type: 'agent', agent_id: agent.agent_id, display_name: agent.name };
const room = { room_id: 'room_shell', slug: 'shell-room', title: 'Shell test room', description: 'A published discussion', created_at: createdAt, updated_at: createdAt, message_count: 1 };
const card = { card_id: 'knw_shell', created_at: createdAt, latest: { version_id: 'knv_shell', version: 1, topic: 'A shell navigation claim', summary: 'Exercised by the shell nav e2e.', body: 'Body.', sources: [], status: 'unconfirmed', review_counts: { confirm: 0, refute: 0, comment: 0 }, author: actor, reviews: [] } };
const message = { message_id: 'msg_shell', room_id: room.room_id, sender: actor, recipient_agent_id: null, reply_to_message_id: null, body: 'A message in the shell test room.', created_at: createdAt };
const snapshot = { generated_at: createdAt, counts: { agents: 1, rooms: 1, messages: 1, knowledge_cards: 1 }, agents: [agent], rooms: [room], knowledge_cards: [card], recent_activity: [], relationships: [] };

async function fixture(page: Page) {
  await page.route('**/v1/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (!path.startsWith('/v1/showcase')) return route.fulfill({ status: 401, json: { error: { message: 'Authentication required' } } });
    const data = path.endsWith('/messages') ? [message]
      : path.endsWith(`/rooms/${room.room_id}`) ? room
      : path.endsWith(`/agents/${agent.agent_id}`) ? agent
      : path.endsWith(`/knowledge/cards/${card.card_id}`) ? card : snapshot;
    await route.fulfill({ json: { data, ...(Array.isArray(data) ? { page: { next_cursor: null } } : {}) } });
  });
}

const buildingList = (page: Page) => page.getByRole('navigation', { name: 'City buildings' });
const overlay = (page: Page) => page.locator('.dive-overlay');
const targetLock = (page: Page) => page.locator('.target-lock');

test.describe('the dive transition (motion allowed)', () => {
  test('opening the Library from the accessible building list focuses, dives under the overlay, then opens the screen', async ({ page }) => {
    await fixture(page);
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Olimpyx city', exact: true })).toBeAttached();
    await expect(overlay(page)).not.toHaveClass(/visible/);

    await buildingList(page).getByRole('button', { name: /^Central Library/ }).click();
    // Focusing: the target lock names the building; nothing is routed yet.
    await expect(targetLock(page)).toContainText('TARGET LOCKED: Central Library of Knowledge');
    await expect(page).not.toHaveURL(/view=/);
    // Diving: the full-screen "packet dive" overlay takes over.
    await expect(overlay(page)).toHaveClass(/visible/, { timeout: 2000 });
    await expect(overlay(page)).toContainText('/// INITIATING PACKET DIVE ///');
    await expect(overlay(page)).toContainText('Central Library of Knowledge');
    // Inside: the screen lands, its heading takes focus, and the target lock is gone.
    await expect(page.getByRole('heading', { name: 'Central Library of Knowledge', exact: true })).toBeFocused({ timeout: 2000 });
    await expect(page).toHaveURL(/view=knowledge/);
    await expect(targetLock(page)).toHaveCount(0);
    await expect(overlay(page)).not.toHaveClass(/visible/);
  });

  test('Back to the city hides the screen behind the overlay, then returns the camera and focus to the building', async ({ page }) => {
    await fixture(page);
    await page.goto('/');
    const library = buildingList(page).getByRole('button', { name: /^Central Library/ });
    await library.click();
    await expect(page.getByRole('heading', { name: 'Central Library of Knowledge', exact: true })).toBeFocused({ timeout: 2000 });

    await page.getByRole('link', { name: 'Back to the city', exact: true }).click();
    await expect(overlay(page)).toHaveClass(/visible/);
    // The screen is still present, just covered, until the exit's cover phase completes.
    await expect(page.getByRole('heading', { name: 'Central Library of Knowledge', exact: true })).toBeAttached();
    await expect(page.locator('.screen-layer')).toHaveCount(0, { timeout: 2000 });
    await expect(page).not.toHaveURL(/view=/);
    await expect(library).toBeFocused({ timeout: 2000 });
    await expect(overlay(page)).not.toHaveClass(/visible/);
  });

  test('a deep link opens the screen at once with the city underneath, and Back still zooms out of its building', async ({ page }) => {
    await fixture(page);
    await page.goto('/?view=agents');
    // Deep links never animate in: the overlay never shows on load.
    await expect(page.getByRole('heading', { name: 'Pantheon of Agents', exact: true })).toBeFocused();
    await expect(overlay(page)).not.toHaveClass(/visible/);
    // The city is still mounted underneath (just inert/aria-hidden while the screen covers it).
    await expect(page.locator('.city-shell-world')).toHaveAttribute('aria-hidden', 'true');

    await page.getByRole('link', { name: 'Back to the city', exact: true }).click();
    await expect(overlay(page)).toHaveClass(/visible/);
    await expect(page.locator('.screen-layer')).toHaveCount(0, { timeout: 2000 });
    await expect(page).not.toHaveURL(/view=/);
  });

  test('Escape cancels an in-progress dive without ever navigating', async ({ page }) => {
    await fixture(page);
    await page.goto('/');
    await buildingList(page).getByRole('button', { name: /^Pantheon of Agents/ }).click();
    await expect(targetLock(page)).toContainText('Pantheon of Agents');
    await page.keyboard.press('Escape');
    // The dive is cancelled before the overlay ever becomes visible, and no route is ever committed.
    await expect(overlay(page)).not.toHaveClass(/visible/);
    await page.waitForTimeout(1300); // longer than focus+dive, to prove it never lands
    await expect(page.locator('.screen-layer')).toHaveCount(0);
    await expect(page).not.toHaveURL(/view=/);
    await expect(page.getByRole('heading', { name: 'Olimpyx city', exact: true })).toBeAttached();
  });
});

test.describe('screens without a dive (reduced motion)', () => {
  test.use({ reducedMotion: 'reduce' });

  test('HUD nav opens a screen instantly, and Escape closes it and returns focus to the nav item', async ({ page }) => {
    await fixture(page);
    await page.goto('/');
    const knowledgeLink = page.getByRole('link', { name: 'Knowledge', exact: true });
    await knowledgeLink.click();
    await expect(page).toHaveURL(/view=knowledge/);
    await expect(page.getByRole('heading', { name: 'Central Library of Knowledge', exact: true })).toBeFocused();
    await expect(overlay(page)).not.toHaveClass(/visible/);

    await page.keyboard.press('Escape');
    await expect(page).not.toHaveURL(/view=/);
    await expect(page.locator('.screen-layer')).toHaveCount(0);
    await expect(knowledgeLink).toBeFocused();
  });

  test('browser Back and Forward mirror closing and opening the screen', async ({ page }) => {
    await fixture(page);
    await page.goto('/');
    await page.getByRole('link', { name: 'Agents', exact: true }).click();
    await expect(page).toHaveURL(/view=agents/);
    await expect(page.getByRole('heading', { name: 'Pantheon of Agents', exact: true })).toBeVisible();

    await page.goBack();
    await expect(page).not.toHaveURL(/view=/);
    await expect(page.locator('.screen-layer')).toHaveCount(0);
    await expect(page.getByRole('navigation', { name: 'Showcase navigation' })).toBeVisible();

    await page.goForward();
    await expect(page).toHaveURL(/view=agents/);
    await expect(page.getByRole('heading', { name: 'Pantheon of Agents', exact: true })).toBeVisible();
  });

  test('opening a room from the directory dives straight into it, without a "Back to the city" round trip', async ({ page }) => {
    await fixture(page);
    await page.goto('/?view=rooms');
    await expect(page.getByRole('heading', { name: 'Rooms', exact: true })).toBeVisible();
    await page.locator('.room-list .room-row').filter({ hasText: room.title }).click();
    await expect(page).toHaveURL(/room=room_shell/);
    await expect(page.getByRole('heading', { name: room.title, exact: true })).toBeVisible();
  });

  test('clicking the building label opens the same screen as the accessible list entry', async ({ page }) => {
    await fixture(page);
    await page.goto('/');
    // The bottom-left legend (PROMPT §2) is a second, coarser way to reach the two forum landmarks.
    await page.getByRole('button', { name: 'Library', exact: true }).click();
    await expect(page).toHaveURL(/view=knowledge/);
    await expect(page.getByRole('heading', { name: 'Central Library of Knowledge', exact: true })).toBeVisible();
  });
});

test.describe('phones (PROMPT §7): compact HUD', () => {
  test('the tab bar is the primary nav, the legend is gone, the camera is zoom/reset only, and the building directory is a collapsed sheet', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 700 });
    await fixture(page);
    await page.goto('/');

    // No legend at phone widths.
    await expect(page.locator('.hud-legend')).toHaveCount(0);

    // The tab bar is the one primary nav, with large touch targets and the current tab marked.
    const tabBar = page.getByRole('navigation', { name: 'Showcase navigation' });
    await expect(tabBar).toBeVisible();
    const overview = tabBar.getByRole('link', { name: 'Overview', exact: true });
    await expect(overview).toHaveAttribute('aria-current', 'page');
    const box = await overview.boundingBox();
    expect(box!.width).toBeGreaterThanOrEqual(44);
    expect(box!.height).toBeGreaterThanOrEqual(44);

    // The camera loses its D-pad: zoom in/out and reset only.
    const camera = page.getByRole('group', { name: 'Map camera' });
    await expect(camera.getByRole('button')).toHaveCount(3);
    await expect(camera.getByRole('button', { name: 'Zoom in' })).toBeVisible();
    await expect(camera.getByRole('button', { name: 'Reset view' })).toBeVisible();
    await expect(camera.getByRole('button', { name: 'Zoom out' })).toBeVisible();

    // The building directory is a collapsed sheet, reachable via its toggle.
    const toggle = page.getByRole('button', { name: /Buildings/ });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(buildingList(page)).toBeHidden();
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(buildingList(page)).toBeVisible();

    // Opening a screen from the tab bar is instant (no long dive) at phone width, even without
    // reduced-motion emulation: `useCityRoute`'s `animate()` excludes narrow viewports.
    await tabBar.getByRole('link', { name: 'Rooms', exact: true }).click();
    await expect(page.locator('.dive-overlay')).not.toHaveClass(/visible/);
    await expect(page.getByRole('heading', { name: 'Rooms', exact: true })).toBeVisible();
  });
});
