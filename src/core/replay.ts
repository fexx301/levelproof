import type { Level } from '../../shared/schema.js';
import { initialState, step, type GameState, type MoveRecord } from './movement.js';
import { compileLevel } from './topology.js';

export interface RouteValidation {
  ok: boolean;
  endState: GameState;
  reason?: string;
}

/** Re-check a stored witness against the repaired level before replaying it. */
export function validateRoute(level: Level, route: MoveRecord[]): RouteValidation {
  const compiled = compileLevel(level);
  let state = initialState(compiled);
  for (const [index, move] of route.entries()) {
    const actual = step(compiled, state, move.action);
    if (actual === null) {
      return { ok: false, endState: state, reason: `move ${index + 1} (${move.action}) is no longer legal from “${state.moduleId}”.` };
    }
    state = actual.after;
  }
  return { ok: true, endState: state };
}
