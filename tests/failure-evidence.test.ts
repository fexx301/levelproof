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
