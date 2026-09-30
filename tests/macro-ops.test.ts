import { describe, expect, it } from 'vitest';
import type { Level, Operation } from '../shared/schema';
import { blankCanvasLevel } from '../src/core/fixtures/blank-canvas';
import { applyOperations } from '../src/core/level';
import { describeOperation } from '../src/core/operation-description';
import { touchesProtected } from '../src/core/search';
import { compileLevel, neighbor } from '../src/core/topology';
import { verify } from '../src/core/verifier';
import { operationLabel } from '../shared/stream-progress';

/** Areas and corridors (§5): one operation lays out many rooms, so big worlds fit one patch. */

function apply(operations: Operation[], base: Level = blankCanvasLevel): Level {
  const result = applyOperations(base, operations);
  if (!result.ok) throw new Error(result.errors.join('; '));
  return result.level;
}

const connected = (level: Level, a: string, b: string): boolean => {
  const compiled = compileLevel(level);
  return (['N', 'E', 'S', 'W'] as const).some((dir) => neighbor(compiled, a, dir)?.toId === b);
};

describe('addArea', () => {
  it('lays out width × depth connected rooms named from the north-west corner', () => {
    const level = apply([{ kind: 'addArea', area: { id: 'yard', x: 2, z: 2, h: 0, width: 3, depth: 2, label: 'courtyard' } }]);
    const cells = level.modules.filter((m) => m.id.startsWith('yard-'));
    expect(cells.map((m) => m.id).sort()).toEqual(['yard-1-1', 'yard-1-2', 'yard-2-1', 'yard-2-2', 'yard-3-1', 'yard-3-2']);
    const corner = cells.find((m) => m.id === 'yard-1-1')!;
    expect([corner.x, corner.z, corner.h, corner.label]).toEqual([2, 2, 0, 'courtyard']);
    expect(corner.ports).toEqual(['E', 'S']); // outer sides are walls
    expect(connected(level, 'yard-1-1', 'yard-2-1')).toBe(true);
    expect(connected(level, 'yard-2-1', 'yard-2-2')).toBe(true);
  });

  it('opens its outer sides onto neighbours that open toward it, and only those', () => {
    // start-walk (7,7) opens N and S; an area to its east sees no port facing it.
    const beside = apply([{ kind: 'addArea', area: { id: 'wing', x: 8, z: 7, h: 0, width: 2, depth: 1 } }]);
    expect(connected(beside, 'start-walk', 'wing-1-1')).toBe(false);
    // Open start-walk toward it in the same patch (after the area): now they join.
    const joined = apply([
      { kind: 'addArea', area: { id: 'wing', x: 8, z: 7, h: 0, width: 2, depth: 1 } },
      { kind: 'setModulePorts', id: 'start-walk', ports: ['N', 'E', 'S'] },
    ]);
    expect(connected(joined, 'start-walk', 'wing-1-1')).toBe(true);
  });

  it('rejects rooms off the grid or on occupied cells', () => {
    expect(applyOperations(blankCanvasLevel, [{ kind: 'addArea', area: { id: 'edge', x: 14, z: 0, h: 0, width: 3, depth: 2 } }]).ok).toBe(false);
    const overlap = applyOperations(blankCanvasLevel, [{ kind: 'addArea', area: { id: 'clash', x: 6, z: 7, h: 0, width: 2, depth: 1 } }]);
    expect(overlap.ok).toBe(false);
  });
});

