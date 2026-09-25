#!/usr/bin/env node
/**
 * Reliability battery (§10.1, raised eval allowance per DECISIONS.md): run a
 * fixed suite of prompt phrasings through the DEPLOYED /api/compile — the
 * exact path judges experience (prompt-4 rules, fence normalization, fallback
 * chain, cache) — and grade every outcome with the deterministic core. The
 * engine is the oracle: no human judgment in the loop.
 *
 * Cache hits are recorded as zero-cost requests. Live calls require explicit
 * opt-in and a post-response budget guard. Run only with authorization:
 * npx tsx scripts/reliability.ts --confirm-live-ai --budget-usd 0.10
 */
import { writeFileSync } from 'node:fs';
import type { CompileResult } from '../shared/compile-result';
import { compileOkResponseSchema } from '../shared/api';
import type { Level, Requirement } from '../shared/schema';
import { baselineLevel } from '../src/core/fixtures/baseline';
import { blankCanvasLevel } from '../src/core/fixtures/blank-canvas';
import { gauntletLevel, overpassLevel, twinKeysLevel } from '../src/core/fixtures/gallery';
import { vaultEmptyLevel } from '../src/core/fixtures/vault-empty';
import { applyOperations, applyRuleProposal, type ApplyResult } from '../src/core/level';
import { verify } from '../src/core/verifier';
import { LiveBudget, LiveEvaluationStop, requireLiveBudget } from './live-budget';

const API = 'https://levelproof.vercel.app/api/compile';

type Category =
  | 'scratch'
  | 'followup'
  | 'twist'
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

/** The canned twist prompt (§12 "Suggest a twist"); mirrors the UI chip. */
export const TWIST_PROMPT =
  'Suggest a twist for this puzzle: add one interesting mechanic — a seal-switch trap, a keyed gate, or a new keyed route — that fits the existing scene. Implement it as a single patch.';

const fail = (note: string): Grade => ({ pass: false, note });
const pass = (note: string): Grade => ({ pass: true, note });

type AppliedCompileResult = Extract<CompileResult, { type: 'patch' | 'rule_proposal' }>;

/** Apply the same atomic transaction the product uses for approval. */
function applyCompileResult(base: Level, result: AppliedCompileResult): ApplyResult {
  return result.type === 'rule_proposal' ? applyRuleProposal(base, result) : applyOperations(base, result.operations);
}

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
  const applied = applyCompileResult(base, result);
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
  const applied = applyCompileResult(base, result);
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
  const applied = applyCompileResult(base, result);
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
    const applied = applyCompileResult(base, result);
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

/** From-scratch build with semantic expectations: the patch must apply, be
 * accepted green, AND honor the prompt's specific asks (counts, templates,
 * elevations, gate relationships) — not merely produce some valid level. */
interface ScratchExpect {
  modules?: number; // total modules after the build
  keys?: number;
  switches?: number;
  doors?: number;
  bridges?: number; // at least this many bridge modules
  ramps?: number; // at least this many ramps
  elevations?: number[]; // these h values must appear among modules
  keyedDoorCount?: number; // doors with requiresKey/requiresKeys
  multiKeyDoor?: boolean; // at least one requiresKeys door
}

