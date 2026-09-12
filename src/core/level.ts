import { BOUNDS, levelSchema, operationSchema, type Level, type LevelModule, type Operation } from '../../shared/schema.js';
import { opposite } from './catalog.js';
import { computeEdges, edgeKey, validateGeometry } from './topology.js';

/**
 * Semantic validation and atomic edit application (§3, §5). Every proposal is
 * schema-validated, applied to a copy, and fully checked; invalid operations
 * never partially mutate the scene.
 */

export function validateLevel(level: Level): string[] {
  const errors: string[] = [];

  const parsed = levelSchema.safeParse(level);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      errors.push(`schema: ${issue.path.join('.') || '(root)'}: ${issue.message}`);
    }
    return errors;
  }
  const lvl = parsed.data;

  // Duplicate ids across every entity kind.
  const moduleIds = new Set<string>();
  for (const m of lvl.modules) {
    if (moduleIds.has(m.id)) errors.push(`Duplicate module id "${m.id}".`);
    moduleIds.add(m.id);
  }
  const keyIds = new Set<string>();
  for (const k of lvl.keys) {
    if (keyIds.has(k.id)) errors.push(`Duplicate key id "${k.id}".`);
    keyIds.add(k.id);
  }
  const switchIds = new Set<string>();
  for (const s of lvl.switches) {
    if (switchIds.has(s.id)) errors.push(`Duplicate switch id "${s.id}".`);
    switchIds.add(s.id);
  }
  for (const id of keyIds) {
    if (switchIds.has(id)) errors.push(`Key and switch share the id "${id}".`);
  }
  const doorIds = new Set<string>();
  for (const d of lvl.doors) {
    if (doorIds.has(d.id)) errors.push(`Duplicate door id "${d.id}".`);
    doorIds.add(d.id);
  }
  const requiredKeyIds = new Set<string>();
  for (const r of lvl.requirements) {
    if (requiredKeyIds.has(r.keyId)) errors.push(`Requirement on key "${r.keyId}" appears more than once.`);
    requiredKeyIds.add(r.keyId);
  }

  // Template rules: ports, ramp orientation, ramp elevation bound.
  for (const m of lvl.modules) {
    const portSet = new Set(m.ports);
    if (portSet.size !== m.ports.length) errors.push(`Module "${m.id}" repeats a port.`);
    if (m.template === 'ramp') {
      if (m.orientation === undefined) {
        errors.push(`Ramp "${m.id}" requires an orientation (its direction of ascent).`);
      } else {
        if (m.h >= BOUNDS.maxElevation) {
          errors.push(`Ramp "${m.id}" at h=${m.h} would rise past elevation ${BOUNDS.maxElevation}.`);
        }
        const ends = [m.orientation, opposite(m.orientation)];
        if (m.ports.length !== 2 || !ends.every((e) => portSet.has(e))) {
          errors.push(`Ramp "${m.id}" must expose exactly its two end ports ${ends.join(' and ')}; its sides are closed.`);
        }
      }
    }
  }

  // References bind to ids; dangling references reject (§5).
  for (const item of [...lvl.keys, ...lvl.switches]) {
    if (!moduleIds.has(item.moduleId)) {
      errors.push(`Item "${item.id}" sits on unknown module "${item.moduleId}".`);
    }
  }
  if (!moduleIds.has(lvl.spawn)) errors.push(`Spawn references unknown module "${lvl.spawn}".`);
  if (!moduleIds.has(lvl.goal)) errors.push(`Goal references unknown module "${lvl.goal}".`);
  for (const d of lvl.doors) {
    if (d.a === d.b) errors.push(`Door "${d.id}" connects module "${d.a}" to itself.`);
    if (!moduleIds.has(d.a)) errors.push(`Door "${d.id}" references unknown module "${d.a}".`);
    if (!moduleIds.has(d.b)) errors.push(`Door "${d.id}" references unknown module "${d.b}".`);
    const c = d.conditions;
    if (c?.requiresKey !== undefined && !keyIds.has(c.requiresKey)) {
      errors.push(`Door "${d.id}" requires unknown key "${c.requiresKey}".`);
    }
    if (c?.requiresSwitch !== undefined && !switchIds.has(c.requiresSwitch)) {
      errors.push(`Door "${d.id}" requires unknown switch "${c.requiresSwitch}".`);
    }
    if (c?.closesAfterSwitch !== undefined && !switchIds.has(c.closesAfterSwitch)) {
      errors.push(`Door "${d.id}" would seal on unknown switch "${c.closesAfterSwitch}".`);
    }
  }
  for (const r of lvl.requirements) {
    if (!keyIds.has(r.keyId)) errors.push(`Requirement references unknown key "${r.keyId}".`);
  }

  // Items occupy flat modules; at most one entity per module (§4.3).
  const occupied = new Map<string, string>();
  const entities: Array<{ kind: string; id: string; moduleId: string }> = [
    ...lvl.keys.map((k) => ({ kind: 'key', id: k.id, moduleId: k.moduleId })),
    ...lvl.switches.map((s) => ({ kind: 'switch', id: s.id, moduleId: s.moduleId })),
    { kind: 'spawn', id: 'spawn', moduleId: lvl.spawn },
    { kind: 'goal', id: 'goal', moduleId: lvl.goal },
  ];
  for (const e of entities) {
    const m = lvl.modules.find((mm) => mm.id === e.moduleId);
    if (!m) continue; // already reported as a dangling reference
    if (m.template !== 'flat') {
      errors.push(`${e.kind} "${e.id}" must sit on a flat module; "${m.id}" is a ${m.template}.`);
    }
    const prior = occupied.get(e.moduleId);
    if (prior !== undefined) {
      errors.push(`Module "${m.id}" holds ${prior} and ${e.kind} "${e.id}"; at most one item per module.`);
    } else {
      occupied.set(e.moduleId, `${e.kind} "${e.id}"`);
    }
  }

  errors.push(...validateGeometry(lvl));

  // Doors sit on connected edges; at most one door per edge (§4.3).
  if (errors.length === 0) {
    const connected = new Set(computeEdges(lvl).map((e) => edgeKey(e.aId, e.bId)));
    const doorEdges = new Set<string>();
    for (const d of lvl.doors) {
      const key = edgeKey(d.a, d.b);
      if (!connected.has(key)) {
        errors.push(`Door "${d.id}" does not sit on a connected edge between "${d.a}" and "${d.b}".`);
      }
      if (doorEdges.has(key)) errors.push(`Edge "${d.a}"–"${d.b}" carries more than one door.`);
      doorEdges.add(key);
    }
  }

  return errors;
}

