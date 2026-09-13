import type { Level } from '../../../shared/schema';

/**
 * Gallery scenes (§12): three hand-authored showcase levels, each verified
 * green by the same engine as everything else. Distinct identities: the
 * Twin Keys (ordered keys and a powered return loop), the Overpass (a
 * two-elevation relay circuit), and the Gauntlet (prepare, arm, commit).
 * Every reachable state remains recoverable, not just the intended route.
 */

export const twinKeysLevel: Level = {
  modules: [
    { id: 'entrance', template: 'flat', x: 6, z: 8, h: 0, ports: ['N'] },
    { id: 'lower-hall', template: 'flat', x: 6, z: 7, h: 0, ports: ['N', 'S'] },
    { id: 'grand-stair', template: 'ramp', x: 6, z: 6, h: 0, orientation: 'N', ports: ['S', 'N'] },
    { id: 'grand-gallery', template: 'flat', x: 6, z: 5, h: 1, label: 'twin gallery', ports: ['N', 'E', 'S', 'W'] },
    { id: 'west-walk', template: 'flat', x: 5, z: 5, h: 1, ports: ['E', 'W'] },
    { id: 'west-balcony', template: 'flat', x: 4, z: 5, h: 1, label: 'silver balcony', ports: ['E'] },
    { id: 'east-walk', template: 'flat', x: 7, z: 5, h: 1, ports: ['W', 'E'] },
    { id: 'east-balcony', template: 'flat', x: 8, z: 5, h: 1, label: 'gold balcony', ports: ['W', 'N'] },
    { id: 'east-return', template: 'flat', x: 8, z: 4, h: 1, label: 'vault power room', ports: ['S', 'W'] },
    { id: 'north-return', template: 'bridge', x: 7, z: 4, h: 1, label: 'return bridge', ports: ['E', 'W'] },
    { id: 'north-approach', template: 'flat', x: 6, z: 4, h: 1, ports: ['N', 'S', 'E'] },
    { id: 'inner-sanctum', template: 'flat', x: 6, z: 3, h: 1, ports: ['S', 'N'] },
    { id: 'treasure-vault', template: 'flat', x: 6, z: 2, h: 1, label: 'twin vault', ports: ['S'] },
  ],
  keys: [
    { id: 'silver-key', moduleId: 'west-balcony' },
    { id: 'gold-key', moduleId: 'east-balcony' },
  ],
  switches: [{ id: 'vault-power', moduleId: 'east-return' }],
  spawn: 'entrance',
  goal: 'treasure-vault',
  doors: [
    { id: 'gold-wing-door', a: 'east-walk', b: 'east-balcony', conditions: { requiresKey: 'silver-key' } },
    { id: 'return-door', a: 'north-approach', b: 'north-return', conditions: { requiresKey: 'gold-key' } },
    { id: 'outer-vault-door', a: 'north-approach', b: 'inner-sanctum', conditions: { requiresKeys: ['silver-key', 'gold-key'] } },
    { id: 'inner-vault-door', a: 'inner-sanctum', b: 'treasure-vault', conditions: { requiresSwitch: 'vault-power' } },
  ],
  requirements: [
    { type: 'collectBeforeGoal', keyId: 'silver-key' },
    { type: 'collectBeforeGoal', keyId: 'gold-key' },
  ],
};

