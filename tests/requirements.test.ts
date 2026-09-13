import { describe, expect, it } from 'vitest';
import { applyOperations } from '../src/core/level';
import { verify } from '../src/core/verifier';
import type { Level } from '../shared/schema';

/**
 * §5 extended requirements: passThrough and switchNecessary.
 *
 * The soundness subtlety under test: goal states record (module, keyMask,
 * switchMask) — item masks DO encode which item modules a route visited
 * (collection is automatic and permanent), but plain modules leave no
 * trace, and routes merge at shared states. So passThrough must be checked
 * by a counterexample search (goal reachable while never arriving at the
 * module), NOT by inspecting goal states. These tests construct exactly
 * the merging-route cases that would fool a goal-state-only check.
 */

function corridor(): Level {
  // spawn -> mid -> goal, plus a bypass lane branching at mid.
  // Routes through "mid" and through "bypass-lane" both reach the goal.
  return {
    modules: [
      { id: 'spawn-pad', template: 'flat', x: 5, z: 8, h: 0, ports: ['N', 'E'] },
      { id: 'mid', template: 'flat', x: 5, z: 7, h: 0, ports: ['N', 'S', 'E'] },
      { id: 'goal-pad', template: 'flat', x: 5, z: 6, h: 0, ports: ['S', 'E'] },
      { id: 'bypass-lane', template: 'flat', x: 6, z: 8, h: 0, ports: ['W', 'N'] },
      { id: 'bypass-join', template: 'flat', x: 6, z: 7, h: 0, ports: ['N', 'S', 'W'] },
      { id: 'bypass-end', template: 'flat', x: 6, z: 6, h: 0, ports: ['S', 'W'] },
    ],
    keys: [],
    switches: [],
    spawn: 'spawn-pad',
    goal: 'goal-pad',
    doors: [],
    requirements: [],
  };
}

describe('passThrough (§5 extended)', () => {
  it('passes when the module is on every winning route', () => {
    // Gate both bypass exits so the only way to the goal is through mid.
    const gated = applyOperations(corridor(), [
      { kind: 'addDoor', door: { id: 'gate-a', a: 'bypass-lane', b: 'bypass-join', conditions: { requiresSwitch: 'never' } } },
    ]);
    // simpler: remove the bypass modules entirely
    const direct: Level = {
      ...corridor(),
      modules: corridor().modules.filter((m) => !m.id.startsWith('bypass')),
    };
    const report = verify({ ...direct, requirements: [{ type: 'passThrough', moduleId: 'mid' }] });
    expect(report.checks.requirements.status).toBe('pass');
    void gated;
  });

  it('fails with a bypass witness when a route avoids the module — merging-route case', () => {
    // Both lanes open: a route can go around "mid" entirely.
    const report = verify({ ...corridor(), requirements: [{ type: 'passThrough', moduleId: 'mid' }] });
    expect(report.checks.requirements.status).toBe('fail');
    const witness = report.checks.requirements.witness;
    expect(witness?.kind).toBe('bypass');
    expect(witness?.route.some((m) => m.destination === 'mid')).toBe(false);
    expect(witness?.route.at(-1)?.destination).toBe('goal-pad');
    // The violation text is honest and replay-verified (internalError free).
    expect(witness?.violationText).toContain('mid');
    expect(report.internalError).toBeUndefined();
  });

  it('both lanes end at the same goal state — the merging case a goal-state check would miss', () => {
    // With both lanes open, the through-route and the bypass route reach
    // the SAME goal state (goal module, no items anywhere). A check that
    // only inspected goal states could not distinguish them; the
    // counterexample search must still find the bypass.
    const bothLanes = corridor();
    const report = verify({ ...bothLanes, requirements: [{ type: 'passThrough', moduleId: 'mid' }] });
    expect(report.checks.requirements.status).toBe('fail');
    expect(report.checks.requirements.witness?.route.some((m) => m.destination === 'mid')).toBe(false);
    expect(report.internalError).toBeUndefined();
  });

  it('rejects dangling module references', () => {
    const errors = verify({ ...corridor(), requirements: [{ type: 'passThrough', moduleId: 'ghost-room' }] });
    expect(errors.invalidReasons.some((r) => r.includes('ghost-room'))).toBe(true);
  });
});

describe('switchNecessary (§5 extended)', () => {
  it('passes when every winning route activates the switch', () => {
    // Switch on the only path; a keyed door behind it forces activation.
    const level: Level = {
      modules: [
        { id: 'spawn-pad', template: 'flat', x: 5, z: 8, h: 0, ports: ['N'] },
        { id: 'switch-room', template: 'flat', x: 5, z: 7, h: 0, ports: ['N', 'S'] },
        { id: 'goal-pad', template: 'flat', x: 5, z: 6, h: 0, ports: ['S'] },
      ],
      keys: [],
      switches: [{ id: 'gate-switch', moduleId: 'switch-room' }],
      spawn: 'spawn-pad',
      goal: 'goal-pad',
      doors: [{ id: 'gated-door', a: 'switch-room', b: 'goal-pad', conditions: { requiresSwitch: 'gate-switch' } }],
      requirements: [{ type: 'switchNecessary', switchId: 'gate-switch' }],
    };
    const report = verify(level);
    expect(report.checks.requirements.status).toBe('pass');
  });

  it('fails with a witness when a winning route skips the switch', () => {
    const level: Level = {
      modules: [
        { id: 'spawn-pad', template: 'flat', x: 5, z: 8, h: 0, ports: ['N', 'E'] },
        { id: 'switch-room', template: 'flat', x: 5, z: 7, h: 0, ports: ['N', 'S'] },
        { id: 'goal-pad', template: 'flat', x: 5, z: 6, h: 0, ports: ['S'] },
        { id: 'side-lane', template: 'flat', x: 6, z: 8, h: 0, ports: ['W', 'N'] },
        { id: 'side-join', template: 'flat', x: 6, z: 7, h: 0, ports: ['S'] },
      ],
      keys: [],
      switches: [{ id: 'gate-switch', moduleId: 'switch-room' }],
      spawn: 'spawn-pad',
      goal: 'side-join',
      doors: [],
      requirements: [{ type: 'switchNecessary', switchId: 'gate-switch' }],
    };
    const report = verify(level);
    expect(report.checks.requirements.status).toBe('fail');
    const witness = report.checks.requirements.witness;
    expect(witness?.kind).toBe('bypass');
    expect(witness?.violationText).toContain('gate-switch');
    expect(report.internalError).toBeUndefined();
  });

  it('rejects dangling switch references', () => {
    const errors = verify({ ...corridor(), requirements: [{ type: 'switchNecessary', switchId: 'ghost-switch' }] });
    expect(errors.invalidReasons.some((r) => r.includes('ghost-switch'))).toBe(true);
  });
});

describe('mixed requirements (all three kinds together)', () => {
  it('each kind is checked independently; the first violation wins', () => {
    const report = verify({ ...corridor(), requirements: [
      { type: 'passThrough', moduleId: 'mid' },
      { type: 'switchNecessary', switchId: 'nope' },
    ] });
    // 'nope' dangles, so the level is invalid rather than check-failed.
    expect(report.valid).toBe(false);
    const clean = verify({ ...corridor(), requirements: [{ type: 'passThrough', moduleId: 'mid' }] });
    expect(clean.checks.requirements.status).toBe('fail');
    expect(clean.checks.requirements.witness?.requirement?.type).toBe('passThrough');
  });
});