describe('addCorridor', () => {
  it('runs from a room, opens that room toward it, and joins what it reaches — in either order', () => {
    const corridorFirst = apply([
      { kind: 'addCorridor', corridor: { id: 'east-walk', from: 'start-walk', direction: 'E', length: 3, label: 'east walk' } },
      { kind: 'addArea', area: { id: 'hall', x: 11, z: 6, h: 0, width: 2, depth: 3, label: 'great hall' } },
    ]);
    const areaFirst = apply([
      { kind: 'addArea', area: { id: 'hall', x: 11, z: 6, h: 0, width: 2, depth: 3, label: 'great hall' } },
      { kind: 'addCorridor', corridor: { id: 'east-walk', from: 'start-walk', direction: 'E', length: 3, label: 'east walk' } },
    ]);
    for (const level of [corridorFirst, areaFirst]) {
      expect(level.modules.find((m) => m.id === 'start-walk')!.ports).toContain('E');
      expect(connected(level, 'start-walk', 'east-walk-1')).toBe(true);
      expect(connected(level, 'east-walk-2', 'east-walk-3')).toBe(true);
      expect(connected(level, 'east-walk-3', 'hall-1-2')).toBe(true); // hall-1-2 sits at (11,7)
    }
  });

  it('never reopens an exit the patch closed explicitly', () => {
    const closed = apply([
      { kind: 'addArea', area: { id: 'hall', x: 11, z: 6, h: 0, width: 2, depth: 3 } },
      { kind: 'addCorridor', corridor: { id: 'east-walk', from: 'start-walk', direction: 'E', length: 3 } },
      { kind: 'setModulePorts', id: 'east-walk-3', ports: ['W'] },
    ]);
    expect(connected(closed, 'east-walk-3', 'hall-1-2')).toBe(false);
    const hallClosed = apply([
      { kind: 'addCorridor', corridor: { id: 'east-walk', from: 'start-walk', direction: 'E', length: 3 } },
      { kind: 'addModule', module: { id: 'vault', template: 'flat', x: 11, z: 7, h: 0, ports: [] } },
      { kind: 'setModulePorts', id: 'vault', ports: [] },
    ]);
    expect(hallClosed.modules.find((m) => m.id === 'vault')!.ports).toEqual([]);
  });

  it('can be a bridge, and never starts from a ramp', () => {
    const bridge = apply([{ kind: 'addCorridor', corridor: { id: 'span', from: 'goal-pad', direction: 'W', length: 2, template: 'bridge' } }]);
    expect(bridge.modules.filter((m) => m.id.startsWith('span-')).every((m) => m.template === 'bridge')).toBe(true);
    const withRamp = apply([{ kind: 'addModule', module: { id: 'slope', template: 'ramp', x: 8, z: 8, h: 0, orientation: 'E', ports: ['E', 'W'] } }]);
    expect(applyOperations(withRamp, [{ kind: 'addCorridor', corridor: { id: 'up', from: 'slope', direction: 'N', length: 2 } }]).ok).toBe(false);
  });

  it('a kept room cannot have a corridor opened out of it', () => {
    const op: Operation = { kind: 'addCorridor', corridor: { id: 'east-walk', from: 'start-walk', direction: 'E', length: 2 } };
    expect(touchesProtected([op], new Set(['start-walk']))).toBe(true);
    expect(touchesProtected([op], new Set(['goal-pad']), blankCanvasLevel)).toBe(false);
  });
});

describe('a big world in few operations', () => {
  it('thirty-odd rooms from a handful of operations, verified like any other level', () => {
    const operations: Operation[] = [
      { kind: 'addArea', area: { id: 'yard', x: 3, z: 9, h: 0, width: 4, depth: 3, label: 'courtyard' } },
      { kind: 'addCorridor', corridor: { id: 'gate-walk', from: 'entry-pad', direction: 'W', length: 1, label: 'gate walk' } },
      { kind: 'addArea', area: { id: 'hall', x: 9, z: 2, h: 0, width: 4, depth: 3, label: 'great hall' } },
      { kind: 'addCorridor', corridor: { id: 'north-walk', from: 'goal-pad', direction: 'E', length: 1, label: 'north walk' } },
      { kind: 'addArea', area: { id: 'crypt', x: 1, z: 2, h: 0, width: 3, depth: 3, label: 'crypt' } },
      { kind: 'addCorridor', corridor: { id: 'crypt-walk', from: 'crypt-3-2', direction: 'E', length: 3, label: 'crypt passage' } },
      { kind: 'addItem', itemType: 'key', id: 'crypt-key', moduleId: 'crypt-1-1' },
      { kind: 'addDoor', door: { id: 'hall-gate', a: 'north-walk-1', b: 'goal-pad', conditions: { requiresKey: 'crypt-key' } } },
    ];
    const level = apply(operations);
    expect(level.modules.length).toBeGreaterThanOrEqual(30);
    expect(operations.length).toBeLessThan(10);
    expect(operationLabel(operations[0])).toBe('+ area: courtyard (4×3)');
    expect(operationLabel(operations[1])).toBe('+ corridor: gate walk ×1');
    expect(describeOperation(operations[0]!, blankCanvasLevel, level)).toMatch(/courtyard.*4 × 3 connected rooms/);
    const report = verify(level);
    expect(report.valid).toBe(true);
    expect(report.complete).toBe(true);
  });
});

