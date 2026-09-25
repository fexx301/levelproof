import type { Level } from '../../shared/schema.js';
import { buildFailureEvidence } from './failure-evidence.js';
import { requirementText } from './level.js';
import { doorPassable, initialState, stateKey, transitions, type GameState } from './movement.js';
import { compileLevel } from './topology.js';
import type { Report } from './verifier.js';

/**
 * Engine findings for the AI↔engine revision loop. These are computed from
 * the level by the same deterministic core the verifier uses — never taken
 * from the client or the model — and phrased as short, concrete facts a
 * model can act on ("door X requires key K, which sits on unreachable Y").
 */

const MAX_FINDINGS = 8;

function quote(id: string): string {
  return `"${id}"`;
}

/** Every module a player can stand on, with the states seen there. */
function reachableStates(level: Level): Map<string, GameState[]> {
  const compiled = compileLevel(level);
  const start = initialState(compiled);
  const seen = new Set([stateKey(start)]);
  const byModule = new Map<string, GameState[]>([[start.moduleId, [start]]]);
  const queue: GameState[] = [start];
  while (queue.length > 0) {
    const state = queue.shift()!;
    for (const move of transitions(compiled, state)) {
      const key = stateKey(move.after);
      if (seen.has(key)) continue;
      seen.add(key);
      queue.push(move.after);
      const list = byModule.get(move.after.moduleId) ?? [];
      list.push(move.after);
      byModule.set(move.after.moduleId, list);
    }
  }
  return byModule;
}

function unreachableFindings(level: Level): string[] {
  const compiled = compileLevel(level);
  const reachable = reachableStates(level);
  const findings: string[] = [];
  const unreachable = level.modules.filter((m) => !reachable.has(m.id)).map((m) => m.id);
  if (unreachable.length > 0) {
    findings.push(`Unreachable platforms: ${unreachable.map(quote).join(', ')}. Reachable: ${[...reachable.keys()].map(quote).join(', ')}.`);
  }
  // Doors on the frontier: one side reachable, the other never.
  for (const door of level.doors) {
    const aIn = reachable.has(door.a);
    const bIn = reachable.has(door.b);
    if (aIn === bIn) continue;
    const side = aIn ? door.a : door.b;
    const states = reachable.get(side) ?? [];
    if (states.some((state) => doorPassable(compiled, door.id, state))) continue;
    const c = door.conditions ?? {};
    const reasons: string[] = [];
    const keys = [...(c.requiresKeys ?? []), ...(c.requiresKey !== undefined ? [c.requiresKey] : [])];
    for (const keyId of keys) {
      const key = level.keys.find((item) => item.id === keyId);
      const where = key === undefined ? 'nowhere' : reachable.has(key.moduleId) ? `${quote(key.moduleId)}` : `${quote(key.moduleId)}, which is unreachable`;
      reasons.push(`it requires key ${quote(keyId)} (on ${where})`);
    }
    if (c.requiresSwitch !== undefined) {
      const sw = level.switches.find((item) => item.id === c.requiresSwitch);
      reasons.push(`it requires switch ${quote(c.requiresSwitch)}${sw !== undefined && !reachable.has(sw.moduleId) ? ` (on unreachable ${quote(sw.moduleId)})` : ''}`);
    }
    if (c.closesAfterSwitch !== undefined) {
      reasons.push(`it seals once ${quote(c.closesAfterSwitch)} activates, and every route to it has already pressed that switch`);
    }
    findings.push(`Door ${quote(door.id)} between ${quote(door.a)} and ${quote(door.b)} never opens: ${reasons.join('; ') || 'no reachable state satisfies it'}.`);
  }
  // Platforms whose ports meet nothing at all.
  for (const module of level.modules) {
    if ((compiled.edgesByModule.get(module.id) ?? []).length === 0) {
      findings.push(`Platform ${quote(module.id)} connects to nothing: no open port meets a neighbor's facing port at the same elevation.`);
    }
  }
  return findings;
}

function routeText(report: Report, check: 'requirements' | 'recovery'): string | null {
  const witness = report.checks[check].witness;
  if (witness === undefined) return null;
  const steps = witness.route.map((move) => {
    const events = [
      move.events.collectedKey !== undefined ? `takes ${quote(move.events.collectedKey)}` : null,
      move.events.activatedSwitch !== undefined ? `presses ${quote(move.events.activatedSwitch)}` : null,
    ].filter(Boolean);
    return `${move.destination}${events.length > 0 ? ` (${events.join(', ')})` : ''}`;
  });
  return `${witness.route[0]?.source ?? witness.endState.moduleId} → ${steps.join(' → ')}`;
}

/** Concise engine facts about every failing check, or [] when all pass. */
export function engineFindings(level: Level, report: Report): string[] {
  if (!report.valid) return report.invalidReasons.slice(0, MAX_FINDINGS).map((reason) => `Invalid level: ${reason}`);
  const findings: string[] = [];
  if (report.checks.solution.status === 'fail') {
    findings.push(`The level cannot be won: ${report.checks.solution.explanation.replace(/^No winning route:\s*/, '')}`);
    findings.push(...unreachableFindings(level));
  }
  if (report.checks.requirements.status === 'fail') {
    const requirement = report.checks.requirements.witness?.requirement;
    findings.push(`A winning route breaks a design rule: ${report.checks.requirements.explanation}${requirement !== undefined ? ` Violated rule: ${requirementText(requirement).replace(/[“”]/g, '"')}.` : ''}`);
    const route = routeText(report, 'requirements');
    if (route !== null) findings.push(`Winning route that breaks the rule: ${route}.`);
  }
  if (report.checks.recovery.status === 'fail' && report.checks.solution.status !== 'fail') {
    const evidence = buildFailureEvidence(level, report, 'recovery');
    findings.push(`A player can get stuck: ${evidence?.fact ?? report.checks.recovery.explanation}`);
    const route = routeText(report, 'recovery');
    if (route !== null) findings.push(`Route that strands the player: ${route}.`);
  }
  if (!report.complete) findings.push(`Check incomplete: ${report.completionExplanation}`);
  return findings.slice(0, MAX_FINDINGS);
}
