import { test, expect, chromium } from '@playwright/test';
import { readFile, stat } from 'node:fs/promises';
import { credentials, encryptFile } from '../../src/crypto.js';
import { createFolder, openFolder, uploadFile, uploadFiles, messageRow, installDiskPicker, diskBytes, storedFiles } from './helpers.js';

test.beforeEach(async ({ page, browserName }) => {
  if (browserName === 'chromium') {
    // WebKit exercises its real missing APIs; Chromium also covers the fallback.
    await page.addInitScript(() => {
      window.showSaveFilePicker = undefined;
      const NativeRequest = Request;
      window.Request = class extends NativeRequest {
        constructor(url, init) {
          super(url, { method: init.method, body: String(init.body) });
        }
      };
    });
  }
  await page.addInitScript(() => {
    window.transferCalls = [];
    const original = window.fetch;
    window.fetch = function (url, init) {
      if (init?.method === 'PUT') window.transferCalls.push({
        blob: init.body instanceof Blob, duplex: Object.hasOwn(init, 'duplex'), size: init.body.size
      });
      return original.call(this, url, init);
    };
    window.revokedDownloads = [];
    const revoke = URL.revokeObjectURL;
    URL.revokeObjectURL = url => { window.revokedDownloads.push(url); revoke.call(URL, url); };
  });
});

async function saveBuffered(page, name) {
  await messageRow(page, name).locator('a').click();
  await expect(page.getByRole('status')).toContainText('Ready: authenticated download complete');
  const link = page.getByRole('link', { name: 'Save file', exact: true });
  await expect(link).toHaveAttribute('download', name);
  const download = page.waitForEvent('download');
  await link.click();
  const result = await download;
  expect(result.suggestedFilename()).toBe(name);
  return readFile(await result.path());
}

test('real buffered photo upload and explicit-gesture Blob save preserve encrypted bytes and empty files', async ({ page, browserName }) => {
  const before = new Set(await storedFiles());
  const passcode = await createFolder(page);
  const payloads = [];
  page.on('request', request => {
    if (request.method() === 'POST') payloads.push(request.postData() || '');
  });
  const photo = Buffer.alloc(1048576 + 37, 93);
  photo.set([0xff, 0xd8, 0xff, 0xe0]);
  await uploadFiles(page, [
    { name: 'private-photo.jpg', content: photo, mimeType: 'image/jpeg' },
    { name: 'empty.txt', content: '' },
  ]);
  await expect(page.locator('.percent')).toContainText('Success: 2');
  expect(await page.evaluate(() => window.transferCalls)).toEqual([
    { blob: true, duplex: false, size: photo.length + 95 },
    { blob: true, duplex: false, size: 53 },
  ]);
  const stored = (await storedFiles()).filter(path => !before.has(path));
  expect(stored).toHaveLength(2);
  for (const path of stored) {
    const wire = await readFile(path);
    expect(wire.subarray(0, 8).toString()).toBe('SNAPFE02');
    expect(wire.includes(photo)).toBe(false);
    expect(wire.includes(Buffer.from('private-photo.jpg'))).toBe(false);
  }
  expect(payloads.every(body => !body.includes(passcode) && !body.includes('private-photo.jpg'))).toBe(true);
  expect(await saveBuffered(page, 'private-photo.jpg')).toEqual(photo);
  const previousUrl = await page.getByRole('link', { name: 'Save file', exact: true }).getAttribute('href');
  expect(await saveBuffered(page, 'empty.txt')).toEqual(Buffer.alloc(0));
  expect(await page.evaluate(url => window.revokedDownloads.includes(url), previousUrl)).toBe(true);
  await page.getByRole('button', { name: 'Discard download' }).click();
  await expect(page.getByRole('link', { name: 'Save file', exact: true })).toHaveCount(0);
  console.log(`${browserName}: actual Blob PUT without duplex and user-clicked Blob download verified`);
});

test('desktop streams and mobile buffers interoperate in both directions', async ({ page }) => {
  const code = await createFolder(page);
  const desktop = await chromium.launch();
  const context = await desktop.newContext({ baseURL: test.info().project.use.baseURL, ignoreHTTPSErrors: true });
  const peer = await context.newPage();
  try {
    await installDiskPicker(peer);
    await openFolder(peer, code);
    await uploadFile(page, 'from-mobile.txt', 'mobile to disk');
    await expect(messageRow(peer, 'from-mobile.txt')).toBeVisible();
    await messageRow(peer, 'from-mobile.txt').locator('a').click();
    await expect(peer.getByRole('status')).toContainText('Saved: authenticated download complete');
    expect(Buffer.from(await diskBytes(peer, 'from-mobile.txt')).toString()).toBe('mobile to disk');
    await uploadFile(peer, 'from-desktop.txt', 'stream to mobile');
    await expect(messageRow(page, 'from-desktop.txt')).toBeVisible();
    expect((await saveBuffered(page, 'from-desktop.txt')).toString()).toBe('stream to mobile');
  } finally {
    await desktop.close();
  }
});

test('the exact upload limit is rejected without file reads or admission', async ({ page }) => {
  await createFolder(page);
  const admissions = [];
  page.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/files') admissions.push(request);
  });
  await page.evaluate(() => {
    const file = new File(['tiny'], 'oversized.jpg');
    Object.defineProperty(file, 'size', { value: 100_000_000 });
    file.slice = () => { throw new Error('Oversized file was read'); };
    const transfer = new DataTransfer();
    transfer.items.add(file);
    const input = document.querySelector('input[type=file]');
    input.files = transfer.files;
    input.dispatchEvent(new Event('change'));
  });
  await expect(page.locator('.percent')).toContainText('smaller than 100 MB');
  await expect(page.locator('.percent')).toHaveCSS('color', 'rgb(176, 0, 32)');
  expect(admissions).toEqual([]);
  await uploadFile(page, 'retry.txt', 'valid');
  await expect(page.locator('.percent')).toContainText('Success: 1');
  await expect(page.locator('.percent')).not.toHaveClass(/upload-error/);
});

