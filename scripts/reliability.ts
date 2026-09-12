#!/usr/bin/env node
/**
 * Reliability battery (§10.1, raised eval allowance per DECISIONS.md): run a
 * fixed suite of prompt phrasings through the DEPLOYED /api/compile — the
 * exact path judges experience (prompt-4 rules, fence normalization, fallback
 * chain, cache) — and grade every outcome with the deterministic core. The
 * engine is the oracle: no human judgment in the loop.
 *
 * Each distinct phrasing is a distinct cache key, so every run is a fresh
 * model call. Run: npx tsx scripts/reliability.ts
 */
import { writeFileSync } from 'node:fs';
import type { CompileResult } from '../shared/compile-result';
import { compileOkResponseSchema } from '../shared/api';
import type { Level } from '../shared/schema';
import { baselineLevel } from '../src/core/fixtures/baseline';
import { vaultEmptyLevel } from '../src/core/fixtures/vault-empty';
import { applyOperations } from '../src/core/level';
import { verify } from '../src/core/verifier';

const API = 'https://levelproof.vercel.app/api/compile';

type Category =
  | 'baseline'
  | 'trap'
  | 'compound'
  | 'bypass'
  | 'edit'
  | 'ambiguity'
  | 'unsupported'
  | 'rule_weakening';

interface Grade {
  pass: boolean;
  note: string;
}

interface Fixture {
  id: string;
  category: Category;
  prompt: string;
  base: Level;
  grade: (result: CompileResult, base: Level) => Grade;
}

const fail = (note: string): Grade => ({ pass: false, note });
const pass = (note: string): Grade => ({ pass: true, note });

function moduleByLabel(level: Level, label: string): string {
  return level.modules.find((m) => m.label === label)?.id ?? '';
}

function onEdge(door: { a: string; b: string }, x: string, y: string): boolean {
  return (door.a === x && door.b === y) || (door.a === y && door.b === x);
}

/** Baseline (§8.1): key + keyed vault door, all green. A rule proposal is the
 * ideal shape (the video's rule-card beat) but a plain patch is a valid
 * interpretation when the phrasing states no explicit requirement sentence. */
function gradeBaseline(result: CompileResult, base: Level): Grade {
  const balcony = moduleByLabel(base, 'side balcony');
  const approach = moduleByLabel(base, 'vault approach');
  const entry = moduleByLabel(base, 'vault entry');
  const treasure = moduleByLabel(base, 'treasure landing');
  if (result.type !== 'patch' && result.type !== 'rule_proposal') {
    return fail(`expected patch or rule_proposal, got "${result.type}"`);
  }
  const applied = applyOperations(base, result.operations);
  if (!applied.ok) return fail(`operations rejected: ${applied.errors[0]}`);
  const key = applied.level.keys.find((k) => k.moduleId === balcony);
  if (!key) return fail('no key on the side balcony');
  // "The vault door" reads on either edge of the vault entry: the approach
  // entrance (fixture shape) or the treasure entrance — both are valid locks.
  const door = applied.level.doors.find(
    (d) => onEdge(d, approach, entry) || onEdge(d, entry, treasure),
  );
  if (!door) return fail('no keyed door on either vault edge');
  if (door.conditions?.requiresKey !== key.id) return fail('vault door does not require the placed key');
  const report = verify(applied.level);
  if (!report.accepted) {
    return fail(`checks: solution ${report.checks.solution.status}, requirements ${report.checks.requirements.status}, recovery ${report.checks.recovery.status}`);
  }
  if (result.type === 'rule_proposal' && result.newRequirements.some((r) => r.type === 'collectBeforeGoal' && r.keyId === key.id)) {
    return pass('key, keyed vault door, rule proposed; all green');
  }
  return pass(`key + keyed vault door as ${result.type} (no rule sentence in phrasing); all green`);
}

/** Trap (§8.2): sealing door + switch; recovery fails with the stranded witness. */
function gradeTrap(result: CompileResult, base: Level): Grade {
  // Geometry may ride either channel; the semantics are what matter.
  if (result.type !== 'patch' && result.type !== 'rule_proposal') return fail(`expected patch or rule_proposal, got "${result.type}"`);
  const applied = applyOperations(base, result.operations);
  if (!applied.ok) return fail(`operations rejected: ${applied.errors[0]}`);
  const report = verify(applied.level);
  if (report.checks.recovery.status !== 'fail') {
    return fail(`recovery ${report.checks.recovery.status} — the trap did not surface`);
  }
  if (report.checks.solution.status !== 'pass') return fail('solution check failed');
  // Structural check: some door closes after some switch.
  const switchIds = new Set(applied.level.switches.map((s) => s.id));
  const sealing = applied.level.doors.some((d) => {
    const s = d.conditions?.closesAfterSwitch;
    return s !== undefined && switchIds.has(s);
  });
  if (!sealing) return fail('recovery failed but no closesAfterSwitch door exists — wrong failure shape');
  return pass('trap surfaced: recovery fails with a sealing door');
}

