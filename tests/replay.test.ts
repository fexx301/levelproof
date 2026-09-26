import { describe, expect, it } from 'vitest';
import { trapLevel } from '../src/core/fixtures/trap';
import { trapRepairedLevel } from '../src/core/fixtures/trap-repaired';
import { validateRoute } from '../src/core/replay';
import { verify } from '../src/core/verifier';

describe('repaired witness replay validation', () => {
  it('accepts the old trap witness after the switch relocation repair', () => {
    const witness = verify(trapLevel).checks.recovery.witness;
    expect(witness).toBeDefined();
    const result = validateRoute(trapRepairedLevel, witness!.route);
    expect(result.ok).toBe(true);
  });

  it('replays the repaired level’s own events, not the stored records', () => {
    const witness = verify(trapLevel).checks.recovery.witness!;
    const result = validateRoute(trapRepairedLevel, witness.route);
    expect(result.route).toHaveLength(witness.route.length);
    expect(result.route.map((move) => move.action)).toEqual(witness.route.map((move) => move.action));
    // The repair relocated the sealing switch: the old route pressed it, the
    // same moves on the repaired level do not.
    const oldSwitches = witness.route.filter((move) => move.events.activatedSwitch !== undefined).length;
    const newSwitches = result.route.filter((move) => move.events.activatedSwitch !== undefined).length;
    expect(oldSwitches).toBeGreaterThan(0);
    expect(newSwitches).not.toBe(oldSwitches);
    expect(result.route.at(-1)!.after).toEqual(result.endState);
  });

  it('rejects a stored route when a later repair makes a move illegal', () => {
    const witness = verify(trapLevel).checks.recovery.witness;
    expect(witness).toBeDefined();
    const changed = structuredClone(trapRepairedLevel);
    const door = changed.doors.find((candidate) => candidate.id === 'gallery-door');
    if (door === undefined) throw new Error('fixture should contain gallery-door');
    door.conditions = { requiresKey: 'brass-key' };
    const result = validateRoute(changed, witness!.route);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('no longer legal');
  });
});
