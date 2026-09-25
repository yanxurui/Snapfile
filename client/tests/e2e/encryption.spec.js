import { test, expect } from '@playwright/test';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createFolder, uploadFile, messageRow, waitForReady, installDiskPicker, diskBytes } from './helpers.js';

async function storedFiles() {
  const runtime = JSON.parse(await readFile(resolve(`../.cache/e2e-${process.env.E2E_HTTPS_PORT || '8443'}.json`), 'utf8'));
  const root = join(runtime.directory, 'uploads');
  const names = await readdir(root, { recursive: true });
  const files = [];
  for (const name of names) {
    const path = join(root, name);
    if ((await stat(path).catch(() => null))?.isFile()) files.push(path);
  }
  return files;
}

test('secure H2 upload, ciphertext storage, private metadata and short-fragment key recovery', async ({ page, browser }) => {
  await installDiskPicker(page);
  const sent = [];
  page.on('request', request => sent.push({ url: request.url(), body: request.postData() || '' }));
  const session = await page.context().newCDPSession(page);
  await session.send('Network.enable');
  const protocols = [];
  session.on('Network.responseReceived', event => {
    if (event.response.url.includes('/files/')) protocols.push(event.response.protocol);
  });
  const before = new Set(await storedFiles());
  const passcode = await createFolder(page);
  const filename = 'secret-filename-594e.txt';
  const text = 'distinctive-file-plaintext-938ea';
  await uploadFile(page, filename, text.repeat(50));
  await expect(messageRow(page, filename)).toBeVisible();
  expect(await page.evaluate(() => window.isSecureContext)).toBe(true);
  expect(protocols).toContain('h2');
  const added = (await storedFiles()).filter(file => !before.has(file));
  expect(added).toHaveLength(1);
  const stored = await readFile(added[0]);
  expect(stored.subarray(0, 8).toString()).toBe('SNAPFE02');
  expect(stored.includes(Buffer.from(text))).toBe(false);
  expect(stored.includes(Buffer.from(filename))).toBe(false);
  for (const request of sent) {
    expect(request.url).not.toContain(passcode);
    expect(request.body).not.toContain(passcode);
    expect(request.body).not.toContain(filename);
    expect(request.body).not.toContain(text);
  }
  const guest = await browser.newContext();
  const guestPage = await guest.newPage();
  await installDiskPicker(guestPage);
  const guestRequests = [];
  guestPage.on('request', request => guestRequests.push(request.url()));
  await guestPage.goto(`/login.html#identity=${passcode}`);
  await waitForReady(guestPage);
  await messageRow(guestPage, filename).locator('a').click();
  await expect(guestPage.getByRole('status')).toContainText('authenticated download complete');
  expect(Buffer.from(await diskBytes(guestPage, filename)).toString()).toBe(text.repeat(50));
  expect(guestRequests.some(url => new URL(url).searchParams.has('identity'))).toBe(false);
  console.log(`Browser ${browser.version()}; secureContext=true; upload protocol=${protocols.join(',')}`);
  await guest.close();
});

for (const size of [0, 1048575, 1048576, 1048577, 3145747]) {
  test(`browser disk round trip at ${size} bytes`, async ({ page }) => {
    await installDiskPicker(page);
    await createFolder(page);
    const name = `boundary-${size}.bin`;
    const data = Buffer.alloc(size);
    for (let i = 0; i < size; i++) data[i] = (i * 37) % 251;
    await uploadFile(page, name, data);
    await messageRow(page, name).locator('a').click();
    await expect(page.getByRole('status')).toContainText('authenticated download complete');
    expect(Buffer.from(await diskBytes(page, name))).toEqual(data);
  });
}

test('failed login sends only the authentication token without protocol negotiation', async ({ page }) => {
  const requests = [];
  page.on('request', request => {
    if (request.method() === 'POST') requests.push(request.postData() || '');
  });
  await page.goto('/login.html');
  await page.getByPlaceholder('Please input your passcode').fill('never-send-this-code');
  await page.getByRole('button', { name: 'Open Your Folder' }).click();
  await expect(page.locator('.error')).toBeVisible();
  expect(requests).toHaveLength(1);
  expect(new URLSearchParams(requests[0]).get('identity')).toMatch(/^[0-9a-f]{64}$/);
  expect(new URLSearchParams(requests[0]).has('protocol')).toBe(false);
  expect(requests[0]).not.toContain('never-send-this-code');
});

