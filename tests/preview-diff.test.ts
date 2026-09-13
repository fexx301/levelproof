import { describe, expect, it } from 'vitest';
import { baselineLevel } from '../src/core/fixtures/baseline';
import { applyRuleProposal } from '../src/core/level';
import { previewDiff } from '../src/render/preview-diff';

describe('edit preview diff', () => {
  it('resolves old and fresh locations independently for modules, items, and doors', () => {
    const before = structuredClone(baselineLevel);
    const after = structuredClone(before);
    after.modules.find((module) => module.id === 'gallery')!.x = 2;
    after.keys[0]!.moduleId = 'gallery';
    after.doors[0]!.conditions = { requiresKeys: ['brass-key'] };

    const markers = previewDiff(before, after);
    expect(markers).toEqual(expect.arrayContaining([
      { phase: 'old', kind: 'module', id: 'gallery', moduleId: 'gallery' },
      { phase: 'fresh', kind: 'module', id: 'gallery', moduleId: 'gallery' },
      { phase: 'old', kind: 'item', id: 'brass-key', moduleId: 'key-balcony' },
      { phase: 'fresh', kind: 'item', id: 'brass-key', moduleId: 'gallery' },
      { phase: 'old', kind: 'door', id: 'vault-door', moduleId: 'vault-approach', otherModuleId: 'vault-entry' },
      { phase: 'fresh', kind: 'door', id: 'vault-door', moduleId: 'vault-approach', otherModuleId: 'vault-entry' },
    ]));
  });

  it('marks added/removed modules and endpoint changes', () => {
    const before = structuredClone(baselineLevel);
    const after = structuredClone(before);
    after.modules = after.modules.filter((module) => module.id !== 'key-walk');
    after.modules.push({ id: 'new-room', template: 'flat', x: 7, z: 7, h: 0, ports: [] });
    after.spawn = 'new-room';
    after.goal = 'new-room';

    const markers = previewDiff(before, after);
    expect(markers).toEqual(expect.arrayContaining([
      { phase: 'old', kind: 'module', id: 'key-walk', moduleId: 'key-walk' },
      { phase: 'fresh', kind: 'module', id: 'new-room', moduleId: 'new-room' },
      { phase: 'old', kind: 'spawn', id: 'spawn', moduleId: 'entrance' },
      { phase: 'fresh', kind: 'spawn', id: 'spawn', moduleId: 'new-room' },
      { phase: 'old', kind: 'goal', id: 'goal', moduleId: 'treasure-landing' },
      { phase: 'fresh', kind: 'goal', id: 'goal', moduleId: 'new-room' },
    ]));
  });

  it('can diff an atomic rule revision that removes a protected key and door', () => {
    const before = structuredClone(baselineLevel);
    const result = applyRuleProposal(before, {
      oldRequirements: before.requirements,
      newRequirements: [],
      operations: [
        { kind: 'removeItem', id: 'brass-key' },
        { kind: 'removeDoor', id: 'vault-door' },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const markers = previewDiff(before, result.level);
    expect(markers).toEqual(expect.arrayContaining([
      { phase: 'old', kind: 'item', id: 'brass-key', moduleId: 'key-balcony' },
      { phase: 'old', kind: 'door', id: 'vault-door', moduleId: 'vault-approach', otherModuleId: 'vault-entry' },
    ]));
  });
});
