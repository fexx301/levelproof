import type { Level } from '../../../shared/schema';

/**
 * The held-out unfamiliar layout (§8.4): a second supported puzzle with
 * different labels, key placement, and shortcut position. Used ONLY for the
 * §13 gate — a real natural-language edit must produce a correct playable
 * diagnosis with no fixture-specific logic. Never used to tune prompts.
 *
 * The iron key sits on the lower floor (side crypt); the strong room door
 * on the upper floor requires it. The natural shortcut runs along the
 * empty north row (z=1), a different position from the vault's bridge row.
 */
export const unfamiliarLevel: Level = {
  modules: [
    { id: 'great-hall', template: 'flat', x: 2, z: 5, h: 0, label: 'great hall', ports: ['N'] },
    { id: 'corridor', template: 'flat', x: 2, z: 4, h: 0, label: 'corridor', ports: ['N', 'S', 'W'] },
    { id: 'side-crypt', template: 'flat', x: 1, z: 4, h: 0, label: 'side crypt', ports: ['E'] },
    { id: 'spiral-stair', template: 'ramp', x: 2, z: 3, h: 0, orientation: 'N', label: 'spiral stair', ports: ['S', 'N'] },
    { id: 'watch-gallery', template: 'flat', x: 2, z: 2, h: 1, label: 'watch gallery', ports: ['N', 'E', 'S'] },
    { id: 'strong-approach', template: 'flat', x: 3, z: 2, h: 1, label: 'strong room approach', ports: ['E', 'W'] },
    { id: 'strong-entry', template: 'flat', x: 4, z: 2, h: 1, label: 'strong room', ports: ['E', 'W'] },
    { id: 'prize-chamber', template: 'flat', x: 5, z: 2, h: 1, label: 'prize chamber', ports: ['N', 'W'] },
  ],
  keys: [{ id: 'iron-key', moduleId: 'side-crypt' }],
  switches: [],
  spawn: 'great-hall',
  goal: 'prize-chamber',
  doors: [
    { id: 'strong-door', a: 'strong-approach', b: 'strong-entry', conditions: { requiresKey: 'iron-key' } },
  ],
  requirements: [{ type: 'collectBeforeGoal', keyId: 'iron-key' }],
};
