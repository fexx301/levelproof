import type { DoorConditions, Environment, KeyLook, Level, Lighting, Operation, PropKind, ThemeKey } from '../../shared/schema.js';

export const ENVIRONMENT_LABELS: Record<Environment, string> = {
  void: 'an empty stage',
  meadow: 'a meadow',
  forest: 'a forest',
  swamp: 'a swamp',
  desert: 'a desert',
  snow: 'a snowfield',
  volcanic: 'volcanic ground',
  cavern: 'a cavern',
  sea: 'the open sea',
  space: 'deep space',
  city: 'a city',
};

export const LIGHTING_LABELS: Record<Lighting, string> = { day: 'daylight', dusk: 'dusk', night: 'night' };

export const ARCHITECTURE_LABELS: Record<ThemeKey, string> = {
  limestone: 'limestone ruin',
  ivory: 'ivory observatory',
  patina: 'patina relay works',
  basalt: 'basalt lockhouse',
  futuristic: 'futuristic vault',
};

const KEY_LOOK_LABELS: Record<KeyLook, string> = {
  key: 'a key',
  torch: 'a torch',
  lantern: 'a lantern',
  gem: 'a gem',
  orb: 'an orb',
  crown: 'a crown',
  scroll: 'a scroll',
  keycard: 'a keycard',
  amulet: 'an amulet',
};

function propName(prop: PropKind): string {
  return prop === 'water' ? 'water' : prop === 'lava' ? 'lava' : prop.replace(/-/g, ' ');
}

function humanize(value: string): string {
  return value.replace(/[-_]+/g, ' ');
}

function moduleName(level: Level, id: string): string {
  const module = level.modules.find((item) => item.id === id);
  return module?.label ? `“${module.label}”` : `“${humanize(id)}”`;
}

function entityName(level: Level, id: string): string {
  if (level.keys.some((item) => item.id === id)) return `key “${humanize(id)}”`;
  if (level.switches.some((item) => item.id === id)) return `switch “${humanize(id)}”`;
  const door = level.doors.find((item) => item.id === id);
  if (door !== undefined) return `door between ${moduleName(level, door.a)} and ${moduleName(level, door.b)}`;
  const module = level.modules.find((item) => item.id === id);
  if (module !== undefined) return moduleName(level, id);
  return `“${humanize(id)}”`;
}

function location(level: Level, moduleId: string): string {
  return moduleName(level, moduleId);
}

function gridPosition(x: number, z: number, h: number): string {
  return `tile (${x + 1}, ${z + 1}), level ${h + 1}`;
}

function conditionPhrases(conditions: DoorConditions | undefined): string[] {
  if (conditions === undefined) return [];
  const phrases: string[] = [];
  if (conditions.requiresKey !== undefined) phrases.push(`requires key “${humanize(conditions.requiresKey)}”`);
  if (conditions.requiresKeys !== undefined && conditions.requiresKeys.length > 0) {
    phrases.push(`requires all keys: ${conditions.requiresKeys.map((id) => `“${humanize(id)}”`).join(', ')}`);
  }
  if (conditions.requiresSwitch !== undefined) phrases.push(`requires switch “${humanize(conditions.requiresSwitch)}”`);
  if (conditions.closesAfterSwitch !== undefined) {
    phrases.push(`closes permanently when “${humanize(conditions.closesAfterSwitch)}” is activated`);
  }
  return phrases;
}

function directionList(directions: string[]): string {
  const names: Record<string, string> = { N: 'north', E: 'east', S: 'south', W: 'west' };
  return directions.length === 0 ? 'no exits' : directions.map((direction) => names[direction] ?? direction).join(', ');
}

