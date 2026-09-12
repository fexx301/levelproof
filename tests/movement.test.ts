import { describe, expect, it } from 'vitest';
import { GEOMETRY, portElevation, traversalSegments } from '../src/core/catalog';
import { baselineLevel } from '../src/core/fixtures/baseline';
import { initialState, step, transitions } from '../src/core/movement';
import { compileLevel } from '../src/core/topology';
import { validateLevel } from '../src/core/level';
import { verify } from '../src/core/verifier';
import type { Level } from '../shared/schema';

describe('movement derivation (§4, §13.1)', () => {
  const compiled = compileLevel(baselineLevel);

  it('the golden baseline is a valid layout', () => {
    expect(validateLevel(baselineLevel)).toEqual([]);
  });

  it('moves are returned in N/E/S/W order', () => {
    const moves = transitions(compiled, { moduleId: 'gallery', keyMask: 0, switchMask: 0 });
    expect(moves.map((m) => m.action)).toEqual(['N', 'E', 'S']);
  });

  it('a ramp connects h to h+1 through its two end ports', () => {
    const ramp = compiled.moduleById.get('gallery-ramp')!;
    expect(portElevation(ramp, 'S')).toBe(0);
    expect(portElevation(ramp, 'N')).toBe(1);
    expect(portElevation(ramp, 'E')).toBeNull();
    const up = step(compiled, { moduleId: 'gallery-ramp', keyMask: 0, switchMask: 0 }, 'N');
    expect(up?.destination).toBe('gallery');
  });

  it('traversal segments follow the ramp surface', () => {
    const hall = compiled.moduleById.get('lower-hall')!;
    const ramp = compiled.moduleById.get('gallery-ramp')!;
    const segments = traversalSegments(hall, 'N', ramp);
    expect(segments[1]!.y).toBe(0); // shared port sits at elevation 0
    expect(segments[2]!.y).toBe(GEOMETRY.floorSpacingCm / 2); // ramp center is mid-slope
  });

  it('different-height neighbors never connect without a ramp', () => {
    const mismatched: Level = {
      modules: [
        { id: 'low', template: 'flat', x: 2, z: 2, h: 0, ports: ['N'] },
        { id: 'high', template: 'flat', x: 2, z: 1, h: 1, ports: ['S'] },
      ],
      keys: [],
      switches: [],
      spawn: 'low',
      goal: 'high',
      doors: [],
      requirements: [],
    };
    expect(validateLevel(mismatched)).toEqual([]);
    const c = compileLevel(mismatched);
    expect(c.edges).toHaveLength(0);
  });

  it('layered floors at the same cell stay distinct modules', () => {
    const layered: Level = {
      modules: [
        { id: 'lower', template: 'flat', x: 2, z: 2, h: 0, ports: ['N'] },
        { id: 'goal-room', template: 'flat', x: 2, z: 1, h: 0, ports: ['S'] },
        { id: 'upper', template: 'flat', x: 2, z: 2, h: 2, ports: [] },
      ],
      keys: [],
      switches: [],
      spawn: 'lower',
      goal: 'goal-room',
      doors: [],
      requirements: [],
    };
    expect(validateLevel(layered)).toEqual([]);
    const c = compileLevel(layered);
    expect(c.edges.map((e) => `${e.aId}-${e.bId}`)).toEqual(['goal-room-lower']);
  });

  it('goal states are terminal with no outgoing transitions', () => {
    expect(transitions(compiled, { moduleId: 'treasure-landing', keyMask: 1, switchMask: 0 })).toEqual([]);
  });

  it('the vault door blocks without the key and passes with it', () => {
    const state = { moduleId: 'vault-approach', keyMask: 0, switchMask: 0 };
    expect(step(compiled, state, 'E')).toBeNull();
    const open = step(compiled, { ...state, keyMask: 1 }, 'E');
    expect(open?.destination).toBe('vault-entry');
    expect(open?.doorId).toBe('vault-door');
  });

  it('keys are collected on arrival exactly once', () => {
    const first = step(compiled, { moduleId: 'key-walk', keyMask: 0, switchMask: 0 }, 'E');
    expect(first?.events.collectedKey).toBe('brass-key');
    expect(first?.after.keyMask).toBe(1);
    const again = step(compiled, { moduleId: 'key-walk', keyMask: 1, switchMask: 0 }, 'E');
    expect(again?.events.collectedKey).toBeUndefined();
    expect(again?.after.keyMask).toBe(1);
  });

  it('the full winning route replays through step from spawn', () => {
    let state = initialState(compiled);
    const path = ['N', 'N', 'N', 'E', 'E', 'W', 'W', 'N', 'E', 'E', 'E'] as const;
    for (const action of path) {
      const move = step(compiled, state, action);
      expect(move, `${action} from ${state.moduleId}`).not.toBeNull();
      state = move!.after;
    }
    expect(state.moduleId).toBe('treasure-landing');
    expect(state.keyMask & 1).toBe(1);
  });
});