function gradeScratchExpect(expect: ScratchExpect): (result: CompileResult, base: Level) => Grade {
  return (result, base) => {
    if (result.type !== 'patch' && result.type !== 'rule_proposal') {
      return fail(`expected patch or rule_proposal, got "${result.type}"`);
    }
    const applied = applyCompileResult(base, result);
    if (!applied.ok) return fail(`operations rejected: ${applied.errors[0]}`);
    const level = applied.level;
    const requirements: Requirement[] = level.requirements;
    const report = verify(level);
    if (!report.valid) return fail(`invalid: ${report.invalidReasons[0]}`);
    if (report.checks.solution.status !== 'pass') return fail('solution failed — built puzzle is unsolvable');
    if (report.checks.recovery.status !== 'pass') return fail('recovery failed — build traps the player');
    if (requirements.length > 0 && report.checks.requirements.status === 'fail') return fail('requirements fail — the build bypasses its own rule');
    // Semantic assertions
    if (expect.modules !== undefined && level.modules.length > expect.modules) {
      return fail(`prompt asked for a compact layout; got ${level.modules.length} modules (expected at most ${expect.modules})`);
    }
    if (expect.keys !== undefined && level.keys.length < expect.keys) {
      return fail(`prompt asked for ${expect.keys} keys; got ${level.keys.length}`);
    }
    if (expect.switches !== undefined && level.switches.length < expect.switches) {
      return fail(`prompt asked for ${expect.switches} switches; got ${level.switches.length}`);
    }
    if (expect.doors !== undefined && level.doors.length < expect.doors) {
      return fail(`prompt asked for ${expect.doors} doors; got ${level.doors.length}`);
    }
    if (expect.bridges !== undefined && level.modules.filter((m) => m.template === 'bridge').length < expect.bridges) {
      return fail(`prompt asked for bridges; got ${level.modules.filter((m) => m.template === 'bridge').length}`);
    }
    if (expect.ramps !== undefined && level.modules.filter((m) => m.template === 'ramp').length < expect.ramps) {
      return fail(`prompt asked for ramps; got ${level.modules.filter((m) => m.template === 'ramp').length}`);
    }
    if (expect.elevations !== undefined) {
      const present = new Set(level.modules.map((m) => m.h));
      for (const h of expect.elevations) {
        if (!present.has(h)) return fail(`prompt asked for elevation ${h}; none of the modules use it`);
      }
    }
    const keyedDoors = level.doors.filter((d) => d.conditions?.requiresKey !== undefined || d.conditions?.requiresKeys !== undefined).length;
    if (expect.keyedDoorCount !== undefined && keyedDoors < expect.keyedDoorCount) {
      return fail(`prompt asked for gated doors; got ${keyedDoors}`);
    }
    if (expect.multiKeyDoor === true && !level.doors.some((d) => d.conditions?.requiresKeys !== undefined)) {
      return fail('prompt asked for a door needing both keys; no requiresKeys door');
    }
    const bits = [
      `modules=${level.modules.length}`,
      `keys=${level.keys.length}`,
      `doors=${level.doors.length}`,
      keyedDoors > 0 ? `keyedDoors=${keyedDoors}` : null,
      requirements.length > 0 ? `rules=${requirements.length}` : null,
    ].filter((b): b is string => b !== null);
    return pass(`accepted; ${bits.join(' ')}`);
  };
}


/** Twist: the patch lands and the engine judges it either way — a twist
 * that breaks recovery is the product working (red floors + witness). */
