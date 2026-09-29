import { CARDINALS, type Cardinal } from '../../shared/schema.js';
import { centerPoint, traversalSegments, type Vec3 } from './catalog.js';
import { caughtBy, cycleOpen } from './hazards.js';
import { neighbor, type CompiledLevel } from './topology.js';

/**
 * Legal transitions, item effects, and door conditions (§6). Player, ghost,
 * verifier, and repair search all use this one implementation.
 */

/** Runtime state: position, collected keys, activated switches, and the
 * world's turn within its hazard cycle (always 0 without hazards). */
export interface GameState {
  moduleId: string;
  keyMask: number;
  switchMask: number;
  phase: number;
}

export interface MoveEvents {
  collectedKey?: string;
  activatedSwitch?: string;
  reachedGoal?: boolean;
  /** Caught by this guard: the level restarts (§6.4). */
  caught?: string;
}

/** A move in a direction, or (only in levels with hazards) waiting a turn. */
export type MoveAction = Cardinal | 'wait';

export interface MoveRecord {
  action: MoveAction;
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
  return `${state.moduleId}|${state.keyMask}|${state.switchMask}|${state.phase}`;
}

export function initialState(compiled: CompiledLevel): GameState {
  return { moduleId: compiled.spawn, keyMask: 0, switchMask: 0, phase: 0 };
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
  // A timed door is judged on the turn the move starts, like every condition.
  if (conditions?.cycle !== undefined && !cycleOpen(conditions.cycle, state.phase)) return false;
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
  // Every move or wait is one turn; guards step and timed doors tick with it.
  const nextPhase = compiled.cycle > 1 ? (state.phase + 1) % compiled.cycle : 0;
  const caughtOn = (to: string): string | null =>
    compiled.patrols.length > 0 ? caughtBy(compiled.patrols, state.phase, state.moduleId, to) : null;
  for (const action of CARDINALS) {
    const hop = neighbor(compiled, state.moduleId, action);
    if (!hop) continue;
    if (hop.edge.doorId !== undefined && !doorPassable(compiled, hop.edge.doorId, state)) continue;

    const collectedKey = compiled.keyByModule.get(hop.toId);
    const activatedSwitch = compiled.switchByModule.get(hop.toId);
    const keyBit = collectedKey !== undefined ? compiled.keyBit.get(collectedKey) : undefined;
    const switchBit = activatedSwitch !== undefined ? compiled.switchBit.get(activatedSwitch) : undefined;
    let after: GameState = {
      moduleId: hop.toId,
      keyMask: keyBit !== undefined ? state.keyMask | keyBit : state.keyMask,
      switchMask: switchBit !== undefined ? state.switchMask | switchBit : state.switchMask,
      phase: nextPhase,
    };

    let events: MoveEvents = {};
    if (collectedKey !== undefined && keyBit !== undefined && (state.keyMask & keyBit) === 0) {
      events.collectedKey = collectedKey;
    }
    if (activatedSwitch !== undefined && switchBit !== undefined && (state.switchMask & switchBit) === 0) {
      events.activatedSwitch = activatedSwitch;
    }
    if (after.moduleId === compiled.goal) events.reachedGoal = true;
    // Caught on arrival (or trading places with a guard): the level restarts.
    const guard = caughtOn(hop.toId);
    if (guard !== null) {
      after = initialState(compiled);
      events = { caught: guard };
    }

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
  // Waiting a turn exists only where something moves on its own.
  if (compiled.cycle > 1) {
    const here = compiled.moduleById.get(state.moduleId);
    if (here !== undefined) {
      const guard = caughtOn(state.moduleId);
      const stay = centerPoint(here);
      moves.push({
        action: 'wait',
        before: state,
        after: guard !== null ? initialState(compiled) : { ...state, phase: nextPhase },
        source: state.moduleId,
        destination: state.moduleId,
        events: guard !== null ? { caught: guard } : {},
        segments: [stay, stay],
      });
    }
  }
  const order = (action: MoveAction): number => (action === 'wait' ? CARDINALS.length : CARDINALS.indexOf(action));
  moves.sort((a, b) => {
    const byDirection = order(a.action) - order(b.action);
    if (byDirection !== 0) return byDirection;
    return a.destination < b.destination ? -1 : a.destination > b.destination ? 1 : 0;
  });
  return moves;
}

/**
 * Cornered (§6.4): every action from here — each move and the wait — gets
 * the player caught. Returns the guard that catches them first, else null.
 * Never true without guards.
 */
export function corneredBy(compiled: CompiledLevel, state: GameState): string | null {
  const moves = transitions(compiled, state);
  if (moves.length === 0 || moves.some((move) => move.events.caught === undefined)) return null;
  return moves[0]!.events.caught ?? null;
}

/** Validate one action against the state's legal transitions (§6). */
export function step(compiled: CompiledLevel, state: GameState, action: MoveAction): MoveRecord | null {
  return transitions(compiled, state).find((m) => m.action === action) ?? null;
}

/**
 * Live goal evaluation shared by manual play and any future actor. The
 * terminal GameState carries item masks, while passThrough needs the path
 * trace because plain module visits intentionally do not change the state.
 */
export function goalRequirementViolated(
  compiled: CompiledLevel,
  state: GameState,
  visitedModules: ReadonlySet<string>,
): boolean {
  if (state.moduleId !== compiled.goal) return false;
  return compiled.level.requirements.some((requirement) => {
    if (requirement.type === 'collectBeforeGoal') {
      const bit = compiled.keyBit.get(requirement.keyId);
      return bit !== undefined && (state.keyMask & bit) === 0;
    }
    if (requirement.type === 'switchNecessary') {
      const bit = compiled.switchBit.get(requirement.switchId);
      return bit !== undefined && (state.switchMask & bit) === 0;
    }
    return !visitedModules.has(requirement.moduleId);
  });
}
