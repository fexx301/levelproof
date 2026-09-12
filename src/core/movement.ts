import { CARDINALS, type Cardinal } from '../../shared/schema.js';
import { traversalSegments, type Vec3 } from './catalog.js';
import { neighbor, type CompiledLevel } from './topology.js';

/**
 * Legal transitions, item effects, and door conditions (§6). Player, ghost,
 * verifier, and repair search all use this one implementation.
 */

/** Runtime state: position plus collected keys and activated switches. */
export interface GameState {
  moduleId: string;
  keyMask: number;
  switchMask: number;
}

export interface MoveEvents {
  collectedKey?: string;
  activatedSwitch?: string;
  reachedGoal?: boolean;
}

export interface MoveRecord {
  action: Cardinal;
  before: GameState;
  after: GameState;
  source: string;
  destination: string;
  doorId?: string;
  events: MoveEvents;
  /** Catalog polyline: source center, shared port, destination center. */
  segments: Vec3[];
}

export function stateKey(state: GameState): string {
  return `${state.moduleId}|${state.keyMask}|${state.switchMask}`;
}

export function initialState(compiled: CompiledLevel): GameState {
  return { moduleId: compiled.spawn, keyMask: 0, switchMask: 0 };
}

/**
 * All conditions on a door must allow traversal, judged against the
 * pre-move state (§4.3): a required key must be held, a required switch
 * must be active, and a sealing switch must not yet have activated.
 */
export function doorPassable(compiled: CompiledLevel, doorId: string, state: GameState): boolean {
  const door = compiled.doorById.get(doorId);
  if (!door) return true;
  const conditions = door.conditions;
  if (conditions?.requiresKey !== undefined) {
    const bit = compiled.keyBit.get(conditions.requiresKey);
    if (bit === undefined || (state.keyMask & bit) === 0) return false;
  }
  if (conditions?.requiresKeys !== undefined) {
    for (const keyId of conditions.requiresKeys) {
      const bit = compiled.keyBit.get(keyId);
      if (bit === undefined || (state.keyMask & bit) === 0) return false;
    }
  }
  if (conditions?.requiresSwitch !== undefined) {
    const bit = compiled.switchBit.get(conditions.requiresSwitch);
    if (bit === undefined || (state.switchMask & bit) === 0) return false;
  }
  if (conditions?.closesAfterSwitch !== undefined) {
    const bit = compiled.switchBit.get(conditions.closesAfterSwitch);
    if (bit !== undefined && (state.switchMask & bit) !== 0) return false;
  }
  return true;
}

/**
 * Every legal move from a state, in N/E/S/W order with destination id as
 * tie-break (§6). Goal states are terminal and return no moves. Move order:
 * validate adjacency and door conditions against the pre-move state, cross,
 * arrive, collect a key or activate a switch, then recognize the goal.
 */
export function transitions(compiled: CompiledLevel, state: GameState): MoveRecord[] {
  if (state.moduleId === compiled.goal) return [];
  const moves: MoveRecord[] = [];
  for (const action of CARDINALS) {
    const hop = neighbor(compiled, state.moduleId, action);
    if (!hop) continue;
    if (hop.edge.doorId !== undefined && !doorPassable(compiled, hop.edge.doorId, state)) continue;

    const collectedKey = compiled.keyByModule.get(hop.toId);
    const activatedSwitch = compiled.switchByModule.get(hop.toId);
    const keyBit = collectedKey !== undefined ? compiled.keyBit.get(collectedKey) : undefined;
    const switchBit = activatedSwitch !== undefined ? compiled.switchBit.get(activatedSwitch) : undefined;
    const after: GameState = {
      moduleId: hop.toId,
      keyMask: keyBit !== undefined ? state.keyMask | keyBit : state.keyMask,
      switchMask: switchBit !== undefined ? state.switchMask | switchBit : state.switchMask,
    };

    const events: MoveEvents = {};
    if (collectedKey !== undefined && keyBit !== undefined && (state.keyMask & keyBit) === 0) {
      events.collectedKey = collectedKey;
    }
    if (activatedSwitch !== undefined && switchBit !== undefined && (state.switchMask & switchBit) === 0) {
      events.activatedSwitch = activatedSwitch;
    }
    if (after.moduleId === compiled.goal) events.reachedGoal = true;

    const source = compiled.moduleById.get(state.moduleId);
    const destination = compiled.moduleById.get(hop.toId);
    if (!source || !destination) continue; // impossible for validated levels
    moves.push({
      action,
      before: state,
      after,
      source: state.moduleId,
      destination: hop.toId,
      ...(hop.edge.doorId !== undefined ? { doorId: hop.edge.doorId } : {}),
      events,
      segments: traversalSegments(source, action, destination),
    });
  }
  moves.sort((a, b) => {
    const byDirection = CARDINALS.indexOf(a.action) - CARDINALS.indexOf(b.action);
    if (byDirection !== 0) return byDirection;
    return a.destination < b.destination ? -1 : a.destination > b.destination ? 1 : 0;
  });
  return moves;
}

/** Validate one action against the state's legal transitions (§6). */
export function step(compiled: CompiledLevel, state: GameState, action: Cardinal): MoveRecord | null {
  return transitions(compiled, state).find((m) => m.action === action) ?? null;
}
