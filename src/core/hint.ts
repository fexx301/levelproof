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
  cap: number = STATE_BOUND * 4,
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
      const next: Node = {
        state: move.after,
        passMask: markVisit(node.passMask, move.after.moduleId),
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