export const overpassLevel: Level = {
  modules: [
    // Lower corridor running north; the key hides at its far end.
    { id: 'south-gate', template: 'flat', x: 8, z: 11, h: 0, ports: ['N'] },
    { id: 'under-hall', template: 'flat', x: 8, z: 10, h: 0, ports: ['N', 'S'] },
    { id: 'under-passage', template: 'flat', x: 8, z: 9, h: 0, label: 'under the bridge', ports: ['N', 'S'] },
    { id: 'under-north', template: 'flat', x: 8, z: 8, h: 0, ports: ['S', 'E', 'N'] },
    { id: 'key-deep', template: 'flat', x: 8, z: 7, h: 0, label: 'deep key room', ports: ['S', 'W'] },
    // The only way up: a ramp off the lower corridor's east side.
    { id: 'climb-ramp', template: 'ramp', x: 9, z: 8, h: 0, orientation: 'E', ports: ['W', 'E'] },
    // Upper loft and the sky bridge — bridge-b crosses DIRECTLY over the
    // under-passage at (8,9): true floor-over-floor.
    { id: 'east-loft', template: 'flat', x: 10, z: 8, h: 1, ports: ['W', 'S'] },
    { id: 'bridge-a', template: 'bridge', x: 10, z: 9, h: 1, ports: ['N', 'W'] },
    { id: 'bridge-b', template: 'bridge', x: 9, z: 9, h: 1, ports: ['E', 'W'] },
    { id: 'bridge-c', template: 'bridge', x: 8, z: 9, h: 1, label: 'the overpass', ports: ['E', 'W'] },
    { id: 'bridge-d', template: 'bridge', x: 7, z: 9, h: 1, ports: ['E', 'W'] },
    { id: 'west-loft', template: 'flat', x: 6, z: 9, h: 1, label: 'upper relay', ports: ['E', 'N'] },
    { id: 'return-ramp', template: 'ramp', x: 6, z: 8, h: 0, orientation: 'S', ports: ['N', 'S'] },
    { id: 'lower-west', template: 'flat', x: 6, z: 7, h: 0, label: 'return landing', ports: ['S', 'E'] },
    { id: 'relay-vault', template: 'flat', x: 7, z: 7, h: 0, label: 'relay vault', ports: ['W', 'E'] },
  ],
  keys: [{ id: 'pass-key', moduleId: 'key-deep' }],
  switches: [{ id: 'bridge-relay', moduleId: 'west-loft' }],
  spawn: 'south-gate',
  goal: 'relay-vault',
  doors: [
    { id: 'overpass-door', a: 'bridge-b', b: 'bridge-c', conditions: { requiresKey: 'pass-key' } },
    { id: 'relay-exit', a: 'lower-west', b: 'relay-vault', conditions: { requiresSwitch: 'bridge-relay', requiresKey: 'pass-key' } },
    { id: 'vault-shortcut', a: 'key-deep', b: 'relay-vault', conditions: { requiresSwitch: 'bridge-relay', requiresKey: 'pass-key' } },
    { id: 'lower-seal', a: 'under-north', b: 'key-deep', conditions: { closesAfterSwitch: 'bridge-relay' } },
  ],
  requirements: [{ type: 'collectBeforeGoal', keyId: 'pass-key' }],
};

export const gauntletLevel: Level = {
  modules: [
    // The winding climb from the south.
    { id: 'entrance', template: 'flat', x: 2, z: 13, h: 0, ports: ['N'] },
    { id: 'hall-one', template: 'flat', x: 2, z: 12, h: 0, ports: ['N', 'S'] },
    { id: 'bend-south', template: 'flat', x: 2, z: 11, h: 0, ports: ['S', 'E'] },
    { id: 'low-run', template: 'flat', x: 3, z: 11, h: 0, ports: ['W', 'E'] },
    { id: 'bend-north', template: 'flat', x: 4, z: 11, h: 0, ports: ['W', 'N'] },
    { id: 'gauntlet-ramp', template: 'ramp', x: 4, z: 10, h: 0, orientation: 'N', ports: ['S', 'N'] },
    // The upper meander.
    { id: 'gallery-start', template: 'flat', x: 4, z: 9, h: 1, ports: ['S', 'E'] },
    { id: 'gallery-run', template: 'flat', x: 5, z: 9, h: 1, ports: ['W', 'E', 'S'] },
    { id: 'key-walk', template: 'flat', x: 5, z: 10, h: 1, ports: ['N', 'S'] },
    { id: 'key-nook', template: 'flat', x: 5, z: 11, h: 1, label: 'gauntlet key nook', ports: ['N'] },
    { id: 'gallery-mid', template: 'flat', x: 6, z: 9, h: 1, ports: ['W', 'E'] },
    { id: 'gallery-end', template: 'flat', x: 7, z: 9, h: 1, ports: ['W', 'N'] },
    // The gated vault.
    { id: 'vault-approach', template: 'flat', x: 7, z: 8, h: 1, ports: ['S', 'N', 'E'] },
    { id: 'sanctum', template: 'flat', x: 7, z: 7, h: 1, ports: ['S', 'N'] },
    { id: 'treasure-room', template: 'flat', x: 7, z: 6, h: 1, label: 'gauntlet vault', ports: ['S'] },
    // The side room is now essential: arm the gate before committing.
    { id: 'bonus-walk', template: 'flat', x: 8, z: 8, h: 1, label: 'arming chamber', ports: ['W'] },
  ],
  keys: [{ id: 'brass-key', moduleId: 'key-nook' }],
  switches: [{ id: 'vault-seal', moduleId: 'sanctum' }, { id: 'gate-primer', moduleId: 'bonus-walk' }],
  spawn: 'entrance',
  goal: 'treasure-room',
  doors: [
    { id: 'gauntlet-door', a: 'vault-approach', b: 'sanctum', conditions: { requiresKey: 'brass-key', requiresSwitch: 'gate-primer', closesAfterSwitch: 'vault-seal' } },
    { id: 'treasure-door', a: 'sanctum', b: 'treasure-room', conditions: { requiresSwitch: 'vault-seal' } },
  ],
  requirements: [{ type: 'collectBeforeGoal', keyId: 'brass-key' }],
};
