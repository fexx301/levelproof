import { beforeEach, describe, expect, it } from 'vitest';
import { baselineLevel } from '../src/core/fixtures/baseline';
import { trapLevel } from '../src/core/fixtures/trap';
import { verify } from '../src/core/verifier';
import { useApp } from '../src/state/store';

/**
 * §9 "keep this" interaction: protections must invalidate stale repair
 * results and guard apply — a candidate found before the protection was set
 * can never move or remove a kept entity.
 */

beforeEach(() => {
  useApp.setState({
    acceptedLevel: baselineLevel,
    previousAccepted: null,
    draft: { level: trapLevel, report: verify(trapLevel), viaRule: false, returnSceneId: 'balcony-vault' },
    pendingRule: null,
    lastResult: null,
    lastPrompt: null,
    lastCompileMeta: null,
    busy: false,
    error: null,
    mode: 'authoring',
    ghost: { witnessKind: null, playing: false, finished: false, moveIndex: 0, totalMoves: 0, keys: [], switches: [], endNote: null },
    play: { at: '', keys: [], switches: [], trapped: false, atGoal: false, goalViolated: false },
    repair: { status: 'idle', candidates: [], explored: 0, durationMs: 0, note: null, applyError: null },
    explain: { byCheck: {}, busy: false, error: null },
    preview: null,
    repairReplay: null,
    selection: [],
    protectedIds: [],
    sceneId: 'balcony-vault',
  });
});

describe('keep-this invalidation and apply guard (§9)', () => {
  it('keeping an entity voids existing repair candidates and previews', () => {
    useApp.getState().runRepairs(verify(trapLevel));
    expect(useApp.getState().repair.candidates.length).toBe(3);

    // Preview the relocation candidate (moves seal-switch).
    const relocation = useApp.getState().repair.candidates.findIndex((c) =>
      c.description.startsWith('Move switch'),
    );
    expect(relocation).toBeGreaterThanOrEqual(0);
    useApp.getState().previewRepair(relocation);
    expect(useApp.getState().preview).not.toBeNull();

    // Now keep the switch: candidates and preview must void.
    useApp.setState({ selection: ['seal-switch'] });
    useApp.getState().keepSelected();
    expect(useApp.getState().repair.status).toBe('idle');
    expect(useApp.getState().repair.candidates).toHaveLength(0);
    expect(useApp.getState().preview).toBeNull();

    // Re-search under the protection: only the door removal remains.
    useApp.getState().runRepairs(verify(trapLevel));
    expect(useApp.getState().repair.candidates).toHaveLength(1);
    expect(useApp.getState().repair.candidates[0]!.description).toContain('Remove the sealing door');
  });

  it('a stale protected-touching candidate is refused at apply time', () => {
    useApp.getState().runRepairs(verify(trapLevel));
    const relocation = useApp.getState().repair.candidates.findIndex((c) =>
      c.description.startsWith('Move switch'),
    );
    expect(relocation).toBeGreaterThanOrEqual(0);

    // Simulate the candidate list surviving a protection change (the UI
    // invalidates, but the store guard must hold regardless).
    useApp.setState({ protectedIds: ['seal-switch'] });
    useApp.getState().applyRepair(relocation);

    const state = useApp.getState();
    expect(state.repair.applyError).toContain('kept entity');
    expect(state.draft).not.toBeNull(); // the draft was not modified
    expect(useApp.getState().acceptedLevel).toBe(baselineLevel);
  });

  it('unkeeping also voids results, restoring the full candidate set on re-search', () => {
    useApp.setState({ protectedIds: ['seal-switch'] });
    useApp.getState().runRepairs(verify(trapLevel));
    expect(useApp.getState().repair.candidates).toHaveLength(1);

    useApp.getState().unkeep('seal-switch');
    expect(useApp.getState().repair.status).toBe('idle');
    useApp.getState().runRepairs(verify(trapLevel));
    expect(useApp.getState().repair.candidates).toHaveLength(3);
  });
});
