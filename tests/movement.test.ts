import { describe, expect, it } from 'vitest';
import { GEOMETRY, portElevation, traversalSegments } from '../src/core/catalog';
import { baselineLevel } from '../src/core/fixtures/baseline';
import { initialState, step, transitions } from '../src/core/movement';
import { compileLevel } from '../src/core/topology';
import { validateLevel } from '../src/core/level';
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
