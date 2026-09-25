import { describe, expect, it } from 'vitest';
import {
  evaluateFixedCase,
  fixedEvaluationCases,
  fixedEvaluationSummary,
  type EvaluationCategory,
} from '../src/core/evaluation-suite';

const minimums: Record<EvaluationCategory, number> = {
  simple_edits: 6,
  linked_changes: 6,
  gameplay_logic: 6,
  preservation: 4,
  ambiguity: 4,
  unsupported_conflicting: 4,
};

describe('versioned deterministic reliability suite', () => {
  it('contains the required 30 fixed cases with explicit metadata', () => {
    expect(fixedEvaluationCases).toHaveLength(30);
    for (const [category, minimum] of Object.entries(minimums)) {
      const cases = fixedEvaluationCases.filter((testCase) => testCase.category === category);
      expect(cases.length, category).toBeGreaterThanOrEqual(minimum);
      for (const testCase of cases) {
        expect(testCase.prompt.length, `${testCase.id} prompt`).toBeGreaterThan(0);
        expect(testCase.expectedOutcome, `${testCase.id} expected outcome`).toBeTruthy();
        expect(testCase.mustNotChange, `${testCase.id} must-not-change contract`).toBeDefined();
        expect(testCase.acceptableAlternatives, `${testCase.id} alternatives`).toBeDefined();
      }
    }
  });

  it('passes every controlled parse → apply → verify contract', () => {
    const summary = fixedEvaluationSummary();
    if (summary.passed !== summary.total) {
      const failures = summary.results
        .filter((result) => !result.semanticFulfillment)
        .map((result) => `${result.id}: ${result.errors.join('; ')}`)
        .join('\n');
      throw new Error(`fixed evaluation failures:\n${failures}`);
    }
    expect(summary.total).toBe(30);
    expect(summary.passed).toBe(30);
    expect(Object.values(summary.byCategory).every((category) => category.total > 0 && category.passed === category.total)).toBe(true);
  });

  it('rejects malformed linked removals without mutating the source level', () => {
    const testCase = fixedEvaluationCases.find((candidate) => candidate.id === 'linked-reject-required-key-only');
    expect(testCase).toBeDefined();
    const before = structuredClone(testCase!.base);
    const result = evaluateFixedCase(testCase!);
    expect(result.safeHandling).toBe(true);
    expect(result.appliedLevel).toBeNull();
    expect(testCase!.base).toEqual(before);
  });

  it('does not let a protected candidate reach the renderer/application stage', () => {
    const protectedCase = fixedEvaluationCases.find((candidate) => candidate.id === 'preserve-protected-module');
    expect(protectedCase).toBeDefined();
    const result = evaluateFixedCase(protectedCase!);
    expect(result.semanticFulfillment).toBe(true);
    expect(result.safeHandling).toBe(true);
    expect(result.appliedLevel).toBeNull();
  });

  it('proves preview and approval use the same candidate for both result channels', () => {
    for (const id of ['logic-build-keyed-vault', 'simple-move-key']) {
      const testCase = fixedEvaluationCases.find((candidate) => candidate.id === id)!;
      const result = evaluateFixedCase(testCase);
      expect(result.previewApplicationConsistent, id).toBe(true);
    }
  });

  it('grades added objects by the requested location and edge, not an arbitrary generated id', () => {
    const addSwitch = fixedEvaluationCases.find((candidate) => candidate.id === 'simple-add-switch')!;
    const switchResult = {
      type: 'patch' as const,
      rationale: 'Add a switch.',
      assumptions: [],
      operations: [{ kind: 'addItem' as const, itemType: 'switch' as const, id: 'vault-entry-toggle', moduleId: 'vault-entry' }],
    };
    expect(evaluateFixedCase({ ...addSwitch, result: switchResult }).semanticFulfillment).toBe(true);

    const addDoor = fixedEvaluationCases.find((candidate) => candidate.id === 'simple-add-door')!;
    const doorResult = {
      type: 'patch' as const,
      rationale: 'Add an open door.',
      assumptions: [],
      operations: [{ kind: 'addDoor' as const, door: { id: 'observatory-door', a: 'gallery', b: 'bridge-landing', conditions: {} } }],
    };
    expect(evaluateFixedCase({ ...addDoor, result: doorResult }).semanticFulfillment).toBe(true);
  });
});
