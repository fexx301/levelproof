#!/usr/bin/env node
/* global console, process, fetch, setTimeout, navigator, document, sessionStorage, localStorage */
/**
 * Live-backend browser journeys for docs/submission-readiness-checklist.md,
 * run against a deployed URL with a real GPU browser. Opt-in: one journey
 * makes a live model call (a few tenths of a cent); the example chips it
 * uses are prewarmed and served from the shared cache.
 *
 *   node scripts/live-journeys.mjs https://levelproof.vercel.app <out-dir> --confirm-live-ai
 *
 * Prints one line per check and a JSON summary; screenshots go to <out-dir>.
 * The limiter journey deliberately exhausts this address's per-minute
 * window, so it runs last.
 */
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const [base, out = 'live-journeys'] = process.argv.slice(2);
if (!base || !process.argv.includes('--confirm-live-ai')) {
  console.error('Usage: node scripts/live-journeys.mjs <url> <out-dir> --confirm-live-ai');
  process.exit(2);
}
mkdirSync(out, { recursive: true });
const results = [];
const check = (journey, name, ok, detail = '') => {
  results.push({ journey, name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} [${journey}] ${name}${detail ? ` — ${detail}` : ''}`);
};

const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
async function freshPage(options = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, ...options });
  await context.addInitScript(() => {
    try {
      if (!sessionStorage.getItem('lp-journey')) {
        localStorage.clear();
        sessionStorage.setItem('lp-journey', '1');
      }
      localStorage.setItem('levelproof:getting-started:dismissed', '1');
    } catch {
      // Storage unavailable: the app still runs, just without the dismissal.
    }
  });
  const page = await context.newPage();
  page.errors = [];
  page.on('pageerror', (error) => page.errors.push(String(error)));
  return { context, page };
}

async function followHintsToWin(page) {
  const panel = page.getByRole('region', { name: 'Play' });
  for (let i = 0; i < 30; i++) {
    if (await panel.getByText('Level complete').count()) return true;
    await panel.getByRole('button', { name: 'Hint' }).click();
    const arrow = panel.locator('button.dpad-hint');
    if (!(await arrow.count())) return false;
    const before = await panel.locator('.dpad-center').getAttribute('data-module');
    await arrow.click();
    await page.waitForFunction((b) => document.querySelector('.dpad-center')?.getAttribute('data-module') !== b, before, { timeout: 15_000 });
  }
  return panel.getByText('Level complete').count().then((n) => n > 0);
}

async function applyChip(page, chip) {
  await page.getByRole('button', { name: chip, exact: true }).click();
  const apply = page.getByRole('button', { name: 'Apply edit' });
  await apply.waitFor({ timeout: 120_000 });
  const cached = (await page.getByText('Cached result').count()) > 0;
  await apply.click();
  return cached;
}

// ---- J1: prompt → preview → approve → play → save → reload → share → clean reopen
{
  const J = 'J1 full journey';
  const { context, page } = await freshPage();
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
  await page.goto(base, { waitUntil: 'networkidle' });
  const cached = await applyChip(page, 'Key + locked door');
  check(J, 'chip compiled, previewed, and applied', true, cached ? 'served from cache' : 'fresh compile');
  await page.getByRole('button', { name: 'Play it yourself' }).click();
  check(J, 'played to the goal by following hints', await followHintsToWin(page));
  await page.screenshot({ path: `${out}/j1-win.png` });
  await page.getByRole('button', { name: /Back to editing/ }).first().click();
  await page.getByRole('button', { name: 'Save checkpoint' }).click();
  check(J, 'saved', (await page.getByText('Saved ✓').count()) > 0);
  await page.reload({ waitUntil: 'networkidle' });
  const saved = await page.locator('select.scene-select option').allTextContents();
  check(J, 'saved scene listed after reload', saved.some((label) => /saved|puzzle/i.test(label)), saved.slice(-2).join(' | '));
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  await page.waitForTimeout(500);
  const url = await page.evaluate(() => navigator.clipboard.readText()).catch(() => '');
  check(J, 'share link copied', url.includes('?p='), `${url.length} chars`);
  const clean = await freshPage();
  await clean.page.goto(url, { waitUntil: 'networkidle' });
  await clean.page.waitForTimeout(1500);
  check(J, 'clean context opens the shared puzzle in play', (await clean.page.getByRole('region', { name: 'Play' }).count()) > 0);
  check(J, 'shared puzzle is winnable by following hints', await followHintsToWin(clean.page));
  await clean.page.screenshot({ path: `${out}/j1-shared-win.png` });
  check(J, 'no page errors', page.errors.length + clean.page.errors.length === 0, [...page.errors, ...clean.page.errors].join('; '));
  await clean.context.close();

  // ---- J2: live key-and-requirement removal (a fresh model call)
  const J2 = 'J2 live removal';
  await page.getByRole('textbox', { name: /Describe a (change|world)/ }).fill('Remove the key and the door it locks, and any rule that needs that key.');
  await page.locator('.prompt-submit').click();
  const previewOrRule = page.getByRole('button', { name: /Apply edit|Approve/ }).first();
  await previewOrRule.waitFor({ timeout: 120_000 });
  const previewText = (await page.locator('.side-panel').textContent()) ?? '';
  check(J2, 'removal previewed before anything changed', /remov/i.test(previewText));
  await page.screenshot({ path: `${out}/j2-preview.png` });
  await previewOrRule.click();
  await page.waitForTimeout(1200);
  await page.getByText(/Edit applied|Rule applied/).first().waitFor({ timeout: 15_000 }).catch(() => undefined);
  const kinds = await page.locator('.scene-object-kind').allTextContents();
  check(J2, 'no key left in the scene', kinds.length > 0 && !kinds.some((kind) => kind.trim().toLowerCase() === 'key'), `${kinds.length} objects listed`);
  const checks = (await page.locator('.check-strip').textContent()) ?? '';
  check(J2, 'level still winnable after removal', /Can it be won\?\s*Yes/.test(checks), checks.replace(/\s+/g, ' ').slice(0, 80));
  await page.screenshot({ path: `${out}/j2-applied.png` });
  await context.close();
}

// ---- J3: Show the problem in every theme
{
  const J = 'J3 evidence in every theme';
  const { context, page } = await freshPage();
  await page.goto(base, { waitUntil: 'networkidle' });
  await applyChip(page, 'The switch trap');
  const themes = await page.getByLabel('Architecture theme').locator('option').evaluateAll((options) => options.map((o) => o.value));
  for (const theme of themes) {
    await page.getByLabel('Architecture theme').selectOption(theme);
    await page.waitForTimeout(800);
    await page.getByRole('button', { name: 'Show the problem' }).first().click();
    const paused = await page.getByRole('status').filter({ hasText: 'Paused at decisive moment' }).waitFor({ timeout: 45_000 }).then(() => true, () => false);
    const evidence = (await page.getByLabel('Verified failure evidence').count()) > 0;
    await page.screenshot({ path: `${out}/j3-${theme || 'scene'}.png` });
    check(J, `theme ${theme || '(from the scene)'}: replay pauses on the decisive move with evidence`, paused && evidence);
    await page.getByRole('button', { name: 'Back to repair' }).click();
    await page.waitForTimeout(600);
  }
  check(J, 'no page errors', page.errors.length === 0, page.errors.join('; '));
  await context.close();
}

// ---- J4: failure journeys on the production UI (the API is intercepted)
{
  const J = 'J4 failures';
  const prompt = 'Add a lantern on the balcony.';
  const scenario = async (name, handler, expectText, extra) => {
    const { context, page } = await freshPage();
    if (extra?.clock) await page.clock.install();
    await page.route('**/api/compile', handler);
    await page.goto(base, { waitUntil: 'networkidle' });
    const box = page.getByRole('textbox', { name: /Describe a change/ });
    await box.fill(prompt);
    await page.locator('.prompt-submit').click();
    if (extra?.during) await extra.during(page);
    const shown = await page.getByText(expectText).first().waitFor({ timeout: 30_000 }).then(() => true, () => false);
    const kept = (await box.inputValue()) === prompt;
    const idle = (await page.getByRole('button', { name: 'Cancel' }).count()) === 0;
    check(J, `${name}: explained, prompt kept, not stuck loading`, shown && kept && idle, `message=${shown} prompt=${kept} idle=${idle}`);
    await page.screenshot({ path: `${out}/j4-${name.replace(/\W+/g, '-')}.png` });
    await context.close();
  };
  await scenario('network outage', (route) => route.abort('failed'), /try again/i);
  await scenario('server error', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'The AI service is unavailable.' }) }), /try again/i);
  await scenario('malformed response', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"result": 42' }), /try again|failed validation/i);
  await scenario(
    'scene changed while compiling',
    async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 6000));
      await route.continue();
    },
    /switched scenes|scene changed/i,
    { during: async (page) => { await page.waitForTimeout(1000); await page.locator('select.scene-select').selectOption({ label: 'The Overpass' }); } },
  );
  await scenario('stalled connection (watchdog)', () => new Promise(() => {}), /did not answer in time/i, {
    clock: true,
    during: async (page) => { await page.waitForTimeout(500); await page.clock.fastForward(131_000); },
  });
}

// ---- J5: production request limiter (per-address window)
{
  const J = 'J5 limiter';
  const statuses = [];
  for (let i = 0; i < 10; i++) {
    const response = await fetch(`${base}/api/compile`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    statuses.push(response.status);
  }
  check(J, 'burst beyond the window is refused with 429 before any model call', statuses.includes(429) && statuses.slice(0, 3).every((s) => s === 400), statuses.join(','));
}

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({ base, when: new Date().toISOString(), passed: results.length - failed.length, failed: failed.length }));
process.exitCode = failed.length > 0 ? 1 : 0;
