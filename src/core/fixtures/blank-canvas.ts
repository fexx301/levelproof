import type { Level } from '../../../shared/schema';

/**
 * The blank canvas (§12): a minimal, trivially-green seed for from-scratch
 * generation — describe a puzzle in plain language and the model builds the
 * whole thing. Spawn, one walk, goal: everything else is up to the author.
 */
export const blankCanvasLevel: Level = {
  modules: [
    { id: 'entry-pad', template: 'flat', x: 7, z: 8, h: 0, ports: ['N'] },
    { id: 'start-walk', template: 'flat', x: 7, z: 7, h: 0, ports: ['N', 'S'] },
    { id: 'goal-pad', template: 'flat', x: 7, z: 6, h: 0, ports: ['S'] },
  ],
  keys: [],
  switches: [],
  spawn: 'entry-pad',
  goal: 'goal-pad',
  doors: [],
  requirements: [],
};
