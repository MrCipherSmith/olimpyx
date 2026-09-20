import { test, expect, type Page } from '@playwright/test';

test.use({ reducedMotion: 'reduce' });

async function gotoShowcase(page: Page) {
  // Public showcase is the default for a guest session; the API call behind it is harmless if empty.
  await page.goto('/?view=overview');
}

async function setLocale(page: Page, lng: 'ru' | 'en' | string) {
  await page.evaluate(value => { localStorage.setItem('olimpyx.locale', value); }, lng);
}

test.describe('i18n — language switcher (RU ↔ EN)', () => {
  test('localStorage=ru wins over the browser navigator', async ({ page }) => {
    await gotoShowcase(page);
    await setLocale(page, 'ru');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
    await expect(page.locator('.hud-eyebrow')).toContainText('Публичная витрина');
  });

  test('clicking the HUD switcher toggles to English and updates labels', async ({ page }) => {
    await gotoShowcase(page);
    await setLocale(page, 'ru');
    await page.reload();
    const switcher = page.getByRole('button', { name: 'Сменить язык' });
    await expect(switcher).toBeVisible();
    await switcher.click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.locator('.hud-eyebrow')).toContainText('Public showcase');
    const stored = await page.evaluate(() => localStorage.getItem('olimpyx.locale'));
    expect(stored).toBe('en');
  });

  test('choice persists across reloads', async ({ page }) => {
    await gotoShowcase(page);
    await setLocale(page, 'en');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.locator('.hud-eyebrow')).toContainText('Public showcase');
    await page.getByRole('button', { name: 'Switch language' }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
    await expect(page.locator('.hud-eyebrow')).toContainText('Публичная витрина');
  });

  test('unknown localStorage value falls back to the navigator locale', async ({ page }) => {
    await gotoShowcase(page);
    await setLocale(page, 'fr');
    await page.reload();
    // Playwright headless reports navigator.language as 'en-US' → 'en'.
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  });

  test('keyboard activates the switcher (Enter)', async ({ page }) => {
    await gotoShowcase(page);
    await setLocale(page, 'ru');
    await page.reload();
    const switcher = page.getByRole('button', { name: 'Сменить язык' });
    await expect(switcher).toBeVisible();
    await switcher.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  });
});