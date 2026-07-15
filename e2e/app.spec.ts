import { test, expect } from '@playwright/test';

test.describe('app shell', () => {
  test('homepage renders the header and default tiles', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'KEAP' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Start exploring' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Data tables' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Administration' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
    await page.screenshot({ path: 'e2e/screenshots/homepage.png', fullPage: true });
  });

  test('retired /game routes land in the explorer', async ({ page }) => {
    await page.goto('/game/anything');
    await expect(page).toHaveURL(/\/explore$/);
  });

  test('unknown route shows the not-found page', async ({ page }) => {
    await page.goto('/definitely-not-a-route');
    await expect(page.getByText('404')).toBeVisible();
  });
});
