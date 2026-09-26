#!/usr/bin/env node
/**
 * From-scratch build battery: judge-style one-sentence worlds on the blank
 * canvas, graded by the engine (schema, engine acceptance of the patch, and
 * the three checks), with latency, reasoning tokens, and billed cost. This is
 * the evidence behind the model choice for free prompts (docs/model-eval.md).
 *
 * Usage: npx tsx scripts/build-battery.ts --confirm-live-ai --budget-usd 0.30 [--models a,b]
 */
import { readFileSync } from 'node:fs';
import { callOptionsFor } from '../api/_lib/model-options';
import { buildSystemPrompt } from '../api/_lib/prompt';
import { chatCompletion, providerConfigFromEnv } from '../api/_lib/provider';
import { blankCanvasLevel } from '../src/core/fixtures/blank-canvas';
import { applyOperations } from '../src/core/level';
import { revisionId } from '../src/core/serialize';
import { verify } from '../src/core/verifier';
import { compileResultSchema, normalizeWirePayload } from '../shared/compile-result';
import { LiveBudget, LiveEvaluationStop, requireLiveBudget } from './live-budget';

export const BUILD_BATTERY = [
  'A haunted mansion with a secret library. The key is hidden in the library and the exit is in the attic.',
  "Make a desert temple where you have to collect two gems to open the pharaoh's tomb.",
  'Space station puzzle: a keycard in the reactor room unlocks the airlock, but the reactor switch seals the corridor behind you.',
  'An ice castle with a bridge over a frozen river and a crown on the highest tower that opens the throne room.',
  "A pirate island: a dock, a jungle path, and a cave with the treasure. The captain's key is on the shipwreck.",
  'A simple two-floor dungeon with a lever that opens the portcullis to the exit.',
  'A volcano lair where a dragon guards a gem; the gem opens the escape tunnel.',
  'Cyberpunk rooftops: three rooftops connected by bridges, a keycard on the last roof, and the exit elevator locked until you have it.',
];

function loadDotEnv(): void {
  try {
    for (const line of readFileSync('.env', 'utf8').split('\n')) {
      const trimmed = line.trim();
      const eq = trimmed.indexOf('=');
      if (trimmed.length === 0 || trimmed.startsWith('#') || eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      if (process.env[key] === undefined) process.env[key] = trimmed.slice(eq + 1).trim();
    }
  } catch {
    // No .env — rely on the real environment.
  }
}

try {
  const args = process.argv.slice(2);
  const limit = requireLiveBudget(args, 'Usage: npx tsx scripts/build-battery.ts --confirm-live-ai --budget-usd 0.30 [--models a,b]');
  loadDotEnv();
  const flag = args.indexOf('--models');
  const models = flag >= 0 ? (args[flag + 1] ?? '').split(',').filter(Boolean) : [process.env.LLM_MODEL ?? 'google/gemini-3.8-flash'];
  const budget = new LiveBudget(limit);
  const system = buildSystemPrompt(blankCanvasLevel, revisionId(blankCanvasLevel));
  for (const model of models) {
    const config = providerConfigFromEnv(process.env, model);
    if (config === null) throw new LiveEvaluationStop('Missing provider configuration.');
    let valid = 0;
    let winnable = 0;
    const latencies: number[] = [];
    console.log(`\n--- ${model} · ${JSON.stringify(callOptionsFor(model))} ---`);
    for (const prompt of BUILD_BATTERY) {
      budget.ensureCanCall(`${model}: ${prompt.slice(0, 24)}`);
      const started = performance.now();
      const response = await chatCompletion({ ...config, timeoutMs: 90_000 }, [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ], callOptionsFor(model));
      const ms = Math.round(performance.now() - started);
      latencies.push(ms);
      if (!response.ok) console.log(`  provider error (${response.kind}): ${response.error.slice(0, 300)}`);
      budget.record(response.ok ? response.usage.costUsd : (response.usage?.costUsd ?? null), prompt.slice(0, 24));
      let grade: string;
      if (!response.ok) {
        grade = `provider error: ${response.kind}`;
      } else {
        let parsed: ReturnType<typeof compileResultSchema.safeParse> | null = null;
        try {
          parsed = compileResultSchema.safeParse(normalizeWirePayload(response.content));
        } catch {
          parsed = null;
        }
        if (parsed === null || !parsed.success) grade = 'schema-invalid';
        else if (parsed.data.type !== 'patch') grade = parsed.data.type;
        else {
          const applied = applyOperations(blankCanvasLevel, parsed.data.operations);
          if (!applied.ok) grade = `engine-rejected: ${applied.errors[0]}`;
          else {
            valid += 1;
            const report = verify(applied.level);
            if (report.checks.solution.status === 'pass') winnable += 1;
            grade = `modules=${applied.level.modules.length} win=${report.checks.solution.status} stuck=${report.checks.recovery.status} env=${applied.level.scenery?.environment ?? '-'} props=${applied.level.props?.length ?? 0}`;
          }
        }
      }
      console.log(`${String(ms).padStart(6)} ms | ${prompt.slice(0, 40).padEnd(40)} | ${grade}`);
    }
    latencies.sort((a, b) => a - b);
    console.log(`valid first try ${valid}/${BUILD_BATTERY.length} · winnable ${winnable}/${BUILD_BATTERY.length} · median ${latencies[Math.floor(latencies.length / 2)]} ms`);
  }
  console.log(`Known provider-reported spend: $${budget.spentUsd.toFixed(5)} / $${limit.toFixed(5)}.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
