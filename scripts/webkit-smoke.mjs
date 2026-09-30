/* global console, process, document */
// Safari-engine smoke test (WebKit via Playwright): desktop and iPhone emulation.
// Usage: node webkit-smoke.mjs <baseURL> <outDir>
import { webkit, devices } from '@playwright/test';

const [base, out] = process.argv.slice(2);
const results = [];
const browser = await webkit.launch();

for (const [label, options] of [
  ['desktop', { viewport: { width: 1280, height: 800 } }],
  ['iphone', { ...devices['iPhone 13'] }],
]) {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(`console: ${message.text()}`); });
  const step = async (name, run) => {
    try {
      await run();
      results.push(`PASS [${label}] ${name}`);
    } catch (error) {
      results.push(`FAIL [${label}] ${name} — ${String(error.message ?? error).split('\n')[0]}`);
      await page.screenshot({ path: `${out}/webkit-${label}-${name.replace(/\W+/g, '-')}.png` }).catch(() => {});
    }
  };

  await step('welcome renders with a live 3D world', async () => {
    await page.goto(base);
    await page.getByRole('heading', { name: /Describe a world/i }).waitFor({ timeout: 30_000 });
    await page.waitForSelector('canvas', { timeout: 30_000 });
    await page.waitForSelector('[data-render-calls]', { timeout: 60_000 });
  });
  await step('editor opens from the welcome', async () => {
    await page.getByRole('button', { name: /Explore the editor/i }).click();
    await page.getByRole('combobox', { name: 'Scene' }).waitFor({ timeout: 20_000 });
  });
  await step('The Sentry: play, wait a turn, walk', async () => {
    await page.getByRole('combobox', { name: 'Scene' }).selectOption('sentry');
    await page.getByText('Accepted').first().waitFor({ timeout: 30_000 });
    await page.getByRole('button', { name: /Play the level/ }).click();
    const location = page.locator('.dpad-center');
    const turn = page.locator('.play-turn-note');
    await location.waitFor({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Wait a turn' }).click();
    await page.waitForFunction(() => document.querySelector('.play-turn-note')?.getAttribute('data-phase') === '1', null, { timeout: 30_000 });
    await page.getByRole('button', { name: /Move east/ }).click();
    await page.waitForFunction(() => document.querySelector('.dpad-center')?.getAttribute('data-module') === 'yard-west', null, { timeout: 30_000 });
    if ((await turn.getAttribute('data-phase')) !== '2') throw new Error('turn did not advance with the move');
  });
  await step('hint lights a move', async () => {
    await page.getByRole('button', { name: 'Hint' }).click();
    await page.locator('.play-hint').waitFor({ timeout: 20_000 });
  });
  const stats = await page.evaluate(() => {
    const host = document.querySelector('[data-render-calls]');
    return host ? { calls: host.dataset.renderCalls, ms: host.dataset.renderMs } : null;
  });
  await page.screenshot({ path: `${out}/webkit-${label}-final.png` });
  results.push(`INFO [${label}] draw stats ${JSON.stringify(stats)}; errors: ${errors.length === 0 ? 'none' : errors.slice(0, 5).join(' | ')}`);
  await context.close();
}
await browser.close();
console.log(results.join('\n'));
