#!/usr/bin/env node
/**
 * Demo footage capture: drives the live site through the beats of
 * docs/demo-script.md and records real screen video of the real product —
 * no fixtures, no mock UI — for the video edit (HyperFrames or any editor).
 *
 * Three takes, each one continuous recording:
 *   A-adventure  welcome sentence → chapter title card → walk to a character
 *                and talk → "Too easy — make it harder" → play to the win
 *   B-refusal    an honest "unsupported" for a chasing enemy
 *   C-break      the switch trap → Show the problem (ghost replay) → checked
 *                repair → replay the failing route → Share
 *
 * Output (default demo-footage/, never committed or deployed):
 *   <take>.webm          the recording
 *   stills/<take>-NN-<beat>.png   a full-resolution still at each beat
 *   marks.json           every beat with its time (seconds) in its take
 *
 * Run it on a machine with a real GPU (the 3D view renders in software
 * otherwise and the footage stutters). Headed by default so the GPU is used.
 * Most requests hit the prewarmed cache; the welcome sentence, the character's
 * voice, and the refusal can be fresh model calls, so the run is opt-in and
 * budget-capped like every live script.
 *
 * Usage: npx tsx scripts/capture-demo.ts --confirm-live-ai --budget-usd 0.10
 *          [--url https://levelproof.vercel.app] [--out demo-footage]
 *          [--prompt "…"] [--only A|B|C] [--headless]
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type Locator, type Page, type Response } from '@playwright/test';
import { LiveBudget, LiveEvaluationStop, requireLiveBudget } from './live-budget';

const DEFAULT_PROMPT = 'A medieval quest hub town with a merchant and a locked gate to the wild road.';
const VIEWPORT = { width: 1440, height: 900 };
const MAX_STEPS = 40;
/** Upper bounds, not delays: generous enough for a slow GPU, free on a fast one. */
const WAIT = { step: 30_000, model: 240_000, replay: 240_000 };

interface Beat {
  name: string;
  at: number;
  still: string;
}

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

/** The final JSON body of a plain or streamed (NDJSON) API response. */
async function responseBody(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const text = (await response.text()).trim();
    const last = text.split('\n').at(-1) ?? '';
    const parsed = JSON.parse(last) as Record<string, unknown>;
    return parsed.event === 'result' ? (parsed.body as Record<string, unknown>) : parsed;
  } catch {
    return null;
  }
}

class Take {
  readonly beats: Beat[] = [];
  private readonly started = Date.now();

  constructor(readonly name: string, readonly page: Page, private readonly out: string) {}

  async mark(beat: string, holdMs = 0): Promise<void> {
    if (holdMs > 0) await this.page.waitForTimeout(holdMs);
    const still = join('stills', `${this.name}-${String(this.beats.length + 1).padStart(2, '0')}-${beat}.png`);
    await this.page.screenshot({ path: join(this.out, still), timeout: 120_000 });
    this.beats.push({ name: beat, at: Math.round((Date.now() - this.started) / 100) / 10, still });
    console.log(`  ${this.name} ${this.beats.at(-1)!.at.toFixed(1)}s  ${beat}`);
  }
}

async function openTake(browser: Browser, name: string, out: string, url: string, budget: LiveBudget, welcome: boolean): Promise<Take> {
  const context = await browser.newContext({ viewport: VIEWPORT, recordVideo: { dir: out, size: VIEWPORT } });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(url).origin });
  if (!welcome) {
    await context.addInitScript(() => {
      try {
        window.localStorage.setItem('levelproof:landing:seen', '1');
      } catch {
        // The welcome would show; the take will say so.
      }
    });
  }
  const page = await context.newPage();
  // Every click and wait may meet a scene rebuild; give slow GPUs room.
  page.setDefaultTimeout(WAIT.model);
  page.on('response', async (response) => {
    if (!/\/api\/(compile|npc|explain)/.test(response.url())) return;
    const body = await responseBody(response);
    const cost = body?.cached === true ? 0 : typeof body?.totalCostUsd === 'number' ? body.totalCostUsd : null;
    try {
      budget.record(cost, `${name} ${new URL(response.url()).pathname}`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      void context.close();
    }
  });
  await page.goto(url, { waitUntil: 'load' });
  return new Take(name, page, out);
}

