import { expect, test, type Browser, type Page } from '@playwright/test';

/**
 * Regression budgets, set with headroom over the measured baseline
 * (2026-09-26, Apple silicon, SwiftShader): cold JS 341 KB, total 1.07 MB,
 * controls ready ~0.26 s, longest startup task 119 ms (median sample), replay
 * 5.2 fps (3.1 fps on the same machine under load — SwiftShader varies).
 * Time budgets scale with PERF_BUDGET_SCALE for slower CI runners.
 */
const TIME_SCALE = Number(process.env.PERF_BUDGET_SCALE ?? '1') || 1;
const BUDGET = {
  coldJsBytes: 400_000,
  coldTotalBytes: 1_400_000,
  controlsReadyMs: 1_500 * TIME_SCALE,
  longestStartupTaskMs: 250 * TIME_SCALE,
  replayMinFps: 2 / TIME_SCALE,
};

interface StartupSample {
  fcpMs: number | null;
  sceneCanvasMs: number | null;
  sceneControlsReadyMs: number | null;
  jsTransferBytes: number;
  totalTransferBytes: number;
  failedResources: string[];
  longTasks: number[];
}

async function observePage(page: Page): Promise<void> {
  await page.addInitScript(() => {
    // Measure the editor's startup, not the first-visit welcome.
    try {
      window.localStorage.setItem('levelproof:landing:seen', '1');
    } catch {
      // Storage blocked; the measurement still runs.
    }
    type MetricState = { sceneCanvasMs: number | null; sceneControlsReadyMs: number | null; longTasks: number[] };
    const root = window as Window & { __levelProofMetrics?: MetricState };
    const state: MetricState = { sceneCanvasMs: null, sceneControlsReadyMs: null, longTasks: [] };
    root.__levelProofMetrics = state;

    const inspectCanvas = (): void => {
      const canvas = document.querySelector<HTMLCanvasElement>('.viewport canvas');
      if (canvas !== null && state.sceneCanvasMs === null && canvas.getBoundingClientRect().width > 0) {
        state.sceneCanvasMs = performance.now();
      }
      const frame = document.querySelector<HTMLButtonElement>('.viewport-home');
      if (canvas !== null && frame?.disabled === false && state.sceneControlsReadyMs === null) {
        const gl = canvas.getContext('webgl2');
        if (gl !== null && !gl.isContextLost()) state.sceneControlsReadyMs = performance.now();
      }
      if (state.sceneControlsReadyMs === null) requestAnimationFrame(inspectCanvas);
    };
    const mutations = new MutationObserver(() => {
      if (state.sceneCanvasMs === null) inspectCanvas();
    });
    mutations.observe(document, { childList: true, subtree: true });
    requestAnimationFrame(inspectCanvas);

    if (PerformanceObserver.supportedEntryTypes.includes('longtask')) {
      const observer = new PerformanceObserver((list) => {
        state.longTasks.push(...list.getEntries().map((entry) => entry.duration));
      });
      observer.observe({ type: 'longtask', buffered: true });
    }
  });
}

async function collect(page: Page): Promise<StartupSample> {
  await page.locator('.viewport canvas').waitFor({ state: 'visible' });
  await page.waitForFunction(() => {
    const state = (window as Window & { __levelProofMetrics?: { sceneControlsReadyMs: number | null } }).__levelProofMetrics;
    return state?.sceneControlsReadyMs !== null && state?.sceneControlsReadyMs !== undefined;
  });
  await page.waitForTimeout(400);
  return page.evaluate(() => {
    const state = (window as Window & { __levelProofMetrics?: { sceneCanvasMs: number | null; sceneControlsReadyMs: number | null; longTasks: number[] } }).__levelProofMetrics;
    const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
    const scripts = resources.filter((entry) => /\.js(?:\?|$)/.test(new URL(entry.name).pathname));
    const failedResources = resources.filter((entry) => entry.responseStatus >= 400).map((entry) => `${entry.responseStatus} ${entry.name}`);
    return {
      fcpMs: performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null,
      sceneCanvasMs: state?.sceneCanvasMs ?? null,
      sceneControlsReadyMs: state?.sceneControlsReadyMs ?? null,
      jsTransferBytes: scripts.reduce((sum, entry) => sum + entry.transferSize, 0),
      totalTransferBytes: resources.reduce((sum, entry) => sum + entry.transferSize, 0),
      failedResources,
      longTasks: state?.longTasks ?? [],
    };
  });
}

function percentileMedian(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function range(values: number[]): [number, number] | null {
  return values.length === 0 ? null : [Math.min(...values), Math.max(...values)];
}

async function samplePair(browser: Browser, baseURL: string): Promise<{ cold: StartupSample; warm: StartupSample }> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  await observePage(page);
  await page.bringToFront();
  await page.goto(baseURL, { waitUntil: 'load' });
  const cold = await collect(page);
  await page.bringToFront();
  await page.reload({ waitUntil: 'load' });
  const warm = await collect(page);
  await context.close();
  return { cold, warm };
}

