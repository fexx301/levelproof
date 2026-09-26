#!/usr/bin/env node
/**
 * Example-chip battery: every one-click prompt the editor offers, run live
 * through the real compile service (cache cleared per run) and graded by the
 * engine against what the chip promises. A chip that fails does more harm
 * than no chip, so any chip below 2/2 here should be removed or rephrased.
 *
 * Usage: npx tsx scripts/chip-battery.ts --confirm-live-ai --budget-usd 0.50 [--runs 2] [--only text]
 */
import { readFileSync } from 'node:fs';
import { resetCache } from '../api/_lib/cache';
import { blankCanvasLevel } from '../src/core/fixtures/blank-canvas';
import { gauntletLevel, overpassLevel, twinKeysLevel } from '../src/core/fixtures/gallery';
import { vaultEmptyLevel } from '../src/core/fixtures/vault-empty';
import { applyOperations, applyRuleProposal } from '../src/core/level';
import { verify } from '../src/core/verifier';
import { BUILD_PROMPTS, EXAMPLE_PROMPTS, MAKEOVER_PROMPT, TWIST_PROMPT, WINTER_PROMPT } from '../src/ui/example-prompts';
import type { CompileResult } from '../shared/compile-result';
import type { Level } from '../shared/schema';
import { compileWithRevision } from './auto-revise';
import { LiveBudget, LiveEvaluationStop, requireLiveBudget } from './live-budget';

type Grade = { pass: boolean; note: string };

function gameplay(level: Level): string {
  return JSON.stringify({
    modules: [...level.modules].map((m) => [m.id, m.template, m.x, m.z, m.h, m.orientation ?? null, [...m.ports].sort()]).sort(),
    keys: level.keys.map((k) => [k.id, k.moduleId]).sort(),
    switches: level.switches.map((s) => [s.id, s.moduleId]).sort(),
    doors: level.doors.map((d) => [d.id, d.a, d.b, d.conditions ?? {}]).sort(),
    spawn: level.spawn,
    goal: level.goal,
    requirements: level.requirements,
  });
}

function applyResult(base: Level, result: CompileResult): Level | string {
  if (result.type === 'patch') {
    const applied = applyOperations(base, result.operations);
    return applied.ok ? applied.level : `rejected: ${applied.errors[0]}`;
  }
  if (result.type === 'rule_proposal') {
    const applied = applyRuleProposal(base, result);
    return applied.ok ? applied.level : `rejected: ${applied.errors[0]}`;
  }
  return `${result.type}`;
}

interface Chip {
  name: string;
  base: Level;
  prompt: string;
  grade: (after: Level, base: Level) => Grade;
}

/** A key on the balcony and a door that needs it anywhere on the vault's run. */
const VAULT_RUN = new Set(['vault-approach', 'vault-entry', 'treasure-landing']);
const keyedVault = (level: Level): boolean => {
  const key = level.keys.find((k) => k.moduleId === 'key-balcony');
  return key !== undefined && level.doors.some((d) =>
    (VAULT_RUN.has(d.a) || VAULT_RUN.has(d.b)) &&
    (d.conditions?.requiresKey === key.id || (d.conditions?.requiresKeys ?? []).includes(key.id)));
};

const winnableBuild = (after: Level): Grade => {
  const report = verify(after);
  const dressed = after.scenery?.environment !== undefined && (after.props?.length ?? 0) >= 2;
  return {
    pass: report.checks.solution.status === 'pass' && dressed,
    note: `modules=${after.modules.length} win=${report.checks.solution.status} stuck=${report.checks.recovery.status} env=${after.scenery?.environment ?? '-'} props=${after.props?.length ?? 0}`,
  };
};

const makeover = (after: Level, base: Level): Grade => {
  const unchanged = gameplay(after) === gameplay(base);
  const night = after.scenery?.lighting === 'night';
  const props = (after.props?.length ?? 0) > (base.props?.length ?? 0);
  return { pass: unchanged && night && props, note: `gameplay unchanged=${unchanged} env=${after.scenery?.environment} light=${after.scenery?.lighting} props=${after.props?.length ?? 0}` };
};

