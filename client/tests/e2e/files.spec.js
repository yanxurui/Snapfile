// @ts-check
import { readFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';
import { createFolder, uploadFile, uploadFiles, messageRow } from './helpers.js';

test.describe('files', () => {
  test('upload a file and see it in the message list', async ({ page }) => {
    await createFolder(page);

    const bytes = await uploadFile(page, 'e2e-note.txt', 'hello from an uploaded file');

    const row = messageRow(page, 'e2e-note.txt');
    await expect(row).toBeVisible();
    // The file row renders a clickable download link and the formatted size.
    await expect(row.locator('a')).toHaveAttribute('href', /\/files\?id=\d+&name=e2e-note\.txt/);
    await expect(row).toContainText(`${bytes}.0B`);

    // The upload status line confirms success with the server's file count.
    await expect(page.locator('.percent')).toContainText('Success: 1 file(s) uploaded');
  });

  test('larger files show a human-readable (KB-scaled) size', async ({ page }) => {
    await createFolder(page);

    // 2500 bytes -> server format_size() -> "2.5K" (1000-based scaling).
    await uploadFile(page, 'big.txt', 'x'.repeat(2500));

    await expect(messageRow(page, 'big.txt')).toContainText('2.5K');
  });

  test('upload multiple files at once', async ({ page }) => {
    await createFolder(page);

    await uploadFiles(page, [
      { name: 'first.txt', content: 'aaa' },
      { name: 'second.txt', content: 'bbbbbb' },
    ]);

    await expect(messageRow(page, 'first.txt')).toBeVisible();
    await expect(messageRow(page, 'second.txt')).toBeVisible();
    await expect(messageRow(page, 'first.txt').locator('a')).toBeVisible();
    await expect(messageRow(page, 'second.txt').locator('a')).toBeVisible();
    await expect(page.locator('.percent')).toContainText('Success: 2 file(s) uploaded');
  });

  test('an over-quota upload is rejected with an error', async ({ page }) => {
    await createFolder(page);

    // The E2E quota is 10 MB (STORAGE_PER_FOLDER); exceed it.
    await uploadFile(page, 'too-big.bin', 'x'.repeat(11 * 1000 * 1000));

    await expect(page.locator('.percent')).toContainText('Storage space not enough');
    // ...and the rejected file does not appear in the message list.
    await expect(messageRow(page, 'too-big.bin')).toHaveCount(0);
  });

  test('download an uploaded file and get its original content back', async ({ page }) => {
    await createFolder(page);

    const content = 'round-trip payload — ' + 'x'.repeat(200);
    await uploadFile(page, 'download-me.txt', content);

    const link = messageRow(page, 'download-me.txt').locator('a');
    await expect(link).toBeVisible();

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      link.click(),
    ]);

    expect(download.suggestedFilename()).toBe('download-me.txt');
    const path = await download.path();
    expect(path).toBeTruthy();
    const downloaded = await readFile(/** @type {string} */ (path), 'utf-8');
    // Verifies the full encrypt-on-upload / decrypt-on-download round trip.
    expect(downloaded).toBe(content);
  });
});
