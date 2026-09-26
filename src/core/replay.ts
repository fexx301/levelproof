import type { Level } from '../../shared/schema.js';
import { initialState, step, type GameState, type MoveRecord } from './movement.js';
import { compileLevel } from './topology.js';

export interface RouteValidation {
  ok: boolean;
  endState: GameState;
  /** The same actions re-stepped on this level: fresh states, segments, and
   * key/switch events. Replay this, never the stored records, which describe
   * the level the witness came from. */
  route: MoveRecord[];
  reason?: string;
}

/** Re-check a stored witness against the repaired level before replaying it. */
export function validateRoute(level: Level, route: MoveRecord[]): RouteValidation {
  const compiled = compileLevel(level);
  let state = initialState(compiled);
  const rebuilt: MoveRecord[] = [];
  for (const [index, move] of route.entries()) {
    const actual = step(compiled, state, move.action);
    if (actual === null) {
      return { ok: false, endState: state, route: rebuilt, reason: `move ${index + 1} (${move.action}) is no longer legal from “${state.moduleId}”.` };
    }
    rebuilt.push(actual);
    state = actual.after;
  }
  return { ok: true, endState: state, route: rebuilt };
}
