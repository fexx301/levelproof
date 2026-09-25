import type { Level, LevelModule } from '../../shared/schema.js';

/** A location marker for a before/after edit preview. */
export interface PreviewMarker {
  phase: 'old' | 'fresh';
  kind: 'module' | 'item' | 'door' | 'spawn' | 'goal' | 'prop';
  id: string;
  /** Host module; empty for props, which are placed by grid cell instead. */
  moduleId: string;
  otherModuleId?: string;
  cell?: { x: number; z: number };
}

function sameModule(a: LevelModule, b: LevelModule): boolean {
  return (
    a.template === b.template &&
    a.x === b.x &&
    a.z === b.z &&
    a.h === b.h &&
    a.orientation === b.orientation &&
    a.label === b.label &&
    a.ports.join('|') === b.ports.join('|')
  );
}

function sameDoor(a: Level['doors'][number], b: Level['doors'][number]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function addEntityPair(
  markers: PreviewMarker[],
  kind: PreviewMarker['kind'],
  id: string,
  beforeModuleId: string,
  afterModuleId: string,
  changed: boolean,
): void {
  if (!changed) return;
  markers.push({ phase: 'old', kind, id, moduleId: beforeModuleId });
  markers.push({ phase: 'fresh', kind, id, moduleId: afterModuleId });
}

/**
 * Pure, renderer-independent diff used by both repair and AI-edit previews.
 * The before and after module maps are intentionally independent: a newly
 * added or moved entity must never be resolved through the old topology.
 */
export function previewDiff(before: Level, after: Level): PreviewMarker[] {
  const markers: PreviewMarker[] = [];
  const beforeModules = new Map(before.modules.map((module) => [module.id, module] as const));
  const afterModules = new Map(after.modules.map((module) => [module.id, module] as const));

  for (const [id, module] of beforeModules) {
    const next = afterModules.get(id);
    if (next === undefined) markers.push({ phase: 'old', kind: 'module', id, moduleId: module.id });
    else if (!sameModule(module, next)) {
      markers.push({ phase: 'old', kind: 'module', id, moduleId: module.id });
      markers.push({ phase: 'fresh', kind: 'module', id, moduleId: next.id });
    }
  }
  for (const [id, module] of afterModules) {
    if (!beforeModules.has(id)) markers.push({ phase: 'fresh', kind: 'module', id, moduleId: module.id });
  }

  const beforeItems = new Map(
    [...before.keys.map((item) => [item.id, item.moduleId] as const), ...before.switches.map((item) => [item.id, item.moduleId] as const)],
  );
  const afterItems = new Map(
    [...after.keys.map((item) => [item.id, item.moduleId] as const), ...after.switches.map((item) => [item.id, item.moduleId] as const)],
  );
  for (const [id, moduleId] of beforeItems) {
    const nextModuleId = afterItems.get(id);
    if (nextModuleId === undefined) markers.push({ phase: 'old', kind: 'item', id, moduleId });
    else addEntityPair(markers, 'item', id, moduleId, nextModuleId, moduleId !== nextModuleId);
  }
  for (const [id, moduleId] of afterItems) {
    if (!beforeItems.has(id)) markers.push({ phase: 'fresh', kind: 'item', id, moduleId });
  }

  const beforeDoors = new Map(before.doors.map((door) => [door.id, door] as const));
  const afterDoors = new Map(after.doors.map((door) => [door.id, door] as const));
  for (const [id, door] of beforeDoors) {
    const next = afterDoors.get(id);
    if (next === undefined) {
      markers.push({ phase: 'old', kind: 'door', id, moduleId: door.a, otherModuleId: door.b });
    } else if (!sameDoor(door, next)) {
      markers.push({ phase: 'old', kind: 'door', id, moduleId: door.a, otherModuleId: door.b });
      markers.push({ phase: 'fresh', kind: 'door', id, moduleId: next.a, otherModuleId: next.b });
    }
  }
  for (const [id, door] of afterDoors) {
    if (!beforeDoors.has(id)) {
      markers.push({ phase: 'fresh', kind: 'door', id, moduleId: door.a, otherModuleId: door.b });
    }
  }

  if (before.spawn !== after.spawn) {
    markers.push({ phase: 'old', kind: 'spawn', id: 'spawn', moduleId: before.spawn });
    markers.push({ phase: 'fresh', kind: 'spawn', id: 'spawn', moduleId: after.spawn });
  }
  if (before.goal !== after.goal) {
    markers.push({ phase: 'old', kind: 'goal', id: 'goal', moduleId: before.goal });
    markers.push({ phase: 'fresh', kind: 'goal', id: 'goal', moduleId: after.goal });
  }

  const beforeProps = new Map((before.props ?? []).map((prop) => [prop.id, prop] as const));
  const afterProps = new Map((after.props ?? []).map((prop) => [prop.id, prop] as const));
  for (const [id, prop] of beforeProps) {
    const next = afterProps.get(id);
    if (next === undefined || next.x !== prop.x || next.z !== prop.z || next.prop !== prop.prop) {
      markers.push({ phase: 'old', kind: 'prop', id, moduleId: '', cell: { x: prop.x, z: prop.z } });
    }
    if (next !== undefined && (next.x !== prop.x || next.z !== prop.z || next.prop !== prop.prop)) {
      markers.push({ phase: 'fresh', kind: 'prop', id, moduleId: '', cell: { x: next.x, z: next.z } });
    }
  }
  for (const [id, prop] of afterProps) {
    if (!beforeProps.has(id)) markers.push({ phase: 'fresh', kind: 'prop', id, moduleId: '', cell: { x: prop.x, z: prop.z } });
  }

  return markers;
}