test('stale multipart clients cannot store plaintext files', async ({ page }) => {
  await createFolder(page);
  const before = await storedFiles();
  const status = await page.evaluate(async () => {
    const body = new FormData();
    body.append('myfile[]', new File(['plaintext'], 'stale.txt'));
    return (await fetch('/files', { method: 'POST', body })).status;
  });
  expect(status).toBe(400);
  expect(await storedFiles()).toEqual(before);
  await expect(messageRow(page, 'stale.txt')).toHaveCount(0);
});

for (const corruption of ['bit flip', 'truncate final', 'trailing bytes', 'reorder records']) {
  test(`download aborts real disk writes on ${corruption}`, async ({ page }) => {
    await installDiskPicker(page);
    await createFolder(page);
    const before = new Set(await storedFiles());
    const name = 'corrupt.bin';
    await uploadFile(page, name, Buffer.alloc(2 * 1048576 + 7, 19));
    await expect(messageRow(page, name)).toBeVisible();
    const path = (await storedFiles()).find(file => !before.has(file));
    const bytes = await readFile(path);
    if (corruption === 'bit flip') bytes[1048700] ^= 1;
    let altered = bytes;
    if (corruption === 'truncate final') altered = bytes.subarray(0, -21);
    if (corruption === 'trailing bytes') altered = Buffer.concat([bytes, Buffer.from([1])]);
    if (corruption === 'reorder records') {
      const end = 32 + 1048576 + 21;
      altered = Buffer.concat([bytes.subarray(0, 32), bytes.subarray(end, end + 1048576 + 21),
        bytes.subarray(32, end), bytes.subarray(end + 1048576 + 21)]);
    }
    await writeFile(path, altered);
    // Existing user file must survive a failed authenticated download.
    await page.evaluate(async (name) => {
      const root = await navigator.storage.getDirectory();
      const handle = await root.getFileHandle(name, { create: true });
      const writer = await handle.createWritable();
      await writer.write('keep original');
      await writer.close();
    }, name);
    await messageRow(page, name).locator('a').click();
    await expect(page.getByRole('status')).toContainText('Download failed');
    expect(Buffer.from(await diskBytes(page, name)).toString()).toBe('keep original');
  });
}

test('missing disk API gives an explicit error instead of buffering a Blob', async ({ page }) => {
  await page.addInitScript(() => { window.showSaveFilePicker = undefined; });
  await createFolder(page);
  await uploadFile(page, 'no-fallback.bin', 'abc');
  await messageRow(page, 'no-fallback.bin').locator('a').click();
  await expect(page.getByRole('status')).toContainText('No in-memory fallback');
});

test('canceling an active UI download aborts without replacing the destination', async ({ page }) => {
  await installDiskPicker(page);
  await createFolder(page);
  await uploadFile(page, 'cancel-download.bin', Buffer.alloc(3 * 1048576, 12));
  await expect(messageRow(page, 'cancel-download.bin')).toBeVisible();
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle('cancel-download.bin', { create: true });
    const writer = await handle.createWritable();
    await writer.write('original destination');
    await writer.close();
  });

  await page.route('**/files?id=*', route => route.continue({
    headers: { ...route.request().headers(), 'x-e2e-slow-download': '1' }
  }));
  await messageRow(page, 'cancel-download.bin').locator('a').click();
  await expect(page.getByRole('status')).toContainText('Downloading and authenticating');
  await page.getByRole('button', { name: 'Cancel download' }).click();
  await expect(page.getByRole('status')).toContainText('Download canceled');
  expect(Buffer.from(await diskBytes(page, 'cancel-download.bin')).toString()).toBe('original destination');
});

