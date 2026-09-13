import { describe, expect, it } from 'vitest';
import { baselineLevel } from '../src/core/fixtures/baseline';
import { trapRepairedLevel } from '../src/core/fixtures/trap-repaired';
import { unfamiliarLevel } from '../src/core/fixtures/unfamiliar';
import { trapLevel } from '../src/core/fixtures/trap';
import { vaultEmptyLevel } from '../src/core/fixtures/vault-empty';
import { verify } from '../src/core/verifier';
import { twinKeysLevel, overpassLevel, gauntletLevel } from '../src/core/fixtures/gallery';
import { compileLevel } from '../src/core/topology';
import { doorPassable, step } from '../src/core/movement';

describe('golden fixture expectations (§8)', () => {
  it('the empty vault: geometry, spawn, and goal only — accepted', () => {
    const report = verify(vaultEmptyLevel);
    expect(report.valid).toBe(true);
    expect(report.checks.solution.status).toBe('pass');
    expect(report.checks.requirements.status).toBe('not_applicable');
    expect(report.checks.recovery.status).toBe('pass');
    expect(report.accepted).toBe(true);
  });

  it('the trap-repaired scene: switch behind the key door — all three pass', () => {
    const report = verify(trapRepairedLevel);
    expect(report.valid).toBe(true);
    expect(report.checks.solution.status).toBe('pass');
    expect(report.checks.requirements.status).toBe('pass');
    expect(report.checks.recovery.status).toBe('pass');
    expect(report.accepted).toBe(true);
    expect(report.internalError).toBeUndefined();
  });

  it('the held-out unfamiliar layout is valid and accepted (§8.4 gate seed)', () => {
    const report = verify(unfamiliarLevel);
    expect(report.valid).toBe(true);
    expect(report.checks.solution.status).toBe('pass');
    expect(report.checks.requirements.status).toBe('pass');
    expect(report.checks.recovery.status).toBe('pass');
    expect(report.accepted).toBe(true);
  });
  it('the unrepaired trap still fails recovery', () => {
    expect(verify(trapLevel).checks.recovery.status).toBe('fail');
  });

  it('baseline stays accepted (regression guard for fixture edits)', () => {
    expect(verify(baselineLevel).accepted).toBe(true);
  });
});

describe('gallery scenes (§12 showcase levels)', () => {
  it('twin keys: ordered collection and a powered return loop — all green', () => {
    const report = verify(twinKeysLevel);
    expect(report.valid).toBe(true);
    expect(report.accepted).toBe(true);
    expect(report.recoveryMap).toEqual({ stranded: [], unreachable: [] });
  });

  it('overpass: a bridge crossing directly over a lower corridor — all green', () => {
    const report = verify(overpassLevel);
    expect(report.accepted).toBe(true);
    const bridge = overpassLevel.modules.find((m) => m.id === 'bridge-c')!;
    const under = overpassLevel.modules.find((m) => m.id === 'under-passage')!;
    expect(bridge.x).toBe(under.x);
    expect(bridge.z).toBe(under.z);
    expect(bridge.h).toBeGreaterThan(under.h);
    expect(report.recoveryMap).toEqual({ stranded: [], unreachable: [] });
  });

  it('gauntlet: the commitment gate is provably safe — no stranded floors', () => {
    const report = verify(gauntletLevel);
    expect(report.accepted).toBe(true);
    expect(report.recoveryMap?.stranded).toEqual([]);
    // The trap exists: a door that seals, and a switch that seals it.
    expect(gauntletLevel.doors.some((d) => d.conditions?.closesAfterSwitch === 'vault-seal')).toBe(true);
  });

  it('Twin Keys cannot reach gold first or skip the power room', () => {
    const c = compileLevel(twinKeysLevel);
    const empty = { moduleId: 'east-walk', keyMask: 0, switchMask: 0 };
    expect(step(c, empty, 'E')).toBeNull();
    expect(doorPassable(c, 'return-door', empty)).toBe(false);
    const silver = c.keyBit.get('silver-key')!;
    expect(step(c, { ...empty, keyMask: silver }, 'E')?.events.collectedKey).toBe('gold-key');
    const route = verify(twinKeysLevel).checks.solution.witness!.route;
    const eventIndex = (id: string) => route.findIndex(move => move.events.collectedKey === id || move.events.activatedSwitch === id);
    expect(eventIndex('silver-key')).toBeLessThan(eventIndex('gold-key'));
    expect(eventIndex('gold-key')).toBeLessThan(eventIndex('vault-power'));
    const unpowered = structuredClone(twinKeysLevel);
    unpowered.modules.find(m => m.id === 'east-return')!.ports = [];
    expect(verify(unpowered).checks.solution.status).toBe('fail');
  });

  it('Overpass needs the upper relay; sealing the lower shortcut leaves a real descent', () => {
    const c = compileLevel(overpassLevel);
    const state = { moduleId: 'west-loft', keyMask: c.keyBit.get('pass-key')!, switchMask: 0 };
    expect(doorPassable(c, 'relay-exit', state)).toBe(false);
    expect(doorPassable(c, 'vault-shortcut', state)).toBe(false);
    const activated = { ...state, switchMask: c.switchBit.get('bridge-relay')! };
    expect(doorPassable(c, 'lower-seal', activated)).toBe(false);
    const descent = step(c, activated, 'N')!;
    expect(descent.destination).toBe('return-ramp');
    const landing = step(c, descent.after, 'N')!;
    expect(step(c, landing.after, 'E')?.events.reachedGoal).toBe(true);
    const route = verify(overpassLevel).checks.solution.witness!.route;
    expect(route.some(move => move.events.activatedSwitch === 'bridge-relay')).toBe(true);
    expect(route.some(move => move.destination === 'under-passage')).toBe(true);
    expect(route.some(move => move.destination === 'bridge-c')).toBe(true);
  });

  it('Gauntlet requires both preparations, then seals behind the player without trapping them', () => {
    const c = compileLevel(gauntletLevel);
    const base = { moduleId: 'vault-approach', keyMask: 0, switchMask: 0 };
    const keyMask = c.keyBit.get('brass-key')!;
    const switchMask = c.switchBit.get('gate-primer')!;
    expect(step(c, { ...base, keyMask }, 'N')).toBeNull();
    expect(step(c, { ...base, switchMask }, 'N')).toBeNull();
    const commit = step(c, { ...base, keyMask, switchMask }, 'N')!;
    expect(commit.events.activatedSwitch).toBe('vault-seal');
    expect(step(c, commit.after, 'S')).toBeNull();
    expect(step(c, commit.after, 'N')?.events.reachedGoal).toBe(true);
    // Negative control: put the seal before preparation and the checker catches it.
    const broken = structuredClone(gauntletLevel);
    broken.switches.find(s => s.id === 'vault-seal')!.moduleId = 'gallery-mid';
    expect(verify(broken).accepted).toBe(false);
  });
});
