import { describe, expect, it } from 'vitest';
import type { Level, LevelModule } from '../shared/schema';
import { caughtBy, hasHazards, patrolPeriod, patrolPosition, worldCycle } from '../src/core/hazards';
import { goalReachableStates, nextStep } from '../src/core/hint';
import { applyOperations, validateLevel } from '../src/core/level';
import { initialState, stateKey, step, transitions } from '../src/core/movement';
import { validateRoute } from '../src/core/replay';
import { compileLevel } from '../src/core/topology';
import { verify } from '../src/core/verifier';
import { baselineLevel } from '../src/core/fixtures/baseline';
import { sentryLevel } from '../src/core/fixtures/gallery';

/** Turn-based hazards (§6.4): timed doors and guards on a turn clock. */

const flat = (id: string, x: number, z: number, ports: LevelModule['ports']): LevelModule => ({ id, template: 'flat', x, z, h: 0, ports });

/** A — B — C — D — E, with an alcove X north of C. */
function corridor(extra: Partial<Level> = {}): Level {
  return {
    modules: [
      flat('hall-a', 1, 5, ['E']),
      flat('hall-b', 2, 5, ['E', 'W']),
      flat('hall-c', 3, 5, ['E', 'W', 'N']),
      flat('hall-d', 4, 5, ['E', 'W']),
      flat('hall-e', 5, 5, ['W']),
      flat('alcove', 3, 4, ['S']),
    ],
    keys: [],
    switches: [],
    spawn: 'hall-a',
    goal: 'hall-e',
    doors: [],
    requirements: [],
    ...extra,
  };
}

describe('hazard schedules', () => {
  it('walks a guard back and forth, one room per turn', () => {
    const guard = { id: 'sentry', route: ['r1', 'r2', 'r3'] };
    expect(patrolPeriod(guard)).toBe(4);
    expect([0, 1, 2, 3, 4, 5, 6].map((turn) => patrolPosition(guard, turn))).toEqual(['r1', 'r2', 'r3', 'r2', 'r1', 'r2', 'r3']);
    expect(patrolPeriod({ route: ['a', 'b'] })).toBe(2);
    expect(patrolPeriod({ route: ['a', 'b', 'c', 'd'] })).toBe(6);
  });

  it('combines periods into one world cycle', () => {
    const level = corridor({
      doors: [{ id: 'gate', a: 'hall-d', b: 'hall-e', conditions: { cycle: { period: 4, openTicks: 2 } } }],
      patrols: [{ id: 'sentry', route: ['hall-b', 'hall-c', 'hall-d', 'alcove'].slice(0, 2) }],
    });
    expect(worldCycle(level)).toBe(4); // lcm(4, 2)
    expect(hasHazards(level)).toBe(true);
    expect(hasHazards(baselineLevel)).toBe(false);
    expect(worldCycle(baselineLevel)).toBe(1);
  });

  it('catches on arrival and on trading places, never otherwise', () => {
    const guard = [{ id: 'sentry', route: ['c', 'x'] }]; // c on even turns, x on odd
    expect(caughtBy(guard, 1, 'b', 'c')).toBe('sentry'); // arrives where the guard steps
    expect(caughtBy(guard, 0, 'b', 'c')).toBeNull(); // follows the guard out
    expect(caughtBy(guard, 0, 'x', 'c')).toBe('sentry'); // trades places
    expect(caughtBy(guard, 1, 'c', 'c')).toBe('sentry'); // waits where the guard steps
  });
});

describe('timed doors', () => {
  const level = corridor({ doors: [{ id: 'drawbridge', a: 'hall-d', b: 'hall-e', conditions: { cycle: { period: 2, openTicks: 1 } } }] });

  it('offers Wait only in levels with hazards', () => {
    const compiled = compileLevel(level);
    expect(transitions(compiled, initialState(compiled)).map((move) => move.action)).toEqual(['E', 'wait']);
    const plain = compileLevel(baselineLevel);
    expect(transitions(plain, initialState(plain)).some((move) => move.action === 'wait')).toBe(false);
  });

  it('is judged on the turn the move starts; the shortest win waits for it', () => {
    expect(validateLevel(level)).toEqual([]);
    const report = verify(level);
    expect(report.checks.solution.status).toBe('pass');
    expect(report.checks.recovery.status).toBe('pass');
    const route = report.checks.solution.witness!.route;
    // A→B (turn 1), B→C (turn 2), C→D (turn 3: the bridge is closed on odd turns), wait, D→E.
    expect(route.map((move) => move.action)).toEqual(['E', 'E', 'E', 'wait', 'E']);
    expect(validateRoute(level, route).ok).toBe(true);
  });
});