function gradeTwist(result: CompileResult, base: Level): Grade {
  if (result.type !== 'patch' && result.type !== 'rule_proposal') {
    return fail(`expected patch or rule_proposal, got "${result.type}"`);
  }
  const applied = applyCompileResult(base, result);
  if (!applied.ok) return fail(`operations rejected: ${applied.errors[0]}`);
  const report = verify(applied.level);
  const twistLanded =
    applied.level.modules.length !== base.modules.length ||
    applied.level.doors.length !== base.doors.length ||
    applied.level.keys.length !== base.keys.length ||
    applied.level.switches.length !== base.switches.length;
  if (!twistLanded) return fail('patch applied but changed nothing');
  if (report.checks.solution.status !== 'pass' && report.checks.recovery.status !== 'pass') {
    return fail('twist made the puzzle unsolvable outright (solution AND recovery fail)');
  }
  const verdict =
    report.accepted ? 'accepted green' : `breaks ${report.checks.recovery.status === 'fail' ? 'recovery (trap found)' : 'requirements (bypass found)'}`;
  return pass(`twist landed; engine verdict: ${verdict}`);
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
  const stillRequired = result.newRequirements.some((r) => r.type === 'collectBeforeGoal' && base.requirements[0]?.type === 'collectBeforeGoal' && r.keyId === base.requirements[0].keyId);
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

  // From-scratch generation: judge-voice phrasings — compound structures,
  // explicit counts, spatial relationships, varied vocabulary. Engine-graded:
  // applies, any proposed rule approved, accepted green.
  { id: 's2-two-floor', category: 'scratch', prompt: 'Make a two-floor maze: a lower corridor, a ramp up, and an upper bridge leading to the goal, with a silver key required at the bridge door.', base: blankCanvasLevel, grade: gradeScratchExpect({ ramps: 1, bridges: 1, keys: 1, elevations: [0, 1], keyedDoorCount: 1 }) },
  { id: 's4-heist', category: 'scratch', prompt: 'Design a small heist: two keys on opposite balconies and a vault door that needs one of them.', base: blankCanvasLevel, grade: gradeScratchExpect({ keys: 2, keyedDoorCount: 1 }) },
  { id: 's5-sky-bridge', category: 'scratch', prompt: 'Add a long sky bridge from the start to a distant treasure platform, with a keyed gate in the middle.', base: blankCanvasLevel, grade: gradeScratchExpect({ bridges: 2, keys: 1, keyedDoorCount: 1 }) },
  { id: 's6-over-under', category: 'scratch', prompt: 'Build something fun with a ramp, a bridge over it, and a key hidden underneath.', base: blankCanvasLevel, grade: gradeScratchExpect({ ramps: 1, bridges: 1, keys: 1 }) },
  { id: 'j1-courtyard', category: 'scratch', prompt: 'Build a courtyard with an elevated bridge, two key rooms, and a vault underneath.', base: blankCanvasLevel, grade: gradeScratchExpect({ bridges: 1, elevations: [0, 1], keys: 2 }) },
  { id: 'j2-twin-towers', category: 'scratch', prompt: 'Create twin towers connected by a high walkway, with a locked chamber at the top of one and the key at the top of the other.', base: blankCanvasLevel, grade: gradeScratchExpect({ bridges: 1, keys: 1, elevations: [1], keyedDoorCount: 1 }) },
  { id: 'j3-spiral', category: 'scratch', prompt: 'Make a winding tower: rooms that spiral upward with ramps, a key room halfway up, and the goal at the very top.', base: blankCanvasLevel, grade: gradeScratchExpect({ ramps: 1, keys: 1, elevations: [1] }) },
  { id: 'j4-island-hop', category: 'scratch', prompt: 'Build a chain of four small islands connected by bridges, where the far island holds the treasure and one bridge needs a key.', base: blankCanvasLevel, grade: gradeScratchExpect({ bridges: 3, keys: 1, keyedDoorCount: 1, modules: 8 }) },
  { id: 'j5-safe-room', category: 'scratch', prompt: 'Design a puzzle where the treasure is in a safe room behind two doors in a row, each needing a different key.', base: blankCanvasLevel, grade: gradeScratchExpect({ doors: 2, keys: 2, keyedDoorCount: 2 }) },
  { id: 'j6-moat', category: 'scratch', prompt: 'Make a castle keep with an outer wall entrance, a courtyard, and the keep itself reached by a bridge over a lower passage, with the key in the courtyard.', base: blankCanvasLevel, grade: gradeScratchExpect({ bridges: 1, keys: 1, elevations: [0, 1] }) },
  { id: 'j7-workshop', category: 'scratch', prompt: 'Build a mechanic workshop: a lower storage area with a key, a ramp up to the workshop floor, and a locked parts cabinet as the goal.', base: blankCanvasLevel, grade: gradeScratchExpect({ ramps: 1, keys: 1, elevations: [0, 1], keyedDoorCount: 1 }) },
  { id: 'j8-lighthouse', category: 'scratch', prompt: 'Create a lighthouse: a spiral of small rooms climbing to a lamp room at the top, with the lamp room locked and the key in the base.', base: blankCanvasLevel, grade: gradeScratchExpect({ ramps: 1, keys: 1, keyedDoorCount: 1 }) },
  { id: 'j9-zigzag', category: 'scratch', prompt: 'Make a zigzag descent: start high, cross a bridge, take a ramp down, then another ramp back up to the treasure room.', base: blankCanvasLevel, grade: gradeScratchExpect({ bridges: 1, ramps: 2, elevations: [0, 1] }) },
  { id: 'j10-observatory', category: 'scratch', prompt: 'Build an observatory with a ground-level entrance hall, an elevated viewing gallery reached by a ramp, and the telescope room locked behind a brass key found on the gallery.', base: blankCanvasLevel, grade: gradeScratchExpect({ ramps: 1, keys: 1, elevations: [0, 1], keyedDoorCount: 1 }) },
  { id: 'j11-bridge-gate', category: 'scratch', prompt: 'Two platforms at different heights connected by a ramp and a bridge, with a gate at the bridge that needs a key kept on the lower platform.', base: blankCanvasLevel, grade: gradeScratchExpect({ bridges: 1, ramps: 1, keys: 1, elevations: [0, 1], keyedDoorCount: 1 }) },
  { id: 'j12-vault-below', category: 'scratch', prompt: 'Put a small vault below a raised walkway: the walkway crosses over the vault entrance, and the vault key sits at the walkway end.', base: blankCanvasLevel, grade: gradeScratchExpect({ bridges: 1, keys: 1, elevations: [0, 1] }) },

  // Suggest-a-twist: the canned twist prompt against completed gallery
  // levels. Pass = a twist lands (patch applies) and the engine judges it —
  // a twist that breaks recovery is still a PASS if the failure is real and
  // the witness exists (that is the product's whole point).
  { id: 'tw1-gauntlet', category: 'twist', prompt: TWIST_PROMPT, base: gauntletLevel, grade: gradeTwist },
  { id: 'tw2-twin', category: 'twist', prompt: TWIST_PROMPT, base: twinKeysLevel, grade: gradeTwist },
  { id: 'tw3-overpass', category: 'twist', prompt: TWIST_PROMPT, base: overpassLevel, grade: gradeTwist },
];

