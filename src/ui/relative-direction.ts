import type { Cardinal } from '../../shared/schema.js';

/** Screen-relative intents for manual play: W / ↑ always means "away from me". */
export type MoveIntent = 'forward' | 'back' | 'left' | 'right';

const RIGHT_OF: Record<Cardinal, Cardinal> = { N: 'E', E: 'S', S: 'W', W: 'N' };
const OPPOSITE: Record<Cardinal, Cardinal> = { N: 'S', S: 'N', E: 'W', W: 'E' };

/** The grid direction for an intent, given the direction the camera faces. */
export function relativeCardinal(facing: Cardinal, intent: MoveIntent): Cardinal {
  switch (intent) {
    case 'forward':
      return facing;
    case 'back':
      return OPPOSITE[facing];
    case 'right':
      return RIGHT_OF[facing];
    case 'left':
      return OPPOSITE[RIGHT_OF[facing]];
  }
}

export const CARDINAL_NAMES: Record<Cardinal, string> = { N: 'north', E: 'east', S: 'south', W: 'west' };

export const KEY_INTENTS: Record<string, MoveIntent> = {
  w: 'forward',
  W: 'forward',
  ArrowUp: 'forward',
  s: 'back',
  S: 'back',
  ArrowDown: 'back',
  a: 'left',
  A: 'left',
  ArrowLeft: 'left',
  d: 'right',
  D: 'right',
  ArrowRight: 'right',
};
