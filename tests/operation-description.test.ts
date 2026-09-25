import { describe, expect, it } from 'vitest';
import { baselineLevel } from '../src/core/fixtures/baseline';
import { describeOperations } from '../src/core/operation-description';
import { applyRuleProposal } from '../src/core/level';

describe('plain-language scene preview descriptions', () => {
  it('names both linked geometry removals in a required-key removal', () => {
    const applied = applyRuleProposal(baselineLevel, {
      oldRequirements: baselineLevel.requirements,
      newRequirements: [],
      operations: [
        { kind: 'removeItem', id: 'brass-key' },
        { kind: 'removeDoor', id: 'vault-door' },
      ],
    });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;

    expect(describeOperations([
      { kind: 'removeItem', id: 'brass-key' },
      { kind: 'removeDoor', id: 'vault-door' },
    ], baselineLevel, applied.level)).toEqual([
      'Remove key “brass key” from “side balcony”.',
      'Remove door between “vault approach” and “vault entry”.',
    ]);
  });

  it('shows the before and after locations for a moved platform', () => {
    const before = structuredClone(baselineLevel);
    const after = structuredClone(before);
    after.modules.find((module) => module.id === 'gallery')!.x = 2;

    expect(describeOperations([
      { kind: 'moveModule', id: 'gallery', x: 2, z: 2, h: 1 },
    ], before, after)).toEqual([
      'Move platform “upper foyer” from tile (2, 3), level 2 to tile (3, 3), level 2.',
    ]);
  });
});