interface RunRecord {
  id: string;
  category: string;
  typeReturned: string | null;
  cached: boolean;
  attempts: number;
  costUsd: number | null;
  grade: { pass: boolean; note: string } | null;
  error: string | null;
  latencyMs: number;
}

function addCost(total: number | null, next: number | null): number | null {
  return total === null || next === null ? null : total + next;
}

function formatCost(cost: number | null): string {
  return cost === null ? 'cost unavailable' : `$${cost.toFixed(5)}`;
}

function responseCost(body: unknown): number | null {
  if (body === null || typeof body !== 'object' || !('totalCostUsd' in body)) return null;
  const value = body.totalCostUsd;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function responseAttempts(body: unknown): number {
  return body !== null && typeof body === 'object' && 'attempts' in body && Array.isArray(body.attempts)
    ? body.attempts.length
    : 0;
}

function responseWasCached(body: unknown): boolean {
  return body !== null && typeof body === 'object' && 'cached' in body && body.cached === true;
}

async function readBudgetedBody(response: Response, budget: LiveBudget, label: string): Promise<unknown> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new LiveEvaluationStop(`Stopping after ${label}: response body or billing metadata was unreadable.`);
  }
  budget.record(responseCost(body), label);
  return body;
}

async function runFixture(fixture: Fixture, budget: LiveBudget): Promise<RunRecord> {
  const started = performance.now();
  budget.ensureCanCall(fixture.id);
  const response = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ level: fixture.base, prompt: fixture.prompt }),
  });
  const body: unknown = await readBudgetedBody(response, budget, fixture.id);
  if (!response.ok) {
    // Error bodies still carry attempts and cost — record them honestly;
    // hiding them made provider failures and schema failures look identical.
    const attempts = responseAttempts(body);
    const costUsd = responseCost(body);
    const note =
      body !== null && typeof body === 'object' && 'error' in body
        ? String(body.error)
        : `HTTP ${response.status}`;
    return { id: fixture.id, category: fixture.category, typeReturned: null, cached: false, attempts, costUsd, grade: null, error: note, latencyMs: performance.now() - started };
  }
  const parsed = compileOkResponseSchema.safeParse(body);
  if (!parsed.success) {
    return { id: fixture.id, category: fixture.category, typeReturned: null, cached: false, attempts: 0, costUsd: null, grade: null, error: 'response failed validation', latencyMs: performance.now() - started };
  }
  const { result, cached, attempts, totalCostUsd } = parsed.data;
  const grade = fixture.grade(result, fixture.base);
  return { id: fixture.id, category: fixture.category, typeReturned: result.type, cached, attempts: attempts.length, costUsd: totalCostUsd, grade, error: null, latencyMs: performance.now() - started };
}

/** Multi-turn conversation fixtures (§12): turn 1 builds, turn 2 refers
 * back with anaphora. The follow-up is graded on the FINAL level after both
 * turns, against the follow-up's own expectation. */
interface FollowupFixture {
  id: string;
  first: string;
  followup: string;
  base: Level;
  expect: ScratchExpect;
}