describe('multi-key doors (§4.3 requiresKeys — AND semantics)', () => {
  // A corridor: spawn -> gate -> goal, with two keys off a side room.
  const level: Level = {
    modules: [
      { id: 'spawn-pad', template: 'flat', x: 6, z: 8, h: 0, ports: ['N', 'E'] },
      { id: 'gate-room', template: 'flat', x: 6, z: 7, h: 0, ports: ['N', 'S'] },
      { id: 'goal-pad', template: 'flat', x: 6, z: 6, h: 0, ports: ['S'] },
      { id: 'key-room-a', template: 'flat', x: 7, z: 8, h: 0, ports: ['W', 'E'] },
      { id: 'key-room-b', template: 'flat', x: 8, z: 8, h: 0, ports: ['W'] },
    ],
    keys: [
      { id: 'key-iron', moduleId: 'key-room-a' },
      { id: 'key-brass', moduleId: 'key-room-b' },
    ],
    switches: [],
    spawn: 'spawn-pad',
    goal: 'goal-pad',
    doors: [
      { id: 'double-lock', a: 'spawn-pad', b: 'gate-room', conditions: { requiresKeys: ['key-iron', 'key-brass'] } },
    ],
    requirements: [],
  };
  const compiled = compileLevel(level);
  // keyBit maps key ids directly to their bit masks.
  const IRON = compiled.keyBit.get('key-iron') ?? 0;
  const BRASS = compiled.keyBit.get('key-brass') ?? 0;

  it('is a valid layout', () => {
    expect(validateLevel(level)).toEqual([]);
  });

  it('blocks with either key missing, passes only with both', () => {
    const none = step(compiled, { moduleId: 'spawn-pad', keyMask: 0, switchMask: 0 }, 'N');
    expect(none).toBeNull();
    const onlyIron = step(compiled, { moduleId: 'spawn-pad', keyMask: IRON, switchMask: 0 }, 'N');
    expect(onlyIron).toBeNull();
    const onlyBrass = step(compiled, { moduleId: 'spawn-pad', keyMask: BRASS, switchMask: 0 }, 'N');
    expect(onlyBrass).toBeNull();
    const both = step(compiled, { moduleId: 'spawn-pad', keyMask: IRON | BRASS, switchMask: 0 }, 'N');
    expect(both?.destination).toBe('gate-room');
  });

  it('the checker sees the full puzzle: both keys are required to win', () => {
    const report = verify(level);
    expect(report.checks.solution.status).toBe('pass');
    // From spawn without keys there are moves (to the key room) but not
    // through the door — recovery must still pass.
    expect(report.checks.recovery.status).toBe('pass');
  });

  it('rejects dangling multi-key references', () => {
    const broken: Level = {
      ...level,
      doors: [{ id: 'bad-lock', a: 'spawn-pad', b: 'gate-room', conditions: { requiresKeys: ['key-ghost'] } }],
    };
    expect(validateLevel(broken)[0]).toContain('unknown key "key-ghost"');
  });
});
