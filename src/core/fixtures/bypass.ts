import type { Level } from '../../../shared/schema';
import { trapRepairedLevel } from './trap-repaired';

/**
 * Golden fixture: the bridge bypass (§8.3) — prompt 3 applied to the
 * accepted switch-relocation repair. Four bridge modules at z=0 connect the
 * upper gallery straight to the treasure landing; side rails prevent links
 * to the vault row. Solution passes, requirement FAILS (a keyless winning
 * route exists), recovery passes.
 */
export const bypassLevel: Level = {
  ...trapRepairedLevel,
  modules: [
    ...trapRepairedLevel.modules,
    { id: 'bridge-west', template: 'bridge', x: 1, z: 0, h: 1, ports: ['S', 'E'] },
    { id: 'bridge-mid-west', template: 'bridge', x: 2, z: 0, h: 1, ports: ['W', 'E'] },
    { id: 'bridge-mid-east', template: 'bridge', x: 3, z: 0, h: 1, ports: ['W', 'E'] },
    { id: 'bridge-east', template: 'bridge', x: 4, z: 0, h: 1, ports: ['W', 'S'] },
  ],
};
