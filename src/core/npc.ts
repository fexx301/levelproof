import { NPC_PROPS, type Level, type Prop } from '../../shared/schema.js';
import { nextStep } from './hint.js';
import type { GameState } from './movement.js';
import type { CompiledLevel } from './topology.js';

/**
 * Talking characters (§12): scenery that speaks the engine's hint. An NPC is
 * a landmark prop — the engine never reads it, so it blocks, trades, and
 * gates nothing. What it says comes from `nextStep`: the next objective on
 * the shortest winning route from exactly where the player stands. The model
 * may only phrase these facts in character (checked on the server); this
 * module also writes a plain line, so the character always answers, even
 * without the model.
 */

export type NpcKind = 'merchant' | 'guide' | 'sage' | 'robot';

export function isNpc(prop: Prop): boolean {
  return NPC_PROPS.has(prop.prop);
}

/** The character the player can talk to from this room: on its cell or beside it. */
export function npcNear(level: Level, moduleId: string): Prop | null {
  const room = level.modules.find((module) => module.id === moduleId);
  if (room === undefined) return null;
  return (level.props ?? []).find((prop) => isNpc(prop) && Math.max(Math.abs(prop.x - room.x), Math.abs(prop.z - room.z)) <= 1) ?? null;
}

export interface NpcFacts {
  npc: { id: string; kind: NpcKind; name: string };
  situation: 'objective' | 'goal' | 'at_goal' | 'stranded' | 'rule_blocked' | 'unknown';
  /** The next key or switch on the shortest winning route, and its room. */
  objective?: { kind: 'key' | 'switch'; name: string; room: string };
  goalRoom: string;
  /** The first step's room; absent when the first step is waiting for a guard. */
  nextRoom?: string;
  waitFirst: boolean;
  /** A spoken line must name at least one of these (empty: no requirement). */
  mustName: string[];
}

const spaced = (id: string): string => id.replace(/-/g, ' ');

export function npcFacts(compiled: CompiledLevel, npc: Prop, state: GameState, visited: ReadonlySet<string>): NpcFacts {
  const room = (id: string): string => compiled.moduleById.get(id)?.label ?? spaced(id);
  const keyName = (id: string): string => {
    const look = compiled.level.keys.find((key) => key.id === id)?.look;
    return look !== undefined && look !== 'key' ? look : spaced(id);
  };
  const base = { npc: { id: npc.id, kind: npc.prop as NpcKind, name: spaced(npc.id) }, goalRoom: room(compiled.goal), waitFirst: false };
  const hint = nextStep(compiled, state, visited);
  switch (hint.kind) {
    case 'move': {
      const first = hint.move;
      const step = first.action === 'wait' ? {} : { nextRoom: room(first.destination) };
      const pickup = hint.route.find((move) => move.events.collectedKey !== undefined || move.events.activatedSwitch !== undefined);
      const common = { ...base, ...step, waitFirst: first.action === 'wait' };
      if (pickup === undefined) return { ...common, situation: 'goal', mustName: [base.goalRoom] };
      const objective = pickup.events.collectedKey !== undefined
        ? { kind: 'key' as const, name: keyName(pickup.events.collectedKey), room: room(pickup.destination) }
        : { kind: 'switch' as const, name: spaced(pickup.events.activatedSwitch!), room: room(pickup.destination) };
      return { ...common, situation: 'objective', objective, mustName: [objective.room, objective.name] };
    }
    case 'rule_blocked':
      return { ...base, situation: 'rule_blocked', mustName: [] };
    case 'at_goal':
      return { ...base, situation: 'at_goal', mustName: [] };
    case 'stranded':
    case 'rule_broken':
      return { ...base, situation: 'stranded', mustName: [] };
    case 'unknown':
      return { ...base, situation: 'unknown', mustName: [] };
  }
}

const OPENERS: Record<NpcKind, string> = {
  merchant: 'Ah, a customer!',
  guide: 'This way, traveller.',
  sage: 'Listen well.',
  robot: 'Greetings, explorer.',
};

/** The engine's words, in a plain voice: shown at once, and kept if the model cannot answer. */
export function plainNpcLine(facts: NpcFacts): string {
  const opener = OPENERS[facts.npc.kind];
  const wait = facts.waitFirst ? ' Wait a turn first and let the guard pass.' : '';
  const start = facts.nextRoom !== undefined ? ` Start toward ${facts.nextRoom}.` : '';
  switch (facts.situation) {
    case 'objective':
      return `${opener} You'll need the ${facts.objective!.name} — it's in ${facts.objective!.room}.${wait}${start}`;
    case 'goal':
      return `${opener} You have all you need: make for ${facts.goalRoom}.${wait}${start}`;
    case 'at_goal':
      return 'You made it — well done!';
    case 'rule_blocked':
      return `You can still reach ${facts.goalRoom}, but only by breaking a rule. Start again (R) for a clean win.`;
    case 'stranded':
      return `${opener} I'm afraid there's no way on from here. Start again (R).`;
    case 'unknown':
      return 'Even I cannot see the whole way from here. Try the Hint.';
  }
}
