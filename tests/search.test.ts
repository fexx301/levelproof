import { describe, expect, it } from 'vitest';
import { baselineLevel } from '../src/core/fixtures/baseline';
import { bypassLevel } from '../src/core/fixtures/bypass';
import { trapLevel } from '../src/core/fixtures/trap';
import { trapRepairedLevel } from '../src/core/fixtures/trap-repaired';
import { applyOperations } from '../src/core/level';
import { findRepairs } from '../src/core/search';
import { revisionId } from '../src/core/serialize';
import { verify } from '../src/core/verifier';

describe('repair search (§9, §13.4)', () => {
  it('the trap has exactly one checked fix: relocate the seal switch behind the vault door', () => {
    const report = verify(trapLevel);
    expect(report.checks.recovery.status).toBe('fail');
    const result = findRepairs(baselineLevel, trapLevel, report);
    expect(result.status).toBe('complete');
    expect(result.candidates).toHaveLength(1);
    const candidate = result.candidates[0]!;
    expect(candidate.operations).toEqual([
      { kind: 'moveItem', id: 'seal-switch', moduleId: 'vault-entry' },
    ]);
    // The applied repair is content-identical to the §8.2 repaired fixture.
    const applied = applyOperations(trapLevel, candidate.operations);
    expect(applied.ok).toBe(true);
    if (applied.ok) {
      expect(revisionId(applied.level)).toBe(revisionId(trapRepairedLevel));
      expect(applied.level.requirements).toEqual(trapLevel.requirements);
    }
    // Search stays inside its bounds and is fast enough to measure.
    expect(result.explored).toBeLessThanOrEqual(24);
    console.log(`[spike] repair search (trap): ${result.explored} candidates, ${result.durationMs.toFixed(1)} ms`);
  });

  it('the bridge bypass is repaired by gating a new-route entrance with the missing key', () => {
    const report = verify(bypassLevel);
    expect(report.checks.requirements.status).toBe('fail');
    const result = findRepairs(trapRepairedLevel, bypassLevel, report);
    expect(result.status).toBe('complete');
    expect(result.candidates.length).toBeGreaterThanOrEqual(1);
    // The §8.3 repair (gate at the bridge entrance) is among the candidates.
    const expected = result.candidates.find((c) =>
      c.operations.some(
        (op) =>
          op.kind === 'addDoor' &&
          ((op.door.a === 'bridge-landing' && op.door.b === 'bridge-west') ||
            (op.door.a === 'bridge-west' && op.door.b === 'bridge-landing')) &&
          op.door.conditions?.requiresKey === 'brass-key',
      ),
    );
    expect(expected).toBeDefined();
    for (const candidate of result.candidates) {
      expect(candidate.operations.length).toBeLessThanOrEqual(4);
      expect(candidate.report.accepted).toBe(true);
    }
    console.log(
      `[spike] repair search (bypass): ${result.explored} candidates, ${result.candidates.length} passing, ${result.durationMs.toFixed(1)} ms`,
    );
  });

  it('a failure no template addresses yields an honest no-fix result, not silence', () => {
    // Disconnecting the goal: solution fails, no rule bypass, no sealing switch.
    const cut = applyOperations(baselineLevel, [
      { kind: 'removeModule', id: 'gallery-ramp' },
    ]);
    expect(cut.ok).toBe(true);
    if (!cut.ok) return;
    const report = verify(cut.level);
    expect(report.checks.solution.status).toBe('fail');
    const result = findRepairs(baselineLevel, cut.level, report);
    expect(result.status).toBe('complete');
    expect(result.candidates).toHaveLength(0);
    expect(result.note).toBe('No checked fix in this search.');
  });
});