test('Cancel upload removes partial ciphertext and allows a new upload', async ({ page }) => {
  await createFolder(page);
  const before = new Set(await storedFiles());
  await page.route('**/files/*', route => route.continue({
    headers: { ...route.request().headers(), 'x-e2e-slow-upload': '1' }
  }));
  await uploadFile(page, 'cancel-upload.bin', Buffer.alloc(8 * 1048576, 9));
  await expect.poll(async () => {
    const partial = (await storedFiles()).find(file => !before.has(file) && file.endsWith('.part'));
    return partial ? (await stat(partial)).size : 0;
  }).toBeGreaterThan(0);
  await page.locator('#cancel').click();
  await expect(page.locator('.percent')).toContainText('Canceled');
  await expect(page.locator('.percent')).not.toHaveClass(/upload-error/);
  await expect(page.locator('.percent')).not.toHaveCSS('color', 'rgb(176, 0, 32)');
  await expect.poll(async () => (await storedFiles()).filter(file => !before.has(file)).length).toBe(0);
  await expect(messageRow(page, 'cancel-upload.bin')).toHaveCount(0);
  await uploadFile(page, 'after-cancel.txt', 'retry works');
  await expect(messageRow(page, 'after-cancel.txt')).toBeVisible();
  await expect(page.locator('.percent')).toContainText('Success');
  await expect(page.locator('.percent')).not.toHaveClass(/upload-error/);
});

test('64 MiB streaming reaches disk early, obeys network backpressure and cancels cleanly', async ({ page }) => {
  test.setTimeout(90000);
  await createFolder(page);
  await page.goto('/tests/e2e/stream.html');
  await page.waitForFunction(() => !!window.streams);
  const before = new Set(await storedFiles());
  await page.evaluate(async () => {
    const streams = window.streams;
    const { key } = await streams.credentials(localStorage.getItem('identity'));
    window.measurement = {};
    const file = {
      name: 'large-generated.bin', size: 64 * streams.CHUNK_SIZE,
      slice(start, end) {
        return { async arrayBuffer() {
          if (start === streams.CHUNK_SIZE) await new Promise(resolve => { window.releaseInput = resolve; });
          return new ArrayBuffer(Math.min(end, file.size) - start);
        } };
      }
    };
    const encrypted = await streams.encryptFile(file, key, { metrics: window.measurement });
    const admission = await fetch('/files', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ size: encrypted.size, metadata: encrypted.metadata }) });
    window.admission = await admission.json();
    window.controller = new AbortController();
    window.transfer = fetch(`/files/${window.admission.token}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'x-e2e-slow-upload': '1' },
      body: encrypted.body, duplex: 'half', signal: window.controller.signal
    }).then(response => { window.transferStatus = response.status; },
      error => { window.transferError = error.name; });
  });
  let partial;
  await expect.poll(async () => {
    partial = (await storedFiles()).find(file => !before.has(file) && file.endsWith('.part'));
    return partial ? (await stat(partial)).size : 0;
  }).toBeGreaterThan(0);
  const early = await page.evaluate(() => window.measurement.produced);
  expect(early).toBe(1048576);
  await page.waitForFunction(() => typeof window.releaseInput === 'function');
  await page.evaluate(() => window.releaseInput());
  await page.waitForTimeout(1800);
  const measurement = await page.evaluate(() => ({ ...window.measurement }));
  const written = (await stat(partial)).size;
  expect(measurement.produced).toBeLessThan(64 * 1048576);
  expect(measurement.produced - written).toBeLessThan(16 * 1048576);
  expect(measurement.maxPlaintext).toBe(1048576);
  expect(measurement.maxRecord).toBe(1048597);
  console.log(`64 MiB source: early backend write at ${early} produced; throttle snapshot=${JSON.stringify({ ...measurement, serverBytes: written })}`);
  await page.evaluate(async () => {
    window.controller.abort();
    await window.transfer;
    await fetch(`/files/${window.admission.token}`, { method: 'DELETE' });
  });
  await expect.poll(async () => (await storedFiles()).filter(file => !before.has(file)).length).toBe(0);
  const recovered = await page.evaluate(async () => {
    const response = await fetch('/files', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ size: 95 * 1048576, metadata: 'opaque' }) });
    if (response.ok) await fetch(`/files/${(await response.json()).token}`, { method: 'DELETE' });
    return response.status;
  });
  expect(recovered).toBe(201);
});

test('32 MiB completes a bounded upload and authenticated disk-backed download', async ({ page }) => {
  test.setTimeout(60000);
  await createFolder(page);
  await page.goto('/tests/e2e/stream.html');
  await page.waitForFunction(() => !!window.streams);
  const result = await page.evaluate(async () => {
    const streams = window.streams;
    const { key } = await streams.credentials(localStorage.getItem('identity'));
    const uploadMetrics = {};
    const downloadMetrics = {};
    const file = {
      name: 'complete-large.bin', size: 32 * streams.CHUNK_SIZE,
      slice(start, end) {
        return { async arrayBuffer() {
          return new Uint8Array(Math.min(end, file.size) - start).fill(start / streams.CHUNK_SIZE).buffer;
        } };
      }
    };
    const encrypted = await streams.encryptFile(file, key, { metrics: uploadMetrics });
    const admitted = await fetch('/files', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ size: encrypted.size, metadata: encrypted.metadata }) });
    if (!admitted.ok) throw new Error(await admitted.text());
    const { token } = await admitted.json();
    const uploaded = await fetch(`/files/${token}`, { method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' }, body: encrypted.body, duplex: 'half' });
    if (!uploaded.ok) throw new Error(await uploaded.text());
    const { id } = await uploaded.json();
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle(file.name, { create: true });
    const response = await fetch(`/files?id=${id}`);
    await streams.decryptFile(response.body, encrypted.metadata, key, await handle.createWritable(),
      { metrics: downloadMetrics });
    const saved = await handle.getFile();
    const reader = saved.stream().getReader();
    let verified = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      for (let i = 0; i < value.length; i++) {
        if (value[i] !== Math.floor((verified + i) / streams.CHUNK_SIZE)) throw new Error('Byte mismatch');
      }
      verified += value.length;
    }
    return { uploadMetrics, downloadMetrics, verified, size: saved.size };
  });
  expect(result.verified).toBe(32 * 1048576);
  expect(result.size).toBe(result.verified);
  expect(result.uploadMetrics.maxPlaintext).toBe(1048576);
  expect(result.uploadMetrics.maxRecord).toBe(1048597);
  expect(result.downloadMetrics.maxBuffered).toBeLessThanOrEqual(1048576 + 17 + 65536);
  console.log(`Completed 32 MiB exact-byte disk round trip: ${JSON.stringify(result)}`);
});

test('HTTP1-only localhost fails visibly without falling back to a buffered upload', async ({ page }) => {
  await page.goto(`http://127.0.0.1:${process.env.E2E_PORT || '8091'}/login.html`);
  await page.getByRole('button', { name: 'Create A New Folder' }).click();
  await waitForReady(page);
  await uploadFile(page, 'http1.bin', 'should not upload');
  await expect(page.locator('.percent')).toContainText('This connection uses HTTP/1');
  await expect(page.locator('.percent')).toContainText('HTTP/2 or HTTP/3');
  await expect(page.locator('.percent')).toHaveClass(/upload-error/);
  await expect(messageRow(page, 'http1.bin')).toHaveCount(0);
});

