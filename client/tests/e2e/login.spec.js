// @ts-check
import { test, expect } from '@playwright/test';
import { createFolder, openFolder, sendMessage, messageRow, waitForReady } from './helpers.js';

test.describe('folders & sessions', () => {
  test('create a new folder and land in the app', async ({ page }) => {
    const passcode = await createFolder(page);

    // We are now in the app, not the login page.
    await expect(page).toHaveURL(/\/(index\.html)?(\?.*)?$/);
    await expect(page.locator('#text')).toBeVisible();

    // The status bar reports the folder usage/expiry once the socket connects.
    const statusBar = page.locator('#status_bar');
    await expect(statusBar).toContainText('used');
    await expect(statusBar).toContainText(passcode.toUpperCase());
  });

  test('open an existing folder with its passcode', async ({ browser }) => {
    // First session creates a folder and leaves a message behind.
    const creator = await browser.newContext();
    const creatorPage = await creator.newPage();
    const passcode = await createFolder(creatorPage);
    await sendMessage(creatorPage, 'left here by the creator');
    await expect(messageRow(creatorPage, 'left here by the creator')).toBeVisible();
    await creator.close();

    // A fresh session re-opens the same folder and sees the history.
    const visitor = await browser.newContext();
    const visitorPage = await visitor.newPage();
    await openFolder(visitorPage, passcode);
    await expect(messageRow(visitorPage, 'left here by the creator')).toBeVisible();
    await visitor.close();
  });

  test('a wrong passcode shows an error and stays on the login page', async ({ page }) => {
    await page.goto('/login.html');
    await page.getByPlaceholder('Please input your passcode').fill('definitely-not-a-real-passcode');
    await page.getByRole('button', { name: /open your folder/i }).click();

    await expect(page.locator('.error')).toContainText(/wrong passcode/i);
    await expect(page).toHaveURL(/login\.html/);
  });

  test('logout returns to the login page and clears the session', async ({ page }) => {
    await createFolder(page);

    await page.locator('#toggle').click(); // open the dropdown menu
    await page.locator('#logout').click();

    await page.waitForURL(/login\.html/);
    const identity = await page.evaluate(() => localStorage.getItem('identity'));
    expect(identity).toBeNull();
  });

  test('the app redirects to login when there is no session', async ({ page }) => {
    // Visiting the app with no stored identity should bounce to the login page.
    await page.goto('/login.html'); // establish the origin so we can clear storage
    await page.evaluate(() => localStorage.clear());
    await page.goto('/');
    await expect(page).toHaveURL(/login\.html/);
  });
});
