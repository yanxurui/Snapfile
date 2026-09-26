import { test, expect } from '@playwright/test';
import { waitForReady } from './helpers.js';

test('login renders before crypto loads, then initializes once on demand', async ({ page }) => {
  const chunks = [];
  page.on('request', request => {
    if (/\/assets\/crypto-.*\.js$/.test(request.url())) chunks.push(request.url());
  });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route('**/assets/crypto-*.js', async route => {
    await gate;
    await route.continue();
  });
  try {
    await page.goto('/login.html');
    await expect(page.getByRole('button', { name: 'Create A New Folder' })).toBeVisible();
    expect(chunks).toEqual([]);
    await page.getByRole('button', { name: 'Create A New Folder' }).click();
    await expect(page.getByRole('status')).toHaveText('Preparing encryption...');
    await expect(page.getByRole('button', { name: 'Creating' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Open Your Folder' })).toBeDisabled();
    expect(chunks).toHaveLength(1);
  } finally {
    release();
  }
  await waitForReady(page);
});

test('a missing crypto chunk leaves a visible error and a usable login form', async ({ page }) => {
  await page.route('**/assets/crypto-*.js', route => route.abort());
  await page.goto('/login.html');
  await page.getByRole('button', { name: 'Create A New Folder' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('Unable to load encryption');
  await expect(page.getByRole('button', { name: 'Create A New Folder' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Open Your Folder' })).toBeEnabled();
  await expect(page.getByRole('status')).toHaveCount(0);
});
