import { describe, expect, it } from 'vitest';
import { baselineLevel } from '../src/core/fixtures/baseline';
import { applyRuleProposal } from '../src/core/level';

describe('atomic rule proposals', () => {
  it('validates the replacement rule and geometry as one transaction', () => {
    const result = applyRuleProposal(baselineLevel, {
      oldRequirements: baselineLevel.requirements,
      newRequirements: [],
      operations: [
        { kind: 'removeItem', id: 'brass-key' },
        { kind: 'removeDoor', id: 'vault-door' },
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.level.keys).toHaveLength(0);
      expect(result.level.doors).toHaveLength(0);
      expect(result.level.requirements).toHaveLength(0);
    }
  });

  it('rejects a proposal whose claimed old rules are not authoritative', () => {
    const result = applyRuleProposal(baselineLevel, {
      oldRequirements: [],
      newRequirements: [],
      operations: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toContain('stale');
  });
});
