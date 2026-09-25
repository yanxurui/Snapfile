// @ts-check
import { test, expect } from '@playwright/test';
import { createFolder, uploadFile, uploadFiles, messageRow, installDiskPicker, diskBytes } from './helpers.js';

test.describe('files', () => {
  test('upload a file and see it in the message list', async ({ page }) => {
    await createFolder(page);
    await expect(page.locator('#status_bar')).not.toContainText('Files and chat end-to-end encrypted');
    await expect(page.locator('#status_bar')).toContainText('expires at');
    await expect(page.locator('#status_bar')).toContainText('used');
    await expect(page.locator('.percent')).not.toHaveClass(/upload-error/);

    const bytes = await uploadFile(page, 'e2e-note.txt', 'hello from an uploaded file');

    const row = messageRow(page, 'e2e-note.txt');
    await expect(row).toBeVisible();
    // The file row renders a clickable download link and the formatted size.
    await expect(row.locator('a')).toHaveAttribute('href', '#');
    await expect(row).toContainText(`${bytes}.0B`);

    // The upload status line confirms success with the server's file count.
    await expect(page.locator('.percent')).toContainText('Success: 1 file(s) uploaded');
    await expect(page.locator('.percent')).not.toHaveCSS('color', 'rgb(176, 0, 32)');
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

  test('quota errors are red without transport advice and a retry clears the error', async ({ page }) => {
    await createFolder(page);

    // Admission must reject without reading or encrypting the oversized file.
    await page.evaluate(() => {
      const file = new File(['small'], 'too-big.bin');
      Object.defineProperty(file, 'size', { value: 100 * 1024 * 1024 });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      const input = document.querySelector('input[type=file]');
      input.files = transfer.files;
      input.dispatchEvent(new Event('change'));
    });

    const status = page.locator('.percent');
    await expect(status).toHaveText('Upload failed (reserving space): Storage space not enough');
    await expect(status).toHaveClass(/upload-error/);
    await expect(status).toHaveCSS('color', 'rgb(176, 0, 32)');
    await expect(status).toHaveCSS('white-space', 'normal');
    await expect(status).toHaveAttribute('role', 'alert');
    await expect(status).not.toContainText(/HTTPS|HTTP2|HTTP\/2|Chrome|Edge/);
    // ...and the rejected file does not appear in the message list.
    await expect(messageRow(page, 'too-big.bin')).toHaveCount(0);

    let resumeAdmission = () => {};
    const admissionGate = new Promise(resolve => { resumeAdmission = resolve; });
    await page.route('**/files', async route => {
      await admissionGate;
      await route.continue();
    });
    try {
      await uploadFile(page, 'retry.txt', 'fits in the same folder');
      await expect(page.locator('#upload_files')).toBeDisabled();
      await expect(status).toHaveText('Preparing upload...');
      await expect(status).not.toHaveClass(/upload-error/);
      await expect(status).not.toHaveCSS('color', 'rgb(176, 0, 32)');
      await expect(status).not.toHaveAttribute('role', 'alert');
    } finally {
      resumeAdmission();
    }
    await expect(messageRow(page, 'retry.txt')).toBeVisible();
    await expect(status).toContainText('Success: 1 file(s) uploaded');
    await expect(status).not.toHaveClass(/upload-error/);
  });

  for (const [routePattern, stage, statusCode, serverError] of [
    ['**/files', 'reserving space', 431, 'Not enough space for the encrypted file and metadata'],
    ['**/files/*', 'sending file', 507, 'Upload disk is full'],
  ]) {
    test(`specific HTTP errors while ${stage} are red without compatibility hints`, async ({ page }) => {
      await createFolder(page);
      await page.route(routePattern, route => route.request().method() === 'DELETE' ? route.continue() :
        route.fulfill({ status: statusCode, contentType: 'text/plain', body: serverError }));
      await uploadFile(page, 'rejected.txt', 'cannot be stored');
      const status = page.locator('.percent');
      await expect(status).toHaveText(`Upload failed (${stage}): ${serverError}`);
      await expect(status).toHaveCSS('color', 'rgb(176, 0, 32)');
      await expect(status).toHaveAttribute('role', 'alert');
      await expect(messageRow(page, 'rejected.txt')).toHaveCount(0);
    });

    test(`network errors while ${stage} do not guess the HTTP version`, async ({ page }) => {
      await createFolder(page);
      await page.route(routePattern, route => route.request().method() === 'DELETE' ?
        route.continue() : route.abort('failed'));
      await uploadFile(page, 'disconnected.txt', 'connection failed');
      const status = page.locator('.percent');
      await expect(status).toContainText(`Upload failed (${stage}): Failed to fetch`);
      await expect(status).toHaveCSS('color', 'rgb(176, 0, 32)');
      await expect(status).not.toContainText(/HTTPS|HTTP2|HTTP\/2|Chrome|Edge/);
      await expect(messageRow(page, 'disconnected.txt')).toHaveCount(0);
    });
  }

  test('cleanup failure does not hide the original stream rejection', async ({ page }) => {
    await createFolder(page);
    let reservation;
    await page.route('**/files/*', route => {
      reservation = route.request().url();
      return route.fulfill({
        status: 503, contentType: 'text/plain',
        body: route.request().method() === 'DELETE' ? 'Cleanup unavailable' : 'Upload storage unavailable'
      });
    });
    try {
      await uploadFile(page, 'cleanup.txt', 'not stored');
      const status = page.locator('.percent');
      await expect(status).toHaveText('Upload failed (sending file): Upload storage unavailable' +
        ' Could not confirm upload cleanup: Cleanup unavailable.');
      await expect(status).toHaveCSS('color', 'rgb(176, 0, 32)');
      await expect(messageRow(page, 'cleanup.txt')).toHaveCount(0);
    } finally {
      await page.unroute('**/files/*');
      if (reservation) expect((await page.request.delete(reservation)).status()).toBe(204);
    }
  });

  test('local metadata errors are reported before reserving storage', async ({ page }) => {
    await createFolder(page);
    const admissions = [];
    page.on('request', request => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/files') admissions.push(request);
    });
    await uploadFile(page, 'x'.repeat(17000), 'small contents');
    const status = page.locator('.percent');
    await expect(status).toHaveText('Upload failed (preparing file): Filename metadata too large');
    await expect(status).toHaveCSS('color', 'rgb(176, 0, 32)');
    expect(admissions).toHaveLength(0);
  });

  for (const missing of ['ReadableStream', 'streaming Request', 'secure context']) {
    test(`missing ${missing} gives capability guidance before admission`, async ({ page }) => {
      await createFolder(page);
      const admissions = [];
      page.on('request', request => {
        if (request.method() === 'POST' && new URL(request.url()).pathname === '/files') admissions.push(request);
      });
      await page.evaluate((missing) => {
        if (missing === 'secure context') {
          Object.defineProperty(window, 'isSecureContext', { value: false });
        } else if (missing === 'ReadableStream') {
          window.ReadableStream = undefined;
        } else {
          const NativeRequest = window.Request;
          window.Request = class extends NativeRequest {
            constructor(url, init) {
              super(url, { method: init.method, body: String(init.body) });
            }
          };
        }
      }, missing);
      await uploadFile(page, 'unsupported.txt', 'no buffering fallback');
      const status = page.locator('.percent');
      await expect(status).toContainText('Upload failed (checking browser support)');
      await expect(status).toContainText(missing === 'secure context' ? 'Open Snapfile over HTTPS' :
        'This browser does not support streaming uploads. Use current desktop Chrome or Edge.');
      await expect(status).toHaveCSS('color', 'rgb(176, 0, 32)');
      await expect(page.locator('#upload_files')).toBeEnabled();
      expect(admissions).toHaveLength(0);
    });
  }

  test('download an uploaded file and get its original content back', async ({ page }) => {
    await installDiskPicker(page);
    await createFolder(page);

    const content = 'round-trip payload — ' + 'x'.repeat(200);
    await uploadFile(page, 'download-me.txt', content);

    const link = messageRow(page, 'download-me.txt').locator('a');
    await expect(link).toBeVisible();

    await link.click();
    await expect(page.getByRole('status')).toContainText('authenticated download complete');
    expect(await page.evaluate(() => window.pickerHadActivation)).toBe(true);
    expect(Buffer.from(await diskBytes(page, 'download-me.txt')).toString()).toBe(content);
  });
});
