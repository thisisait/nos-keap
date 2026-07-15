import { test, expect } from '@playwright/test';

/**
 * The R2′ data-tables journey, end to end through the real UI: create a
 * table with an OLAP-shaped schema (dimension × measure) on the libsql
 * driver, add rows in the grid, edit a cell inline, watch the Σ summary
 * bar aggregate, sort, delete a row, then delete the table.
 * Serial: each step builds on the previous one.
 */
test.describe.serial('data tables', () => {
  test('list starts empty and the storage picker is honest', async ({ page }) => {
    await page.goto('/tables');
    await expect(page.getByText('No tables yet.')).toBeVisible();

    await page.getByRole('button', { name: 'New table' }).click();
    // Driver cards come from GET /api/tables/drivers — libsql must be
    // available, rustfs unavailable without KEAP_RUSTFS_* env.
    const libsql = page.getByRole('button', { name: /SQL/ }).first();
    await expect(libsql).toBeEnabled();
    await expect(page.getByRole('button', { name: /unavailable/ }).first()).toBeDisabled();
    await page.screenshot({ path: 'e2e/screenshots/tables-storage-picker.png', fullPage: true });
  });

  test('create a table with dimension + measure columns', async ({ page }) => {
    await page.goto('/tables');
    await page.getByRole('button', { name: 'New table' }).click();
    await page.getByLabel('Title').fill('Workshop stock');

    // First column: item (text, dimension)
    const colRows = page.locator('main .grid.md\\:grid-cols-7');
    await colRows.nth(0).getByPlaceholder('key (snake_case)').fill('item');
    await colRows.nth(0).getByPlaceholder('Label').fill('Item');
    await colRows.nth(0).locator('select').nth(1).selectOption('dimension');

    // Second column: qty (number, measure)
    await page.getByRole('button', { name: 'Add column' }).click();
    await colRows.nth(1).getByPlaceholder('key (snake_case)').fill('qty');
    await colRows.nth(1).getByPlaceholder('Label').fill('Qty');
    await colRows.nth(1).locator('select').nth(0).selectOption('number');
    await colRows.nth(1).locator('select').nth(1).selectOption('measure');

    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('Table created.').first()).toBeVisible();
    await expect(page.getByRole('link', { name: /Workshop stock/ })).toBeVisible();
    await expect(page.getByText('0 rows · 2 columns')).toBeVisible();
  });

  test('grid: add rows, inline-edit a cell, Σ summary aggregates', async ({ page }) => {
    await page.goto('/tables');
    await page.getByRole('link', { name: /Workshop stock/ }).click();
    await expect(page.getByText('No rows')).toBeVisible();

    // Add two rows through the form row (Enter submits).
    await page.getByPlaceholder('Item').fill('bolt');
    await page.getByPlaceholder('Qty').fill('5');
    await page.getByRole('button', { name: 'Add row' }).click();
    await expect(page.getByRole('button', { name: 'bolt' })).toBeVisible();

    await page.getByPlaceholder('Item').fill('nut');
    await page.getByPlaceholder('Qty').fill('9');
    await page.getByRole('button', { name: 'Add row' }).click();
    await expect(page.getByRole('button', { name: 'nut' })).toBeVisible();

    // Inline edit: bolt 5 -> 7 (click cell, type, Enter).
    await page.getByRole('button', { name: '5', exact: true }).click();
    const editor = page.locator('tbody input');
    await editor.fill('7');
    await editor.press('Enter');
    await expect(page.getByRole('button', { name: '7', exact: true })).toBeVisible();

    // Σ summary bar: sum(qty) grouped by the first dimension (item).
    const summary = page.locator('main > div').first();
    await expect(summary.getByText('Summary')).toBeVisible();
    await expect(summary.getByText(/bolt/)).toBeVisible();
    await expect(summary.getByText(/Σ Qty:\s*7/)).toBeVisible();
    await expect(summary.getByText(/Σ Qty:\s*9/)).toBeVisible();

    // Header meta reflects the server-side row count.
    await expect(page.getByText('2 rows · 2 columns')).toBeVisible();
    await page.screenshot({ path: 'e2e/screenshots/tables-grid.png', fullPage: true });
  });

  test('server-side sort and row delete', async ({ page }) => {
    await page.goto('/tables');
    await page.getByRole('link', { name: /Workshop stock/ }).click();

    // Sort by Qty ascending: bolt(7) before nut(9); descending flips it.
    await page.getByRole('button', { name: /^Qty/ }).click();
    const firstDataRow = page.locator('tbody tr').first();
    await expect(firstDataRow.getByRole('button', { name: 'bolt' })).toBeVisible();
    await page.getByRole('button', { name: /^Qty/ }).click();
    await expect(firstDataRow.getByRole('button', { name: 'nut' })).toBeVisible();

    // Delete one row.
    await firstDataRow.getByRole('button', { name: 'Delete' }).click();
    await expect(page.getByText('1 rows · 2 columns')).toBeVisible();
  });

  test('delete the table', async ({ page }) => {
    await page.goto('/tables');
    await expect(page.getByRole('link', { name: /Workshop stock/ })).toBeVisible();
    await page.getByRole('button', { name: 'Delete' }).click();
    await expect(page.getByText('Table deleted.').first()).toBeVisible();
    await expect(page.getByText('No tables yet.')).toBeVisible();
  });
});
