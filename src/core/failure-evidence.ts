import type { Level } from '../../shared/schema.js';
import type { MoveRecord } from './movement.js';
import type { Report, Witness } from './verifier.js';

export type EvidenceCheck = 'solution' | 'requirements' | 'recovery';

/**
 * Structured, engine-owned evidence for the "Show the problem" action. The
 * prose can be improved independently, but the route, revision, and ids are
 * always taken from the verifier witness rather than invented by an AI model.
 */
export interface FailureEvidence {
  check: EvidenceCheck;
  revisionId: string;
  witnessKind: Witness['kind'];
  route: MoveRecord[];
  implicatedIds: string[];
  focusModuleId: string;
  /** Number of completed moves at which the replay should pause. */
  decisiveMoveIndex: number;
  fact: string;
  suggestedAction: string;
}

function routeModules(route: MoveRecord[], witness: Witness): string[] {
  const ids = new Set<string>();
  for (const move of route) {
    ids.add(move.source);
    ids.add(move.destination);
    if (move.doorId !== undefined) ids.add(move.doorId);
    if (move.events.collectedKey !== undefined) ids.add(move.events.collectedKey);
    if (move.events.activatedSwitch !== undefined) ids.add(move.events.activatedSwitch);
  }
  ids.add(witness.endState.moduleId);
  return [...ids];
}

function implicatedFor(level: Level, check: EvidenceCheck, witness: Witness): string[] {
  const ids = routeModules(witness.route, witness);
  const seen = new Set(ids);
  const add = (id: string | undefined): void => {
    if (id !== undefined && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  };

  if (check === 'requirements' && witness.requirement !== undefined) {
    const requirement = witness.requirement;
    if (requirement.type === 'collectBeforeGoal') {
      add(requirement.keyId);
      const key = level.keys.find((item) => item.id === requirement.keyId);
      add(key?.moduleId);
      for (const door of level.doors) {
        if (door.conditions?.requiresKey === requirement.keyId || door.conditions?.requiresKeys?.includes(requirement.keyId)) add(door.id);
      }
    } else if (requirement.type === 'switchNecessary') {
      add(requirement.switchId);
      add(level.switches.find((item) => item.id === requirement.switchId)?.moduleId);
      for (const door of level.doors) {
        if (door.conditions?.requiresSwitch === requirement.switchId) add(door.id);
      }
    } else {
      add(requirement.moduleId);
    }
  }

  if (check === 'recovery') {
    const focus = witness.endState.moduleId;
    for (const door of level.doors) {
      if (door.a === focus || door.b === focus) add(door.id);
    }
    for (const move of witness.route) {
      const activatedSwitch = move.events.activatedSwitch;
      if (activatedSwitch === undefined) continue;
      add(activatedSwitch);
      for (const door of level.doors) {
        if (door.conditions?.closesAfterSwitch === activatedSwitch) add(door.id);
      }
    }
    for (const item of level.keys) {
      if (item.moduleId === focus) add(item.id);
    }
    for (const item of level.switches) {
      if (item.moduleId === focus) add(item.id);
    }
  }
  return ids;
}

export function buildFailureEvidence(level: Level, report: Report, check: EvidenceCheck): FailureEvidence | null {
  const result = report.checks[check];
  if (result.status !== 'fail' || result.witness === undefined) return null;
  const witness = result.witness;
  const causalSwitchStep = check === 'recovery'
    ? witness.route.findIndex((move) =>
        move.events.activatedSwitch !== undefined &&
        level.doors.some((door) => door.conditions?.closesAfterSwitch === move.events.activatedSwitch),
      )
    : -1;
  const decisiveMoveIndex = causalSwitchStep >= 0 ? causalSwitchStep + 1 : witness.route.length;
  const decisiveMove = decisiveMoveIndex > 0 ? witness.route[decisiveMoveIndex - 1] : undefined;
  let fact = result.explanation;
  if (causalSwitchStep >= 0 && decisiveMove !== undefined) {
    const switchId = decisiveMove.events.activatedSwitch!;
    const closingDoor = level.doors.find((door) => door.conditions?.closesAfterSwitch === switchId);
    if (closingDoor !== undefined) {
      fact = `At move ${decisiveMoveIndex}, activating “${switchId}” closes “${closingDoor.id}”. The verified route later ends stranded at “${witness.endState.moduleId}”, with no winning continuation.`;
    }
  }
  const suggestedAction =
    check === 'recovery'
      ? 'Try Repair search, or move the sealing mechanic so this state still has a route to the goal.'
      : check === 'requirements'
        ? 'Keep the implicated rule and gate aligned, then preview the repair before applying it.'
        : 'Restore a connected route to the goal, then run the checks again.';
  return {
    check,
    revisionId: report.revisionId,
    witnessKind: witness.kind,
    route: witness.route,
    implicatedIds: implicatedFor(level, check, witness),
    focusModuleId: check === 'recovery' && decisiveMove !== undefined ? decisiveMove.destination : witness.endState.moduleId,
    decisiveMoveIndex,
    fact,
    suggestedAction,
  };
}
