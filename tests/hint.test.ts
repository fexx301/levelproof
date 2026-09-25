import { describe, expect, it } from 'vitest';
import type { Level } from '../shared/schema';
import { nextStep } from '../src/core/hint';
import { goalRequirementViolated, initialState, step } from '../src/core/movement';
import { compileLevel } from '../src/core/topology';
import { verify } from '../src/core/verifier';
import { baselineLevel } from '../src/core/fixtures/baseline';
import { gauntletLevel, overpassLevel, twinKeysLevel } from '../src/core/fixtures/gallery';
import { trapLevel } from '../src/core/fixtures/trap';
import { trapRepairedLevel } from '../src/core/fixtures/trap-repaired';
import { unfamiliarLevel } from '../src/core/fixtures/unfamiliar';

/** Follow hints from spawn; returns the moves taken, or the first non-move hint. */
function followHints(level: Level) {
  const compiled = compileLevel(level);
  let state = initialState(compiled);
  const visited = new Set([state.moduleId]);
  const first = nextStep(compiled, state, visited);
  let moves = 0;
  for (let guard = 0; guard < 200; guard++) {
    const hint = nextStep(compiled, state, visited);
    if (hint.kind !== 'move') return { first, final: hint, moves, violated: goalRequirementViolated(compiled, state, visited) };
    expect(hint.movesToGoal).toBeGreaterThan(0);
    const move = step(compiled, state, hint.move.action);
    expect(move).not.toBeNull();
    state = move!.after;
    visited.add(state.moduleId);
    moves++;
  }
  throw new Error('hints did not converge');
}

describe('play hints', () => {
  const winnable: Array<[string, Level]> = [
    ['baseline', baselineLevel],
    ['twin keys', twinKeysLevel],
    ['overpass', overpassLevel],
    ['gauntlet', gauntletLevel],
    ['trap repaired', trapRepairedLevel],
    ['unfamiliar', unfamiliarLevel],
  ];

  it.each(winnable)('%s: following hints wins in exactly the promised moves, keeping every rule', (_name, level) => {
    expect(verify(level).checks.solution.status).toBe('pass');
    const run = followHints(level);
    expect(run.first.kind).toBe('move');
    expect(run.final.kind).toBe('at_goal');
    expect(run.violated).toBe(false);
    expect(run.moves).toBe(run.first.kind === 'move' ? run.first.movesToGoal : -1);
    // Shortest: no shorter than the verifier's own (BFS) solution witness.
    expect(run.moves).toBeLessThanOrEqual(verify(level).checks.solution.witness!.route.length);
  });

  it('honours passThrough rules the plain state cannot see', () => {
    const compiled = compileLevel(baselineLevel);
    let routed = 0;
    for (const module of compiled.level.modules) {
      if (module.id === compiled.goal) continue;
      const level: Level = { ...structuredClone(baselineLevel), requirements: [{ type: 'passThrough', moduleId: module.id }] };
      const run = followHints(level);
      if (run.first.kind !== 'move') {
        expect(run.first.kind).toBe('stranded');
        continue;
      }
      routed++;
      expect(run.final.kind).toBe('at_goal');
      expect(run.violated).toBe(false);
    }
    expect(routed).toBeGreaterThan(3);
  });

  it('calls the trap dead end stranded while moves remain', () => {
    const report = verify(trapLevel);
    const dead = report.checks.recovery.witness!.endState;
    const compiled = compileLevel(trapLevel);
    const route = report.checks.recovery.witness!.route;
    const visited = new Set([compiled.spawn, ...route.map((move) => move.after.moduleId)]);
    expect(nextStep(compiled, dead, visited).kind).toBe('stranded');
    // …and from spawn the same level still has a winning line.
    expect(nextStep(compiled, initialState(compiled), new Set([compiled.spawn])).kind).toBe('move');
  });
});
