import type { DoorConditions, Level, Operation } from '../../shared/schema.js';

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
      return previous === undefined
        ? `Set the exits from ${moduleName(after, operation.id)} to ${directionList(operation.ports)}.`
        : `Change exits from ${moduleName(before, operation.id)} from ${directionList(previous.ports)} to ${directionList(operation.ports)}.`;
    }
    case 'setModuleLabel':
      return `Rename ${moduleName(before, operation.id)} to “${operation.label}”.`;
    case 'addItem':
      return `Add a ${operation.itemType} “${humanize(operation.id)}” to ${location(after, operation.moduleId)}.`;
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
  }
}

export function describeOperations(operations: Operation[], before: Level, after: Level): string[] {
  return operations.map((operation) => describeOperation(operation, before, after));
}
