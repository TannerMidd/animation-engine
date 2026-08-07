import assert from 'node:assert/strict';
import type http from 'node:http';
import { chromium } from 'playwright';
import { createServer } from '../../src/server/index.ts';

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('editor test server did not bind');
  return `http://127.0.0.1:${address.port}`;
}

const server = createServer();
const browser = await chromium.launch({ headless: true });
try {
  const baseUrl = await listen(server);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const response = await page.goto(baseUrl, { waitUntil: 'networkidle' });
  assert.equal(response?.status(), 200);
  await page.getByText('animation engine', { exact: true }).waitFor();
  await page.getByRole('button', { name: /Search or run a command/i }).click();
  await page.getByPlaceholder(/Type a command or a beat/i).fill('Run Check');
  await page.getByText('Run Check', { exact: true }).waitFor();
  assert.deepEqual(pageErrors, []);
} finally {
  await browser.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