export type ApplyResult = { ok: true; level: Level } | { ok: false; errors: string[] };

/**
 * Apply operations atomically to a copy of the base level (§2.3, §5). Any
 * failure rejects the whole patch; the base is never mutated. Requirements
 * cannot be edited here — no operation kind exists for them.
 */
export function applyOperations(base: Level, operations: Operation[]): ApplyResult {
  if (operations.length === 0) return { ok: true, level: structuredClone(base) };
  if (operations.length > BOUNDS.maxOpsPerPatch) {
    return { ok: false, errors: [`A proposal may carry at most ${BOUNDS.maxOpsPerPatch} operations.`] };
  }
  for (const op of operations) {
    const check = operationSchema.safeParse(op);
    if (!check.success) {
      return { ok: false, errors: [`Invalid operation: ${check.error.issues[0]?.message ?? 'unknown'}`] };
    }
  }

  const draft: Level = structuredClone(base);
  const fail = (error: string): ApplyResult => ({ ok: false, errors: [error] });
  const findModule = (id: string): LevelModule | undefined => draft.modules.find((m) => m.id === id);

  for (const op of operations) {
    switch (op.kind) {
      case 'addModule': {
        if (findModule(op.module.id)) return fail(`Module "${op.module.id}" already exists.`);
        draft.modules.push(structuredClone(op.module));
        break;
      }
      case 'removeModule': {
        const index = draft.modules.findIndex((m) => m.id === op.id);
        if (index < 0) return fail(`Unknown module "${op.id}".`);
        draft.modules.splice(index, 1);
        break;
      }
      case 'moveModule': {
        const m = findModule(op.id);
        if (!m) return fail(`Unknown module "${op.id}".`);
        m.x = op.x;
        m.z = op.z;
        m.h = op.h;
        if (op.orientation !== undefined) m.orientation = op.orientation;
        break;
      }
      case 'setModulePorts': {
        const m = findModule(op.id);
        if (!m) return fail(`Unknown module "${op.id}".`);
        m.ports = [...op.ports];
        break;
      }
      case 'addItem': {
        const list = op.itemType === 'key' ? draft.keys : draft.switches;
        const other = op.itemType === 'key' ? draft.switches : draft.keys;
        if (list.some((i) => i.id === op.id) || other.some((i) => i.id === op.id)) {
          return fail(`Item "${op.id}" already exists.`);
        }
        list.push({ id: op.id, moduleId: op.moduleId });
        break;
      }
      case 'moveItem': {
        const item =
          draft.keys.find((i) => i.id === op.id) ?? draft.switches.find((i) => i.id === op.id);
        if (!item) return fail(`Unknown item "${op.id}".`);
        item.moduleId = op.moduleId;
        break;
      }
      case 'removeItem': {
        const keyIndex = draft.keys.findIndex((i) => i.id === op.id);
        if (keyIndex >= 0) {
          if (draft.requirements.some((r) => r.keyId === op.id)) {
            return fail(
              `Key "${op.id}" is required by an active rule; removing it needs an approved rule revision.`,
            );
          }
          draft.keys.splice(keyIndex, 1);
          break;
        }
        const switchIndex = draft.switches.findIndex((i) => i.id === op.id);
        if (switchIndex >= 0) {
          draft.switches.splice(switchIndex, 1);
          break;
        }
        return fail(`Unknown item "${op.id}".`);
      }
      case 'moveSpawn':
        draft.spawn = op.moduleId;
        break;
      case 'moveGoal':
        draft.goal = op.moduleId;
        break;
      case 'addDoor': {
        if (draft.doors.some((d) => d.id === op.door.id)) return fail(`Door "${op.door.id}" already exists.`);
        draft.doors.push(structuredClone(op.door));
        break;
      }
      case 'setDoorConditions': {
        const door = draft.doors.find((d) => d.id === op.id);
        if (!door) return fail(`Unknown door "${op.id}".`);
        door.conditions = structuredClone(op.conditions);
        break;
      }
      case 'removeDoor': {
        const index = draft.doors.findIndex((d) => d.id === op.id);
        if (index < 0) return fail(`Unknown door "${op.id}".`);
        draft.doors.splice(index, 1);
        break;
      }
    }
  }

  const errors = validateLevel(draft);
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, level: draft };
}
