import type { Level } from '../../../shared/schema';
import { baselineLevel } from './baseline';

/**
 * Golden fixture: the switch trap (§8.2) — prompt 2 applied to the accepted
 * baseline. `gallery-door` between the upper foyer (gallery) and the upper
 * gallery (bridge-landing) is initially open and seals permanently once
 * `seal-switch` on the vault approach activates. A winning route still
 * exists (collect the key first), but a player who seals the door before
 * collecting the key is stranded: solution passes, requirement passes,
 * recovery FAILS with the witness
 * entrance → lower-hall → gallery-ramp → gallery → bridge-landing → vault-approach.
 */
export const trapLevel: Level = {
  ...baselineLevel,
  switches: [{ id: 'seal-switch', moduleId: 'vault-approach' }],
  doors: [
    ...baselineLevel.doors,
    { id: 'gallery-door', a: 'gallery', b: 'bridge-landing', conditions: { closesAfterSwitch: 'seal-switch' } },
  ],
};
