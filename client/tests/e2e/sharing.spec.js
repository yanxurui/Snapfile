// @ts-check
import { test, expect } from '@playwright/test';
import { createFolder, sendMessage, messageRow, waitForReady } from './helpers.js';

// Clipboard access needs an explicit permission grant in Chromium.
test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

test.describe('sharing', () => {
  test('Share copies an invite link and shows a QR code', async ({ page }) => {
    const passcode = await createFolder(page);

    await page.locator('#toggle').click(); // open the dropdown menu
    await page.getByRole('link', { name: 'Share' }).click();

    // The QR modal opens regardless of clipboard availability.
    const qr = page.locator('.qr-overlay');
    await expect(qr).toBeVisible();
    await expect(qr.locator('img.qr-image')).toBeVisible();

    // The copied link points back at this folder.
    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboard).toContain(`/login.html?identity=${passcode}`);

    // Clicking the backdrop closes the modal.
    await qr.click({ position: { x: 5, y: 5 } });
    await expect(qr).toBeHidden();
  });

  test('opening the shared invite link auto-logs into the same folder', async ({ browser }) => {
    // The owner creates a folder and leaves a marker behind.
    const owner = await browser.newContext();
    const ownerPage = await owner.newPage();
    const passcode = await createFolder(ownerPage);
    await sendMessage(ownerPage, 'shared via invite link');
    await expect(messageRow(ownerPage, 'shared via invite link')).toBeVisible();
    await owner.close();

    // A guest who just opens the invite URL is logged straight into the folder.
    const guest = await browser.newContext();
    const guestPage = await guest.newPage();
    await guestPage.goto(`/login.html?identity=${passcode}`);
    await waitForReady(guestPage);
    await expect(messageRow(guestPage, 'shared via invite link')).toBeVisible();
    await guest.close();
  });
});
