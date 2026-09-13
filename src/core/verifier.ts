import type { Level, Requirement } from '../../shared/schema.js';
import { CATALOG_VERSION } from './catalog.js';
import { validateLevel } from './level.js';
import { initialState, stateKey, step, transitions, type GameState, type MoveRecord } from './movement.js';
import { compileLevel, type CompiledLevel } from './topology.js';
import { revisionId } from './serialize.js';

/**
 * Bounded exploration and the three separate checks (§7). Pure: no DOM, no
 * network, no clock. Incomplete checks never become a green result.
 */

export const VERIFIER_VERSION = 'verifier-1.0.0';

/** 256 modules × 2^3 key masks × 2^4 switch masks (§7.1). */
export const STATE_BOUND = 256 * 2 ** 3 * 2 ** 4;

export type CheckStatus = 'pass' | 'fail' | 'unknown' | 'not_applicable';

export interface CheckResult {
  status: CheckStatus;
  explanation: string;
}

export type WitnessKind = 'solution' | 'bypass' | 'dead_end';

export interface Witness {
  kind: WitnessKind;
  route: MoveRecord[];
  endState: GameState;
  missingKeys?: string[];
  /** For bypass witnesses: the violated requirement and a short display
   * phrase ("without the brass-key") for labels and narration. */
  requirement?: Requirement;
  violationText?: string;
}

export interface CheckedResult extends CheckResult {
  witness?: Witness;
}

export interface RecoveryMap {
  /** Modules holding at least one reachable state that can no longer win. */
  stranded: string[];
  /** Modules no reachable state ever visits. */
  unreachable: string[];
}

export interface Report {
  valid: boolean;
  invalidReasons: string[];
  revisionId: string;
  catalogVersion: string;
  verifierVersion: string;
  requirements: Requirement[];
  complete: boolean;
  completionExplanation: string;
  exploredCount: number;
  /** Per-module recovery analysis for visualization; only when complete. */
  recoveryMap?: RecoveryMap;
  checks: {
    solution: CheckedResult;
    requirements: CheckedResult;
    recovery: CheckedResult;
  };
  internalError?: string;
  accepted: boolean;
}

export interface VerifierConfig {
  explorationCap?: number;
}

interface Visit {
  order: number;
  parentKey: string | null;
  viaMove: MoveRecord | null;
  state: GameState;
}

/** Replay a witness through core step from the real initial state (§7.3). */
function replayWitness(compiled: CompiledLevel, witness: Witness): string | undefined {
  let state = initialState(compiled);
  for (const move of witness.route) {
    const actual = step(compiled, state, move.action);
    if (actual === null) {
      return `Witness replay failed: move ${move.action} from "${state.moduleId}" is not legal.`;
    }
    if (actual.destination !== move.destination || stateKey(actual.after) !== stateKey(move.after)) {
      return `Witness replay diverged moving ${move.action} from "${state.moduleId}".`;
    }
    state = actual.after;
  }
  if (stateKey(state) !== stateKey(witness.endState)) {
    return 'Witness replay ended in a different state than claimed.';
  }
  if (witness.kind === 'solution' || witness.kind === 'bypass') {
    if (state.moduleId !== compiled.goal) {
      return `A ${witness.kind} witness must end at the goal.`;
    }
    if (witness.kind === 'bypass') {
      for (const keyId of witness.missingKeys ?? []) {
        const bit = compiled.keyBit.get(keyId);
        if (bit !== undefined && (state.keyMask & bit) !== 0) {
          return `Bypass witness claims "${keyId}" is missing, but it was collected.`;
        }
      }
      if (witness.requirement !== undefined) {
        const requirement = witness.requirement;
        if (requirement.type === 'collectBeforeGoal') {
          const bit = compiled.keyBit.get(requirement.keyId);
          if (bit !== undefined && (state.keyMask & bit) !== 0) {
            return `Bypass witness claims "${requirement.keyId}" is missing, but it was collected.`;
          }
        } else if (requirement.type === 'switchNecessary') {
          const bit = compiled.switchBit.get(requirement.switchId);
          if (bit !== undefined && (state.switchMask & bit) !== 0) {
            return `Bypass witness claims "${requirement.switchId}" is inactive, but it was activated.`;
          }
        } else if (
          witness.route.some((move) => move.destination === requirement.moduleId) ||
          initialState(compiled).moduleId === requirement.moduleId
        ) {
          return `Bypass witness claims to avoid "${requirement.moduleId}", but it crosses it.`;
        }
      }
    }
    return undefined;
  }
  if (state.moduleId === compiled.goal) return 'A dead-end witness must not end at the goal.';
  return undefined;
}

