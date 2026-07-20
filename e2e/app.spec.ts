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

/**
 * The running system reports what it was BUILT from, which is a different fact
 * from the image tag an operator chose. A pin that builds one ref and labels it
 * another leaves a system that is healthy in every respect except being the
 * version anyone believes — undetectable from inside until this field existed.
 */
test('health reports the built-from version, matching package.json', async ({ request }) => {
  const pkg = JSON.parse(
    await import('node:fs/promises').then((fs) => fs.readFile('package.json', 'utf8')),
  ) as { version: string };

  const human = (await (await request.get('/api/health')).json()) as {
    data: { status: string; version: string };
  };
  expect(human.data.status).toBe('OK');
  expect(human.data.version, 'never a guess').not.toBe('unknown');
  expect(human.data.version).toBe(pkg.version);

  const agent = (await (
    await request.get('/agent/v1/health', { headers: { Authorization: 'Bearer e2e-ro' } })
  ).json()) as { data: { version: string } };
  expect(agent.data.version, 'both surfaces agree').toBe(pkg.version);
});
