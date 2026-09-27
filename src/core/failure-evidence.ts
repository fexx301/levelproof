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
  // The dead-end witness is the breadth-first earliest state that can no
  // longer win, reached by a shortest route; its predecessor could still win
  // (it was explored earlier and is not dead), so the witness's LAST move is
  // the point of no return. A sealing switch is named as the cause only when
  // that move pressed it — an earlier, unrelated seal is context, not cause.
  const decisiveMoveIndex = witness.route.length;
  const decisiveMove = decisiveMoveIndex > 0 ? witness.route[decisiveMoveIndex - 1] : undefined;
  let fact = result.explanation;
  if (check === 'recovery' && decisiveMove !== undefined) {
    const pressed = decisiveMove.events.activatedSwitch;
    const sealedNow = pressed === undefined ? undefined : level.doors.find((door) => door.conditions?.closesAfterSwitch === pressed);
    if (pressed !== undefined && sealedNow !== undefined) {
      fact = `At move ${decisiveMoveIndex}, activating “${pressed}” closes “${sealedNow.id}”. From that state no winning route remains (stranded at “${witness.endState.moduleId}”).`;
    } else {
      const earlierSeals = witness.route
        .slice(0, -1)
        .flatMap((move) => {
          const id = move.events.activatedSwitch;
          const door = id === undefined ? undefined : level.doors.find((d) => d.conditions?.closesAfterSwitch === id);
          return id !== undefined && door !== undefined ? [`“${id}” (it closed “${door.id}”)`] : [];
        });
      fact = `At move ${decisiveMoveIndex}, the route enters “${decisiveMove.destination}”; from that state no winning route remains.${earlierSeals.length > 0 ? ` Already pressed before then: ${earlierSeals.join(', ')}.` : ''}`;
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