export function verify(level: Level, config: VerifierConfig = {}): Report {
  const catalogVersion = CATALOG_VERSION;
  const revision = revisionId(level);

  // 1. Validate and bound first (§7.1). Invalid input yields an invalid report.
  const invalidReasons = validateLevel(level);
  if (invalidReasons.length > 0) {
    const unknown: CheckedResult = {
      status: 'unknown',
      explanation: 'Level input is invalid; exploration did not run.',
    };
    return {
      valid: false,
      invalidReasons,
      revisionId: revision,
      catalogVersion,
      verifierVersion: VERIFIER_VERSION,
      requirements: level.requirements,
      complete: false,
      completionExplanation: 'Invalid input.',
      exploredCount: 0,
      checks: { solution: unknown, requirements: unknown, recovery: unknown },
      accepted: false,
    };
  }

  const compiled = compileLevel(level);
  const cap = config.explorationCap ?? STATE_BOUND;
  const start = initialState(compiled);

  // 2. BFS from spawn with empty masks (§7.2). Store every legal edge,
  //    including edges into already-visited states, plus stable parents.
  const visited = new Map<string, Visit>();
  const edges = new Map<string, Array<{ toKey: string; move: MoveRecord }>>();
  const queue: GameState[] = [start];
  visited.set(stateKey(start), { order: 0, parentKey: null, viaMove: null, state: start });

  let complete = true;
  let completionExplanation = 'Exploration finished within the state bound.';
  let overflowed = false;

  while (queue.length > 0 && !overflowed) {
    const current = queue.shift()!;
    if (current.moduleId === compiled.goal) continue; // never expand goal states
    const legal = transitions(compiled, current);
    const fromKey = stateKey(current);
    const outgoing = edges.get(fromKey) ?? [];
    edges.set(fromKey, outgoing);
    for (const move of legal) {
      const toKey = stateKey(move.after);
      outgoing.push({ toKey, move });
      if (!visited.has(toKey)) {
        if (visited.size >= cap) {
          complete = false;
          completionExplanation = `Exploration cap of ${cap} states reached before the graph was exhausted.`;
          overflowed = true;
          break;
        }
        visited.set(toKey, { order: visited.size, parentKey: fromKey, viaMove: move, state: move.after });
        queue.push(move.after);
      }
    }
  }

  const routeTo = (visit: Visit, map: Map<string, Visit> = visited): MoveRecord[] => {
    const route: MoveRecord[] = [];
    let node: Visit | undefined = visit;
    while (node !== undefined && node.parentKey !== null && node.viaMove !== null) {
      route.push(node.viaMove);
      node = map.get(node.parentKey);
    }
    route.reverse();
    return route;
  };

  /**
   * passThrough counterexample search (§5): can the goal be reached without
   * EVER arriving at the forbidden module? Goal states cannot answer this —
   * they record location and item masks, not visited plain modules, and
   * routes merge at shared states. (Key/switch masks DO record visits to
   * item modules, because collection is automatic and permanent — which is
   * why collectBeforeGoal and switchNecessary are sound on goal states.)
   * Runs only after complete exploration, so it stays inside the bound.
   */
  const goalAvoiding = (forbidden: string): { visit: Visit; map: Map<string, Visit> } | null => {
    if (start.moduleId === forbidden) return null; // every route starts there
    const local = new Map<string, Visit>();
    const queue: GameState[] = [start];
    local.set(stateKey(start), { order: 0, parentKey: null, viaMove: null, state: start });
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current.moduleId === compiled.goal) {
        return { visit: local.get(stateKey(current))!, map: local };
      }
      const fromKey = stateKey(current);
      for (const move of transitions(compiled, current)) {
        if (move.destination === forbidden) continue;
        const toKey = stateKey(move.after);
        if (!local.has(toKey)) {
          local.set(toKey, { order: local.size, parentKey: fromKey, viaMove: move, state: move.after });
          queue.push(move.after);
        }
      }
    }
    return null;
  };

  const goalVisits = [...visited.values()]
    .filter((v) => v.state.moduleId === compiled.goal)
    .sort((a, b) => a.order - b.order);

  // An incomplete exploration can never produce a green result (§7.1).
  if (!complete) {
    const unknown = (what: string): CheckedResult => ({
      status: 'unknown',
      explanation: `Check incomplete: ${what}`,
    });
    return {
      valid: true,
      invalidReasons: [],
      revisionId: revision,
      catalogVersion,
      verifierVersion: VERIFIER_VERSION,
      requirements: level.requirements,
      complete: false,
      completionExplanation,
      exploredCount: visited.size,
      checks: {
        solution: unknown('exploration did not finish.'),
        requirements: unknown('exploration did not finish.'),
        recovery: unknown('exploration did not finish.'),
      },
      accepted: false,
    };
  }

  // Check 1 — Solution (§7.2.1).
  let solutionCheck: CheckedResult;
  if (goalVisits.length > 0) {
    solutionCheck = {
      status: 'pass',
      explanation: 'Solution found.',
      witness: { kind: 'solution', route: routeTo(goalVisits[0]!), endState: goalVisits[0]!.state },
    };
  } else {
    solutionCheck = {
      status: 'fail',
      explanation: `No winning route: the goal is unreachable across ${visited.size} explored states.`,
    };
  }

  // Check 2 — Design requirements (§7.2.2). No reachable goal is
  // "No winning route", not vacuous success; no rules is "No rules set."
  let requirementsCheck: CheckedResult;
  if (level.requirements.length === 0) {
    requirementsCheck = { status: 'not_applicable', explanation: 'No rules set.' };
  } else if (goalVisits.length === 0) {
    requirementsCheck = { status: 'not_applicable', explanation: 'No winning route.' };
  } else {
    let violation: { requirement: Requirement; visit: Visit; map: Map<string, Visit> } | null = null;
    for (const requirement of level.requirements) {
      if (requirement.type === 'collectBeforeGoal') {
        const bit = compiled.keyBit.get(requirement.keyId) ?? 0;
        const bad = goalVisits.find((v) => (v.state.keyMask & bit) === 0);
        if (bad) {
          violation = { requirement, visit: bad, map: visited };
          break;
        }
      } else if (requirement.type === 'switchNecessary') {
        // Sound on goal states: switches are one-shot and permanent, so a
        // state's switchMask is exactly the set its route activated.
        const bit = compiled.switchBit.get(requirement.switchId) ?? 0;
        const bad = goalVisits.find((v) => (v.state.switchMask & bit) === 0);
        if (bad) {
          violation = { requirement, visit: bad, map: visited };
          break;
        }
      } else {
        // passThrough: plain modules leave no state trace — restricted search.
        const bad = goalAvoiding(requirement.moduleId);
        if (bad !== null) {
          violation = { requirement, visit: bad.visit, map: bad.map };
          break;
        }
      }
    }
    if (violation) {
      const text =
        violation.requirement.type === 'collectBeforeGoal'
          ? `without the required key "${violation.requirement.keyId}"`
          : violation.requirement.type === 'switchNecessary'
            ? `without activating "${violation.requirement.switchId}"`
            : `without crossing "${violation.requirement.moduleId}"`;
      requirementsCheck = {
        status: 'fail',
        explanation: `A winning route reaches the goal ${text}.`,
        witness: {
          kind: 'bypass',
          route: routeTo(violation.visit, violation.map),
          endState: violation.visit.state,
          ...(violation.requirement.type === 'collectBeforeGoal'
            ? { missingKeys: [violation.requirement.keyId] }
            : {}),
          requirement: violation.requirement,
          violationText: text,
        },
      };
    } else {
      requirementsCheck = {
        status: 'pass',
        explanation: 'Every reachable winning state satisfies every rule.',
      };
    }
  }

  // Check 3 — Recovery (§7.2.3): reverse-search all stored edges from all
  // goal states; any reachable non-goal state outside that set is a dead end.
  let recoveryCheck: CheckedResult;
  const canWinSet = new Set<string>();
  if (goalVisits.length === 0) {
    recoveryCheck = {
      status: 'fail',
      explanation: 'No winning route is reachable; every reachable state is a dead end.',
      witness: { kind: 'dead_end', route: [], endState: start },
    };
  } else {
    const reverse = new Map<string, string[]>();
    for (const [fromKey, outgoing] of edges) {
      for (const { toKey } of outgoing) {
        const list = reverse.get(toKey);
        if (list) list.push(fromKey);
        else reverse.set(toKey, [fromKey]);
      }
    }
    const stack: string[] = [];
    for (const g of goalVisits) {
      const key = stateKey(g.state);
      if (!canWinSet.has(key)) {
        canWinSet.add(key);
        stack.push(key);
      }
    }
    while (stack.length > 0) {
      const key = stack.pop()!;
      for (const from of reverse.get(key) ?? []) {
        if (!canWinSet.has(from)) {
          canWinSet.add(from);
          stack.push(from);
        }
      }
    }
    const dead = [...visited.values()]
      .filter((v) => v.state.moduleId !== compiled.goal && !canWinSet.has(stateKey(v.state)))
      .sort((a, b) => a.order - b.order);
    if (dead.length > 0) {
      const first = dead[0]!;
      const heldKeys = [...compiled.keyBit]
        .filter(([, bit]) => (first.state.keyMask & bit) !== 0)
        .map(([id]) => id);
      const activeSwitches = [...compiled.switchBit]
        .filter(([, bit]) => (first.state.switchMask & bit) !== 0)
        .map(([id]) => id);
      const holding =
        heldKeys.length > 0
          ? ` holding the ${heldKeys.join(' and the ')}`
          : ' holding no keys';
      const switches =
        activeSwitches.length > 0 ? `, with the ${activeSwitches.join(' and the ')} active` : '';
      recoveryCheck = {
        status: 'fail',
        explanation: `A player can be stranded at “${first.state.moduleId}”${holding}${switches} — no winning route remains.`,
        witness: { kind: 'dead_end', route: routeTo(first), endState: first.state },
      };
    } else {
      recoveryCheck = {
        status: 'pass',
        explanation: 'Every reachable non-winning state can still reach the goal.',
      };
    }
  }

  // Per-module recovery analysis for the visualization layer (§7.2.3): a
  // module is "stranded" if some reachable state there can no longer win;
  // "unreachable" if no reachable state ever visits it. Only when complete —
  // an incomplete map would be a silent lie.
  let recoveryMap: RecoveryMap | undefined;
  if (complete) {
    const visitedModules = new Set<string>();
    const strandedModules = new Set<string>();
    for (const v of visited.values()) {
      visitedModules.add(v.state.moduleId);
      if (v.state.moduleId !== compiled.goal && !canWinSet.has(stateKey(v.state))) {
        strandedModules.add(v.state.moduleId);
      }
    }
    const unreachable = level.modules
      .map((m) => m.id)
      .filter((id) => !visitedModules.has(id))
      .sort();
    recoveryMap = { stranded: [...strandedModules].sort(), unreachable };
  }

  // Witness integrity (§7.3): a failed replay is an internal error that
  // blocks acceptance.
  let internalError: string | undefined;
  const witnesses = [solutionCheck.witness, requirementsCheck.witness, recoveryCheck.witness].filter(
    (w): w is Witness => w !== undefined,
  );
  for (const witness of witnesses) {
    const failure = replayWitness(compiled, witness);
    if (failure !== undefined) {
      internalError = failure;
      break;
    }
  }

  const accepted =
    solutionCheck.status === 'pass' &&
    recoveryCheck.status === 'pass' &&
    (requirementsCheck.status === 'pass' || requirementsCheck.status === 'not_applicable') &&
    internalError === undefined;

  return {
    valid: true,
    invalidReasons: [],
    revisionId: revision,
    catalogVersion,
    verifierVersion: VERIFIER_VERSION,
    requirements: level.requirements,
    complete,
    completionExplanation,
    exploredCount: visited.size,
    checks: { solution: solutionCheck, requirements: requirementsCheck, recovery: recoveryCheck },
    ...(recoveryMap !== undefined ? { recoveryMap } : {}),
    ...(internalError !== undefined ? { internalError } : {}),
    accepted,
  };
}
