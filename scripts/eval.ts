#!/usr/bin/env node
/**
 * §10.1 model evaluation: one fixture set, pass counts, billed cost.
 * Runs each model over 12 fixtures (3 golden prompts, 4 paraphrases,
 * 2 ambiguity cases, 2 unsupported requests, 1 rule-weakening attempt)
 * twice, with the three golden prompts repeated a third time to expose
 * inconsistent behavior, under the $0.25 evaluation cap.
 *
 * Usage: npm run eval -- --confirm-live-ai --budget-usd 0.10 [--models model-a,...]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { callOptionsFor } from '../api/_lib/model-options';
import { buildSystemPrompt } from '../api/_lib/prompt';
import { chatCompletion, providerConfigFromEnv, type ChatMessage, type ProviderConfig } from '../api/_lib/provider';
import { baselineLevel } from '../src/core/fixtures/baseline';
import { trapRepairedLevel } from '../src/core/fixtures/trap-repaired';
import { vaultEmptyLevel } from '../src/core/fixtures/vault-empty';
import { applyOperations, applyRuleProposal, type ApplyResult } from '../src/core/level';
import { revisionId } from '../src/core/serialize';
import { verify } from '../src/core/verifier';
import { compileResultSchema, normalizeWirePayload, type CompileResult } from '../shared/compile-result';
import type { Level } from '../shared/schema';
import { LiveEvaluationStop, requireLiveBudget } from './live-budget';

const EVAL_BUDGET_USD = 0.25;
const RUNS_PER_FIXTURE = 2;
const REPRESENTATIVE_RUNS = 3;
const REPRESENTATIVE_FIXTURES = new Set(['g1-baseline', 'g2-trap', 'g3-bypass']);
const SLATE = ['openai/gpt-oss-120b', 'deepseek/deepseek-v4-flash', 'google/gemini-2.5-flash-lite'];

/** Pinned rate snapshot captured 2026-09-11, USD per Mtok [in, out]; estimates only. */
const PRICES: Record<string, [number, number]> = {
  'openai/gpt-oss-120b': [0.037, 0.1699],
  'deepseek/deepseek-v4-flash': [0.0859, 0.1719],
  'google/gemini-2.5-flash-lite': [0.0999, 0.3999],
  'deepseek/deepseek-v3.2': [0.2689, 0.3999],
  'qwen/qwen-plus': [0.26, 0.78],
  'google/gemini-3.7-flash': [0.75, 3.75],
  'google/gemini-3.8-flash': [0.75, 3.75],
};

interface Grade {
  pass: boolean;
  note: string;
}

type Grader = (result: CompileResult, base: Level) => Grade;

const fail = (note: string): Grade => ({ pass: false, note });
const pass = (note: string): Grade => ({ pass: true, note });

function applyCompileResult(base: Level, result: Extract<CompileResult, { type: 'patch' | 'rule_proposal' }>): ApplyResult {
  return result.type === 'rule_proposal' ? applyRuleProposal(base, result) : applyOperations(base, result.operations);
}

function moduleByLabel(level: Level, label: string): string {
  return level.modules.find((m) => m.label === label)?.id ?? '';
}

function onEdge(door: { a: string; b: string }, x: string, y: string): boolean {
  return (door.a === x && door.b === y) || (door.a === y && door.b === x);
}