test('authenticated oversized metadata is rejected before fetching a buffered download', async ({ page }) => {
  let metadata;
  await page.routeWebSocket('**/ws', socket => {
    const server = socket.connectToServer();
    server.onMessage(raw => {
      const frame = JSON.parse(String(raw));
      for (const message of frame.msgs || []) {
        if (message.type === 1 && metadata) message.data = metadata;
      }
      socket.send(JSON.stringify(frame));
    });
  });
  const code = await createFolder(page);
  const { key } = await credentials(code);
  const oversized = await encryptFile({ name: 'too-large.bin', size: 100_000_000 }, key);
  metadata = oversized.metadata;
  oversized.dispose();
  await uploadFile(page, 'small.bin', 'small ciphertext fixture');
  await expect(messageRow(page, 'too-large.bin')).toBeVisible();
  const downloads = [];
  page.on('request', request => {
    if (request.method() === 'GET' && new URL(request.url()).pathname === '/files') downloads.push(request);
  });
  await messageRow(page, 'too-large.bin').locator('a').click();
  await expect(page.getByRole('status')).toContainText('smaller than 100 MB');
  await expect(page.getByRole('status')).toHaveCSS('color', 'rgb(176, 0, 32)');
  expect(downloads).toEqual([]);
  await expect(page.getByRole('link', { name: 'Save file', exact: true })).toHaveCount(0);
});

test('buffered quota errors stay specific and cancellation before admission permits retry', async ({ page }) => {
  await createFolder(page);
  await page.route('**/files', route => route.fulfill({ status: 431, body: 'Storage space not enough' }));
  await uploadFile(page, 'quota.txt', 'private');
  await expect(page.locator('.percent')).toHaveText('Upload failed (reserving space): Storage space not enough');
  await expect(page.locator('.percent')).toHaveCSS('color', 'rgb(176, 0, 32)');
  await page.unroute('**/files');
  const admissions = [];
  page.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/files') admissions.push(request);
  });
  await page.evaluate(() => {
    const slice = File.prototype.slice;
    window.readStarted = false;
    window.restoreSlice = () => { File.prototype.slice = slice; };
    File.prototype.slice = function (...args) {
      window.readStarted = true;
      return { arrayBuffer: () => new Promise(resolve => {
        window.releaseSlice = async () => resolve(await slice.apply(this, args).arrayBuffer());
      }) };
    };
  });
  await uploadFile(page, 'cancel.jpg', 'cancel while encrypting');
  await expect.poll(() => page.evaluate(() => window.readStarted)).toBe(true);
  await page.locator('#cancel').click();
  await page.evaluate(() => { window.restoreSlice(); window.releaseSlice(); });
  await expect(page.locator('.percent')).toContainText('Canceled');
  await expect(page.locator('.percent')).not.toHaveClass(/upload-error/);
  expect(admissions).toEqual([]);
  await uploadFile(page, 'after-cancel.txt', 'retry');
  await expect(page.locator('.percent')).toContainText('Success: 1');
});

test('corrupt ciphertext and canceled downloads never offer a plaintext Blob', async ({ page }) => {
  await createFolder(page);
  await uploadFile(page, 'damaged.bin', Buffer.alloc(2 * 1048576, 17));
  await expect(messageRow(page, 'damaged.bin')).toBeVisible();
  await page.route('**/files?id=*', async route => {
    const response = await route.fetch();
    const bytes = await response.body();
    bytes[1048700] ^= 1;
    await route.fulfill({ response, body: bytes });
  });
  await messageRow(page, 'damaged.bin').locator('a').click();
  await expect(page.getByRole('status')).toContainText('Download failed');
  await expect(page.getByRole('link', { name: 'Save file', exact: true })).toHaveCount(0);
  await page.unroute('**/files?id=*');
  await page.route('**/files?id=*', route => route.continue({
    headers: { ...route.request().headers(), 'x-e2e-slow-download': '1' }
  }));
  await messageRow(page, 'damaged.bin').locator('a').click();
  await expect(page.getByRole('status')).toContainText('Downloading and authenticating');
  await page.getByRole('button', { name: 'Cancel download' }).click();
  await expect(page.getByRole('status')).toContainText('Download canceled');
  await expect(page.getByRole('link', { name: 'Save file', exact: true })).toHaveCount(0);
});

test('canceling a Blob PUT releases server storage and permits another upload', async ({ page }) => {
  await createFolder(page);
  const before = new Set(await storedFiles());
  await page.route('**/files/*', route => route.continue({
    headers: { ...route.request().headers(), 'x-e2e-slow-upload': '1' }
  }));
  await uploadFile(page, 'cancel-put.bin', Buffer.alloc(4 * 1048576, 28));
  await expect.poll(async () => {
    const partial = (await storedFiles()).find(path => !before.has(path) && path.endsWith('.part'));
    return partial ? (await stat(partial)).size : 0;
  }).toBeGreaterThan(0);
  await page.locator('#cancel').click();
  await expect(page.locator('.percent')).toContainText('Canceled');
  await expect(page.locator('.percent')).not.toHaveClass(/upload-error/);
  await expect.poll(async () => (await storedFiles()).filter(path => !before.has(path))).toEqual([]);
  await expect(messageRow(page, 'cancel-put.bin')).toHaveCount(0);
  await uploadFile(page, 'retry-put.txt', 'retry');
  await expect(messageRow(page, 'retry-put.txt')).toBeVisible();
});
