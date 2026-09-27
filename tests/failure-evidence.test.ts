import { describe, expect, it } from 'vitest';
import { applyOperations } from '../src/core/level';
import { baselineLevel } from '../src/core/fixtures/baseline';
import { trapLevel } from '../src/core/fixtures/trap';
import { buildFailureEvidence } from '../src/core/failure-evidence';
import { verify } from '../src/core/verifier';

describe('grounded failure evidence', () => {
  it('binds a recovery explanation to the verifier witness and implicated scene ids', () => {
    const report = verify(trapLevel);
    const evidence = buildFailureEvidence(trapLevel, report, 'recovery');
    expect(evidence).not.toBeNull();
    expect(evidence?.witnessKind).toBe('dead_end');
    expect(evidence?.route.length).toBeGreaterThan(0);
    expect(evidence?.implicatedIds).toContain('gallery-door');
    expect(evidence?.implicatedIds).toContain(evidence?.focusModuleId);
    expect(evidence?.decisiveMoveIndex).toBeGreaterThan(0);
    expect(evidence?.decisiveMoveIndex).toBeLessThanOrEqual(evidence?.route.length ?? 0);
    expect(evidence?.fact).toContain('closes');
    expect(evidence?.fact).toContain('stranded');
    expect(evidence?.revisionId).toBe(report.revisionId);
  });

  it('binds a bypass explanation to the missing requirement rather than AI prose', () => {
    const opened = applyOperations(baselineLevel, [{ kind: 'setDoorConditions', id: 'vault-door', conditions: {} }]);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const report = verify(opened.level);
    const evidence = buildFailureEvidence(opened.level, report, 'requirements');
    expect(evidence).not.toBeNull();
    expect(evidence?.witnessKind).toBe('bypass');
    expect(evidence?.implicatedIds).toContain('brass-key');
    expect(evidence?.fact).toContain('without');
  });

  it('returns no replay action for a passing or non-witness failure', () => {
    const report = verify(baselineLevel);
    expect(buildFailureEvidence(baselineLevel, report, 'requirements')).toBeNull();
    expect(buildFailureEvidence(baselineLevel, report, 'solution')).toBeNull();
  });
});

describe('the decisive move is the point of no return', () => {
  it('does not blame an earlier, harmless sealing switch', () => {
    const level = structuredClone(trapLevel);
    level.switches.push({ id: 'decoy', moduleId: 'lower-hall' });
    level.doors.push({ id: 'decoy-door', a: 'entrance', b: 'lower-hall', conditions: { closesAfterSwitch: 'decoy' } });
    const report = verify(level);
    expect(report.valid).toBe(true);
    const evidence = buildFailureEvidence(level, report, 'recovery')!;
    const route = report.checks.recovery.witness!.route;
    expect(evidence.decisiveMoveIndex).toBe(route.length);
    expect(evidence.fact).toContain('seal-switch');
    expect(evidence.fact).not.toMatch(/activating “decoy”/);
    expect(evidence.focusModuleId).toBe(route.at(-1)!.destination);
  });
});
