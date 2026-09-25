// @ts-check
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createFolder, openFolder, sendMessage, messageRow, waitForReady } from './helpers.js';

async function redis(...command) {
  const runtime = JSON.parse(await readFile(resolve('../.cache/e2e-current.json'), 'utf8'));
  return execFileSync('redis-cli', ['-h', '127.0.0.1', '-p', runtime.redisPort, '-n', '15',
    '--raw', ...command], { encoding: 'utf8' }).trim();
}

async function captureSocket(page) {
  await page.addInitScript(() => {
    const NativeWebSocket = window.WebSocket;
    window.WebSocket = class extends NativeWebSocket {
      constructor(...args) {
        super(...args);
        window.testSocket = this;
      }
    };
  });
}

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

  test('live frames and Redis contain only ciphertext; fragment guests decrypt text, Unicode and links', async ({ page, browser }) => {
    const frames = [];
    let auth;
    page.on('request', request => {
      if (request.url().endsWith('/signup')) auth = new URLSearchParams(request.postData()).get('identity');
    });
    page.on('websocket', socket => {
      socket.on('framesent', frame => frames.push(String(frame.payload)));
      socket.on('framereceived', frame => frames.push(String(frame.payload)));
    });
    const passcode = await createFolder(page);
    const text = 'chat-private-marker-a941 \u4e16\u754c \u{1f30d}\nsecond line';
    await sendMessage(page, text);
    await expect(messageRow(page, 'chat-private-marker-a941')).toBeVisible();
    const identity = createHash('sha256').update(auth).digest('hex');
    const stored = JSON.parse(await redis('LINDEX', `messages:${identity}`, '0'));
    const outgoing = frames.map(frame => JSON.parse(frame)).find(frame => frame.action === 'send' && frame.data);
    expect(outgoing.data).toMatch(/^SNAPCHAT01\.[A-Za-z0-9_-]+$/);
    expect(stored.data).toBe(outgoing.data);
    expect(stored.size).toBe(Buffer.byteLength(outgoing.data));
    expect(JSON.stringify(frames)).not.toContain('chat-private-marker-a941');
    expect(JSON.stringify(stored)).not.toContain('chat-private-marker-a941');
    const folder = JSON.parse(await redis('GET', `folder:${identity}`));
    expect(folder).not.toHaveProperty('chat_key');
    expect(folder.current_size).toBe(Buffer.byteLength(outgoing.data));

    const guest = await browser.newContext();
    const guestPage = await guest.newPage();
    await guestPage.goto(`/login.html#identity=${passcode}`);
    await waitForReady(guestPage);
    await expect(guestPage.locator('#middle tr').first().locator('td').first()).toHaveText(text);
    await sendMessage(guestPage, 'https://example.com/private-chat-link');
    await expect(page.getByRole('link', { name: 'https://example.com/private-chat-link' }))
      .toHaveAttribute('href', 'https://example.com/private-chat-link');
    await page.reload();
    await waitForReady(page);
    await expect(page.locator('#middle tr').first().locator('td').first()).toHaveText(text);
    await guest.close();
  });

  test('rapid sends remain ordered across paged history, reconnect and duplicate delivery', async ({ page }) => {
    await captureSocket(page);
    const received = [];
    const pulls = [];
    page.on('websocket', socket => {
      socket.on('framesent', frame => {
        const data = JSON.parse(String(frame.payload));
        if (data.action === 'pull') pulls.push(data.offset);
      });
      socket.on('framereceived', frame => {
        const data = JSON.parse(String(frame.payload));
        if (data.action === 'send' && data.msgs.length) received.push(data);
      });
    });
    await createFolder(page);
    const texts = Array.from({ length: 129 }, (_, i) => `ordered-${i.toString().padStart(3, '0')} \u00e9\nline`);
    for (const text of texts) await sendMessage(page, text);
    await expect(page.locator('#middle tr')).toHaveCount(texts.length);
    expect(await page.locator('#middle tr td:first-child').allTextContents()).toEqual(texts);
    // Replay a real received frame while reconnecting; it must not create a second row.
    await page.evaluate(frame => {
      window.testSocket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(frame) }));
      window.testSocket.close();
    }, received.at(-1));
    await page.waitForFunction(() => window.testSocket.readyState === WebSocket.OPEN);
    await expect(page.locator('#middle tr')).toHaveCount(texts.length);
    await sendMessage(page, 'after reconnect');
    await expect(messageRow(page, 'after reconnect')).toBeVisible();
    const beforeReload = pulls.length;
    await page.reload();
    await expect(page.locator('#middle tr')).toHaveCount(texts.length + 1);
    expect(await page.locator('#middle tr td:first-child').allTextContents()).toEqual([...texts, 'after reconnect']);
    expect(pulls.slice(beforeReload)).toEqual([0, 64, 128]);
  });

  test('live messages arriving before the first history page are ordered and deduplicated', async ({ page, browser }) => {
    const passcode = await createFolder(page);
    const texts = Array.from({ length: 19 }, (_, i) => `history-live-race-${i}`);
    for (const text of texts) await sendMessage(page, text);
    await expect(page.locator('#middle tr')).toHaveCount(texts.length);
    const guest = await browser.newContext();
    const guestPage = await guest.newPage();
    await guestPage.addInitScript(() => {
      const NativeWebSocket = window.WebSocket;
      window.WebSocket = class extends NativeWebSocket {
        send(data) {
          const request = JSON.parse(data);
          if (request.action === 'pull' && request.offset === 0 && !window.releaseHistory) {
            // Delay, then send the real network request so live frames arrive first.
            window.releaseHistory = () => super.send(data);
            return;
          }
          super.send(data);
        }
      };
    });
    await guestPage.goto(`/login.html#identity=${passcode}`);
    await guestPage.waitForFunction(() => !!window.releaseHistory);
    for (let i = 0; i < 3; i++) {
      const text = `new-live-${i}`;
      texts.push(text);
      await sendMessage(page, text);
    }
    await expect(page.locator('#middle tr')).toHaveCount(texts.length);
    await expect(guestPage.locator('#middle tr')).toHaveCount(0);
    await guestPage.evaluate(() => window.releaseHistory());
    await expect(guestPage.locator('#middle tr')).toHaveCount(texts.length);
    expect(await guestPage.locator('#middle tr td:first-child').allTextContents()).toEqual(texts);
    await guest.close();
  });

  test('tampered and wrong-key messages show individual errors; later valid live and history messages still render', async ({ page }) => {
    let auth;
    page.on('request', request => {
      if (request.url().endsWith('/signup')) auth = new URLSearchParams(request.postData()).get('identity');
    });
    await createFolder(page);
    await sendMessage(page, 'before failures');
    await expect(messageRow(page, 'before failures')).toBeVisible();
    const harness = await page.context().newPage();
    await harness.goto('/tests/e2e/stream.html');
    await harness.waitForFunction(() => !!window.streams);
    await harness.evaluate(async () => {
      const { chatKey } = await window.streams.credentials(localStorage.getItem('identity'));
      const wrong = (await window.streams.credentials('wrong-passcode')).chatKey;
      const encrypted = await window.streams.encryptChat('must never display', chatKey);
      const tampered = encrypted.slice(0, 30) + (encrypted[30] === 'A' ? 'B' : 'A') + encrypted.slice(31);
      const messages = [tampered, await window.streams.encryptChat('wrong key text', wrong),
        await window.streams.encryptChat('after failures', chatKey)];
      await new Promise((resolve, reject) => {
        const socket = new WebSocket(`wss://${location.host}/ws`);
        let sent = 0;
        socket.onmessage = event => {
          const data = JSON.parse(event.data);
          if (data.action === 'error') { reject(new Error(data.message)); socket.close(); return; }
          if (sent === messages.length) { socket.close(); resolve(); }
          else socket.send(JSON.stringify({ action: 'send', data: messages[sent++] }));
        };
        socket.onerror = reject;
      });
    });
    await expect(page.locator('#middle .decrypt-error')).toHaveCount(2);
    await expect(messageRow(page, 'after failures')).toBeVisible();
    await expect(messageRow(page, 'must never display')).toHaveCount(0);
    const identity = createHash('sha256').update(auth).digest('hex');
    const first = JSON.parse(await redis('LINDEX', `messages:${identity}`, '0'));
    first.data = 'malformed stored chat envelope';
    await redis('LSET', `messages:${identity}`, '0', JSON.stringify(first));
    await page.reload();
    await expect(page.locator('#middle .decrypt-error')).toHaveCount(3);
    await expect(messageRow(page, 'after failures')).toBeVisible();
    await sendMessage(page, 'still usable');
    await expect(messageRow(page, 'still usable')).toBeVisible();
    await expect(page.locator('#middle tr')).toHaveCount(5);
    await harness.close();
  });

  test('plaintext or malformed clients get visible errors and do not consume quota', async ({ page }) => {
    await captureSocket(page);
    await createFolder(page);
    await page.evaluate(() => window.testSocket.send(JSON.stringify({ action: 'send', data: 'stale plaintext', size: 0 })));
    await expect(page.getByRole('alert')).toContainText('encrypted SNAPCHAT01');
    await expect(page.locator('#middle tr')).toHaveCount(0);
    await page.evaluate(() => window.testSocket.send(JSON.stringify({ action: 'send', data: 'SNAPCHAT01.A' })));
    await expect(page.getByRole('alert')).toContainText('Invalid encrypted chat');
    await sendMessage(page, 'valid after rejection');
    await expect(messageRow(page, 'valid after rejection')).toBeVisible();
  });

  test('oversize UTF-8 text stays in the composer and quota errors are visible', async ({ page }) => {
    await captureSocket(page);
    await createFolder(page);
    const tooLarge = '\u00e9'.repeat(32769);
    await sendMessage(page, tooLarge);
    await expect(page.getByRole('alert')).toContainText('65536 UTF-8 bytes');
    await expect(page.locator('#text')).toHaveValue(tooLarge);
    await expect(page.locator('#middle tr')).toHaveCount(0);
    const token = await page.evaluate(async () => {
      const response = await fetch('/files', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ size: 96 * 1024 * 1024 - 30, metadata: 'opaque' }) });
      if (!response.ok) throw new Error(await response.text());
      return (await response.json()).token;
    });
    await sendMessage(page, 'quota test');
    await expect(page.getByRole('alert')).toHaveText('Storage space not enough');
    await expect(page.locator('#middle tr')).toHaveCount(0);
    await page.evaluate(token => fetch(`/files/${token}`, { method: 'DELETE' }), token);
    await sendMessage(page, 'works after releasing quota');
    await expect(messageRow(page, 'works after releasing quota')).toBeVisible();
  });
});