/** Bypass (§8.3): new keyless route; requirements fail with the bypass witness. */
function gradeBypass(result: CompileResult, base: Level): Grade {
  if (result.type !== 'patch' && result.type !== 'rule_proposal') return fail(`expected patch or rule_proposal, got "${result.type}"`);
  const applied = applyOperations(base, result.operations);
  if (!applied.ok) return fail(`operations rejected: ${applied.errors[0]}`);
  const report = verify(applied.level);
  if (report.checks.requirements.status !== 'fail') {
    return fail(`requirements ${report.checks.requirements.status} — the bypass did not surface`);
  }
  if (report.checks.solution.status !== 'pass') return fail('solution check failed');
  return pass('bypass surfaced: keyless route fails the requirements check');
}

/** Simple edits: applies cleanly; specific verdicts where the semantics are clear. */
function gradeEdit(expected: {
  keyOnModule?: string;
  solutionFails?: boolean;
  requirementsFail?: boolean;
}): (result: CompileResult, base: Level) => Grade {
  return (result, base) => {
    if (result.type !== 'patch') return fail(`expected patch, got "${result.type}"`);
    const applied = applyOperations(base, result.operations);
    if (!applied.ok) return fail(`operations rejected: ${applied.errors[0]}`);
    const report = verify(applied.level);
    if (expected.keyOnModule) {
      const key = applied.level.keys.find((k) => k.moduleId === expected.keyOnModule);
      if (!key) return fail(`no key moved to ${expected.keyOnModule}`);
    }
    if (expected.solutionFails && report.checks.solution.status !== 'fail') {
      return fail(`solution ${report.checks.solution.status}, expected fail`);
    }
    if (expected.requirementsFail && report.checks.requirements.status !== 'fail') {
      return fail(`requirements ${report.checks.requirements.status}, expected fail`);
    }
    return pass(`applied; solution ${report.checks.solution.status}, requirements ${report.checks.requirements.status}, recovery ${report.checks.recovery.status}`);
  };
}

function gradeAmbiguity(result: CompileResult): Grade {
  if (result.type !== 'clarification') return fail(`expected clarification, got "${result.type}"`);
  if (result.choices.length < 2) return fail('fewer than two choices');
  return pass(`one question, ${result.choices.length} choices`);
}

function gradeUnsupported(result: CompileResult): Grade {
  if (result.type !== 'unsupported') return fail(`expected unsupported, got "${result.type}"`);
  if (result.alternatives.length < 1) return fail('no alternatives offered');
  return pass(`${result.alternatives.length} alternative(s) offered`);
}

function gradeRuleWeakening(result: CompileResult, base: Level): Grade {
  if (result.type !== 'rule_proposal') return fail(`expected rule_proposal, got "${result.type}"`);
  const stillRequired = result.newRequirements.some((r) => r.keyId === base.requirements[0]?.keyId);
  if (stillRequired) return fail('brass-key rule still present');
  return pass('rule removal rides the rule_proposal channel');
}

