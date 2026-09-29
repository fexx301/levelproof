import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Level } from '../shared/schema';
import { measureChapter } from '../src/core/adventure';
import { baselineLevel } from '../src/core/fixtures/baseline';
import { blankCanvasLevel } from '../src/core/fixtures/blank-canvas';
import { bypassLevel } from '../src/core/fixtures/bypass';
import { gauntletLevel, overpassLevel, twinKeysLevel } from '../src/core/fixtures/gallery';
import { trapRepairedLevel } from '../src/core/fixtures/trap-repaired';
import { trapLevel } from '../src/core/fixtures/trap';
import { unfamiliarLevel } from '../src/core/fixtures/unfamiliar';
import { vaultEmptyLevel } from '../src/core/fixtures/vault-empty';
import { goalReachableStates, nextStep } from '../src/core/hint';
import { initialState, transitions, type GameState, type MoveRecord } from '../src/core/movement';
import { revisionId } from '../src/core/serialize';
import { compileLevel } from '../src/core/topology';
import { verify, type Report } from '../src/core/verifier';

/**
 * Engine lock (§6/§7): everything the engine says about every fixture —
 * verdicts, explanations, witness routes with their geometry, recovery maps,
 * revision ids, hints, reachability, chapter measures — must stay exactly as
 * recorded before turn-based hazards were added. Levels without hazards run
 * on a cycle of one, so the added `phase` is always 0 and is left out of the
 * projection. Regenerate only for an intentional engine change:
 *   UPDATE_ENGINE_LOCK=1 npx vitest run tests/engine-lock.test.ts
 */

const GOLDEN = 'tests/golden/engine-lock.json';

const LEVELS: Record<string, Level> = {
  baseline: baselineLevel,
  blankCanvas: blankCanvasLevel,
  bypass: bypassLevel,
  gauntlet: gauntletLevel,
  overpass: overpassLevel,
  twinKeys: twinKeysLevel,
  trapRepaired: trapRepairedLevel,
  trap: trapLevel,
  unfamiliar: unfamiliarLevel,
  vaultEmpty: vaultEmptyLevel,
  baselinePassThrough: { ...baselineLevel, requirements: [{ type: 'passThrough', moduleId: 'gallery' }] },
  trapSwitchRule: { ...trapLevel, requirements: [{ type: 'switchNecessary', switchId: 'seal-switch' }] },
};

function state(value: GameState): unknown {
  return { moduleId: value.moduleId, keyMask: value.keyMask, switchMask: value.switchMask };
}

function move(value: MoveRecord): unknown {
  return {
    action: value.action,
    before: state(value.before),
    after: state(value.after),
    source: value.source,
    destination: value.destination,
    doorId: value.doorId ?? null,
    events: value.events,
    segments: value.segments.map((point) => [point.x, point.y, point.z].map((n) => Math.round(n * 1000) / 1000)),
  };
}

function report(value: Report): unknown {
  const checks = Object.fromEntries(
    Object.entries(value.checks).map(([name, check]) => [
      name,
      {
        status: check.status,
        explanation: check.explanation,
        witness: check.witness === undefined
          ? null
          : {
              kind: check.witness.kind,
              route: check.witness.route.map(move),
              endState: state(check.witness.endState),
              missingKeys: check.witness.missingKeys ?? null,
              requirement: check.witness.requirement ?? null,
              violationText: check.witness.violationText ?? null,
            },
      },
    ]),
  );
  return {
    valid: value.valid,
    invalidReasons: value.invalidReasons,
    revisionId: value.revisionId,
    complete: value.complete,
    completionExplanation: value.completionExplanation,
    exploredCount: value.exploredCount,
    accepted: value.accepted,
    recoveryMap: value.recoveryMap ?? null,
    checks,
  };
}

function snapshot(): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(LEVELS).map(([name, level]) => {
      const compiled = compileLevel(level);
      const start = initialState(compiled);
      const hint = nextStep(compiled, start, new Set([start.moduleId]));
      const measure = measureChapter(level);
      return [
        name,
        {
          revision: revisionId(level),
          report: report(verify(level)),
          openingMoves: transitions(compiled, start).map(move),
          hint: hint.kind === 'move' || hint.kind === 'rule_blocked' ? { kind: hint.kind, move: move(hint.move), movesToGoal: hint.movesToGoal } : { kind: hint.kind },
          canWin: [...goalReachableStates(compiled, start)].map((key) => key.split('|').slice(0, 3).join('|')).sort(),
          chapter: { accepted: measure.accepted, shortest: measure.shortest, gatesOnRoute: measure.gatesOnRoute, exploredStates: measure.exploredStates },
        },
      ];
    }),
  );
}

describe('engine lock (hazard-free levels behave exactly as before)', () => {
  it('matches the recorded engine output for every fixture', () => {
    const current = snapshot();
    if (process.env.UPDATE_ENGINE_LOCK === '1' || !existsSync(GOLDEN)) {
      mkdirSync('tests/golden', { recursive: true });
      writeFileSync(GOLDEN, `${JSON.stringify(current, null, 1)}\n`);
    }
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(current).sort()).toEqual(Object.keys(golden).sort());
    for (const name of Object.keys(golden)) {
      expect(current[name], name).toEqual(golden[name]);
    }
  });
});
