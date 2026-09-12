import { describe, expect, it } from 'vitest';
import { baselineLevel } from '../src/core/fixtures/baseline';
import { trapRepairedLevel } from '../src/core/fixtures/trap-repaired';
import { unfamiliarLevel } from '../src/core/fixtures/unfamiliar';
import { trapLevel } from '../src/core/fixtures/trap';
import { vaultEmptyLevel } from '../src/core/fixtures/vault-empty';
import { verify } from '../src/core/verifier';
import { twinKeysLevel, overpassLevel, gauntletLevel } from '../src/core/fixtures/gallery';

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
  it('twin keys: two keys, two rules, two keyed doors — all green', () => {
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

  it('gauntlet: the sealing bonus door is provably safe — no stranded floors', () => {
    const report = verify(gauntletLevel);
    expect(report.accepted).toBe(true);
    expect(report.recoveryMap?.stranded).toEqual([]);
    // The trap exists: a door that seals, and a switch that seals it.
    expect(gauntletLevel.doors.some((d) => d.conditions?.closesAfterSwitch === 'vault-seal')).toBe(true);
  });
});