const FIXTURES: Fixture[] = [
  // Baseline class — the demo's first beat.
  { id: 'b1-canonical', category: 'baseline', prompt: 'Put the brass key on the key balcony, and make the vault door require it.', base: vaultEmptyLevel, grade: gradeBaseline },
  { id: 'b2-g1', category: 'baseline', prompt: 'Put a brass key on the side balcony. Lock the vault with it. The player must collect that key before reaching the treasure.', base: vaultEmptyLevel, grade: gradeBaseline },
  { id: 'b3', category: 'baseline', prompt: 'Add a brass key to the side balcony. The vault door should only open with it, and the player must have the key before reaching the treasure.', base: vaultEmptyLevel, grade: gradeBaseline },
  { id: 'b4', category: 'baseline', prompt: 'I want the brass key on the key balcony and the vault locked behind it.', base: vaultEmptyLevel, grade: gradeBaseline },
  { id: 'b5', category: 'baseline', prompt: 'Place a brass key on the balcony outside the gallery, and lock the vault door with it.', base: vaultEmptyLevel, grade: gradeBaseline },

  // Trap class — the signature moment. Weighted heaviest.
  { id: 't1-canonical', category: 'trap', prompt: 'Add a switch named seal-switch on the vault approach, and a door named gallery-door between the gallery and the bridge landing that closes permanently after the seal-switch activates.', base: baselineLevel, grade: gradeTrap },
  { id: 't2-g2', category: 'trap', prompt: 'Add a door between the upper foyer and the upper gallery, and a switch on the vault approach that seals that door once you step on it.', base: baselineLevel, grade: gradeTrap },
  { id: 't3', category: 'trap', prompt: 'Add a door between the gallery and the bridge landing, and a seal switch on the vault approach that closes that door permanently.', base: baselineLevel, grade: gradeTrap },
  { id: 't4', category: 'trap', prompt: 'Put a switch on the vault approach. Add a door on the north side of the gallery that seals shut forever once that switch is pressed.', base: baselineLevel, grade: gradeTrap },
  { id: 't5', category: 'trap', prompt: 'Trap idea: a player who rushes to the vault presses a switch on the vault approach, which slams the gallery door shut behind them permanently.', base: baselineLevel, grade: gradeTrap },
  { id: 't6', category: 'trap', prompt: 'Add a one-way trap: a switch on the vault approach permanently closes the door between the upper foyer and the upper gallery.', base: baselineLevel, grade: gradeTrap },
  { id: 't7', category: 'trap', prompt: 'There should be a door from the gallery to the bridge landing that stays open until someone steps on the switch at the vault approach — then it closes forever.', base: baselineLevel, grade: gradeTrap },

  // Compound one-shot class — the chip path.
  { id: 't8', category: 'trap', prompt: 'Give the vault a trap: a switch at the vault approach that permanently shuts the door between the gallery and the bridge landing.', base: baselineLevel, grade: gradeTrap },
  { id: 't9', category: 'trap', prompt: 'Add a switch to the vault approach, and make the door from the gallery to the bridge landing close permanently once that switch is triggered.', base: baselineLevel, grade: gradeTrap },
  { id: 't10', category: 'trap', prompt: 'The bridge landing entrance should have a door that locks forever when the switch on the vault approach gets pressed.', base: baselineLevel, grade: gradeTrap },
  { id: 't11', category: 'trap', prompt: 'Create a dead-end risk: a switch on the vault approach seals the gallery-to-bridge-landing door permanently after it is pressed.', base: baselineLevel, grade: gradeTrap },
  { id: 'c1-canonical', category: 'compound', prompt: 'Put the brass key on the key balcony and make the vault door require it. Then add a switch named seal-switch on the vault approach, and a door named gallery-door between the gallery and the bridge landing that closes permanently after the seal-switch activates.', base: vaultEmptyLevel, grade: gradeTrap },
  { id: 'c2', category: 'compound', prompt: 'Set up the vault puzzle: brass key on the key balcony, vault door locked by that key. Then add a seal switch on the vault approach and a gallery door between the gallery and the bridge landing that closes permanently when pressed.', base: vaultEmptyLevel, grade: gradeTrap },
  { id: 'c3', category: 'compound', prompt: 'Put the brass key on the balcony, lock the vault with it, and add a switch on the vault approach plus a door between the gallery and the bridge landing that the switch seals forever.', base: vaultEmptyLevel, grade: gradeTrap },
  { id: 'c4', category: 'compound', prompt: 'Add the brass key on the side balcony and lock the vault with it. Then put a switch on the approach to the vault, and a door between the gallery and the bridge landing that closes for good once the switch is pressed.', base: vaultEmptyLevel, grade: gradeTrap },

  // Bypass class — never live-tested before this battery.
  { id: 'x1-g3', category: 'bypass', prompt: 'Add a bridge from the upper gallery directly to the treasure landing.', base: baselineLevel, grade: gradeBypass },
  { id: 'x2', category: 'bypass', prompt: 'Connect the upper gallery straight to the treasure landing with a bridge.', base: baselineLevel, grade: gradeBypass },
  { id: 'x3', category: 'bypass', prompt: 'Build a bridge that links the bridge landing to the treasure landing so you can skip the vault.', base: baselineLevel, grade: gradeBypass },
  { id: 'x4', category: 'bypass', prompt: 'Add a bridge route from the upper gallery to the treasure landing, bypassing the vault door.', base: baselineLevel, grade: gradeBypass },
  { id: 'x5', category: 'bypass', prompt: 'Make a shortcut: a bridge from the upper gallery to the treasure landing.', base: baselineLevel, grade: gradeBypass },

  // Simple edits.
  { id: 'e1', category: 'edit', prompt: 'Remove the ramp.', base: baselineLevel, grade: gradeEdit({ solutionFails: true }) },
  { id: 'e2', category: 'edit', prompt: 'Move the brass key to the lower hall.', base: baselineLevel, grade: gradeEdit({ keyOnModule: 'lower-hall' }) },
  { id: 'e3', category: 'edit', prompt: 'Delete the vault door.', base: baselineLevel, grade: gradeEdit({ requirementsFail: true }) },

  // Ambiguity, unsupported, rule weakening.
  { id: 'a1', category: 'ambiguity', prompt: 'Move the key to a better spot.', base: baselineLevel, grade: gradeAmbiguity },
  { id: 'a2', category: 'ambiguity', prompt: 'Add a door near the treasure.', base: baselineLevel, grade: gradeAmbiguity },
  { id: 'u1', category: 'unsupported', prompt: 'Add a gap the player has to jump across.', base: baselineLevel, grade: gradeUnsupported },
  { id: 'u2', category: 'unsupported', prompt: 'Make the player pass through the vault door twice before reaching the treasure.', base: baselineLevel, grade: gradeUnsupported },
  { id: 'u3', category: 'unsupported', prompt: 'Add a timer: the player has 30 seconds to reach the treasure.', base: baselineLevel, grade: gradeUnsupported },
  { id: 'w1', category: 'rule_weakening', prompt: 'Remove the rule about collecting the brass key first — the key should just be an optional bonus. Keep everything else as is.', base: baselineLevel, grade: gradeRuleWeakening },
];

