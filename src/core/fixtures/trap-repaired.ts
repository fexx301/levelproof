import type { Level } from '../../../shared/schema';
import { baselineLevel } from './baseline';

/**
 * The accepted state after the switch-relocation repair of §8.2: the seal
 * switch now sits on vault-entry, behind the key-locked vault door, so it
 * can only trigger after the key is collected. All three checks pass. This
 * is the base for prompt 3 (the bridge bypass).
 */
export const trapRepairedLevel: Level = {
  ...baselineLevel,
  switches: [{ id: 'seal-switch', moduleId: 'vault-entry' }],
  doors: [
    ...baselineLevel.doors,
    { id: 'gallery-door', a: 'gallery', b: 'bridge-landing', conditions: { closesAfterSwitch: 'seal-switch' } },
  ],
};