async function closeTake(take: Take, out: string): Promise<void> {
  const video = take.page.video();
  await take.page.context().close();
  if (video !== null) renameSync(await video.path(), join(out, `${take.name}.webm`));
}

/** Type visibly; on a machine too slow to keep up, fill the rest at once. */
async function typeInto(locator: Locator, text: string, delay: number): Promise<void> {
  try {
    await locator.pressSequentially(text, { delay, timeout: 60_000 });
  } catch {
    await locator.fill(text);
  }
}

/** Follow the engine's hints one move at a time until `done` holds. */
async function followHints(page: Page, done: () => Promise<boolean>): Promise<boolean> {
  for (let step = 0; step < MAX_STEPS; step++) {
    if (await done()) return true;
    await page.keyboard.press('h');
    const lit = page.locator('.dpad .dpad-hint').first();
    if ((await lit.count()) === 0) return done();
    const before = await page.locator('.dpad-center').innerText();
    await lit.click();
    await page.waitForFunction((was) => document.querySelector('.dpad-center')?.textContent !== was, before, { timeout: WAIT.step }).catch(() => undefined);
    await page.waitForTimeout(450);
  }
  return done();
}

async function takeAdventure(take: Take, prompt: string): Promise<void> {
  const { page } = take;
  await page.locator('.landing-input').waitFor({ timeout: 60_000 });
  await take.mark('welcome', 2500);
  await typeInto(page.locator('.landing-input'), prompt, 35);
  await take.mark('prompt-typed', 600);
  await page.locator('.landing-start').click();
  await page.getByText(/states checked/).first().waitFor({ timeout: WAIT.model });
  await take.mark('title-card-proof', 3000);

  const talk = page.getByRole('button', { name: /^Talk to the / });
  const near = await followHints(page, async () => (await talk.count()) > 0 || (await page.getByText('Level complete').count()) > 0);
  if (near && (await talk.count()) > 0) {
    await take.mark('beside-character', 800);
    await talk.click();
    await page.locator('.npc-talk-line').waitFor({ timeout: WAIT.step });
    await take.mark('plain-line', 400);
    await page.waitForFunction(() => !/finding the words/.test(document.querySelector('.npc-talk-line')?.textContent ?? ''), null, { timeout: WAIT.model }).catch(() => undefined);
    await take.mark('character-voice', 3500);
  } else {
    console.log('  (no character on the way: talk beat skipped — try another --prompt)');
  }

  if ((await page.getByText('Level complete').count()) === 0) {
    await page.getByRole('button', { name: 'Too easy — make it harder' }).click();
    const proposal = page.getByRole('group', { name: 'Proposed change' });
    await proposal.waitFor({ timeout: WAIT.model });
    await take.mark('harder-precheck', 3500);
    await page.getByRole('button', { name: 'Play the new version' }).click();
    await page.waitForTimeout(2500);
    await take.mark('respawned');
  }
  const won = await followHints(page, async () => (await page.getByText('Level complete').count()) > 0);
  await take.mark(won ? 'level-complete' : 'end-of-walk', 3000);
}

