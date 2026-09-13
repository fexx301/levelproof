import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { baselineLevel } from '../src/core/fixtures/baseline';
import { revisionId } from '../src/core/serialize';
import { useApp } from '../src/state/store';

const base = structuredClone(baselineLevel);

function compileResponse(result: unknown, theme?: 'futuristic') {
  return {
    ok: true,
    json: async () => ({
      result,
      baseRevision: revisionId(base),
      ...(theme !== undefined ? { theme } : {}),
      cached: true,
      attempts: [],
      totalCostUsd: 0,
    }),
  };
}

beforeEach(() => {
  useApp.setState({
    acceptedLevel: base,
    acceptedTheme: null,
    acceptedPromptHistory: [],
    theme: null,
    promptHistory: [],
    history: [],
    previousAccepted: null,
    draft: null,
    pendingRule: null,
    lastResult: null,
    lastPrompt: null,
    lastCompileMeta: null,
    busy: false,
    error: null,
    preview: null,
    repairReplay: null,
    sceneId: 'balcony-vault',
    acceptedSceneId: 'balcony-vault',
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('staged AI changes', () => {
  it('previews a patch and commits its theme/history only on Apply', async () => {
    const result = {
      type: 'patch',
      rationale: 'Give the upper foyer a future-facing identity.',
      assumptions: [],
      operations: [{ kind: 'setModuleLabel', id: 'gallery', label: 'future gallery' }],
    };
    vi.stubGlobal('fetch', vi.fn(async () => compileResponse(result, 'futuristic')));

    await useApp.getState().submitPrompt('Make this a futuristic vault.');
    const pending = useApp.getState().pendingRule;
    expect(pending?.kind).toBe('patch');
    expect(useApp.getState().acceptedLevel).toBe(base);
    expect(useApp.getState().theme).toBeNull();
    expect(useApp.getState().promptHistory).toEqual([]);
    expect(useApp.getState().preview?.operations).toHaveLength(1);

    useApp.getState().applyPatch();
    expect(useApp.getState().pendingRule).toBeNull();
    expect(useApp.getState().acceptedLevel.modules.find((module) => module.id === 'gallery')?.label).toBe('future gallery');
    expect(useApp.getState().theme).toBe('futuristic');
    expect(useApp.getState().acceptedTheme).toBe('futuristic');
    expect(useApp.getState().promptHistory).toEqual(['Make this a futuristic vault.']);
  });

  it('does not commit prompt context when the author declines a patch', async () => {
    const result = {
      type: 'patch',
      rationale: 'Change the mood.',
      assumptions: [],
      operations: [],
    };
    vi.stubGlobal('fetch', vi.fn(async () => compileResponse(result, 'futuristic')));

    await useApp.getState().submitPrompt('Make it a futuristic vault.');
    useApp.getState().declinePatch();
    expect(useApp.getState().acceptedLevel).toBe(base);
    expect(useApp.getState().theme).toBeNull();
    expect(useApp.getState().promptHistory).toEqual([]);
    expect(useApp.getState().lastResult).toBeNull();
  });

  it('keeps the accepted checkpoint separate from a failing applied draft', async () => {
    const result = {
      type: 'patch',
      rationale: 'Move the goal to the upper foyer.',
      assumptions: [],
      operations: [{ kind: 'moveGoal', moduleId: 'gallery' }],
    };
    vi.stubGlobal('fetch', vi.fn(async () => compileResponse(result, 'futuristic')));

    await useApp.getState().submitPrompt('Make the vault futuristic and move the goal upstairs.');
    useApp.getState().applyPatch();
    expect(useApp.getState().draft).not.toBeNull();
    expect(useApp.getState().acceptedLevel).toBe(base);
    expect(useApp.getState().previousAccepted).toBeNull();
    expect(useApp.getState().promptHistory).toHaveLength(1);
    expect(useApp.getState().theme).toBe('futuristic');

    useApp.getState().discardDraft();
    expect(useApp.getState().draft).toBeNull();
    expect(useApp.getState().theme).toBeNull();
    expect(useApp.getState().promptHistory).toEqual([]);
  });

  it('reviews a rule proposal through the same atomic transaction', async () => {
    const result = {
      type: 'rule_proposal',
      reason: 'Remove the key requirement with its keyed door.',
      oldRequirements: base.requirements,
      newRequirements: [],
      operations: [
        { kind: 'removeItem', id: 'brass-key' },
        { kind: 'removeDoor', id: 'vault-door' },
      ],
    };
    vi.stubGlobal('fetch', vi.fn(async () => compileResponse(result)));

    await useApp.getState().submitPrompt('Remove the key rule.');
    expect(useApp.getState().pendingRule?.kind).toBe('rule');
    expect(useApp.getState().acceptedLevel.keys).toHaveLength(1);
    useApp.getState().approveRule();
    expect(useApp.getState().acceptedLevel.keys).toHaveLength(0);
    expect(useApp.getState().acceptedLevel.requirements).toHaveLength(0);
    expect(useApp.getState().promptHistory).toEqual(['Remove the key rule.']);
  });

  it('does not promote an invalid saved or imported level into accepted state', () => {
    const failing = structuredClone(base);
    failing.goal = 'gallery';

    useApp.setState({
      savedScenes: [{ recordKey: 'legacy-draft', id: 'legacy-draft', name: 'Legacy draft', savedAt: 0, status: 'draft', theme: null, promptHistory: [], level: failing }],
    });
    useApp.getState().loadScene('saved:legacy-draft');
    expect(useApp.getState().acceptedLevel).toBe(base);
    expect(useApp.getState().draft).not.toBeNull();
    expect(useApp.getState().draft?.returnSceneId).toBe('balcony-vault');
    expect(useApp.getState().error).toBeNull();

    useApp.getState().loadLevel(failing);
    expect(useApp.getState().acceptedLevel).toBe(base);
    expect(useApp.getState().error).toContain('Only a verified accepted level');
  });
});
