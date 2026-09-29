import type { DoorCycle, Level, Patrol } from '../../shared/schema.js';

/**
 * Turn-based hazards (§6.4). The world keeps a turn counter; every move or
 * wait is one turn. Timed doors open on a fixed schedule and guards walk
 * their routes back and forth, one room per turn. Both depend only on the
 * turn — never on the player — so the reachable states are
 * (module, keys, switches, turn mod cycle) and the checker stays exhaustive.
 */

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

function lcm(a: number, b: number): number {
  return (a / gcd(a, b)) * b;
}

/** A guard on route A B C walks A B C B A B C …: period 2 × (length − 1). */
export function patrolPeriod(patrol: Pick<Patrol, 'route'>): number {
  return Math.max(1, 2 * (patrol.route.length - 1));
}

/** Where a guard stands on a given turn. */
export function patrolPosition(patrol: Pick<Patrol, 'route'>, turn: number): string {
  const period = patrolPeriod(patrol);
  const step = ((turn % period) + period) % period;
  const index = step < patrol.route.length ? step : period - step;
  return patrol.route[index]!;
}

/** The world's cycle: after this many turns every hazard repeats (1 = none). */
export function worldCycle(level: Pick<Level, 'doors' | 'patrols'>): number {
  let cycle = 1;
  for (const door of level.doors) {
    const timed: DoorCycle | undefined = door.conditions?.cycle;
    if (timed !== undefined) cycle = lcm(cycle, timed.period);
  }
  for (const patrol of level.patrols ?? []) cycle = lcm(cycle, patrolPeriod(patrol));
  return cycle;
}

/** True when the level has any turn-based hazard (and so a Wait action). */
export function hasHazards(level: Pick<Level, 'doors' | 'patrols'>): boolean {
  return worldCycle(level) > 1;
}

/** A timed door is open while (turn mod period) < openTicks. */
export function cycleOpen(cycle: DoorCycle, turn: number): boolean {
  return turn % cycle.period < cycle.openTicks;
}

/**
 * Caught by a guard: the player ends the turn where the guard now stands,
 * or the two trade places (walking through each other).
 */
export function caughtBy(
  patrols: ReadonlyArray<Pick<Patrol, 'id' | 'route'>>,
  turn: number,
  from: string,
  to: string,
): string | null {
  for (const patrol of patrols) {
    const before = patrolPosition(patrol, turn);
    const after = patrolPosition(patrol, turn + 1);
    if (to === after || (to === before && after === from)) return patrol.id;
  }
  return null;
}