const FOLLOWUPS: FollowupFixture[] = [
  {
    id: 'f1-raise-bridge',
    first: 'Build a small fort: a ramp up to a wall walk and a gate room at the top.',
    followup: 'Now raise the wall walk one level higher.',
    base: blankCanvasLevel,
    expect: { ramps: 1, elevations: [0, 2] },
  },
  {
    id: 'f2-move-key',
    first: 'Make a puzzle with a key room and a locked vault.',
    followup: 'Move the key somewhere farther from the vault.',
    base: blankCanvasLevel,
    expect: { keys: 1, keyedDoorCount: 1 },
  },
  {
    id: 'f3-second-key',
    first: 'Build a treasury with one silver key and a locked door.',
    followup: 'Add a gold key too, and make the door need both.',
    base: blankCanvasLevel,
    expect: { keys: 2, multiKeyDoor: true },
  },
  {
    id: 'f4-keep-courtyard',
    first: 'Build a courtyard with a fountain room and a gate.',
    followup: 'Keep the courtyard, but make reaching the gate harder.',
    base: blankCanvasLevel,
    expect: { doors: 1 },
  },
  {
    id: 'f5-rename-theme',
    first: 'Build a small watchtower with a lamp room.',
    followup: 'Give the lamp room a better name.',
    base: blankCanvasLevel,
    expect: {},
  },
];

async function runFollowup(fixture: FollowupFixture, budget: LiveBudget): Promise<RunRecord> {
  const started = performance.now();
  // Turn 1
  budget.ensureCanCall(`${fixture.id} turn 1`);
  const firstResponse = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ level: fixture.base, prompt: fixture.first }),
  });
  const firstBody: unknown = await readBudgetedBody(firstResponse, budget, `${fixture.id} turn 1`);
  let level1: Level | null = null;
  let cost: number | null = responseCost(firstBody);
  let cached = responseWasCached(firstBody);
  let attempts = responseAttempts(firstBody);
  if (firstResponse.ok) {
    const parsed = compileOkResponseSchema.safeParse(firstBody);
    if (parsed.success) {
      cost = parsed.data.totalCostUsd;
      cached = parsed.data.cached;
      attempts = parsed.data.attempts.length;
      const { result } = parsed.data;
      if (result.type === 'patch' || result.type === 'rule_proposal') {
        const applied = applyCompileResult(fixture.base, result);
        if (applied.ok) {
          level1 = applied.level;
        }
      }
    }
  }
  if (level1 === null) {
    return { id: fixture.id, category: 'followup', typeReturned: null, cached, attempts, costUsd: cost, grade: { pass: false, note: 'turn 1 failed' }, error: 'turn1', latencyMs: performance.now() - started };
  }
  // Turn 2 with history
  budget.ensureCanCall(`${fixture.id} turn 2`);
  const secondResponse = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ level: level1, prompt: fixture.followup, history: [{ prompt: fixture.first }] }),
  });
  const secondBody: unknown = await readBudgetedBody(secondResponse, budget, `${fixture.id} turn 2`);
  cost = addCost(cost, responseCost(secondBody));
  cached ||= responseWasCached(secondBody);
  attempts += responseAttempts(secondBody);
  if (!secondResponse.ok) {
    const note =
      secondBody !== null && typeof secondBody === 'object' && 'error' in secondBody ? String(secondBody.error) : `HTTP ${secondResponse.status}`;
    return { id: fixture.id, category: 'followup', typeReturned: null, cached, attempts, costUsd: cost, grade: null, error: note, latencyMs: performance.now() - started };
  }
  const parsed2 = compileOkResponseSchema.safeParse(secondBody);
  if (!parsed2.success) {
    return { id: fixture.id, category: 'followup', typeReturned: null, cached, attempts, costUsd: cost, grade: null, error: 'response failed validation', latencyMs: performance.now() - started };
  }
  const { result: result2 } = parsed2.data;
  if (result2.type !== 'patch' && result2.type !== 'rule_proposal') {
    return { id: fixture.id, category: 'followup', typeReturned: result2.type, cached, attempts, costUsd: cost, grade: { pass: false, note: `follow-up returned "${result2.type}"` }, error: null, latencyMs: performance.now() - started };
  }
  const applied2 = applyCompileResult(level1, result2);
  if (!applied2.ok) {
    return { id: fixture.id, category: 'followup', typeReturned: result2.type, cached, attempts, costUsd: cost, grade: { pass: false, note: `follow-up rejected: ${applied2.errors[0]}` }, error: null, latencyMs: performance.now() - started };
  }
  const finalLevel = applied2.level;
  const grade = gradeScratchExpect(fixture.expect)(result2, level1);
  // Re-verify the FINAL level end-state for greenness
  const report = verify(finalLevel);
  const note = report.accepted ? grade.note : `final level not accepted: sol=${report.checks.solution.status} req=${report.checks.requirements.status} rec=${report.checks.recovery.status}`;
  return {
    id: fixture.id,
    category: 'followup',
    typeReturned: result2.type,
    cached,
    attempts,
    costUsd: cost,
    grade: { pass: grade.pass && report.accepted, note: grade.pass ? note : grade.note },
    error: null,
    latencyMs: performance.now() - started,
  };
}