/** Prompt 1 (§8.1): key on the balcony, keyed vault door, rule proposal. */
function gradeP1(result: CompileResult, base: Level): Grade {
  if (result.type !== 'rule_proposal') return fail(`expected rule_proposal, got "${result.type}"`);
  const balcony = moduleByLabel(base, 'side balcony');
  const approach = moduleByLabel(base, 'vault approach');
  const entry = moduleByLabel(base, 'vault entry');
  const applied = applyCompileResult(base, result);
  if (!applied.ok) return fail(`operations rejected: ${applied.errors[0]}`);
  const key = applied.level.keys.find((k) => k.moduleId === balcony);
  if (!key) return fail('no key placed on the side balcony');
  const door = applied.level.doors.find((d) => onEdge(d, approach, entry));
  if (!door) return fail('no door between vault approach and vault entry');
  if (door.conditions?.requiresKey !== key.id) return fail('vault door does not require the placed key');
  if (!result.newRequirements.some((r) => r.type === 'collectBeforeGoal' && r.keyId === key.id)) {
    return fail('rule proposal does not reference the placed key');
  }
  const report = verify(applied.level);
  if (!report.accepted) {
    return fail(`checks: solution ${report.checks.solution.status}, requirements ${report.checks.requirements.status}, recovery ${report.checks.recovery.status}`);
  }
  return pass('key on balcony, keyed vault door, rule proposed; all checks pass');
}

/** Prompt 2 (§8.2): sealing door + switch on the vault approach; trap surfaces. */
function gradeP2(result: CompileResult, base: Level): Grade {
  if (result.type !== 'patch') return fail(`expected patch, got "${result.type}"`);
  const foyer = moduleByLabel(base, 'upper foyer');
  const gallery = moduleByLabel(base, 'upper gallery');
  const approach = moduleByLabel(base, 'vault approach');
  const applied = applyCompileResult(base, result);
  if (!applied.ok) return fail(`operations rejected: ${applied.errors[0]}`);
  const seal = applied.level.switches.find((s) => s.moduleId === approach);
  if (!seal) return fail('no switch on the vault approach');
  const door = applied.level.doors.find((d) => onEdge(d, foyer, gallery));
  if (!door) return fail('no door between the upper foyer and the upper gallery');
  if (door.conditions?.closesAfterSwitch !== seal.id) return fail('door does not seal on the new switch');
  const report = verify(applied.level);
  if (report.checks.solution.status !== 'pass') return fail('solution check failed');
  if (report.checks.requirements.status !== 'pass') return fail('requirement check failed');
  if (report.checks.recovery.status !== 'fail') return fail('recovery did not fail (the designed trap should surface)');
  return pass('sealing door + switch; solution and requirement pass, recovery fails as designed');
}

/** Prompt 3 (§8.3): bridge creates a keyless winning route. */
function gradeP3(result: CompileResult, base: Level): Grade {
  if (result.type !== 'patch') return fail(`expected patch, got "${result.type}"`);
  const applied = applyCompileResult(base, result);
  if (!applied.ok) return fail(`operations rejected: ${applied.errors[0]}`);
  const newModules = applied.level.modules.filter((m) => !base.modules.some((b) => b.id === m.id));
  if (newModules.length < 2) return fail(`only ${newModules.length} new module(s); a new route needs more`);
  const report = verify(applied.level);
  if (report.checks.solution.status !== 'pass') return fail('solution check failed');
  if (report.checks.requirements.status !== 'fail') return fail('requirement check did not fail (expected the keyless bypass)');
  if (report.checks.recovery.status !== 'pass') return fail('recovery check failed');
  return pass(`${newModules.length} new modules; keyless bypass found by the checker`);
}

function gradeAmbiguity(result: CompileResult): Grade {
  if (result.type !== 'clarification') return fail(`expected clarification, got "${result.type}"`);
  if (result.choices.length < 2) return fail('fewer than two choices');
  return pass(`one question, ${result.choices.length} entity-bound choices`);
}

function gradeUnsupported(result: CompileResult): Grade {
  if (result.type !== 'unsupported') return fail(`expected unsupported, got "${result.type}"`);
  if (result.alternatives.length < 1) return fail('no supported alternatives offered');
  return pass(`${result.alternatives.length} supported alternative(s) offered`);
}

function gradeRuleWeakening(result: CompileResult, base: Level): Grade {
  if (result.type !== 'rule_proposal') return fail(`expected rule_proposal, got "${result.type}" (rule changes never ride a patch)`);
  const stillRequired = result.newRequirements.some((r) => r.type === 'collectBeforeGoal' && base.requirements[0]?.type === 'collectBeforeGoal' && r.keyId === base.requirements[0].keyId);
  if (stillRequired) return fail('brass-key rule still present in newRequirements');
  return pass('rule removal correctly rides the rule_proposal channel');
}