test('records five cold and warm production-preview startup samples', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(180_000);
  const samples = [];
  for (let index = 0; index < 5; index++) samples.push(await samplePair(browser, baseURL!));
  const cold = samples.map((sample) => sample.cold);
  const warm = samples.map((sample) => sample.warm);
  const all = [...cold, ...warm];
  const report = {
    measuredAt: new Date().toISOString(),
    build: 'production local Vite preview',
    browser: `Chromium ${browser.version()} with Playwright SwiftShader`,
    viewport: '1280x720, DPR 1',
    runs: 5,
    fcpSamples: { cold: cold.filter((item) => item.fcpMs !== null).length, warm: warm.filter((item) => item.fcpMs !== null).length },
    fcpMedianMs: { cold: percentileMedian(cold.flatMap((item) => item.fcpMs === null ? [] : [item.fcpMs])), warm: percentileMedian(warm.flatMap((item) => item.fcpMs === null ? [] : [item.fcpMs])) },
    sceneCanvasMedianMs: { cold: percentileMedian(cold.flatMap((item) => item.sceneCanvasMs === null ? [] : [item.sceneCanvasMs])), warm: percentileMedian(warm.flatMap((item) => item.sceneCanvasMs === null ? [] : [item.sceneCanvasMs])) },
    sceneControlsReadyMedianMs: { cold: percentileMedian(cold.flatMap((item) => item.sceneControlsReadyMs === null ? [] : [item.sceneControlsReadyMs])), warm: percentileMedian(warm.flatMap((item) => item.sceneControlsReadyMs === null ? [] : [item.sceneControlsReadyMs])) },
    fcpRangeMs: { cold: range(cold.flatMap((item) => item.fcpMs === null ? [] : [item.fcpMs])), warm: range(warm.flatMap((item) => item.fcpMs === null ? [] : [item.fcpMs])) },
    jsTransferBytesMedian: { cold: percentileMedian(cold.map((item) => item.jsTransferBytes)), warm: percentileMedian(warm.map((item) => item.jsTransferBytes)) },
    totalTransferBytesMedian: { cold: percentileMedian(cold.map((item) => item.totalTransferBytes)), warm: percentileMedian(warm.map((item) => item.totalTransferBytes)) },
    failedResources: all.flatMap((item) => item.failedResources),
    longTasks: all.flatMap((item) => item.longTasks),
    samples,
  };
  expect(cold.every((sample) => sample.sceneControlsReadyMs !== null)).toBe(true);
  expect(warm.every((sample) => sample.sceneControlsReadyMs !== null)).toBe(true);
  expect(report.failedResources).toEqual([]);
  await testInfo.attach('production-startup-performance.json', {
    body: JSON.stringify(report, null, 2),
    contentType: 'application/json',
  });
  // Printed before the budgets, so a failed run still shows its numbers.
  console.log(`PRODUCTION_STARTUP_PERFORMANCE ${JSON.stringify(report)}`);
  expect(report.jsTransferBytesMedian.cold, 'cold JavaScript transfer').toBeLessThanOrEqual(BUDGET.coldJsBytes);
  expect(report.totalTransferBytesMedian.cold, 'cold total transfer').toBeLessThanOrEqual(BUDGET.coldTotalBytes);
  expect(report.sceneControlsReadyMedianMs.cold ?? Infinity, 'controls ready (cold median)').toBeLessThanOrEqual(BUDGET.controlsReadyMs);
  // The typical sample's longest task: the very first cold context pays
  // one-off browser costs (shader and disk caches) that are not the app's.
  const longestPerSample = samples.map((sample) => Math.max(0, ...sample.cold.longTasks, ...sample.warm.longTasks));
  expect(percentileMedian(longestPerSample) ?? 0, 'longest startup task (median sample)').toBeLessThanOrEqual(BUDGET.longestStartupTaskMs);
  await testInfo.attach('production-startup-performance-budgets.json', {
    body: JSON.stringify(BUDGET, null, 2),
    contentType: 'application/json',
  });
});

test('records an eight-second witness replay frame-pacing sample', async ({ page, baseURL }, testInfo) => {
  test.setTimeout(90_000);
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem('levelproof:landing:seen', '1');
    } catch {
      // Storage blocked; the welcome would cover the replay button.
    }
  });
  await page.goto(baseURL!);
  await page.bringToFront();
  await page.getByRole('button', { name: 'A winning route' }).click();
  await expect(page.getByRole('region', { name: 'Playtester' })).toContainText('Move 1 of');
  await page.waitForTimeout(400);
  const sample = await page.evaluate(async () => new Promise<{ durationMs: number; intervals: number[] }>((resolve) => {
    const intervals: number[] = [];
    const started = performance.now();
    let previous = started;
    const collectFrame = (now: number): void => {
      intervals.push(now - previous);
      previous = now;
      if (now - started >= 8_000) resolve({ durationMs: now - started, intervals });
      else requestAnimationFrame(collectFrame);
    };
    requestAnimationFrame(collectFrame);
  }));
  const ordered = [...sample.intervals].sort((a, b) => a - b);
  const p95 = ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * 0.95))] ?? null;
  const report = {
    measuredAt: new Date().toISOString(),
    build: 'production local Vite preview',
    browser: `Chromium ${page.context().browser()?.version() ?? 'unknown'} with Playwright SwiftShader`,
    sampleDurationMs: sample.durationMs,
    frameCount: sample.intervals.length,
    observedFps: sample.durationMs === 0 ? null : sample.intervals.length * 1000 / sample.durationMs,
    medianFrameMs: ordered.length === 0 ? null : percentileMedian(ordered),
    p95FrameMs: p95,
    maxFrameMs: ordered.at(-1) ?? null,
    framesOver33ms: sample.intervals.filter((interval) => interval > 33).length,
    routeStatus: await page.getByRole('region', { name: 'Playtester' }).getByRole('status').first().textContent(),
  };
  await testInfo.attach('replay-frame-pacing.json', {
    body: JSON.stringify(report, null, 2),
    contentType: 'application/json',
  });
  console.log(`PRODUCTION_REPLAY_PERFORMANCE ${JSON.stringify(report)}`);
  expect(report.frameCount).toBeGreaterThan(0);
  expect(report.observedFps ?? 0, 'replay frame rate under software WebGL').toBeGreaterThanOrEqual(BUDGET.replayMinFps);
});
