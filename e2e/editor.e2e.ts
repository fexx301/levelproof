import { expect, test, type Page } from '@playwright/test';
import type { CompileResult } from '../shared/compile-result.js';
import type { Level } from '../shared/schema.js';
import { revisionId } from '../src/core/serialize.js';

const addBalconyKey: CompileResult = {
  type: 'patch',
  rationale: 'Add a brass key to the side balcony.',
  assumptions: [],
  operations: [{ kind: 'addItem', itemType: 'key', id: 'brass-key', moduleId: 'key-balcony' }],
};

async function fixtureCompile(page: Page, result: CompileResult): Promise<void> {
  await page.route('**/api/compile', async (route) => {
    const request = route.request().postDataJSON() as { level: Level };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        result,
        baseRevision: revisionId(request.level),
        cached: false,
        attempts: [{ model: 'deterministic-browser-fixture', outcome: 'schema_valid', latencyMs: 2, costUsd: null }],
        totalCostUsd: null,
        generationCostUsd: null,
      }),
    });
  });
}

test('selects a visible floor and keeps selection/protection across theme remounts', async ({ page }, testInfo) => {
  await page.goto('/');
  const canvas = page.getByRole('region', { name: /3D view of the current level/ }).locator('canvas');
  const bounds = await canvas.boundingBox();
  expect(bounds).not.toBeNull();
  if (bounds === null) throw new Error('The scene canvas is not visible.');
  // In the production overview camera, this point is the visible gallery floor.
  await page.mouse.click(bounds.x + bounds.width * 0.43, bounds.y + bounds.height * 0.34);
  await expect(page.getByRole('group', { name: 'Selected scene entities' })).toContainText('gallery');
  await expect(page.locator('.viewport canvas')).toHaveCount(1);
  await page.getByText('Select an object by name').click();
  const gallery = page.getByRole('button', { name: /upper foyer.*gallery.*floor/i });
  await expect(gallery).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('group', { name: 'Selected scene entities' })).toContainText('gallery');
  await page.getByRole('button', { name: 'Keep these' }).click();
  await page.screenshot({ path: testInfo.outputPath('selection-limestone.png') });

  for (const theme of ['limestone', 'ivory', 'patina', 'basalt', 'futuristic']) {
    if (theme !== 'limestone') await page.getByLabel('Architecture theme').selectOption(theme);
    await expect(gallery).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('group', { name: 'Selected scene entities' })).toContainText('gallery');
    await expect(page.getByRole('group', { name: 'Kept entities' })).toContainText('gallery');
    await expect(page.locator('.viewport canvas')).toHaveCount(1);
    await page.screenshot({ path: testInfo.outputPath(`selection-${theme}.png`) });
  }
});

