import { describe, expect, it } from 'vitest';
import { blankCanvasLevel } from '../src/core/fixtures/blank-canvas';
import { gauntletLevel, overpassLevel, twinKeysLevel } from '../src/core/fixtures/gallery';
import { vaultEmptyLevel } from '../src/core/fixtures/vault-empty';
import { applyOperations, validateLevel } from '../src/core/level';
import { canonicalJson, decodeLevelShare, encodeLevelShare, revisionId } from '../src/core/serialize';
import { verify } from '../src/core/verifier';
import { summarizeChange, describeOperations } from '../src/core/operation-description';
import type { Level } from '../shared/schema';

/** Scenery is cosmetic: it round-trips everywhere a level goes and the engine never reads it. */

function withoutScenery(level: Level): Level {
  const copy = structuredClone(level);
  delete copy.scenery;
  delete copy.props;
  copy.keys = copy.keys.map((key) => ({ id: key.id, moduleId: key.moduleId }));
  return copy;
}

describe('scenery operations', () => {
  it('merges scenery fields and manages props atomically', () => {
    const applied = applyOperations(blankCanvasLevel, [
      { kind: 'setScenery', environment: 'forest', lighting: 'night' },
      { kind: 'setScenery', architecture: 'basalt' },
      { kind: 'addProp', id: 'old-oak', prop: 'tree', x: 5, z: 5 },
      { kind: 'addProp', id: 'guardian', prop: 'dragon', x: 8, z: 6 },
      { kind: 'moveProp', id: 'guardian', x: 6, z: 6 },
      { kind: 'removeProp', id: 'old-oak' },
    ]);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.level.scenery).toEqual({ environment: 'forest', lighting: 'night', architecture: 'basalt' });
    expect(applied.level.props).toEqual([{ id: 'guardian', prop: 'dragon', x: 6, z: 6 }]);
  });

  it('gives keys a cosmetic look but never gives switches one', () => {
    const key = applyOperations(blankCanvasLevel, [{ kind: 'addItem', itemType: 'key', id: 'torch', moduleId: 'start-walk', look: 'torch' }]);
    expect(key.ok && key.level.keys[0]).toEqual({ id: 'torch', moduleId: 'start-walk', look: 'torch' });
    const restyled = key.ok ? applyOperations(key.level, [{ kind: 'setKeyLook', id: 'torch', look: 'lantern' }]) : null;
    expect(restyled?.ok && restyled.level.keys[0]?.look).toBe('lantern');
    const plate = applyOperations(blankCanvasLevel, [{ kind: 'addItem', itemType: 'switch', id: 'plate', moduleId: 'start-walk', look: 'gem' }]);
    expect(plate.ok).toBe(false);
  });

  it('rejects water on a ground-level floor, id collisions, and crowded cells', () => {
    const wet = applyOperations(blankCanvasLevel, [{ kind: 'addProp', id: 'river', prop: 'water', x: 7, z: 7 }]);
    expect(wet.ok).toBe(false);
    const collision = applyOperations(blankCanvasLevel, [{ kind: 'addProp', id: 'goal-pad', prop: 'rock', x: 2, z: 2 }]);
    expect(collision.ok).toBe(false);
    const crowded = applyOperations(blankCanvasLevel, [0, 1, 2, 3, 4].map((index) => ({ kind: 'addProp' as const, id: `rock-${index}`, prop: 'rock' as const, x: 2, z: 2 })));
    expect(crowded.ok).toBe(false);
    const moat = applyOperations(blankCanvasLevel, [{ kind: 'addProp', id: 'moat', prop: 'water', x: 6, z: 7 }]);
    expect(moat.ok).toBe(true);
  });

  it('removing the last prop returns the exact revision of the undressed level', () => {
    const added = applyOperations(blankCanvasLevel, [{ kind: 'addProp', id: 'stone', prop: 'rock', x: 1, z: 1 }]);
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(revisionId(added.level)).not.toBe(revisionId(blankCanvasLevel));
    const removed = applyOperations(added.level, [{ kind: 'removeProp', id: 'stone' }]);
    expect(removed.ok && removed.level.props).toBeUndefined();
    expect(removed.ok && revisionId(removed.level)).toBe(revisionId(blankCanvasLevel));
  });
});

describe('scenery never changes the verdict', () => {
  for (const [name, level] of [
    ['vault', vaultEmptyLevel],
    ['twin keys', twinKeysLevel],
    ['overpass', overpassLevel],
    ['gauntlet', gauntletLevel],
  ] as const) {
    it(`${name}: identical checks with and without its scenery`, () => {
      expect(level.scenery).toBeDefined();
      expect(validateLevel(level)).toEqual([]);
      const dressed = verify(level);
      const bare = verify(withoutScenery(level));
      expect(dressed.accepted).toBe(true);
      expect(dressed.exploredCount).toBe(bare.exploredCount);
      for (const check of ['solution', 'requirements', 'recovery'] as const) {
        expect(dressed.checks[check].status).toBe(bare.checks[check].status);
        expect(dressed.checks[check].explanation).toBe(bare.checks[check].explanation);
      }
    });
  }

  it('keeps pre-scenery revision identities stable', () => {
    expect(canonicalJson(blankCanvasLevel)).not.toContain('scenery');
    expect(canonicalJson(blankCanvasLevel)).not.toContain('props');
  });

  it('round-trips scenery through share links', () => {
    const decoded = decodeLevelShare(encodeLevelShare(gauntletLevel));
    expect(decoded).not.toBeNull();
    expect(revisionId(decoded!)).toBe(revisionId(gauntletLevel));
    expect(decoded!.props?.find((prop) => prop.id === 'vault-dragon')?.prop).toBe('dragon');
  });
});

describe('plain-language change summaries', () => {
  it('counts a from-scratch build including its scenery', () => {
    const applied = applyOperations(blankCanvasLevel, [
      { kind: 'addModule', module: { id: 'tower-stair', template: 'ramp', x: 8, z: 7, h: 0, orientation: 'E', ports: ['W', 'E'] } },
      { kind: 'addModule', module: { id: 'tower-top', template: 'flat', x: 9, z: 7, h: 1, ports: ['W'] } },
      { kind: 'setModulePorts', id: 'start-walk', ports: ['N', 'S', 'E'] },
      { kind: 'addItem', itemType: 'key', id: 'crown', moduleId: 'tower-top', look: 'crown' },
      { kind: 'setScenery', environment: 'snow', lighting: 'dusk' },
      { kind: 'addProp', id: 'pine-a', prop: 'pine', x: 5, z: 5 },
    ]);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(summarizeChange(blankCanvasLevel, applied.level)).toBe(
      'Builds 2 platforms (1 ramp), adds 1 key, sets a snowfield at dusk, places 1 landmark.',
    );
  });

  it('omits exit changes that change nothing', () => {
    expect(describeOperations([{ kind: 'setModulePorts', id: 'goal-pad', ports: ['S'] }], blankCanvasLevel, blankCanvasLevel)).toEqual([]);
  });
});
