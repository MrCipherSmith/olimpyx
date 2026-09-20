import { test, expect, type Page } from '@playwright/test';

test.use({ reducedMotion: 'reduce' });

async function clearStorage(page: Page) {
  await page.context().clearCookies();
  await page.evaluate(() => { try { localStorage.clear(); sessionStorage.clear(); } catch { /* ignore */ } });
}

async function mockShowcase(page: Page) {
  const createdAt = '2026-09-12T12:00:00.000Z';
  const actor = { actor_type: 'agent', agent_id: 'agt_i18n', display_name: 'i18n Agent' };
  const agent = { agent_id: actor.agent_id, name: actor.display_name, role: 'Tester', bio: 'bio', interests: [], capabilities: [], presence: 'offline', created_at: createdAt };
  const room = { room_id: 'room_i18n', slug: 'i18n', title: 'i18n room', description: '', created_at: createdAt, updated_at: createdAt, message_count: 0 };
  const snapshot = { generated_at: createdAt, counts: { agents: 1, rooms: 1, messages: 0, knowledge_cards: 0 }, agents: [agent], rooms: [room], knowledge_cards: [], recent_activity: [], relationships: [] };
  await page.route('**/v1/showcase', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/showcase')) {
      await route.fulfill({ json: { data: snapshot } });
    } else {
      await route.fulfill({ status: 404, json: { error: { code: 'not_found', message: 'Not found' } } });
    }
  });
  await page.route('**/v1/showcase/**', async route => {
    await route.fulfill({ json: { data: snapshot } });
  });
}

test.describe('i18n — language switcher (RU ↔ EN)', () => {
  test('default locale is Russian when localStorage is empty', async ({ page }) => {
    await mockShowcase(page);
    await page.goto('/');
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    // The HUD eyebrow on the showcase side reads "Публичная витрина".
    await expect(page.locator('.hud-eyebrow')).toContainText('Публичная витрина');
    await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
  });

  test('clicking the HUD switcher toggles to English and updates labels', async ({ page }) => {
    await mockShowcase(page);
    await page.goto('/');
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    const switcher = page.getByRole('button', { name: 'Сменить язык' });
    await switcher.click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.locator('.hud-eyebrow')).toContainText('Public showcase');
    // Persisted.
    const stored = await page.evaluate(() => localStorage.getItem('olimpyx.locale'));
    expect(stored).toBe('en');
  });

  test('choice persists across reloads', async ({ page }) => {
    await mockShowcase(page);
    await page.goto('/');
    await page.evaluate(() => localStorage.setItem('olimpyx.locale', 'en'));
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.locator('.hud-eyebrow')).toContainText('Public showcase');
    // Switch back to Russian
    const switcher = page.getByRole('button', { name: 'Switch language' });
    await switcher.click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
    await expect(page.locator('.hud-eyebrow')).toContainText('Публичная витрина');
  });

  test('unknown localStorage value falls back to Russian', async ({ page }) => {
    await mockShowcase(page);
    await page.goto('/');
    await page.evaluate(() => localStorage.setItem('olimpyx.locale', 'fr'));
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
  });

  test('keyboard activates the switcher (Enter)', async ({ page }) => {
    await mockShowcase(page);
    await page.goto('/');
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    const switcher = page.getByRole('button', { name: 'Сменить язык' });
    await switcher.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  });
});