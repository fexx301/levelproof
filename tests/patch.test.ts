import { describe, expect, it } from 'vitest';
import { baselineLevel } from '../src/core/fixtures/baseline';
import { trapLevel } from '../src/core/fixtures/trap';
import { applyOperations, validateLevel } from '../src/core/level';
import { revisionId } from '../src/core/serialize';
import { verify } from '../src/core/verifier';
import type { Operation } from '../shared/schema';

describe('atomic edit application (§5, §13.1/§13.4)', () => {
  it('applies a valid patch', () => {
    const ops: Operation[] = [{ kind: 'addItem', itemType: 'key', id: 'silver-key', moduleId: 'lower-hall' }];
    const result = applyOperations(baselineLevel, ops);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.level.keys.map((k) => k.id).sort()).toEqual(['brass-key', 'silver-key']);
    }
  });

  it('rejects the whole patch when any operation is invalid, leaving the base untouched', () => {
    const before = revisionId(baselineLevel);
    const ops: Operation[] = [
      { kind: 'addItem', itemType: 'switch', id: 'lever', moduleId: 'key-walk' },
      { kind: 'addModule', module: { id: 'clash', template: 'flat', x: 1, z: 5, h: 0, ports: ['N'] } },
    ];
    const result = applyOperations(baselineLevel, ops);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(' ')).toMatch(/overlap/i);
    expect(revisionId(baselineLevel)).toBe(before);
    expect(verify(baselineLevel).accepted).toBe(true);
  });

  it('rule protection: removing a required key rejects the patch', () => {
    const result = applyOperations(baselineLevel, [{ kind: 'removeItem', id: 'brass-key' }]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(' ')).toMatch(/rule/i);
  });

  it('deleting a door endpoint rejects alone and applies together with door removal', () => {
    const bad = applyOperations(baselineLevel, [{ kind: 'removeModule', id: 'vault-entry' }]);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.join(' ')).toMatch(/vault-door|unknown module/i);

    const good = applyOperations(baselineLevel, [
      { kind: 'removeDoor', id: 'vault-door' },
      { kind: 'removeModule', id: 'vault-entry' },
    ]);
    expect(good.ok).toBe(true);
    if (good.ok) {
      // Structurally valid, but the goal is now unreachable: a verification
      // finding, not a schema error (§1 brief).
      const report = verify(good.level);
      expect(report.valid).toBe(true);
      expect(report.checks.solution.status).toBe('fail');
    }
  });

  it('moving a module carries its resident item', () => {
    const result = applyOperations(baselineLevel, [
      { kind: 'moveModule', id: 'key-balcony', x: 4, z: 2, h: 1 },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.level.keys.find((k) => k.id === 'brass-key')!.moduleId).toBe('key-balcony');
      // The moved balcony no longer touches key-walk: the draft stays valid
      // but the key is unreachable, so checks fail while editing continues.
      const report = verify(result.level);
      expect(report.valid).toBe(true);
      expect(report.checks.solution.status).toBe('fail');
    }
  });

  it('the trap fixture is reachable from baseline by an ordinary patch with identical identity', () => {
    const result = applyOperations(baselineLevel, [
      { kind: 'addItem', itemType: 'switch', id: 'seal-switch', moduleId: 'vault-approach' },
      {
        kind: 'addDoor',
        door: {
          id: 'gallery-door',
          a: 'gallery',
          b: 'bridge-landing',
          conditions: { closesAfterSwitch: 'seal-switch' },
        },
      },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(revisionId(result.level)).toBe(revisionId(trapLevel));
      expect(verify(result.level).checks.recovery.status).toBe('fail');
    }
  });

  it('rejects schema-invalid operations at the boundary', () => {
    const ops = [
      { kind: 'addModule', module: { id: 'X', template: 'flat', x: 99, z: 0, h: 0, ports: [] } },
    ] as unknown as Operation[];
    expect(applyOperations(baselineLevel, ops).ok).toBe(false);
    expect(applyOperations(baselineLevel, []).ok).toBe(true);
    const tooMany: Operation[] = Array.from({ length: 17 }, () => ({
      kind: 'addItem',
      itemType: 'key',
      id: 'k',
      moduleId: 'lower-hall',
    }));
    expect(applyOperations(baselineLevel, tooMany).ok).toBe(false);
  });
});

describe('ids are unique across entity kinds', () => {
  it('rejects a door that reuses a module id', () => {
    const errors = validateLevel({
      ...structuredClone(baselineLevel),
      doors: [{ id: 'gallery', a: 'gallery', b: 'bridge-landing', conditions: {} }],
    });
    expect(errors.some((error) => error.includes('"gallery" is used by both a module and a door'))).toBe(true);
  });

  it('rejects a prop that reuses a key id', () => {
    const errors = validateLevel({
      ...structuredClone(baselineLevel),
      props: [{ id: 'brass-key', prop: 'chest', x: 9, z: 9 }],
    });
    expect(errors.some((error) => error.includes('used by both a key and a prop'))).toBe(true);
  });
});
