#!/usr/bin/env node
/**
 * Prewarm the shared compile cache on a deployed LevelProof: sends every
 * example chip exactly as the editor would (same scene, same body), follows
 * the two-step vault trap, and repeats any automatic AI↔engine revision the
 * editor would request. Cached chips then answer instantly for every visitor
 * (disclosed in the UI as "Cached result"). Re-run after each deploy that
 * changes the prompt version, and before judging windows (entries last
 * SHARED_CACHE_TTL_SECONDS, 7 days by default).
 *
 * Usage: npx tsx scripts/prewarm.ts --confirm-live-ai --budget-usd 0.40 [--url https://levelproof.vercel.app]
 */
import { compileOkResponseSchema } from '../shared/api';
import type { Level, Operation } from '../shared/schema';
import { blankCanvasLevel } from '../src/core/fixtures/blank-canvas';
import { gauntletLevel, overpassLevel, twinKeysLevel } from '../src/core/fixtures/gallery';
import { vaultEmptyLevel } from '../src/core/fixtures/vault-empty';
import { applyOperations, applyRuleProposal } from '../src/core/level';
import { shouldAutoRevise } from '../src/core/revision-policy';
import { BUILD_PROMPTS, EXAMPLE_PROMPTS, MAKEOVER_PROMPT, TWIST_PROMPT, WINTER_PROMPT } from '../src/ui/example-prompts';
import { LiveBudget, LiveEvaluationStop, requireLiveBudget } from './live-budget';

const SPACING_MS = 8_000; // stays under the default 8-requests-per-minute window

interface Job {
  scene: string;
  level: Level;
  prompt: string;
  /** Optional follow-up chip compiled on this job's accepted result. */
  then?: string;
}

const JOBS: Job[] = [
  { scene: 'vault', level: vaultEmptyLevel, prompt: EXAMPLE_PROMPTS.baseline, then: EXAMPLE_PROMPTS.trap },
  { scene: 'vault', level: vaultEmptyLevel, prompt: EXAMPLE_PROMPTS.trapOneShot },
  { scene: 'vault', level: vaultEmptyLevel, prompt: MAKEOVER_PROMPT },
  { scene: 'vault', level: vaultEmptyLevel, prompt: EXAMPLE_PROMPTS.removeRamp },
  { scene: 'vault', level: vaultEmptyLevel, prompt: TWIST_PROMPT },
  ...[['twin keys', twinKeysLevel], ['overpass', overpassLevel], ['gauntlet', gauntletLevel]].flatMap(([scene, level]) =>
    [MAKEOVER_PROMPT, WINTER_PROMPT, TWIST_PROMPT].map((prompt) => ({ scene: scene as string, level: level as Level, prompt }))),
  ...BUILD_PROMPTS.map((build) => ({ scene: 'blank', level: blankCanvasLevel, prompt: build.prompt })),
];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

try {
  const args = process.argv.slice(2);
  const limit = requireLiveBudget(args, 'Usage: npx tsx scripts/prewarm.ts --confirm-live-ai --budget-usd 0.40 [--url https://levelproof.vercel.app]');
  const urlFlag = args.indexOf('--url');
  const origin = urlFlag >= 0 ? args[urlFlag + 1]! : 'https://levelproof.vercel.app';
  const budget = new LiveBudget(limit);

  const post = async (label: string, body: Record<string, unknown>) => {
    budget.ensureCanCall(label);
    const started = performance.now();
    const response = await fetch(`${origin}/api/compile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // The editor always sends these fields; the cache key treats absent and empty alike.
      body: JSON.stringify({ selection: [], protectedIds: [], history: [], ...body }),
    });
    const json: unknown = await response.json();
    const parsed = compileOkResponseSchema.safeParse(json);
    const ms = Math.round(performance.now() - started);
    if (!response.ok || !parsed.success) {
      console.log(`FAIL ${label} · HTTP ${response.status} · ${JSON.stringify(json).slice(0, 160)}`);
      return null;
    }
    budget.record(parsed.data.cached ? 0 : parsed.data.totalCostUsd, label);
    console.log(`${parsed.data.cached ? 'HIT ' : 'WARM'} ${label} · ${parsed.data.result.type} · ${ms} ms`);
    await sleep(SPACING_MS);
    return parsed.data;
  };

  const warm = async (label: string, level: Level, prompt: string, history: string[] = []): Promise<Level | null> => {
    const body = { level, prompt, history: history.map((entry) => ({ prompt: entry })) };
    const first = await post(label, body);
    if (first === null) return null;
    const result = first.result;
    if (result.type !== 'patch' && result.type !== 'rule_proposal') return null;
    const applied = result.type === 'patch' ? applyOperations(level, result.operations) : applyRuleProposal(level, result);
    if (!applied.ok) return null;
    if (result.type === 'patch' && shouldAutoRevise(level, applied.level, result.operations as Operation[])) {
      const revised = await post(`${label} (revision)`, { ...body, revision: { operations: result.operations } });
      if (revised?.result.type === 'patch') {
        const revisedLevel = applyOperations(level, revised.result.operations);
        if (revisedLevel.ok) return revisedLevel.level;
      }
    }
    return applied.level;
  };

  console.log(`Prewarming ${JOBS.length} chips on ${origin}`);
  for (const job of JOBS) {
    const label = `${job.scene}: ${job.prompt.slice(0, 48)}`;
    const next = await warm(label, job.level, job.prompt);
    if (job.then !== undefined && next !== null) await warm(`${job.scene} (step 2): ${job.then.slice(0, 40)}`, next, job.then, [job.prompt]);
  }
  console.log(`Known provider-reported spend: $${budget.spentUsd.toFixed(5)} / $${limit.toFixed(5)}.`);
} catch (error) {
  console.error(error instanceof LiveEvaluationStop || error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
