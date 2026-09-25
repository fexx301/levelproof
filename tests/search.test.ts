import { describe, expect, it } from 'vitest';
import { baselineLevel } from '../src/core/fixtures/baseline';
import { bypassLevel } from '../src/core/fixtures/bypass';
import { trapLevel } from '../src/core/fixtures/trap';
import { trapRepairedLevel } from '../src/core/fixtures/trap-repaired';
import { applyOperations } from '../src/core/level';
import { findRepairs, touchesProtected } from '../src/core/search';
import { revisionId } from '../src/core/serialize';
import { verify } from '../src/core/verifier';

describe('repair search (§9, §13.4)', () => {
  it('the trap ranks the preserving relocation above destructive removals', () => {
    const report = verify(trapLevel);
    expect(report.checks.recovery.status).toBe('fail');
    const result = findRepairs(baselineLevel, trapLevel, report);
    expect(result.status).toBe('complete');
    expect(result.candidates.length).toBeGreaterThanOrEqual(1);
    // §9 ranking: repairs that keep every entity outrank removals, so the
    // canonical §8.2 relocation is always first.
    const first = result.candidates[0]!;
    expect(first.operations).toEqual([
      { kind: 'moveItem', id: 'seal-switch', moduleId: 'vault-entry' },
    ]);
    // The applied first repair is content-identical to the §8.2 repaired fixture.
    const applied = applyOperations(trapLevel, first.operations);
    expect(applied.ok).toBe(true);
    if (applied.ok) {
      expect(revisionId(applied.level)).toBe(revisionId(trapRepairedLevel));
      expect(applied.level.requirements).toEqual(trapLevel.requirements);
    }
    // Destructive variants (drop the switch, drop the door) are honest
    // candidates too, but never outrank the relocation.
    for (const candidate of result.candidates.slice(1)) {
      const removes = candidate.operations.some((op) => op.kind === 'removeItem' || op.kind === 'removeDoor');
      expect(removes).toBe(true);
      expect(candidate.report.accepted).toBe(true);
    }
    // Search stays inside its bounds and is fast enough to measure.
    expect(result.explored).toBeLessThanOrEqual(24);
    console.log(`[spike] repair search (trap): ${result.explored} candidates, ${result.candidates.length} passing, ${result.durationMs.toFixed(1)} ms`);
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

describe('creator preservation constraints (§9 "keep this")', () => {
  it('treats protected module label and exit edits as changes to that module', () => {
    const protectedGallery = new Set(['gallery']);
    expect(touchesProtected([
      { kind: 'setModuleLabel', id: 'gallery', label: 'Renamed gallery' },
    ], protectedGallery)).toBe(true);
    expect(touchesProtected([
      { kind: 'setModulePorts', id: 'gallery', ports: ['N', 'S'] },
    ], protectedGallery)).toBe(true);
  });

  it('keeping the seal switch excludes relocation and removal — only the door removal remains', () => {
    const report = verify(trapLevel);
    const result = findRepairs(baselineLevel, trapLevel, report, ['seal-switch']);
    expect(result.status).toBe('complete');
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.description).toContain('Remove the sealing door');
    expect(result.skippedProtected).toBeGreaterThan(0);
    expect(result.note).toContain('skipped to keep your choices');
  });

  it('keeping both the switch and the door leaves no checked fix — reported honestly', () => {
    const report = verify(trapLevel);
    const result = findRepairs(baselineLevel, trapLevel, report, ['seal-switch', 'gallery-door']);
    expect(result.candidates).toHaveLength(0);
    expect(result.note).toContain('No checked fix keeps those entities');
  });

  it('gating repairs (addDoor) are never blocked by protections', () => {
    const report = verify(bypassLevel);
    const result = findRepairs(trapRepairedLevel, bypassLevel, report, ['brass-key']);
    expect(result.candidates.length).toBeGreaterThanOrEqual(1);
    expect(result.candidates.some((c) => c.description.startsWith('Lock the entrance'))).toBe(true);
  });

  it('keeping the key excludes key-relocation but keeps gating', () => {
    const report = verify(bypassLevel);
    const result = findRepairs(trapRepairedLevel, bypassLevel, report, ['brass-key']);
    expect(result.candidates.some((c) => c.description.startsWith('Move key'))).toBe(false);
  });
});
