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
