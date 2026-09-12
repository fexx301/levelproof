import type { Level, Operation } from '../../shared/schema';
import { applyOperations } from './level';
import { compileLevel, edgeKey } from './topology';
import { verify, type Report } from './verifier';

/**
 * Bounded repair search (§9), separate from verification. At most 24
 * deterministic candidates, each at most four operations, no recursion.
 * Templates for the first slice: gate a requirement-bypassing new route
 * with the missing key, and relocate a trapping switch. Every candidate is
 * fully checked against every active requirement; the search never weakens
 * rules, moves the goal, changes the movement model, or silently discards
 * the requested change. Ranking is a declared heuristic tuple, not a
 * minimality proof.
 */

const MAX_CANDIDATES = 24;
const MAX_SHOWN = 3;

export interface RepairCandidate {
  key: string;
  description: string;
  operations: Operation[];
  report: Report;
}

export interface RepairSearchResult {
  status: 'complete' | 'incomplete';
  candidates: RepairCandidate[];
  explored: number;
  durationMs: number;
  note: string;
}

interface DraftCandidate {
  key: string;
  description: string;
  operations: Operation[];
  changedExisting: number;
}

function canonicalKey(operations: Operation[]): string {
  return JSON.stringify(
    operations.map((op) => {
      const copy: Record<string, unknown> = { kind: op.kind };
      for (const [field, value] of Object.entries(op)) {
        if (field !== 'kind') copy[field] = value;
      }
      return copy;
    }),
  );
}

/** Template 2 (§9): relocate a switch whose door seals a player in. */
function switchRelocationCandidates(draft: Level, report: Report): DraftCandidate[] {
  const recovery = report.checks.recovery;
  if (recovery.status !== 'fail' || recovery.witness?.kind !== 'dead_end') return [];
  const sealingSwitchIds = new Set(
    draft.doors
      .map((door) => door.conditions?.closesAfterSwitch)
      .filter((id): id is string => id !== undefined),
  );
  if (sealingSwitchIds.size === 0) return [];
  const occupied = new Set<string>([
    ...draft.keys.map((k) => k.moduleId),
    ...draft.switches.map((s) => s.moduleId),
    draft.spawn,
    draft.goal,
  ]);
  const eligible = draft.modules
    .filter((m) => m.template === 'flat' && !occupied.has(m.id))
    .map((m) => m.id)
    .sort();
  const candidates: DraftCandidate[] = [];
  for (const switchId of [...sealingSwitchIds].sort()) {
    const current = draft.switches.find((s) => s.id === switchId);
    if (!current) continue;
    for (const moduleId of eligible) {
      if (moduleId === current.moduleId) continue;
      candidates.push({
        key: canonicalKey([{ kind: 'moveItem', id: switchId, moduleId }]),
        description: `Move switch “${switchId}” to “${moduleId}”`,
        operations: [{ kind: 'moveItem', id: switchId, moduleId }],
        changedExisting: 1,
      });
    }
  }
  return candidates;
}

/** Template 1 (§9): gate the new route with a door requiring the missing key. */
function routeGatingCandidates(accepted: Level, draft: Level, report: Report): DraftCandidate[] {
  const requirements = report.checks.requirements;
  const witness = requirements.witness;
  if (requirements.status !== 'fail' || witness?.kind !== 'bypass') return [];
  const missingKeys = witness.missingKeys ?? [];
  if (missingKeys.length === 0) return [];
  const acceptedModules = new Set(accepted.modules.map((m) => m.id));
  // Modules the witness passes through that did not exist in the accepted level.
  const newModules = new Set<string>();
  for (const move of witness.route) {
    if (!acceptedModules.has(move.source)) newModules.add(move.source);
    if (!acceptedModules.has(move.destination)) newModules.add(move.destination);
  }
  if (newModules.size === 0) return [];
  // Entrance edges: edges of new modules that connect back to old modules.
  const compiled = compileLevel(draft);
  const entrances = compiled.edges
    .filter(
      (edge) =>
        (newModules.has(edge.aId) && !newModules.has(edge.bId)) ||
        (newModules.has(edge.bId) && !newModules.has(edge.aId)),
    )
    .map((edge) => edgeKey(edge.aId, edge.bId))
    .sort();
  const candidates: DraftCandidate[] = [];
  for (const entrance of entrances) {
    const [a, b] = entrance.split('|');
    if (!a || !b) continue;
    for (const keyId of missingKeys) {
      const operations: Operation[] = [
        {
          kind: 'addDoor',
          door: { id: `gate-${a}`, a, b, conditions: { requiresKey: keyId } },
        },
      ];
      candidates.push({
        key: canonicalKey(operations),
        description: `Lock the entrance at “${a}”–“${b}” with key “${keyId}”`,
        operations,
        changedExisting: 0,
      });
    }
  }
  return candidates;
}

export function findRepairs(accepted: Level, draft: Level, report: Report): RepairSearchResult {
  const t0 = performance.now();
  const pool = [
    ...routeGatingCandidates(accepted, draft, report),
    ...switchRelocationCandidates(draft, report),
  ];
  const seen = new Set<string>();
  const enumerated: DraftCandidate[] = [];
  let truncated = false;
  for (const candidate of pool) {
    if (seen.has(candidate.key)) continue;
    seen.add(candidate.key);
    if (enumerated.length >= MAX_CANDIDATES) {
      truncated = true;
      break;
    }
    enumerated.push(candidate);
  }

  const passing: RepairCandidate[] = [];
  for (const candidate of enumerated) {
    const applied = applyOperations(draft, candidate.operations);
    if (!applied.ok) continue;
    const repaired = verify(applied.level);
    if (repaired.accepted) {
      passing.push({
        key: candidate.key,
        description: candidate.description,
        operations: candidate.operations,
        report: repaired,
      });
    }
  }

  passing.sort((x, y) => {
    const byChanged = countChanged(accepted, x) - countChanged(accepted, y);
    if (byChanged !== 0) return byChanged;
    const byOps = x.operations.length - y.operations.length;
    if (byOps !== 0) return byOps;
    return x.key < y.key ? -1 : x.key > y.key ? 1 : 0;
  });

  const durationMs = performance.now() - t0;
  return {
    status: truncated ? 'incomplete' : 'complete',
    candidates: passing.slice(0, MAX_SHOWN),
    explored: enumerated.length,
    durationMs,
    note:
      truncated
        ? 'Repair search incomplete.'
        : passing.length === 0
          ? 'No checked fix in this search.'
          : `${passing.length} checked fix${passing.length === 1 ? '' : 'es'} found.`,
  };
}

function countChanged(accepted: Level, candidate: RepairCandidate): number {
  const acceptedIds = new Set(accepted.modules.map((m) => m.id));
  return candidate.operations.filter((op) => {
    const target =
      op.kind === 'moveItem' ? op.id : op.kind === 'setDoorConditions' || op.kind === 'removeDoor' ? op.id : null;
    return target !== null && acceptedIds.has(target);
  }).length;
}