test('wrong metadata key aborts a real disk destination', async ({ page }) => {
  await createFolder(page);
  await page.goto('/tests/e2e/stream.html');
  await page.waitForFunction(() => !!window.streams);
  const result = await page.evaluate(async () => {
    const streams = window.streams;
    const { key } = await streams.credentials(localStorage.getItem('identity'));
    const wrong = (await streams.credentials('wrongkey')).key;
    const file = await streams.encryptFile(new File(['secret'], 'wrong.bin'), key);
    const admitted = await fetch('/files', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ size: file.size, metadata: file.metadata }) });
    const { token } = await admitted.json();
    const uploaded = await fetch(`/files/${token}`, { method: 'PUT', duplex: 'half',
      headers: { 'Content-Type': 'application/octet-stream' }, body: file.body });
    const { id } = await uploaded.json();
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle('wrong.bin', { create: true });
    const previous = await handle.createWritable();
    await previous.write('original');
    await previous.close();
    const response = await fetch(`/files?id=${id}`);
    let rejected = false;
    try {
      await streams.decryptFile(response.body, file.metadata, wrong, await handle.createWritable());
    } catch { rejected = true; }
    return { rejected, content: await (await handle.getFile()).text() };
  });
  expect(result).toEqual({ rejected: true, content: 'original' });
});
