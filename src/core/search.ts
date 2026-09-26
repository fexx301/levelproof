import type { Level, Operation } from '../../shared/schema.js';
import { applyOperations } from './level.js';
import { compileLevel, edgeKey } from './topology.js';
import { verify, type Report } from './verifier.js';

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
  /** How many candidates were skipped because they moved or removed an
   * entity the creator marked "keep this" (§9 creator constraints). */
  skippedProtected: number;
}

interface DraftCandidate {
  key: string;
  description: string;
  operations: Operation[];
  changedExisting: number;
  /** Removals rank last: repairs that keep every entity outrank destructive ones. */
  removals: number;
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
        removals: 0,
      });
    }
  }
  return candidates;
}

/**
 * Template 3 (§9 breadth): dissolve the trap instead of relocating it —
 * either drop the sealing condition (door stays, switch goes) or remove the
 * sealing door outright. Both discard the trap mechanic; full re-verification
 * decides whether anything else breaks.
 */
function trapRemovalCandidates(draft: Level, report: Report): DraftCandidate[] {
  const recovery = report.checks.recovery;
  if (recovery.status !== 'fail' || recovery.witness?.kind !== 'dead_end') return [];
  const switchIds = new Set(draft.switches.map((s) => s.id));
  const candidates: DraftCandidate[] = [];
  for (const door of draft.doors) {
    const sealId = door.conditions?.closesAfterSwitch;
    if (sealId === undefined || !switchIds.has(sealId)) continue;
    candidates.push({
      key: canonicalKey([
        { kind: 'setDoorConditions', id: door.id, conditions: {} },
        { kind: 'removeItem', id: sealId },
      ]),
      description: `Remove switch “${sealId}” and leave “${door.id}” open`,
      operations: [
        { kind: 'setDoorConditions', id: door.id, conditions: {} },
        { kind: 'removeItem', id: sealId },
      ],
      changedExisting: 0,
      removals: 1,
    });
    candidates.push({
      key: canonicalKey([{ kind: 'removeDoor', id: door.id }]),
      description: `Remove the sealing door “${door.id}”`,
      operations: [{ kind: 'removeDoor', id: door.id }],
      changedExisting: 0,
      removals: 1,
    });
  }
  return candidates;
}

/**
 * Template 4 (§9 breadth): a bypass skipped the required key — move the key
 * onto the bypass route so the shortcut collects it too. Keys are collected
 * on arrival, so placement on the route is enough; full re-verification
 * proves every winning route now honors the requirement.
 */
function keyRelocationCandidates(draft: Level, report: Report): DraftCandidate[] {
  const requirements = report.checks.requirements;
  const witness = requirements.witness;
  if (requirements.status !== 'fail' || witness?.kind !== 'bypass') return [];
  const missingKeys = witness.missingKeys ?? [];
  if (missingKeys.length === 0) return [];
  const occupied = new Set<string>([
    ...draft.keys.map((k) => k.moduleId),
    ...draft.switches.map((s) => s.moduleId),
    draft.spawn,
    draft.goal,
  ]);
  const flatIds = new Set(draft.modules.filter((m) => m.template === 'flat').map((m) => m.id));
  const routeModules = new Set<string>();
  for (const move of witness.route) {
    if (flatIds.has(move.source)) routeModules.add(move.source);
    if (flatIds.has(move.destination)) routeModules.add(move.destination);
  }
  const candidates: DraftCandidate[] = [];
  for (const keyId of missingKeys) {
    const key = draft.keys.find((k) => k.id === keyId);
    if (!key) continue;
    for (const moduleId of [...routeModules].sort()) {
      if (moduleId === key.moduleId || occupied.has(moduleId)) continue;
      const operations: Operation[] = [{ kind: 'moveItem', id: keyId, moduleId }];
      candidates.push({
        key: canonicalKey(operations),
        description: `Move key “${keyId}” onto the shortcut at “${moduleId}”`,
        operations,
        changedExisting: 0,
        removals: 0,
      });
    }
  }
  return candidates;
}

/** Template 1 (§9): gate the new route with a door requiring the missing key. */
/**
 * A valid id (≤ 32 chars) derived from `base` that no entity in the level
 * uses yet: long module ids are shortened, collisions get a numeric suffix.
 */
export function freshId(level: Level, base: string): string {
  const used = new Set<string>([
    ...level.modules.map((m) => m.id),
    ...level.keys.map((k) => k.id),
    ...level.switches.map((s) => s.id),
    ...level.doors.map((d) => d.id),
    ...(level.props ?? []).map((p) => p.id),
  ]);
  const trim = (id: string): string => id.slice(0, 32).replace(/-+$/, '');
  let candidate = trim(base);
  for (let n = 2; used.has(candidate); n++) candidate = `${trim(base.slice(0, 32 - String(n).length - 1))}-${n}`;
  return candidate;
}

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
          door: { id: freshId(draft, `gate-${a}`), a, b, conditions: { requiresKey: keyId } },
        },
      ];
      candidates.push({
        key: canonicalKey(operations),
        description: `Lock the entrance at “${a}”–“${b}” with key “${keyId}”`,
        operations,
        changedExisting: 0,
        removals: 0,
      });
    }
  }
  return candidates;
}