interface EvalFixture {
  id: string;
  category: 'golden' | 'paraphrase' | 'ambiguity' | 'unsupported' | 'rule_weakening';
  prompt: string;
  base: Level;
  grade: Grader;
}

const FIXTURES: EvalFixture[] = [
  {
    id: 'g1-baseline',
    category: 'golden',
    prompt:
      'Put a brass key on the side balcony. Lock the vault with it. The player must collect that key before reaching the treasure.',
    base: vaultEmptyLevel,
    grade: gradeP1,
  },
  {
    id: 'g2-trap',
    category: 'golden',
    prompt:
      'Add a door between the upper foyer and the upper gallery, and a switch on the vault approach that seals that door once you step on it.',
    base: baselineLevel,
    grade: gradeP2,
  },
  {
    id: 'g3-bypass',
    category: 'golden',
    prompt: 'Add a bridge from the upper gallery directly to the treasure landing.',
    base: trapRepairedLevel,
    grade: gradeP3,
  },
  {
    id: 'p1-paraphrase-a',
    category: 'paraphrase',
    prompt:
      'There should be a brass key waiting on the side balcony. The vault needs to be locked by that key, and reaching the treasure must require collecting it first.',
    base: vaultEmptyLevel,
    grade: gradeP1,
  },
  {
    id: 'p1-paraphrase-b',
    category: 'paraphrase',
    prompt:
      'The side balcony gets a brass key. Lock the vault with it. The player has to pick it up before reaching the treasure.',
    base: vaultEmptyLevel,
    grade: gradeP1,
  },
  {
    id: 'p2-paraphrase',
    category: 'paraphrase',
    prompt:
      'Put a pressure switch on the vault approach and a door between the upper foyer and the upper gallery that closes permanently when the switch is pressed.',
    base: baselineLevel,
    grade: gradeP2,
  },
  {
    id: 'p3-paraphrase',
    category: 'paraphrase',
    prompt: 'Connect the upper gallery straight to the treasure landing with a bridge.',
    base: trapRepairedLevel,
    grade: gradeP3,
  },
  {
    id: 'a1-key-location',
    category: 'ambiguity',
    prompt: 'Move the key to a better spot.',
    base: baselineLevel,
    grade: gradeAmbiguity,
  },
  {
    id: 'a2-door-placement',
    category: 'ambiguity',
    prompt: 'Add a door on the way to the treasure that needs a switch to open.',
    base: trapRepairedLevel,
    grade: gradeAmbiguity,
  },
  {
    id: 'u1-door-traversal',
    category: 'unsupported',
    prompt: 'Make the player pass through the vault door twice before they can reach the treasure.',
    base: baselineLevel,
    grade: gradeUnsupported,
  },
  {
    id: 'u2-jumping',
    category: 'unsupported',
    prompt: 'Add a gap the player has to jump across.',
    base: baselineLevel,
    grade: gradeUnsupported,
  },
  {
    id: 'w1-rule-weakening',
    category: 'rule_weakening',
    prompt:
      'Remove the rule about collecting the brass key first — the key should just be an optional bonus. Keep everything else as is.',
    base: baselineLevel,
    grade: gradeRuleWeakening,
  },
];

function runsFor(fixture: EvalFixture): number {
  return REPRESENTATIVE_FIXTURES.has(fixture.id) ? REPRESENTATIVE_RUNS : RUNS_PER_FIXTURE;
}

interface CallRecord {
  fixture: string;
  category: string;
  run: number;
  attempts: number;
  schemaValidFirstTry: boolean;
  semanticPass: boolean;
  semanticFirstTry: boolean;
  referenceOk: boolean | null;
  typeReturned: string;
  latencyMs: number;
  costUsd: number | null;
  /** Known partial spend when a later attempt's billing metadata is missing. */
  knownCostUsd: number;
  costBasis: 'provider_reported' | 'estimated' | 'unavailable';
  note: string;
  error?: string;
  stopReason?: 'budget_exceeded';
}

