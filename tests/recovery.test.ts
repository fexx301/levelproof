import { describe, expect, it } from 'vitest';
import { baselineLevel } from '../src/core/fixtures/baseline';
import { applyOperations } from '../src/core/level';
import { revisionId } from '../src/core/serialize';
import { RECOVERY_KEY, RECOVERY_VERSION, parseRecoverySnapshot, persistRecovery, readRecovery, type RecoverySnapshot } from '../src/state/recovery';
import type { StorageLike } from '../src/state/persistence';

function memoryStorage(initial: string | null = null): StorageLike & { value: string | null } {
  let value = initial;
  return {
    get value() { return value; },
    getItem() { return value; },
    setItem(_key, next) { value = next; },
    removeItem() { value = null; },
  };
}

function snapshot(): RecoverySnapshot {
  const draft = structuredClone(baselineLevel);
  draft.goal = 'gallery';
  const base = structuredClone(draft);
  const operations = [{ kind: 'setModuleLabel' as const, id: 'gallery', label: 'A recovered proposal' }];
  const applied = applyOperations(base, operations);
  if (!applied.ok) throw new Error(applied.errors[0]);
  return {
    version: RECOVERY_VERSION,
    acceptedLevel: structuredClone(baselineLevel),
    acceptedSceneId: 'balcony-vault',
    sceneId: 'balcony-vault',
    acceptedTheme: null,
    acceptedPromptHistory: [],
    theme: 'basalt',
    promptHistory: [],
    promptDraft: 'Keep my prompt if the tab reloads.',
    draft: { level: draft, viaRule: false, returnSceneId: 'balcony-vault', lineageKnown: true },
    pending: {
      base,
      result: { type: 'patch', rationale: 'A saved proposal', assumptions: [], operations },
      prompt: 'Rename the gallery.',
      nextTheme: 'basalt',
      baseRevision: revisionId(base),
    },
    selection: ['gallery'],
    protectedIds: ['gallery'],
    history: [],
    previousAccepted: null,
    lastPrompt: 'Rename the gallery.',
    changeSummary: 'moved a protected object earlier',
    lastCompileMeta: { cached: false, totalCostUsd: null, generationCostUsd: null, attempts: 1, model: 'unknown-model' },
  };
}

describe('local session recovery', () => {
  it('round-trips the accepted checkpoint, editable draft, protections, and unapproved preview', () => {
    const storage = memoryStorage();
    const value = snapshot();
    expect(persistRecovery(storage, value).ok).toBe(true);
    const restored = readRecovery(storage);
    expect(restored.status).toBe('ready');
    if (restored.status !== 'ready') return;
    expect(restored.snapshot.acceptedLevel).toEqual(baselineLevel);
    expect(restored.snapshot.draft?.level.goal).toBe('gallery');
    expect(restored.snapshot.protectedIds).toEqual(['gallery']);
    expect(restored.snapshot.pending?.result).toEqual(value.pending?.result);
    expect(restored.snapshot.lastCompileMeta?.totalCostUsd).toBeNull();
  });

  it('rejects an outdated proposal rather than restoring it against a newer draft', () => {
    const value = snapshot();
    const changed = structuredClone(value);
    changed.pending!.baseRevision = 'rev-stale';
    expect(parseRecoverySnapshot(changed)).toBeNull();
  });

  it('preserves malformed recovery bytes until the user explicitly clears them', () => {
    const storage = memoryStorage('{bad-json');
    expect(readRecovery(storage)).toEqual({ status: 'malformed' });
    expect(storage.value).toBe('{bad-json');
  });

  it('does not report success when storage is unavailable', () => {
    expect(persistRecovery(undefined, snapshot())).toMatchObject({ ok: false });
    expect(memoryStorage().getItem(RECOVERY_KEY)).toBeNull();
  });
});
