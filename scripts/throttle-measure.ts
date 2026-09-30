#!/usr/bin/env node
/**
 * Phone-class frame pacing (week 4): the real GPU (ANGLE Metal) with the CPU
 * throttled through the DevTools protocol, a phone viewport at DPR 3, and
 * the player walking by hints. Worlds: the Balcony Vault, The Sentry, and a
 * 72-room world laid out with areas and corridors (built here, opened via a
 * share link). No live AI calls.
 *
 * Usage: npx tsx scripts/throttle-measure.ts [baseURL=http://127.0.0.1:4173/] [cpuRate=4]
 */
import { chromium } from '@playwright/test';
import { blankCanvasLevel } from '../src/core/fixtures/blank-canvas';
import { applyOperations } from '../src/core/level';
import { encodeLevelShare } from '../src/core/serialize';
import type { Operation } from '../shared/schema';

const base = process.argv[2] ?? 'http://127.0.0.1:4173/';
const rate = Number(process.argv[3] ?? 4);

/** Four 4×4 areas joined by corridors and opened sides: 72 rooms, 20 operations. */
function bigWorldShare(): string {
  const operations: Operation[] = [
    { kind: 'setScenery', environment: 'volcanic', lighting: 'dusk', architecture: 'basalt' },
    { kind: 'addArea', area: { id: 'yard', x: 3, z: 7, h: 0, width: 4, depth: 4, label: 'courtyard' } },
    { kind: 'setModulePorts', id: 'entry-pad', ports: ['N', 'W'] },
    { kind: 'addArea', area: { id: 'hall', x: 9, z: 3, h: 0, width: 4, depth: 4, label: 'great hall' } },
    { kind: 'addCorridor', corridor: { id: 'north-walk', from: 'goal-pad', direction: 'E', length: 1, label: 'north walk' } },
    { kind: 'addArea', area: { id: 'crypt', x: 1, z: 1, h: 0, width: 4, depth: 4, label: 'crypt' } },
    { kind: 'addCorridor', corridor: { id: 'crypt-walk', from: 'yard-1-1', direction: 'N', length: 2, label: 'crypt stair' } },
    { kind: 'addArea', area: { id: 'garden', x: 10, z: 7, h: 0, width: 4, depth: 4, label: 'ash garden' } },
    { kind: 'addCorridor', corridor: { id: 'east-walk', from: 'start-walk', direction: 'E', length: 2, label: 'east walk' } },
    { kind: 'addItem', itemType: 'key', id: 'ember-key', moduleId: 'crypt-1-1' },
    { kind: 'moveGoal', moduleId: 'hall-4-1' },
    { kind: 'addDoor', door: { id: 'hall-gate', a: 'north-walk-1', b: 'hall-1-4', conditions: { requiresKey: 'ember-key' } } },
    ...([[1, 13], [8, 13], [14, 13], [0, 6], [15, 6], [8, 0], [15, 0], [6, 14]] as const).map(([x, z], index): Operation => ({
      kind: 'addProp', id: `rock-${index}`, prop: index % 2 === 0 ? 'lava' : 'crystal', x, z,
    })),
  ];
  const result = applyOperations(blankCanvasLevel, operations);
  if (!result.ok) throw new Error(result.errors.join('; '));
  return encodeLevelShare(result.level);
}

const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const worlds: Array<[string, string]> = [['vault', base], ['sentry', base], ['big', `${base}?p=${bigWorldShare()}`]];
for (const [name, url] of worlds) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem('levelproof:landing:seen', '1'));
  const cdp = await page.context().newCDPSession(page);
  await page.goto(url);
  if (name === 'sentry') await page.getByRole('combobox', { name: 'Scene' }).selectOption('sentry');
  await page.waitForSelector('[data-render-ms]', { timeout: 60_000 });
  const play = page.getByRole('button', { name: /Play the level/ });
  if (await play.count()) await play.first().click();
  await page.waitForTimeout(3000);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate });
  await page.waitForTimeout(2000);
  // Walk by hints while frame intervals are sampled for six seconds.
  const walking = page.evaluate(async () => {
    for (let i = 0; i < 8; i++) {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'h' }));
      await new Promise((resolve) => setTimeout(resolve, 150));
      (document.querySelector('button.dpad-hint') as HTMLButtonElement | null)?.click();
      await new Promise((resolve) => setTimeout(resolve, 700));
    }
  });
  // Plain JavaScript text: tsx would wrap a named callback in a helper the page lacks.
  const intervals = await page.evaluate<number[]>(`new Promise((resolve) => {
    const collected = [];
    let last = performance.now();
    const end = last + 6000;
    requestAnimationFrame(function tick(now) {
      collected.push(now - last);
      last = now;
      if (now < end) requestAnimationFrame(tick);
      else resolve(collected);
    });
  })`);
  await walking;
  const sorted = [...intervals].sort((a, b) => a - b);
  const fps = intervals.length / (intervals.reduce((sum, value) => sum + value, 0) / 1000);
  const stats = await page.evaluate(() => {
    const host = document.querySelector<HTMLElement>('[data-render-ms]');
    return { calls: host?.dataset.renderCalls, submitMs: host?.dataset.renderMs, dpr: window.devicePixelRatio };
  });
  const at = (p: number): string => (sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0).toFixed(1);
  console.log(
    `${name.padEnd(6)} cpu×${rate}: ${fps.toFixed(1)} fps · median ${at(0.5)} ms · p95 ${at(0.95)} ms · frames >33 ms ${intervals.filter((value) => value > 33).length}/${intervals.length} · ${JSON.stringify(stats)}${errors.length > 0 ? ` · errors: ${errors.join(' | ')}` : ''}`,
  );
  await page.close();
}
await browser.close();
