import type { Level } from '../../../shared/schema';

/**
 * Golden fixture: Balcony Vault, baseline state (§8.1) — the expected result
 * of prompt 1 (brass key on the side balcony, keyed vault door, explicit
 * collectBeforeGoal rule). Geometry per the §8 table; unlisted ports closed.
 * N = -z, E = +x. Labels match §8 so references are unambiguous.
 */
export const baselineLevel: Level = {
  modules: [
    { id: 'entrance', template: 'flat', x: 1, z: 5, h: 0, ports: ['N'] },
    { id: 'lower-hall', template: 'flat', x: 1, z: 4, h: 0, ports: ['N', 'S'] },
    { id: 'gallery-ramp', template: 'ramp', x: 1, z: 3, h: 0, orientation: 'N', ports: ['S', 'N'] },
    { id: 'gallery', template: 'flat', x: 1, z: 2, h: 1, label: 'upper foyer', ports: ['N', 'E', 'S'] },
    { id: 'key-walk', template: 'flat', x: 2, z: 2, h: 1, ports: ['E', 'W'] },
    { id: 'key-balcony', template: 'flat', x: 3, z: 2, h: 1, label: 'side balcony', ports: ['W'] },
    { id: 'bridge-landing', template: 'flat', x: 1, z: 1, h: 1, label: 'upper gallery', ports: ['N', 'E', 'S'] },
    { id: 'vault-approach', template: 'flat', x: 2, z: 1, h: 1, label: 'vault approach', ports: ['E', 'W'] },
    { id: 'vault-entry', template: 'flat', x: 3, z: 1, h: 1, label: 'vault entry', ports: ['E', 'W'] },
    { id: 'treasure-landing', template: 'flat', x: 4, z: 1, h: 1, label: 'treasure landing', ports: ['N', 'W'] },
  ],
  keys: [{ id: 'brass-key', moduleId: 'key-balcony' }],
  switches: [],
  spawn: 'entrance',
  goal: 'treasure-landing',
  doors: [
    { id: 'vault-door', a: 'vault-approach', b: 'vault-entry', conditions: { requiresKey: 'brass-key' } },
  ],
  requirements: [{ type: 'collectBeforeGoal', keyId: 'brass-key' }],
  // Cosmetic dressing (§12 visual identity): never read by the engine.
  scenery: { environment: 'meadow', lighting: 'dusk', architecture: 'limestone' },
  props: [
    { id: 'hoard-brazier', prop: 'brazier', x: 4, z: 1 },
    { id: 'gate-torch', prop: 'torch', x: 1, z: 5 },
    { id: 'west-ruin', prop: 'ruin', x: 0, z: 3 },
    { id: 'north-pillar', prop: 'pillar', x: 2, z: 0 },
    { id: 'vault-banner', prop: 'banner', x: 3, z: 0 },
    { id: 'far-pillar', prop: 'pillar', x: 4, z: 0 },
  ],
};