describe('guards', () => {
  // The sentry steps between the corridor (hall-c, even turns) and the alcove (odd).
  const level = corridor({ patrols: [{ id: 'sentry', route: ['hall-c', 'alcove'] }] });

  it('restarts the level on capture — no dead ends, no shortcuts', () => {
    expect(validateLevel(level)).toEqual([]);
    const compiled = compileLevel(level);
    const atB = step(compiled, initialState(compiled), 'E')!.after; // turn 1
    const intoGuard = step(compiled, atB, 'E')!;
    expect(intoGuard.events.caught).toBe('sentry');
    expect(intoGuard.after).toEqual(initialState(compiled));
    const report = verify(level);
    expect(report.accepted).toBe(true);
    expect(report.checks.recovery.status).toBe('pass');
    // Wait at B for the guard to step out, then follow it through.
    expect(report.checks.solution.witness!.route.map((move) => move.action)).toEqual(['E', 'wait', 'E', 'E', 'E']);
  });

  it('never advises walking into a guard while waiting wins', () => {
    const compiled = compileLevel(level);
    const atB = step(compiled, initialState(compiled), 'E')!.after;
    const hint = nextStep(compiled, atB, new Set(['hall-a', 'hall-b']));
    expect(hint.kind).toBe('move');
    expect(hint.kind === 'move' ? hint.move.action : null).toBe('wait');
  });

  it('a guard in a one-wide corridor cannot be passed — the engine says so', () => {
    const blocked = corridor({ patrols: [{ id: 'sentry', route: ['hall-c', 'hall-d'] }] });
    expect(verify(blocked).checks.solution.status).toBe('fail');
  });

  it('is added and removed by operations', () => {
    const added = applyOperations(corridor(), [{ kind: 'addPatrol', patrol: { id: 'sentry', route: ['hall-c', 'alcove'] } }]);
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(added.level.patrols).toHaveLength(1);
    const removed = applyOperations(added.level, [{ kind: 'removePatrol', id: 'sentry' }]);
    expect(removed.ok && removed.level.patrols).toBeUndefined();
  });
});