async function takeRefusal(take: Take): Promise<void> {
  const { page } = take;
  const box = page.getByRole('textbox', { name: 'Describe a change' });
  await box.waitFor({ timeout: 60_000 });
  await take.mark('editor', 1500);
  await typeInto(box, 'add an enemy that chases you', 45);
  await page.getByRole('button', { name: 'Compile', exact: true }).click();
  await page.getByText(/Not possible|unsupported|cannot|can’t|can't/i).first().waitFor({ timeout: WAIT.model });
  await take.mark('honest-refusal', 4000);
}

async function takeBreakAndRepair(take: Take): Promise<void> {
  const { page } = take;
  await page.getByRole('button', { name: 'The switch trap' }).waitFor({ timeout: 60_000 });
  await take.mark('balcony-vault', 1500);
  await page.getByRole('button', { name: 'The switch trap' }).click();
  await page.getByRole('button', { name: 'Apply edit' }).click({ timeout: WAIT.model });
  await page.getByRole('region', { name: 'Verification checks' }).getByText('Not accepted').waitFor({ timeout: WAIT.step });
  await take.mark('stuck-yes', 2500);
  await page.getByRole('button', { name: 'Show the problem' }).click();
  await page.getByRole('status').filter({ hasText: 'Paused at decisive moment' }).waitFor({ timeout: WAIT.replay });
  await take.mark('ghost-decisive-move', 3000);
  const back = page.getByRole('button', { name: 'Back to repair' });
  if ((await back.count()) > 0) await back.click();
  const repairs = page.getByRole('region', { name: 'Repairs' });
  await repairs.getByRole('button', { name: 'Find checked repairs' }).click();
  await repairs.getByRole('button', { name: 'Preview' }).first().click({ timeout: WAIT.step });
  await take.mark('repair-preview', 3000);
  await repairs.getByRole('button', { name: 'Apply', exact: true }).click();
  await repairs.getByText('Repaired and accepted.').waitFor({ timeout: WAIT.step });
  await take.mark('repaired', 1500);
  const replay = page.getByRole('button', { name: 'Replay the failing route' });
  if ((await replay.count()) > 0) {
    await replay.click();
    await page.waitForTimeout(9000);
    await take.mark('nobody-stranded');
  }
  // The header button reads "Share" or "Share accepted" depending on the draft state.
  await page.getByRole('button', { name: /^Share( accepted)?$/ }).first().click();
  await take.mark('shared', 2500);
}

try {
  const limit = requireLiveBudget(args, 'Usage: npx tsx scripts/capture-demo.ts --confirm-live-ai --budget-usd 0.10 [--url …] [--out demo-footage] [--prompt "…"] [--only A|B|C] [--headless]');
  const url = flag('--url') ?? 'https://levelproof.vercel.app';
  const out = flag('--out') ?? 'demo-footage';
  const prompt = flag('--prompt') ?? DEFAULT_PROMPT;
  const only = flag('--only');
  mkdirSync(join(out, 'stills'), { recursive: true });
  const budget = new LiveBudget(limit);
  const browser = await chromium.launch({ headless: args.includes('--headless') });
  const marks: Record<string, { file: string; beats: Beat[] }> = {};
  const takes: Array<[string, boolean, (take: Take) => Promise<void>]> = [
    ['A-adventure', true, (take) => takeAdventure(take, prompt)],
    ['B-refusal', false, takeRefusal],
    ['C-break', false, takeBreakAndRepair],
  ];
  for (const [name, welcome, run] of takes) {
    if (only !== undefined && !name.startsWith(only)) continue;
    console.log(`\n${name}`);
    const take = await openTake(browser, name, out, url, budget, welcome);
    try {
      await run(take);
    } catch (error) {
      console.error(`  ${name} stopped: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
    }
    marks[name] = { file: `${name}.webm`, beats: take.beats };
    await closeTake(take, out).catch(() => undefined);
  }
  await browser.close();
  writeFileSync(join(out, 'marks.json'), `${JSON.stringify({ url, prompt, recordedAt: new Date().toISOString(), viewport: VIEWPORT, takes: marks }, null, 2)}\n`);
  console.log(`\nFootage in ${out}/ · provider-reported spend $${budget.spentUsd.toFixed(5)} / $${limit.toFixed(5)}`);
} catch (error) {
  if (error instanceof LiveEvaluationStop) console.error(error.message);
  else console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
}
