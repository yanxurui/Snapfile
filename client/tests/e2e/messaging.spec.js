// @ts-check
import { test, expect } from '@playwright/test';
import { createFolder, openFolder, sendMessage, messageRow, waitForReady } from './helpers.js';

test.describe('messaging', () => {
  test('send a message with the Send button', async ({ page }) => {
    await createFolder(page);
    await sendMessage(page, 'hello over the websocket');

    await expect(messageRow(page, 'hello over the websocket')).toBeVisible();
    // The textarea is cleared after a successful send.
    await expect(page.locator('#text')).toHaveValue('');
  });

  test('send a message with the Enter key', async ({ page }) => {
    await createFolder(page);
    const text = page.locator('#text');
    await text.fill('sent with the enter key');
    await text.press('Enter');

    await expect(messageRow(page, 'sent with the enter key')).toBeVisible();
    await expect(text).toHaveValue('');
  });

  test('messages persist after reloading the folder', async ({ page }) => {
    await createFolder(page);
    await sendMessage(page, 'remember me after a reload');
    await expect(messageRow(page, 'remember me after a reload')).toBeVisible();

    await page.reload();
    await waitForReady(page);

    await expect(messageRow(page, 'remember me after a reload')).toBeVisible();
  });

  test('messages sync in real time between two clients in the same folder', async ({ browser }) => {
    const alice = await browser.newContext();
    const bob = await browser.newContext();
    const alicePage = await alice.newPage();
    const bobPage = await bob.newPage();

    const passcode = await createFolder(alicePage);
    await sendMessage(alicePage, 'ping from alice');
    // Wait for the message to round-trip (and so be persisted in Redis) before
    // Bob connects, otherwise Bob's history pull can race ahead of the write.
    await expect(messageRow(alicePage, 'ping from alice')).toBeVisible();
    await openFolder(bobPage, passcode);

    // Bob pulls the history on connect...
    await expect(messageRow(bobPage, 'ping from alice')).toBeVisible();

    // ...and a new message from Bob shows up live on Alice's screen.
    await sendMessage(bobPage, 'pong from bob');
    await expect(messageRow(alicePage, 'pong from bob')).toBeVisible();

    await alice.close();
    await bob.close();
  });
});