describe('the AI can lay out areas and corridors', () => {
  it('parses them from the wire format (nulls for absent fields) and documents them in the prompt', async () => {
    const { normalizeWirePayload, compileResultSchema } = await import('../shared/compile-result');
    const { buildSystemPrompt } = await import('../api/_lib/prompt');
    const raw = JSON.stringify({
      type: 'patch',
      rationale: 'A courtyard and a walk.',
      assumptions: [],
      story: null,
      operations: [
        { kind: 'addArea', area: { id: 'yard', x: 2, z: 2, h: 0, width: 3, depth: 3, label: null } },
        { kind: 'addCorridor', corridor: { id: 'walk', from: 'yard-3-2', direction: 'E', length: 4, label: 'long walk', template: null } },
      ],
    });
    const parsed = compileResultSchema.safeParse(normalizeWirePayload(raw));
    expect(parsed.success).toBe(true);
    const prompt = buildSystemPrompt(blankCanvasLevel, 'rev');
    expect(prompt).toContain('"kind":"addArea"');
    expect(prompt).toContain('"kind":"addCorridor"');
  });
});

describe('kept landmarks', () => {
  it('a floor built beneath a kept landmark changes it, so protection refuses', () => {
    const withStatue = apply([{ kind: 'addProp', id: 'old-statue', prop: 'statue', x: 3, z: 3 }]);
    const raise: Operation = { kind: 'addModule', module: { id: 'plinth', template: 'flat', x: 3, z: 3, h: 1, ports: [] } };
    expect(touchesProtected([raise], new Set(['old-statue']), withStatue)).toBe(true);
    const elsewhere: Operation = { kind: 'addModule', module: { id: 'plinth', template: 'flat', x: 4, z: 3, h: 1, ports: [] } };
    expect(touchesProtected([elsewhere], new Set(['old-statue']), withStatue)).toBe(false);
  });
});

describe('rule proposals and Keep these', () => {
  it('judges a rule proposal by the level it would produce, not by the old rules', async () => {
    const { applyRuleProposal } = await import('../src/core/level');
    const { vaultEmptyLevel } = await import('../src/core/fixtures/vault-empty');
    // A level whose rule requires a key; the proposal drops the rule, removes
    // the key, and adds a switch on a kept floor.
    const keyed = apply([{ kind: 'addItem', itemType: 'key', id: 'brass-key', moduleId: 'key-balcony' }], vaultEmptyLevel);
    const base: Level = { ...keyed, requirements: [{ type: 'collectBeforeGoal', keyId: 'brass-key' }] };
    const proposal = {
      oldRequirements: base.requirements,
      newRequirements: [],
      operations: [
        { kind: 'removeItem', id: 'brass-key' },
        { kind: 'addItem', itemType: 'switch', id: 'floor-plate', moduleId: 'gallery' },
      ] as Operation[],
    };
    const candidate = applyRuleProposal(base, proposal);
    expect(candidate.ok).toBe(true);
    expect(applyOperations(base, proposal.operations).ok).toBe(false); // why the old check missed it
    expect(touchesProtected(proposal.operations, new Set(['gallery']), base, candidate.ok ? candidate.level : undefined)).toBe(true);
  });
});