async function main(): Promise<void> {
  const liveBudgetUsd = requireLiveBudget(
    process.argv.slice(2),
    'Usage: npx tsx scripts/reliability.ts --confirm-live-ai --budget-usd 0.10 (optional ONLY=scratch).',
  );
  const budget = new LiveBudget(liveBudgetUsd);
  const only = process.env.ONLY;
  const validCategories = new Set([...new Set(FIXTURES.map((fixture) => fixture.category)), 'followup']);
  if (only !== undefined && !validCategories.has(only as Category | 'followup')) {
    throw new LiveEvaluationStop(`Unknown ONLY category: ${only}`);
  }
  const records: RunRecord[] = [];
  const fixtures = only !== undefined ? FIXTURES.filter((f) => f.category === only) : FIXTURES;
  const followupMode = only === 'followup';
  const expectedCount = followupMode ? FOLLOWUPS.length : fixtures.length;
  let stopReason: string | null = null;

  try {
    if (followupMode) {
      for (const fixture of FOLLOWUPS) {
        const record = await runFollowup(fixture, budget);
        records.push(record);
        const mark = record.error ? 'ERR ' : record.grade?.pass ? 'PASS' : 'FAIL';
        console.log(`${mark}  ${fixture.id.padEnd(20)} ${record.typeReturned ?? '—'} ${record.latencyMs.toFixed(0)} ms ${formatCost(record.costUsd)}  ${record.grade?.note ?? record.error ?? ''}`);
        if (record.error !== null) throw new LiveEvaluationStop(`Stopping after ${fixture.id}: ${record.error}`);
        await new Promise((r) => setTimeout(r, 2500));
      }
    } else {
      for (const fixture of fixtures) {
        const record = await runFixture(fixture, budget);
        records.push(record);
        const mark = record.error ? 'ERR ' : record.grade?.pass ? 'PASS' : 'FAIL';
        console.log(`${mark}  ${fixture.id.padEnd(14)} ${record.typeReturned ?? '—'}${record.cached ? ' (cached)' : ''} ${record.latencyMs.toFixed(0)} ms ${formatCost(record.costUsd)}  ${record.grade?.note ?? record.error ?? ''}`);
        if (record.error !== null) throw new LiveEvaluationStop(`Stopping after ${fixture.id}: ${record.error}`);
        await new Promise((r) => setTimeout(r, 2500));
      }
    }
  } catch (error) {
    stopReason = error instanceof Error ? error.message : String(error);
  }

  if (!followupMode) console.log('\n=== per-class reliability ===');
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
  console.log(`\ntotal: ${passed}/${records.length} passed · known billed/estimated $${budget.spentUsd.toFixed(5)} / $${liveBudgetUsd.toFixed(5)}`);
  if (stopReason !== null) console.error(`Stopped with incomplete evidence: ${stopReason}`);
  const report = {
    generatedAt: new Date().toISOString(),
    endpoint: API,
    cacheAware: true,
    repeats: 1,
    budgetUsd: liveBudgetUsd,
    knownTotalCostUsd: budget.spentUsd,
    complete: stopReason === null && records.length === expectedCount,
    stopReason,
    total: records.length,
    passed,
    costUsd: records.some((record) => record.costUsd === null) ? null : records.reduce((sum, record) => sum + record.costUsd!, 0),
    byCategory: Object.fromEntries([...byCategory.entries()].sort()),
    records,
  };
  writeFileSync('/tmp/reliability.json', JSON.stringify(report, null, 2));
  console.log('full records: /tmp/reliability.json');
  if (stopReason !== null || records.length !== expectedCount) process.exitCode = 2;
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
