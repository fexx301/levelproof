import { goalRequirementViolated, stateKey, transitions, type GameState, type MoveRecord } from './movement.js';
import type { CompiledLevel } from './topology.js';
import { STATE_BOUND } from './verifier.js';

/**
 * Play-mode hints (§12): the next move of a shortest winning route from the
 * player's exact current state, found with the same `transitions()` the
 * verifier explores. A winning route must end at the goal with every design
 * requirement met. Keys and switches are already in the state; passThrough
 * modules are not (plain visits do not change the state), so the search
 * carries which of them the route has visited as an extra bitmask, seeded
 * from the player's own path so far. Goal states are not expanded, exactly
 * as in the verifier.
 */

export type Hint =
  | { kind: 'move'; move: MoveRecord; movesToGoal: number }
  /** The goal is still reachable, but only by breaking a design rule; the
   * move leads toward it. (The verifier's solution and recovery checks count
   * such routes; hints and the win card do not.) */
  | { kind: 'rule_blocked'; move: MoveRecord; movesToGoal: number }
  | { kind: 'at_goal' }
  | { kind: 'rule_broken' }
  | { kind: 'stranded' }
  | { kind: 'unknown' };

interface Node {
  state: GameState;
  passMask: number;
  first: MoveRecord | null;
  depth: number;
}

export function nextStep(
  compiled: CompiledLevel,
  state: GameState,
  visitedModules: ReadonlySet<string>,
  // Engine states × passThrough masks (at most three passThrough rules).
  cap: number = STATE_BOUND * 8,
): Hint {
  // Never advise walking into a guard while any other way wins: search
  // without captures first, and only then with them.
  if (compiled.patrols.length > 0) {
    const safe = search(compiled, state, visitedModules, cap, false);
    if (safe.kind === 'move' || safe.kind === 'at_goal' || safe.kind === 'rule_broken' || safe.kind === 'unknown') return safe;
    const any = search(compiled, state, visitedModules, cap, true);
    return any.kind === 'move' ? any : safe.kind === 'rule_blocked' ? safe : any;
  }
  return search(compiled, state, visitedModules, cap, true);
}

function search(
  compiled: CompiledLevel,
  state: GameState,
  visitedModules: ReadonlySet<string>,
  cap: number,
  allowCapture: boolean,
): Hint {
  if (state.moduleId === compiled.goal) {
    return goalRequirementViolated(compiled, state, visitedModules) ? { kind: 'rule_broken' } : { kind: 'at_goal' };
  }
  const passModules = [
    ...new Set(
      compiled.level.requirements.flatMap((requirement) => (requirement.type === 'passThrough' ? [requirement.moduleId] : [])),
    ),
  ];
  const passBit = new Map(passModules.map((id, index) => [id, 1 << index]));
  const markVisit = (mask: number, moduleId: string): number => mask | (passBit.get(moduleId) ?? 0);
  let seeded = 0;
  for (const id of visitedModules) seeded = markVisit(seeded, id);
  const allPassed = (1 << passModules.length) - 1;

  const winning = (node: Node): boolean => {
    if (node.state.moduleId !== compiled.goal) return false;
    if (node.passMask !== allPassed) return false;
    // Keys and switches: the shared live rule (passThrough already checked).
    const visitedAll = new Set(passModules);
    return !goalRequirementViolated(compiled, node.state, visitedAll);
  };

  const key = (node: Pick<Node, 'state' | 'passMask'>): string => `${stateKey(node.state)}|${node.passMask}`;
  const start: Node = { state, passMask: markVisit(seeded, state.moduleId), first: null, depth: 0 };
  const seen = new Set([key(start)]);
  const queue: Node[] = [start];
  let ruleBreaking: Node | null = null;
  for (let head = 0; head < queue.length; head++) {
    const node = queue[head]!;
    if (node.state.moduleId === compiled.goal) continue;
    for (const move of transitions(compiled, node.state)) {
      if (!allowCapture && move.events.caught !== undefined) continue;
      const next: Node = {
        state: move.after,
        // Caught restarts the level: rule tracking starts over at the spawn.
        passMask: move.events.caught !== undefined ? markVisit(0, move.after.moduleId) : markVisit(node.passMask, move.after.moduleId),
        first: node.first ?? move,
        depth: node.depth + 1,
      };
      if (winning(next)) return { kind: 'move', move: next.first!, movesToGoal: next.depth };
      if (ruleBreaking === null && next.state.moduleId === compiled.goal) ruleBreaking = next;
      const nextKey = key(next);
      if (seen.has(nextKey)) continue;
      if (seen.size >= cap) return { kind: 'unknown' };
      seen.add(nextKey);
      queue.push(next);
    }
  }
  if (ruleBreaking !== null) return { kind: 'rule_blocked', move: ruleBreaking.first!, movesToGoal: ruleBreaking.depth };
  return { kind: 'stranded' };
}

/**
 * Every state reachable from spawn that can still reach the goal (rules
 * aside) — the verifier's recovery semantics. Computed once per level so
 * play can flag a dead end on each move with a set lookup instead of a
 * search. Goal states are not expanded, as in the verifier.
 */
export function goalReachableStates(compiled: CompiledLevel, start: GameState): Set<string> {
  const reverse = new Map<string, string[]>();
  const seen = new Set([stateKey(start)]);
  const queue: GameState[] = [start];
  const goals: string[] = [];
  for (let head = 0; head < queue.length; head++) {
    const state = queue[head]!;
    const from = stateKey(state);
    if (state.moduleId === compiled.goal) {
      goals.push(from);
      continue;
    }
    for (const move of transitions(compiled, state)) {
      const to = stateKey(move.after);
      const back = reverse.get(to);
      if (back === undefined) reverse.set(to, [from]);
      else back.push(from);
      if (!seen.has(to)) {
        seen.add(to);
        queue.push(move.after);
      }
    }
  }
  const canWin = new Set(goals);
  const stack = [...goals];
  while (stack.length > 0) {
    for (const from of reverse.get(stack.pop()!) ?? []) {
      if (!canWin.has(from)) {
        canWin.add(from);
        stack.push(from);
      }
    }
  }
  return canWin;
}