/** Describe the proposed result in user language, using the before/candidate pair. */
export function describeOperation(operation: Operation, before: Level, after: Level): string {
  switch (operation.kind) {
    case 'addModule': {
      const name = moduleName(after, operation.module.id);
      return `Add a ${operation.module.template} platform ${name} at ${gridPosition(operation.module.x, operation.module.z, operation.module.h)}.`;
    }
    case 'removeModule':
      return `Remove platform ${moduleName(before, operation.id)}.`;
    case 'moveModule': {
      const oldModule = before.modules.find((item) => item.id === operation.id);
      const next = after.modules.find((item) => item.id === operation.id);
      if (oldModule === undefined || next === undefined) return `Move platform ${moduleName(before, operation.id)}.`;
      return `Move platform ${moduleName(before, operation.id)} from ${gridPosition(oldModule.x, oldModule.z, oldModule.h)} to ${gridPosition(next.x, next.z, next.h)}.`;
    }
    case 'setModulePorts': {
      const previous = before.modules.find((item) => item.id === operation.id);
      if (previous !== undefined && [...previous.ports].sort().join() === [...operation.ports].sort().join()) return '';
      return previous === undefined
        ? `Set the exits from ${moduleName(after, operation.id)} to ${directionList(operation.ports)}.`
        : `Change exits from ${moduleName(before, operation.id)} from ${directionList(previous.ports)} to ${directionList(operation.ports)}.`;
    }
    case 'setModuleLabel':
      return `Rename ${moduleName(before, operation.id)} to “${operation.label}”.`;
    case 'addItem':
      return operation.look !== undefined && operation.look !== 'key'
        ? `Add a key “${humanize(operation.id)}” (shown as ${KEY_LOOK_LABELS[operation.look]}) to ${location(after, operation.moduleId)}.`
        : `Add a ${operation.itemType} “${humanize(operation.id)}” to ${location(after, operation.moduleId)}.`;
    case 'moveItem': {
      const oldModuleId = [...before.keys, ...before.switches].find((item) => item.id === operation.id)?.moduleId;
      const noun = entityName(before, operation.id);
      return oldModuleId === undefined
        ? `Move ${noun} to ${location(after, operation.moduleId)}.`
        : `Move ${noun} from ${location(before, oldModuleId)} to ${location(after, operation.moduleId)}.`;
    }
    case 'removeItem': {
      const item = [...before.keys, ...before.switches].find((entry) => entry.id === operation.id);
      return item === undefined
        ? `Remove ${entityName(before, operation.id)}.`
        : `Remove ${entityName(before, operation.id)} from ${location(before, item.moduleId)}.`;
    }
    case 'moveSpawn':
      return `Move the player start from ${location(before, before.spawn)} to ${location(after, operation.moduleId)}.`;
    case 'moveGoal':
      return `Move the goal from ${location(before, before.goal)} to ${location(after, operation.moduleId)}.`;
    case 'addDoor': {
      const conditions = conditionPhrases(operation.door.conditions);
      return `Add a door between ${moduleName(after, operation.door.a)} and ${moduleName(after, operation.door.b)}${conditions.length > 0 ? `; it ${conditions.join(' and ')}.` : '.'}`;
    }
    case 'setDoorConditions': {
      const nextConditions = conditionPhrases(operation.conditions);
      const phrase = nextConditions.length > 0 ? `It now ${nextConditions.join(' and ')}.` : 'It is now freely passable.';
      return `Change the rules on ${entityName(before, operation.id)}. ${phrase}`;
    }
    case 'removeDoor':
      return `Remove ${entityName(before, operation.id)}.`;
    case 'setScenery': {
      const parts: string[] = [];
      if (operation.environment !== undefined) parts.push(`set the world to ${ENVIRONMENT_LABELS[operation.environment]}`);
      if (operation.lighting !== undefined) parts.push(`light it for ${LIGHTING_LABELS[operation.lighting]}`);
      if (operation.architecture !== undefined) parts.push(`build in ${ARCHITECTURE_LABELS[operation.architecture]} style`);
      const text = parts.join(', ');
      return `Scenery: ${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
    }
    case 'addProp': {
      const host = after.modules
        .filter((module) => module.x === operation.x && module.z === operation.z)
        .sort((a, b) => b.h - a.h)[0];
      const where = host !== undefined && operation.prop !== 'water' && operation.prop !== 'lava'
        ? `on ${moduleName(after, host.id)}`
        : `at tile (${operation.x + 1}, ${operation.z + 1})`;
      return `Scenery: add ${propName(operation.prop)} “${humanize(operation.id)}” ${where}.`;
    }
    case 'moveProp':
      return `Scenery: move “${humanize(operation.id)}” to tile (${operation.x + 1}, ${operation.z + 1}).`;
    case 'removeProp':
      return `Scenery: remove “${humanize(operation.id)}”.`;
    case 'setKeyLook':
      return `Show key “${humanize(operation.id)}” as ${KEY_LOOK_LABELS[operation.look]}.`;
  }
}

/** Plain-language lines for the preview; edits that change nothing are omitted. */
export function describeOperations(operations: Operation[], before: Level, after: Level): string[] {
  return operations
    .map((operation) => describeOperation(operation, before, after))
    .filter((text) => text.length > 0);
}

function plural(count: number, noun: string, pluralNoun = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : pluralNoun}`;
}

/**
 * One line for the whole change, counted from the actual before/after levels
 * rather than the operation list, so it cannot drift from the preview.
 */
export function summarizeChange(before: Level, after: Level): string {
  const parts: string[] = [];
  const beforeModules = new Map(before.modules.map((module) => [module.id, module] as const));
  const added = after.modules.filter((module) => !beforeModules.has(module.id));
  const afterIds = new Set(after.modules.map((module) => module.id));
  const removed = before.modules.filter((module) => !afterIds.has(module.id));
  const moved = after.modules.filter((module) => {
    const previous = beforeModules.get(module.id);
    return previous !== undefined && (previous.x !== module.x || previous.z !== module.z || previous.h !== module.h);
  });
  if (added.length > 0) {
    const ramps = added.filter((module) => module.template === 'ramp').length;
    const bridges = added.filter((module) => module.template === 'bridge').length;
    const extras = [ramps > 0 ? plural(ramps, 'ramp') : null, bridges > 0 ? plural(bridges, 'bridge') : null].filter(Boolean);
    parts.push(`builds ${plural(added.length, 'platform')}${extras.length > 0 ? ` (${extras.join(', ')})` : ''}`);
  }
  if (moved.length > 0) parts.push(`moves ${plural(moved.length, 'platform')}`);
  if (removed.length > 0) parts.push(`removes ${plural(removed.length, 'platform')}`);
  const countNew = <T extends { id: string }>(a: T[], b: T[]): number => b.filter((item) => !a.some((other) => other.id === item.id)).length;
  const countGone = <T extends { id: string }>(a: T[], b: T[]): number => a.filter((item) => !b.some((other) => other.id === item.id)).length;
  const keys = countNew(before.keys, after.keys);
  const switches = countNew(before.switches, after.switches);
  const doors = countNew(before.doors, after.doors);
  if (keys > 0) parts.push(`adds ${plural(keys, 'key')}`);
  if (switches > 0) parts.push(`adds ${plural(switches, 'switch', 'switches')}`);
  if (doors > 0) parts.push(`adds ${plural(doors, 'door')}`);
  const goneItems = countGone(before.keys, after.keys) + countGone(before.switches, after.switches);
  const goneDoors = countGone(before.doors, after.doors);
  if (goneItems > 0) parts.push(`removes ${plural(goneItems, 'item')}`);
  if (goneDoors > 0) parts.push(`removes ${plural(goneDoors, 'door')}`);
  const reconditioned = after.doors.filter((door) => {
    const previous = before.doors.find((item) => item.id === door.id);
    return previous !== undefined && JSON.stringify(previous.conditions ?? {}) !== JSON.stringify(door.conditions ?? {});
  }).length;
  if (reconditioned > 0) parts.push(`changes ${plural(reconditioned, 'door rule')}`);
  const rules = after.requirements.length - before.requirements.length;
  if (rules > 0) parts.push(`adds ${plural(rules, 'design rule')}`);
  if (rules < 0) parts.push(`removes ${plural(-rules, 'design rule')}`);
  const environment = after.scenery?.environment;
  const lighting = after.scenery?.lighting;
  if (environment !== before.scenery?.environment && environment !== undefined) {
    parts.push(`sets ${ENVIRONMENT_LABELS[environment]}${lighting !== undefined ? ` at ${LIGHTING_LABELS[lighting]}` : ''}`);
  } else if (lighting !== before.scenery?.lighting && lighting !== undefined) {
    parts.push(`changes the light to ${LIGHTING_LABELS[lighting]}`);
  }
  const newProps = countNew(before.props ?? [], after.props ?? []);
  if (newProps > 0) parts.push(`places ${plural(newProps, 'landmark')}`);
  if (parts.length === 0) {
    const renamed = after.modules.some((module) => beforeModules.get(module.id)?.label !== module.label);
    return renamed ? 'Renames places in the scene.' : 'Small scene adjustments.';
  }
  const text = parts.join(', ');
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}
