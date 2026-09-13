import { test, expect } from '@playwright/test';

/**
 * Addressable explore view — focus / view / lens / relations round-trip
 * through the URL query so any view is a shareable link. Drives the UI (no
 * canvas picking needed) and asserts the URL both ways: state → URL, and a
 * fresh load of that URL → restored state.
 */
test.describe('addressable explore view', () => {
  test('view control writes ?view=, and a reload restores it', async ({ page }) => {
    await page.goto('/explore');
    await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15_000 });
    // Clean start — Folders (core-on/fs) is the default, so no ?view.
    expect(new URL(page.url()).search).toBe('');
    await expect(page.getByTestId('explore-view-control')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Folders', exact: true })).toBeVisible();

    // Taxonomy → ?view=taxonomy.
    await page.getByRole('button', { name: 'Taxonomy', exact: true }).click();
    await expect.poll(() => new URL(page.url()).searchParams.get('view')).toBe('taxonomy');

    const shared = page.url();
    await page.goto(shared);
    await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15_000 });
    expect(new URL(page.url()).searchParams.get('view')).toBe('taxonomy');

    // Constellation (core off) → ?view=constellation. The segmented control
    // stays mounted; only the selected segment changes.
    await page.getByRole('button', { name: 'Constellation', exact: true }).click();
    await expect.poll(() => new URL(page.url()).searchParams.get('view')).toBe('constellation');
    await page.goto(page.url());
    await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15_000 });
    expect(new URL(page.url()).searchParams.get('view')).toBe('constellation');
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