const CHIPS: Chip[] = [
  { name: 'vault: key + locked door', base: vaultEmptyLevel, prompt: EXAMPLE_PROMPTS.baseline, grade: (after) => ({ pass: keyedVault(after) && verify(after).checks.solution.status === 'pass', note: `keyed vault=${keyedVault(after)}` }) },
  {
    name: 'vault: the switch trap',
    base: vaultEmptyLevel,
    prompt: EXAMPLE_PROMPTS.trapOneShot,
    grade: (after) => {
      const report = verify(after);
      const trap = after.doors.some((d) => d.conditions?.closesAfterSwitch !== undefined);
      return { pass: keyedVault(after) && trap && report.checks.solution.status === 'pass' && report.checks.recovery.status === 'fail', note: `trap=${trap} win=${report.checks.solution.status} stuck=${report.checks.recovery.status}` };
    },
  },
  { name: 'vault: spooky night makeover', base: vaultEmptyLevel, prompt: MAKEOVER_PROMPT, grade: makeover },
  {
    name: 'vault: remove the ramp',
    base: vaultEmptyLevel,
    prompt: EXAMPLE_PROMPTS.removeRamp,
    grade: (after) => ({ pass: !after.modules.some((m) => m.id === 'gallery-ramp') && verify(after).checks.solution.status === 'fail', note: `ramp gone=${!after.modules.some((m) => m.id === 'gallery-ramp')}` }),
  },
  { name: 'vault: suggest a twist', base: vaultEmptyLevel, prompt: TWIST_PROMPT, grade: (after, base) => ({ pass: gameplay(after) !== gameplay(base) && verify(after).valid, note: `changed=${gameplay(after) !== gameplay(base)}` }) },
  { name: 'gauntlet: spooky night makeover', base: gauntletLevel, prompt: MAKEOVER_PROMPT, grade: makeover },
  {
    name: 'twin keys: winter makeover',
    base: twinKeysLevel,
    prompt: WINTER_PROMPT,
    grade: (after, base) => ({
      pass: gameplay(after) === gameplay(base) && after.scenery?.environment === 'snow' && (after.props?.length ?? 0) > (base.props?.length ?? 0),
      note: `gameplay unchanged=${gameplay(after) === gameplay(base)} env=${after.scenery?.environment} light=${after.scenery?.lighting} props=${after.props?.length ?? 0}`,
    }),
  },
  { name: 'overpass: suggest a twist', base: overpassLevel, prompt: TWIST_PROMPT, grade: (after, base) => ({ pass: gameplay(after) !== gameplay(base) && verify(after).valid, note: `changed=${gameplay(after) !== gameplay(base)}` }) },
  ...BUILD_PROMPTS.map((build) => ({ name: `blank: ${build.label}`, base: blankCanvasLevel, prompt: build.prompt, grade: winnableBuild })),
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
  const limit = requireLiveBudget(args, 'Usage: npx tsx scripts/chip-battery.ts --confirm-live-ai --budget-usd 0.50 [--runs 2]');
  const runsFlag = args.indexOf('--runs');
  const runs = runsFlag >= 0 ? Number(args[runsFlag + 1]) : 2;
  const onlyFlag = args.indexOf('--only');
  const only = onlyFlag >= 0 ? (args[onlyFlag + 1] ?? '') : '';
  loadDotEnv();
  process.env.LEVELPROOF_SHARED_CACHE = 'off';
  const budget = new LiveBudget(limit);
  console.log(`chips × ${runs} on ${process.env.LLM_MODEL} (fallback ${process.env.LLM_FALLBACK_MODEL})`);
  const tally = new Map<string, number>();
  const selected = CHIPS.filter((chip) => only === '' || chip.name.includes(only));
  for (const chip of selected) {
    for (let run = 1; run <= runs; run++) {
      resetCache();
      const started = performance.now();
      const { outcome, costs, rounds } = await compileWithRevision(process.env, { level: chip.base, prompt: chip.prompt }, () => budget.ensureCanCall(chip.name));
      const cost = costs.at(-1) ?? null;
      const note = rounds > 0 ? ` (revised ×${rounds})` : '';
      const after = outcome.result === null ? `failed: ${outcome.error} ${outcome.providerError ?? ''}` : applyResult(chip.base, outcome.result);
      for (const spent of costs.slice(0, -1)) budget.record(spent, chip.name);
      if (cost === null) console.log(`  attempts: ${JSON.stringify(outcome.attempts)}`);
      budget.record(cost, chip.name);
      const ms = Math.round(performance.now() - started);
      const grade: Grade = typeof after === 'string' ? { pass: false, note: after } : chip.grade(after, chip.base);
      if (grade.pass) tally.set(chip.name, (tally.get(chip.name) ?? 0) + 1);
      console.log(`${grade.pass ? 'PASS' : 'FAIL'} ${chip.name.padEnd(34)} run ${run} ${String(ms).padStart(6)} ms ${outcome.result?.type ?? '-'}${note} | ${grade.note}`);
    }
  }
  console.log('\nSummary:');
  for (const chip of selected) console.log(`${String(tally.get(chip.name) ?? 0)}/${runs} ${chip.name}`);
  console.log(`Known provider-reported spend: $${budget.spentUsd.toFixed(5)} / $${limit.toFixed(5)}.`);
} catch (error) {
  if (error instanceof LiveEvaluationStop) console.error(error.message);
  else console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 2;
}