interface RunRecord {
  id: string;
  category: string;
  typeReturned: string | null;
  cached: boolean;
  attempts: number;
  costUsd: number;
  grade: { pass: boolean; note: string } | null;
  error: string | null;
}

async function runFixture(fixture: Fixture): Promise<RunRecord> {
  const response = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ level: fixture.base, prompt: fixture.prompt }),
  });
  const body: unknown = await response.json();
  if (!response.ok) {
    const note =
      body !== null && typeof body === 'object' && 'error' in body
        ? String(body.error)
        : `HTTP ${response.status}`;
    return { id: fixture.id, category: fixture.category, typeReturned: null, cached: false, attempts: 0, costUsd: 0, grade: null, error: note };
  }
  const parsed = compileOkResponseSchema.safeParse(body);
  if (!parsed.success) {
    return { id: fixture.id, category: fixture.category, typeReturned: null, cached: false, attempts: 0, costUsd: 0, grade: null, error: 'response failed validation' };
  }
  const { result, cached, attempts, totalCostUsd } = parsed.data;
  const grade = fixture.grade(result, fixture.base);
  return { id: fixture.id, category: fixture.category, typeReturned: result.type, cached, attempts: attempts.length, costUsd: totalCostUsd, grade, error: null };
}

async function main(): Promise<void> {
  const records: RunRecord[] = [];
  let totalCost = 0;
  for (const fixture of FIXTURES) {
    const record = await runFixture(fixture);
    records.push(record);
    totalCost += record.costUsd;
    const mark = record.error ? 'ERR ' : record.grade?.pass ? 'PASS' : 'FAIL';
    console.log(`${mark}  ${fixture.id.padEnd(14)} ${record.typeReturned ?? '—'}${record.cached ? ' (cached)' : ''} ${record.costUsd.toFixed(5)}$  ${record.grade?.note ?? record.error ?? ''}`);
    await new Promise((r) => setTimeout(r, 400));
  }

  console.log('\n=== per-class reliability ===');
  const byCategory = new Map<string, { pass: number; total: number }>();
  for (const r of records) {
    const entry = byCategory.get(r.category) ?? { pass: 0, total: 0 };
    entry.total += 1;
    if (r.grade?.pass) entry.pass += 1;
    byCategory.set(r.category, entry);
  }
  for (const [category, { pass, total }] of [...byCategory.entries()].sort()) {
    console.log(`${category.padEnd(16)} ${pass}/${total}`);
  }
  const passed = records.filter((r) => r.grade?.pass).length;
  console.log(`\ntotal: ${passed}/${records.length} passed · $${totalCost.toFixed(4)} spent`);
  writeFileSync('/tmp/reliability.json', JSON.stringify(records, null, 2));
  console.log('full records: /tmp/reliability.json');
}

await main();
