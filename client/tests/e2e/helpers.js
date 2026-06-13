// @ts-check
import { expect } from '@playwright/test';

/**
 * Shared helpers for the Snapfile end-to-end suite. They drive the real UI the
 * same way a user would (login page -> websocket-backed app) so every spec
 * exercises the full HTTP + WebSocket + Redis stack.
 */

/** Locator for a single message row in the chat list that contains `text`. */
export function messageRow(page, text) {
  return page.locator('#middle tr', { hasText: text });
}

/**
 * Wait until the folder is fully open: the status bar only renders after the
 * websocket delivers its `connect` frame, so it's a reliable "socket is live"
 * signal and a good gate before sending messages.
 */
export async function waitForReady(page) {
  await expect(page.locator('#status_bar')).toBeVisible();
}

/**
 * Create a brand new folder through the login page.
 * @returns {Promise<string>} the generated passcode (used to re-open the folder).
 */
export async function createFolder(page) {
  await page.goto('/login.html');
  await page.getByRole('button', { name: /create a new folder/i }).click();
  await waitForReady(page);
  const passcode = await page.evaluate(() => localStorage.getItem('identity'));
  expect(passcode, 'a passcode should be stored after creating a folder').toBeTruthy();
  return /** @type {string} */ (passcode);
}

/** Open an existing folder by typing its passcode on the login page. */
export async function openFolder(page, passcode) {
  await page.goto('/login.html');
  await page.getByPlaceholder('Please input your passcode').fill(passcode);
  await page.getByRole('button', { name: /open your folder/i }).click();
  await waitForReady(page);
}

/** Type a message and send it via the Send button (waits for the socket to be ready). */
export async function sendMessage(page, text) {
  await page.locator('#text').fill(text);
  const sendButton = page.locator('#send_message');
  // The button is disabled until the websocket is OPEN and the textarea is non-empty.
  await expect(sendButton).toBeEnabled();
  await sendButton.click();
}

/**
 * Upload one or more in-memory files through the hidden file input.
 * @param {{name: string, content: string|Buffer, mimeType?: string}[]} files
 * @returns {Promise<number[]>} the byte length of each uploaded file.
 */
export async function uploadFiles(page, files) {
  const payloads = files.map((f) => ({
    name: f.name,
    mimeType: f.mimeType || 'text/plain',
    buffer: Buffer.from(f.content),
  }));
  await page.locator('input[type="file"]').setInputFiles(payloads);
  return payloads.map((p) => p.buffer.byteLength);
}

/**
 * Upload a single in-memory file through the hidden file input.
 * @returns {Promise<number>} the number of bytes uploaded.
 */
export async function uploadFile(page, name, content) {
  const [bytes] = await uploadFiles(page, [{ name, content }]);
  return bytes;
}