/**
 * Everything about a protected entity the author can see: its own fields
 * plus the placement of any module it sits in or connects. Moving the
 * module under a kept key moves the key, so it changes this footprint.
 */
function protectedFootprint(level: Level, id: string): string | null {
  const moduleById = (moduleId: string) => level.modules.find((m) => m.id === moduleId);
  const place = (moduleId: string) => {
    const m = moduleById(moduleId);
    return m === undefined ? null : [m.x, m.z, m.h, m.template, m.orientation ?? null];
  };
  const module = moduleById(id);
  if (module !== undefined) {
    return JSON.stringify(['module', place(id), [...module.ports].sort(), module.label ?? null]);
  }
  const key = level.keys.find((k) => k.id === id);
  if (key !== undefined) return JSON.stringify(['key', key.moduleId, place(key.moduleId), key.look ?? null]);
  const pad = level.switches.find((s) => s.id === id);
  if (pad !== undefined) return JSON.stringify(['switch', pad.moduleId, place(pad.moduleId)]);
  const door = level.doors.find((d) => d.id === id);
  if (door !== undefined) return JSON.stringify(['door', door.a, door.b, door.conditions ?? {}, place(door.a), place(door.b)]);
  const prop = level.props?.find((p) => p.id === id);
  if (prop !== undefined) return JSON.stringify(['prop', prop.prop, prop.x, prop.z]);
  return null;
}

/**
 * An operation list touches a protected entity when it changes that
 * entity's existence, location, label, exits, conditions, or look —
 * directly (the operation names it) or indirectly (it moves or removes the
 * module the entity sits in or connects). With `base`, the operations are
 * applied and every protected footprint compared; without it, only direct
 * references are caught.
 */
export function touchesProtected(operations: Operation[], protectedIds: Set<string>, base?: Level): boolean {
  for (const op of operations) {
    if (
      op.kind === 'moveItem' || op.kind === 'removeItem' ||
      op.kind === 'removeModule' || op.kind === 'moveModule' ||
      op.kind === 'setModulePorts' || op.kind === 'setModuleLabel'
    ) {
      if (protectedIds.has(op.id)) return true;
    }
    if (op.kind === 'setDoorConditions' || op.kind === 'removeDoor') {
      if (protectedIds.has(op.id)) return true;
    }
    if (op.kind === 'moveProp' || op.kind === 'removeProp' || op.kind === 'setKeyLook') {
      if (protectedIds.has(op.id)) return true;
    }
  }
  if (base === undefined || protectedIds.size === 0) return false;
  const applied = applyOperations(base, operations);
  if (!applied.ok) return false; // rejected elsewhere; nothing would change
  for (const id of protectedIds) {
    if (protectedFootprint(base, id) !== protectedFootprint(applied.level, id)) return true;
  }
  return false;
}

export function findRepairs(
  accepted: Level,
  draft: Level,
  report: Report,
  protectedIds: string[] = [],
): RepairSearchResult {
  const t0 = performance.now();
  const protectedSet = new Set(protectedIds);
  const pool = [
    ...routeGatingCandidates(accepted, draft, report),
    ...switchRelocationCandidates(draft, report),
    ...trapRemovalCandidates(draft, report),
    ...keyRelocationCandidates(draft, report),
  ];
  const seen = new Set<string>();
  const enumerated: DraftCandidate[] = [];
  let truncated = false;
  let skippedProtected = 0;
  for (const candidate of pool) {
    if (seen.has(candidate.key)) continue;
    seen.add(candidate.key);
    if (protectedSet.size > 0 && touchesProtected(candidate.operations, protectedSet, draft)) {
      skippedProtected += 1;
      continue;
    }
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
    const byRemovals = removalCount(x) - removalCount(y);
    if (byRemovals !== 0) return byRemovals;
    const byChanged = countChanged(accepted, x) - countChanged(accepted, y);
    if (byChanged !== 0) return byChanged;
    const byOps = x.operations.length - y.operations.length;
    if (byOps !== 0) return byOps;
    return x.key < y.key ? -1 : x.key > y.key ? 1 : 0;
  });

  const durationMs = performance.now() - t0;
  const baseNote =
    truncated
      ? 'Repair search incomplete.'
      : passing.length === 0
        ? protectedSet.size > 0
          ? 'No checked fix keeps those entities — try unkeeping one.'
          : 'No checked fix in this search.'
        : `${passing.length} checked fix${passing.length === 1 ? '' : 'es'} found.`;
  return {
    status: truncated ? 'incomplete' : 'complete',
    candidates: passing.slice(0, MAX_SHOWN),
    explored: enumerated.length,
    durationMs,
    note: skippedProtected > 0 ? `${baseNote} ${skippedProtected} skipped to keep your choices.` : baseNote,
    skippedProtected,
  };
}

function removalCount(candidate: RepairCandidate): number {
  return candidate.operations.filter((op) => op.kind === 'removeItem' || op.kind === 'removeDoor').length;
}

function countChanged(accepted: Level, candidate: RepairCandidate): number {
  const acceptedIds = new Set(accepted.modules.map((m) => m.id));
  return candidate.operations.filter((op) => {
    const target =
      op.kind === 'moveItem' ? op.id : op.kind === 'setDoorConditions' || op.kind === 'removeDoor' ? op.id : null;
    return target !== null && acceptedIds.has(target);
  }).length;
}