test('shows an added object in the preview, applies the same candidate, then saves and shares it', async ({ page, context, browser }, testInfo) => {
  // Seven animated moves under software WebGL need more than the default budget.
  test.setTimeout(240_000);
  await fixtureCompile(page, addBalconyKey);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/');
  await page.getByRole('textbox', { name: 'Describe a change' }).fill('Add a brass key to the side balcony.');
  await page.getByRole('button', { name: 'Compile', exact: true }).click();
  const preview = page.getByRole('region', { name: 'Edit preview' });
  await expect(preview).toBeVisible();
  await expect(preview).toContainText('Add a key “brass key” to “side balcony”.');
  await expect(preview).toContainText('Before / removed');
  await expect(preview).toContainText('Proposed / added');
  await expect(preview.getByRole('button', { name: 'Apply edit' })).toBeInViewport();
  await expect.poll(() => preview.evaluate((element) => {
    const panel = element.closest('.side-panel');
    if (!panel) return false;
    const card = element.getBoundingClientRect();
    const viewport = panel.getBoundingClientRect();
    return card.top >= viewport.top - 1 && card.bottom <= viewport.bottom + 1;
  })).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('add-key-preview.png') });

  await page.reload();
  await expect(page.getByRole('region', { name: 'Edit preview' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Describe a change' })).toHaveValue('Add a brass key to the side balcony.');
  await page.getByRole('button', { name: 'Apply edit' }).click();
  await expect(page.getByRole('heading', { name: 'Edit applied — accepted' })).toBeVisible();
  await expect(page.getByText('Accepted', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Play it yourself' }).click();
  const playPanel = page.getByRole('region', { name: 'Play' });
  const location = playPanel.getByRole('status');
  await expect(location).toHaveAttribute('data-module', 'entrance');
  const journey: Array<[string, string]> = [
    ['north', 'lower-hall'], ['north', 'gallery-ramp'], ['north', 'gallery'], ['north', 'bridge-landing'],
    ['east', 'vault-approach'], ['east', 'vault-entry'], ['east', 'treasure-landing'],
  ];
  for (const [direction, destination] of journey) {
    await playPanel.getByRole('button', { name: `Move ${direction}` }).click();
    // Each move animates to completion; software WebGL in CI renders the
    // dressed scene at a few frames per second, so allow for slow frames.
    await expect(location).toHaveAttribute('data-module', destination, { timeout: 20_000 });
  }
  await expect(playPanel).toContainText('Level complete');
  await page.getByRole('button', { name: 'Back to editing (Esc)' }).click();

  await page.getByRole('button', { name: 'Save checkpoint' }).click();
  await expect(page.getByText('Saved ✓')).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Scene').locator('option', { hasText: 'Puzzle' }).first()).toBeAttached();

  await page.getByRole('button', { name: 'Share', exact: true }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('?p=');
  const sharedUrl = await page.evaluate(() => navigator.clipboard.readText());
  const cleanContext = await browser.newContext();
  const sharedPage = await cleanContext.newPage();
  await sharedPage.goto(sharedUrl);
  await expect(sharedPage.getByRole('button', { name: 'Remix this puzzle (Esc)' })).toBeVisible();
  await cleanContext.close();
});

test('keeps the prompt retryable after an API failure', async ({ page }) => {
  await page.route('**/api/compile', (route) => route.fulfill({
    status: 503,
    contentType: 'application/json',
    body: JSON.stringify({ error: 'provider_not_configured' }),
  }));
  await page.goto('/');
  const prompt = 'Place a brass key on the side balcony.';
  await page.getByRole('textbox', { name: 'Describe a change' }).fill(prompt);
  await page.getByRole('button', { name: 'Compile', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('AI provider is not configured');
  await expect(page.getByRole('textbox', { name: 'Describe a change' })).toHaveValue(prompt);
  await expect(page.getByRole('button', { name: 'Compile', exact: true })).toBeEnabled();
});

test('kept objects reject a conflicting proposal and can be unkept before retry', async ({ page }) => {
  const rename: CompileResult = {
    type: 'patch',
    rationale: 'Rename the upper foyer.',
    assumptions: [],
    operations: [{ kind: 'setModuleLabel', id: 'gallery', label: 'Kept observatory' }],
  };
  await fixtureCompile(page, rename);
  await page.goto('/');
  await page.getByText('Select an object by name').click();
  await page.getByRole('group', { name: 'Scene objects' }).getByRole('button', { name: /upper foyer.*gallery.*floor/i }).click();
  await page.getByRole('button', { name: 'Keep these' }).click();

  const prompt = page.getByRole('textbox', { name: 'Describe a change' });
  await prompt.fill('Rename the kept gallery.');
  await page.getByRole('button', { name: 'Compile', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('marked Keep these');
  await expect(page.getByRole('region', { name: 'Edit preview' })).toHaveCount(0);
  await expect(page.getByRole('group', { name: 'Kept entities' })).toContainText('gallery');

  await page.getByRole('group', { name: 'Kept entities' }).getByRole('button', { name: /gallery/ }).click();
  await expect(page.getByRole('textbox', { name: 'Describe a change' })).toHaveValue('Rename the kept gallery.');
  await page.getByRole('button', { name: 'Compile', exact: true }).click();
  const preview = page.getByRole('region', { name: 'Edit preview' });
  await expect(preview).toBeVisible();
  await page.getByRole('button', { name: 'Apply edit' }).click();
  await expect(page.getByRole('heading', { name: 'Edit applied — accepted' })).toBeVisible();
});

test('applies a rule-linked trap as a draft and replays its verified stranded witness', async ({ page }, testInfo) => {
  const trap: CompileResult = {
    type: 'rule_proposal',
    reason: 'Add a required key and a switch that seals the route behind the player.',
    oldRequirements: [],
    newRequirements: [{ type: 'collectBeforeGoal', keyId: 'brass-key' }],
    operations: [
      { kind: 'addItem', itemType: 'key', id: 'brass-key', moduleId: 'key-balcony' },
      { kind: 'addDoor', door: { id: 'vault-door', a: 'vault-approach', b: 'vault-entry', conditions: { requiresKey: 'brass-key' } } },
      { kind: 'addItem', itemType: 'switch', id: 'seal-switch', moduleId: 'vault-approach' },
      { kind: 'addDoor', door: { id: 'gallery-door', a: 'gallery', b: 'bridge-landing', conditions: { closesAfterSwitch: 'seal-switch' } } },
    ],
  };
  await fixtureCompile(page, trap);
  await page.goto('/');
  await page.getByRole('textbox', { name: 'Describe a change' }).fill('Add a key-and-switch trap to test recovery.');
  await page.getByRole('button', { name: 'Compile', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Rule proposal' })).toBeVisible();
  await page.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByRole('heading', { name: 'Rule applied — draft' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Verification checks' })).toContainText('Can a player get stuck?');
  await expect(page.getByRole('region', { name: 'Verification checks' })).toContainText('Not accepted');

  await page.getByRole('button', { name: 'Show the problem' }).click();
  const evidence = page.getByLabel('Verified failure evidence');
  await expect(evidence).toBeVisible();
  await expect(evidence).toContainText('gallery-door');
  await expect(page.getByRole('status').filter({ hasText: 'Paused at decisive moment' })).toBeVisible({ timeout: 45_000 });
  await expect(evidence).toContainText('closes');
  await page.screenshot({ path: testInfo.outputPath('decisive-replay.png') });
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Stranded at' })).toBeVisible({ timeout: 45_000 });
  await page.getByRole('button', { name: 'Back to repair' }).click();
  const repairs = page.getByRole('region', { name: 'Repairs' });
  await expect(repairs.getByRole('button', { name: 'Ask the AI to fix it' })).toBeVisible();
  await expect(repairs.getByRole('button', { name: 'Find checked repairs' })).toBeVisible();
  await repairs.getByRole('button', { name: 'Find checked repairs' }).click();
  await expect(repairs.getByRole('button', { name: 'Preview' }).first()).toBeVisible();
  await repairs.getByRole('button', { name: 'Preview' }).first().click();
  await repairs.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(repairs).toContainText('Repaired and accepted.');
});

test('previews and atomically applies removal of a required key, door, and rule', async ({ page }) => {
  const add: CompileResult = {
    type: 'rule_proposal',
    reason: 'Add a key gate and make the key required.',
    oldRequirements: [],
    newRequirements: [{ type: 'collectBeforeGoal', keyId: 'brass-key' }],
    operations: [
      { kind: 'addItem', itemType: 'key', id: 'brass-key', moduleId: 'key-balcony' },
      { kind: 'addDoor', door: { id: 'vault-door', a: 'vault-approach', b: 'vault-entry', conditions: { requiresKey: 'brass-key' } } },
    ],
  };
  const remove: CompileResult = {
    type: 'rule_proposal',
    reason: 'Remove the linked key mechanic together.',
    oldRequirements: [{ type: 'collectBeforeGoal', keyId: 'brass-key' }],
    newRequirements: [],
    operations: [
      { kind: 'removeItem', id: 'brass-key' },
      { kind: 'removeDoor', id: 'vault-door' },
    ],
  };
  await page.route('**/api/compile', async (route) => {
    const request = route.request().postDataJSON() as { level: Level; prompt: string };
    const result = request.prompt.startsWith('Remove') ? remove : add;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        result,
        baseRevision: revisionId(request.level),
        cached: false,
        attempts: [{ model: 'deterministic-browser-fixture', outcome: 'schema_valid', latencyMs: 2, costUsd: null }],
        totalCostUsd: null,
        generationCostUsd: null,
      }),
    });
  });

  await page.goto('/');
  const prompt = page.getByRole('textbox', { name: 'Describe a change' });
  await prompt.fill('Build a brass key gate and require its key.');
  await page.getByRole('button', { name: 'Compile', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Rule proposal' })).toContainText('Add: Collect');
  await page.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByRole('heading', { name: 'Rule applied — accepted' })).toBeVisible();

  await prompt.fill('Remove the brass key, its door, and its requirement.');
  await page.getByRole('button', { name: 'Compile', exact: true }).click();
  const preview = page.getByRole('region', { name: 'Rule proposal' });
  await expect(preview).toContainText('Remove: Collect');
  await expect(preview).toContainText('Remove key “brass key” from “side balcony”.');
  await expect(preview).toContainText('Remove door between “vault approach” and “vault entry”.');
  await expect(preview).toContainText('Before / removed');
  await expect(preview.getByRole('button', { name: 'Approve' })).toBeEnabled();
  await page.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByRole('heading', { name: 'Rule applied — accepted' })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Active rules' })).toContainText('No rules set');

  await page.getByText('Select an object by name').click();
  const objects = page.getByRole('group', { name: 'Scene objects' });
  await expect(objects.getByRole('button', { name: /brass-key/ })).toHaveCount(0);
  await expect(objects.getByRole('button', { name: /vault-door/ })).toHaveCount(0);
});

test('shows a recoverable fallback when WebGL cannot start', async ({ page }) => {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (contextId: string, ...args: unknown[]) {
      if (contextId.startsWith('webgl')) return null;
      return Reflect.apply(original, this, [contextId, ...args]) as RenderingContext | null;
    } as typeof HTMLCanvasElement.prototype.getContext;
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '3D view unavailable' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry 3D view' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Verification checks' })).toBeVisible();
});

test('keyboard workflow and essential controls remain usable at a narrow viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fixtureCompile(page, addBalconyKey);
  await page.goto('/');

  const viewport = page.getByRole('region', { name: /3D view of the current level/ });
  const prompt = page.getByRole('textbox', { name: 'Describe a change' });
  const compile = page.getByRole('button', { name: 'Compile', exact: true });
  await expect(viewport).toBeVisible();

  // The authoring panel scrolls independently on narrow screens. Focus and
  // activate the workflow with keyboard input rather than pointer clicks.
  await prompt.focus();
  await prompt.fill('Add a brass key to the side balcony.');
  await page.keyboard.press('Tab');
  await expect(compile).toBeFocused();
  const focusStyle = await compile.evaluate((element) => ({
    outlineStyle: getComputedStyle(element).outlineStyle,
    outlineWidth: getComputedStyle(element).outlineWidth,
  }));
  expect(focusStyle.outlineStyle).toBe('solid');
  expect(Number.parseFloat(focusStyle.outlineWidth)).toBeGreaterThanOrEqual(2);
  await page.keyboard.press('Enter');

  const preview = page.getByRole('region', { name: 'Edit preview' });
  await expect(preview).toBeVisible();
  const approve = preview.getByRole('button', { name: 'Apply edit' });
  await approve.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Edit applied — accepted' })).toBeVisible();

  const play = page.getByRole('button', { name: 'Play it yourself' });
  await play.focus();
  await page.keyboard.press('Enter');
  const playPanel = page.getByRole('region', { name: 'Play' });
  await expect(playPanel).toBeVisible();
  const north = playPanel.getByRole('button', { name: 'Move north' });
  const northBounds = await north.boundingBox();
  expect(northBounds).not.toBeNull();
  if (northBounds === null) throw new Error('The north movement control is not visible.');
  expect(northBounds.x).toBeGreaterThanOrEqual(0);
  expect(northBounds.x + northBounds.width).toBeLessThanOrEqual(390);
  await north.focus();
  await page.keyboard.press('Enter');
  await expect(playPanel.getByRole('status')).toBeVisible();

  const dimensions = await page.evaluate(() => ({
    viewportWidth: document.documentElement.clientWidth,
    documentWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.documentWidth).toBeLessThanOrEqual(dimensions.viewportWidth);
});
