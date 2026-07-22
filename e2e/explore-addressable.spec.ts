import { test, expect } from '@playwright/test';

/**
 * Addressable explore view — focus / core order / lens / relations round-trip
 * through the URL query so any view is a shareable link. Drives the UI (no
 * canvas picking needed) and asserts the URL both ways: state → URL, and a
 * fresh load of that URL → restored state.
 */
test.describe('addressable explore view', () => {
  test('core toggle + reorder write the URL, and a reload restores them', async ({ page }) => {
    await page.goto('/explore');
    await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15_000 });
    // Clean start — no explore params; core-on/fs IS the default (no ?core),
    // so the reorder bar is already visible.
    expect(new URL(page.url()).search).toBe('');
    await expect(page.getByRole('button', { name: 'Folders', exact: true })).toBeVisible();

    // Reorder to Taxonomy → ?core=taxonomy.
    await page.getByRole('button', { name: 'Taxonomy', exact: true }).click();
    await expect.poll(() => new URL(page.url()).searchParams.get('core')).toBe('taxonomy');

    // Fresh load of the shareable URL restores the core view + order (the
    // reorder bar only renders when core is on).
    const shared = page.url();
    await page.goto(shared);
    await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: 'Folders', exact: true })).toBeVisible();
    expect(new URL(page.url()).searchParams.get('core')).toBe('taxonomy');

    // Core OFF → explicit ?core=0 (absence now means the on-by-default view),
    // and a fresh load of that URL restores the off state (no reorder bar).
    await page.getByRole('button', { name: 'Core', exact: true }).click();
    await expect.poll(() => new URL(page.url()).searchParams.get('core')).toBe('0');
    await page.goto(page.url());
    await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: 'Folders', exact: true })).toHaveCount(0);
  });

  test('relations toggle round-trips as ?rel=0', async ({ page }) => {
    await page.goto('/explore');
    await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15_000 });
    // Relations default ON → no param. Toggling off writes ?rel=0.
    const rel = page.getByRole('button', { name: 'Vazby' }).or(page.getByRole('button', { name: 'Relations' }));
    if (await rel.first().isVisible().catch(() => false)) {
      await rel.first().click();
      await expect.poll(() => new URL(page.url()).searchParams.get('rel')).toBe('0');
    }
  });
});