describe('hazard validation', () => {
  const errorsFor = (patch: Partial<Level>): string => validateLevel(corridor(patch)).join(' ');
  it('rejects guards on the spawn or goal, repeated rooms, gaps, and unknown rooms', () => {
    expect(errorsFor({ patrols: [{ id: 'sentry', route: ['hall-a', 'hall-b'] }] })).toMatch(/may not patrol the spawn/);
    expect(errorsFor({ patrols: [{ id: 'sentry', route: ['hall-d', 'hall-e'] }] })).toMatch(/may not patrol the goal/);
    expect(errorsFor({ patrols: [{ id: 'sentry', route: ['hall-b', 'hall-c', 'hall-b'] }] })).toMatch(/visits a room twice/);
    expect(errorsFor({ patrols: [{ id: 'sentry', route: ['hall-b', 'hall-d'] }] })).toMatch(/not connected/);
    expect(errorsFor({ patrols: [{ id: 'sentry', route: ['hall-b', 'nowhere'] }] })).toMatch(/unknown module "nowhere"/);
    expect(errorsFor({ patrols: [{ id: 'hall-b', route: ['hall-b', 'hall-c'] }] })).toMatch(/used by both a module and a guard/);
  });

  it('keeps every hazard level inside the exhaustive exploration bound', () => {
    // 64 rooms × 8 key sets × 16 switch sets × a 12-turn cycle is too many.
    const modules: LevelModule[] = Array.from({ length: 64 }, (_, i) =>
      flat(`room-${i}`, i % 16, Math.floor(i / 16), [
        ...(i % 16 > 0 ? (['W'] as const) : []),
        ...(i % 16 < 15 ? (['E'] as const) : []),
      ]),
    );
    const level: Level = {
      modules,
      keys: [{ id: 'key-a', moduleId: 'room-3' }, { id: 'key-b', moduleId: 'room-5' }, { id: 'key-c', moduleId: 'room-7' }],
      switches: [{ id: 'plate-a', moduleId: 'room-9' }, { id: 'plate-b', moduleId: 'room-10' }, { id: 'plate-c', moduleId: 'room-11' }, { id: 'plate-d', moduleId: 'room-12' }],
      spawn: 'room-0',
      goal: 'room-15',
      doors: [
        { id: 'gate-a', a: 'room-1', b: 'room-2', conditions: { cycle: { period: 4, openTicks: 2 } } },
        { id: 'gate-b', a: 'room-13', b: 'room-14', conditions: { cycle: { period: 3, openTicks: 1 } } },
      ],
      requirements: [],
    };
    expect(validateLevel(level).join(' ')).toMatch(/could reach 98304 situations, over the checker's 32768/);
  });
});

describe('The Sentry (hazard showcase)', () => {
  it('is accepted; its shortest win times the sentry and the drawbridge', () => {
    expect(validateLevel(sentryLevel)).toEqual([]);
    const compiled = compileLevel(sentryLevel);
    expect(compiled.cycle).toBe(4); // lcm(sentry 2, drawbridge 4)
    const report = verify(sentryLevel);
    expect(report.accepted).toBe(true);
    const route = report.checks.solution.witness!.route;
    expect(route.some((move) => move.action === 'wait')).toBe(true);
    expect(route.some((move) => move.events.caught !== undefined)).toBe(false);
    expect(route.at(-1)!.destination).toBe('treasury');
    expect(validateRoute(sentryLevel, route).ok).toBe(true);
  });

  it('walking straight into the yard after the key gets the player caught', () => {
    const compiled = compileLevel(sentryLevel);
    let state = initialState(compiled);
    for (const action of ['E', 'N', 'N', 'S', 'S'] as const) state = step(compiled, state, action)!.after;
    expect(state.moduleId).toBe('yard-west');
    expect(state.keyMask).not.toBe(0);
    const rushed = step(compiled, state, 'E')!;
    expect(rushed.events.caught).toBe('sentry');
    expect(rushed.after).toEqual(initialState(compiled));
  });
});

describe('guards never hide a trap', () => {
  // A cell north of the corridor: stepping in presses a plate that seals the
  // door behind. The jailer then walks in. Being caught restarts the level —
  // but a restart is not a way out, so the checker still calls it a trap.
  const cellLevel = (patrols?: Level['patrols']): Level =>
    corridor({
      modules: [...corridor().modules.filter((m) => m.id !== 'alcove'), flat('cell', 3, 4, ['S', 'N']), flat('cell-back', 3, 3, ['S'])],
      switches: [{ id: 'plate', moduleId: 'cell' }],
      doors: [{ id: 'cell-door', a: 'hall-c', b: 'cell', conditions: { closesAfterSwitch: 'plate' } }],
      ...(patrols !== undefined ? { patrols } : {}),
    });

  it('a sealed cell is a dead end, with or without a guard who would catch you there', () => {
    expect(verify(cellLevel()).checks.recovery.status).toBe('fail');
    const guarded = cellLevel([{ id: 'jailer', route: ['cell-back', 'cell'] }]);
    expect(validateLevel(guarded)).toEqual([]);
    const report = verify(guarded);
    expect(report.checks.solution.status).toBe('pass');
    expect(report.checks.recovery.status).toBe('fail');
    expect(report.checks.recovery.explanation).toMatch(/cell/);
    expect(report.accepted).toBe(false);
  });

  it('play agrees: the sealed cell is flagged as a dead end', () => {
    const compiled = compileLevel(cellLevel([{ id: 'jailer', route: ['cell-back', 'cell'] }]));
    const start = initialState(compiled);
    const canWin = goalReachableStates(compiled, start);
    let state = start;
    // Wait once at the cell door so the step in lands while the jailer is at the back.
    for (const action of ['E', 'E', 'wait'] as const) state = step(compiled, state, action)!.after;
    const sealed = step(compiled, state, 'N')!;
    expect(sealed.events.caught).toBeUndefined();
    expect(sealed.after.switchMask).not.toBe(0);
    expect(canWin.has(stateKey(sealed.after))).toBe(false);
  });

  it('the Sentry stays accepted: nobody there depends on being caught', () => {
    expect(verify(sentryLevel).checks.recovery.status).toBe('pass');
  });
});