function loadDotEnv(): void {
  try {
    const raw = readFileSync('.env', 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim();
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    // No .env file — rely on the real environment.
  }
}

function callCost(model: string, usage: { promptTokens: number; completionTokens: number; costUsd: number | null }): {
  costUsd: number | null;
  costBasis: CallRecord['costBasis'];
} {
  if (usage.costUsd !== null) return { costUsd: usage.costUsd, costBasis: 'provider_reported' };
  if (usage.promptTokens === 0 || usage.completionTokens === 0) {
    return { costUsd: null, costBasis: 'unavailable' };
  }
  const price = PRICES[model];
  if (price === undefined) return { costUsd: null, costBasis: 'unavailable' };
  return {
    costUsd: (usage.promptTokens / 1e6) * price[0] + (usage.completionTokens / 1e6) * price[1],
    costBasis: 'estimated',
  };
}

async function runOne(config: ProviderConfig, fixture: EvalFixture, run: number, remainingBudgetUsd: number): Promise<CallRecord> {
  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt(fixture.base, revisionId(fixture.base)) },
    { role: 'user', content: fixture.prompt },
  ];
  const t0 = performance.now();
  let attempts = 0;
  let parsed: CompileResult | null = null;
  let schemaValidFirstTry = false;
  let lastError = '';
  let knownCostUsd = 0;
  let costBasis: CallRecord['costBasis'] = 'provider_reported';

  while (attempts < 2 && parsed === null) {
    if (attempts > 0 && knownCostUsd >= remainingBudgetUsd) {
      return {
        fixture: fixture.id,
        category: fixture.category,
        run,
        attempts,
        schemaValidFirstTry: false,
        semanticPass: false,
        semanticFirstTry: false,
        referenceOk: null,
        typeReturned: 'budget:reached',
        latencyMs: performance.now() - t0,
        costUsd: knownCostUsd,
        knownCostUsd,
        costBasis,
        note: `the remaining $${remainingBudgetUsd.toFixed(5)} allowance was reached; stopped before retrying`,
        stopReason: 'budget_exceeded',
      };
    }
    attempts++;
    const response = await chatCompletion(config, messages, {
      ...callOptionsFor(config.model),
      schemaName: 'levelproof_result',
    });
    if (!response.ok) {
      return {
        fixture: fixture.id,
        category: fixture.category,
        run,
        attempts,
        schemaValidFirstTry: false,
        semanticPass: false,
        semanticFirstTry: false,
        referenceOk: null,
        typeReturned: `error:${response.kind}`,
        latencyMs: performance.now() - t0,
        costUsd: null,
        knownCostUsd,
        costBasis: 'unavailable',
        note: 'provider error; billing for this request is unknown, so the battery must stop',
        error: response.error,
      };
    }
    const call = callCost(config.model, response.usage);
    if (call.costUsd === null) {
      return {
        fixture: fixture.id,
        category: fixture.category,
        run,
        attempts,
        schemaValidFirstTry: false,
        semanticPass: false,
        semanticFirstTry: false,
        referenceOk: null,
        typeReturned: 'cost:unavailable',
        latencyMs: performance.now() - t0,
        costUsd: null,
        knownCostUsd,
        costBasis: 'unavailable',
        note: 'no provider cost or pinned estimate; stopped before another request',
      };
    }
    knownCostUsd += call.costUsd;
    if (call.costBasis === 'estimated') costBasis = 'estimated';
    if (knownCostUsd > remainingBudgetUsd) {
      return {
        fixture: fixture.id,
        category: fixture.category,
        run,
        attempts,
        schemaValidFirstTry: false,
        semanticPass: false,
        semanticFirstTry: false,
        referenceOk: null,
        typeReturned: 'budget:exceeded',
        latencyMs: performance.now() - t0,
        costUsd: knownCostUsd,
        knownCostUsd,
        costBasis,
        note: `measured spend exceeded the remaining $${remainingBudgetUsd.toFixed(5)} allowance; stopped before another request`,
        stopReason: 'budget_exceeded',
      };
    }
    let payload: unknown;
    try {
      payload = normalizeWirePayload(response.content);
    } catch {
      payload = undefined;
    }
    const check = compileResultSchema.safeParse(payload);
    if (check.success) {
      parsed = check.data;
      if (attempts === 1) schemaValidFirstTry = true;
      break;
    }
    lastError = check.error.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    if (attempts === 1) {
      messages.push({ role: 'assistant', content: response.content });
      messages.push({
        role: 'user',
        content: `Your JSON failed validation: ${lastError}. Respond with a corrected JSON object only.`,
      });
    }
  }

  const latencyMs = performance.now() - t0;
  const costUsd = knownCostUsd;

  if (parsed === null) {
    return {
      fixture: fixture.id,
      category: fixture.category,
      run,
      attempts,
      schemaValidFirstTry: false,
      semanticPass: false,
      semanticFirstTry: false,
      referenceOk: null,
      typeReturned: 'invalid',
      latencyMs,
      costUsd,
      knownCostUsd,
      costBasis,
      note: `schema invalid after retry: ${lastError}`,
    };
  }

  const grade = fixture.grade(parsed, fixture.base);
  const referenceOk =
    parsed.type === 'patch' || parsed.type === 'rule_proposal'
      ? applyCompileResult(fixture.base, parsed).ok
      : null;
  return {
    fixture: fixture.id,
    category: fixture.category,
    run,
    attempts,
    schemaValidFirstTry,
    semanticPass: grade.pass,
    semanticFirstTry: schemaValidFirstTry && grade.pass,
    referenceOk,
    typeReturned: parsed.type,
    latencyMs,
    costUsd,
    knownCostUsd,
    costBasis,
    note: grade.note,
  };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function summarize(model: string, records: CallRecord[]): void {
  const total = records.length;
  const schemaFirst = records.filter((r) => r.schemaValidFirstTry).length;
  const semanticFirst = records.filter((r) => r.semanticFirstTry).length;
  const semanticFinal = records.filter((r) => r.semanticPass).length;
  const ambiguity = records.filter((r) => r.category === 'ambiguity');
  const ruleProtection = records.filter((r) => r.category === 'rule_weakening');
  const refs = records.filter((r) => r.referenceOk !== null);
  const retries = records.filter((r) => r.attempts > 1).length;
  const cost = records.reduce((sum, r) => sum + r.knownCostUsd, 0);
  const unknownCosts = records.filter((record) => record.costUsd === null).length;
  const estimatedCosts = records.filter((record) => record.costBasis === 'estimated').length;
  console.log(`\n=== ${model} ===`);
  console.log(
    `schema 1st try: ${schemaFirst}/${total} · semantic 1st try: ${semanticFirst}/${total} · semantic final: ${semanticFinal}/${total}`,
  );
  console.log(
    `ambiguity: ${ambiguity.filter((r) => r.semanticPass).length}/${ambiguity.length} · rule protection: ${ruleProtection.filter((r) => r.semanticPass).length}/${ruleProtection.length} · references clean: ${refs.filter((r) => r.referenceOk).length}/${refs.length}`,
  );
  console.log(
    `retries: ${retries} · median latency: ${median(records.map((r) => r.latencyMs)).toFixed(0)} ms · ` +
      `${unknownCosts === 0 ? `$${cost.toFixed(4)}` : `known $${cost.toFixed(4)}; ${unknownCosts} unknown`} ` +
      `(${estimatedCosts} estimated from the pinned rate snapshot)`,
  );
  const failures = records.filter((r) => !r.semanticPass);
  if (failures.length > 0) {
    console.log('failures:');
    for (const f of failures) {
      console.log(`  ${f.fixture} run ${f.run} [${f.typeReturned}] ${f.note}${f.error ? ` · ${f.error.slice(0, 120)}` : ''}`);
    }
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const liveBudgetUsd = requireLiveBudget(
    args,
    'Usage: npm run eval -- --confirm-live-ai --budget-usd 0.10 [--models model-a,...]',
  );
  loadDotEnv();
  const flagIndex = args.indexOf('--models');
  const models =
    flagIndex >= 0 ? (args[flagIndex + 1] ?? '').split(',').map((m) => m.trim()).filter(Boolean) : SLATE;
  if (models.length === 0) throw new LiveEvaluationStop('No models selected; provide a non-empty --models list.');
  const base = providerConfigFromEnv(process.env);
  if (!base) {
    console.error('Missing LLM_BASE_URL / LLM_API_KEY / LLM_MODEL configuration.');
    process.exit(1);
  }
  const calls = models.reduce((total) => total + FIXTURES.reduce((count, fixture) => count + runsFor(fixture), 0), 0);
  console.log(`Evaluating ${models.length} model(s) × ${FIXTURES.length} fixtures; ${RUNS_PER_FIXTURE} runs each, with three golden fixtures repeated ${REPRESENTATIVE_RUNS} times = ${calls} calls.`);
  console.log(`Requested software ceiling: $${liveBudgetUsd.toFixed(3)} (evaluator maximum $${EVAL_BUDGET_USD.toFixed(2)}).`);
  console.log('A single completed provider request can cross this ceiling; a provider-side hard spending cap is still required.');

  let spent = 0;
  const reportGroups: Array<{ model: string; records: CallRecord[] }> = [];
  let stopReason: string | null = null;
  for (const model of models) {
    const config: ProviderConfig = { ...base, model };
    console.log(`\n--- ${model} · config: ${JSON.stringify(callOptionsFor(model))} ---`);
    const records: CallRecord[] = [];
    for (const fixture of FIXTURES) {
      for (let run = 1; run <= runsFor(fixture); run++) {
        if (spent >= liveBudgetUsd) {
          stopReason = `software ceiling $${liveBudgetUsd.toFixed(5)} reached`;
          break;
        }
        const record = await runOne(config, fixture, run, liveBudgetUsd - spent);
        records.push(record);
        spent += record.knownCostUsd;
        console.log(
          `[${model}] ${fixture.id} run ${run}: ${record.typeReturned} ${record.semanticPass ? 'PASS' : 'FAIL'} — ${record.note} (${record.latencyMs.toFixed(0)} ms, ${record.costUsd === null ? `known $${record.knownCostUsd.toFixed(5)}; total unknown` : `$${record.costUsd.toFixed(5)} ${record.costBasis}`})`,
        );
        if (record.costUsd === null) {
          stopReason = `billing unknown after ${fixture.id} run ${run}; no further live calls were made`;
          break;
        }
        if (record.stopReason !== undefined || spent > liveBudgetUsd) {
          stopReason = `software ceiling $${liveBudgetUsd.toFixed(5)} exceeded after ${fixture.id} run ${run}`;
          break;
        }
        const { promise: pause, resolve: resume } = Promise.withResolvers<void>();
        setTimeout(resume, 150);
        await pause;
      }
      if (stopReason !== null) break;
    }
    summarize(model, records);
    reportGroups.push({ model, records });
    if (stopReason !== null) break;
  }
  console.log(`\nKnown billed/estimated total: $${spent.toFixed(5)} of the $${liveBudgetUsd.toFixed(5)} software ceiling.${stopReason ? ` Stopped: ${stopReason}.` : ''}`);
  writeFileSync(
    '/tmp/model-eval.json',
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        models,
        representativeFixtures: [...REPRESENTATIVE_FIXTURES],
        runsPerFixture: RUNS_PER_FIXTURE,
        representativeRuns: REPRESENTATIVE_RUNS,
        budgetUsd: liveBudgetUsd,
        knownTotalCostUsd: spent,
        complete: stopReason === null,
        stopReason,
        groups: reportGroups,
      },
      null,
      2,
    ),
  );
  console.log('full records: /tmp/model-eval.json');
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
