import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { baselineLevel } from '../src/core/fixtures/baseline';
import { blankCanvasLevel } from '../src/core/fixtures/blank-canvas';
import { revisionId } from '../src/core/serialize';
import { shouldAutoRevise, useApp } from '../src/state/store';

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
      generationCostUsd: 0,
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
    promptDraft: '',
    selection: [],
    protectedIds: [],
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
  it('keeps selected prompt context within the API limit and explains the limit', () => {
    for (let index = 0; index < 8; index++) useApp.getState().toggleSelect(`entity-${index}`);
    useApp.getState().toggleSelect('ninth-entity');
    expect(useApp.getState().selection).toHaveLength(8);
    expect(useApp.getState().error).toContain('up to 8');
  });

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
    const stagedCandidate = useApp.getState().preview?.candidate;

    useApp.getState().applyPatch();
    expect(useApp.getState().pendingRule).toBeNull();
    expect(useApp.getState().acceptedLevel.modules.find((module) => module.id === 'gallery')?.label).toBe('future gallery');
    expect(useApp.getState().theme).toBe('futuristic');
    expect(useApp.getState().acceptedTheme).toBe('futuristic');
    expect(useApp.getState().promptHistory).toEqual(['Make this a futuristic vault.']);
    expect(useApp.getState().acceptedLevel).toEqual(stagedCandidate);
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
    const stagedCandidate = useApp.getState().preview?.candidate;
    useApp.getState().approveRule();
    expect(useApp.getState().acceptedLevel.keys).toHaveLength(0);
    expect(useApp.getState().acceptedLevel.requirements).toHaveLength(0);
    expect(useApp.getState().promptHistory).toEqual(['Remove the key rule.']);
    expect(useApp.getState().acceptedLevel).toEqual(stagedCandidate);
  });

  it('blocks a generated proposal that changes an object marked Keep these', async () => {
    useApp.setState({ protectedIds: ['gallery'] });
    let requestBody = '';
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('/api/compile');
      requestBody = String(init?.body);
      return compileResponse({
        type: 'patch',
        rationale: 'Move the gallery.',
        assumptions: [],
        operations: [{ kind: 'moveModule', id: 'gallery', x: 2, z: 3, h: 1 }],
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    await useApp.getState().submitPrompt('Move the kept gallery.');

    expect(useApp.getState().acceptedLevel).toEqual(base);
    expect(useApp.getState().pendingRule).toBeNull();
    expect(useApp.getState().preview).toBeNull();
    expect(useApp.getState().promptDraft).toBe('Move the kept gallery.');
    expect(useApp.getState().error).toContain('marked Keep these');
    const request = JSON.parse(requestBody) as { protectedIds: string[] };
    expect(request.protectedIds).toEqual(['gallery']);
  });

  it('rechecks protection at approval if an object was kept after previewing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => compileResponse({
      type: 'rule_proposal',
      reason: 'Rename the entrance module.',
      oldRequirements: base.requirements,
      newRequirements: base.requirements,
      operations: [{ kind: 'setModuleLabel', id: 'gallery', label: 'new gallery name' }],
    })));

    await useApp.getState().submitPrompt('Rename the gallery.');
    expect(useApp.getState().pendingRule?.kind).toBe('rule');
    useApp.setState({ protectedIds: ['gallery'] });
    useApp.getState().approveRule();

    expect(useApp.getState().acceptedLevel).toEqual(base);
    expect(useApp.getState().pendingRule?.kind).toBe('rule');
    expect(useApp.getState().error).toContain('marked Keep these');
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

  it('keeps saved-draft lineage tied to the accepted checkpoint when drafts are opened in sequence', () => {
    const first = structuredClone(base);
    first.goal = 'gallery';
    const second = structuredClone(base);
    second.goal = 'bridge-landing';
    useApp.setState({
      savedScenes: [
        { recordKey: 'draft-a', id: 'draft-a', name: 'Draft A', savedAt: 1, status: 'draft', theme: null, promptHistory: [], level: first },
        { recordKey: 'draft-b', id: 'draft-b', name: 'Draft B', savedAt: 2, status: 'draft', theme: null, promptHistory: [], level: second },
      ],
    });

    useApp.getState().loadScene('saved:draft-a');
    expect(useApp.getState().draft?.returnSceneId).toBe('balcony-vault');
    useApp.getState().loadScene('saved:draft-b');
    expect(useApp.getState().draft?.returnSceneId).toBe('balcony-vault');
    expect(useApp.getState().draft?.lineageKnown).toBe(false);
    useApp.getState().discardDraft();
    expect(useApp.getState().sceneId).toBe('balcony-vault');
    expect(useApp.getState().draft).toBeNull();
  });

  it('keeps a failed prompt retryable and never mutates the accepted checkpoint', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('offline');
    }));
    await useApp.getState().submitPrompt('Move the key to the gallery.');
    expect(useApp.getState().acceptedLevel).toEqual(base);
    expect(useApp.getState().pendingRule).toBeNull();
    expect(useApp.getState().busy).toBe(false);
    expect(useApp.getState().error).toContain('prompt is still available');
  });

  it('fails closed on a malformed compile response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ result: { type: 'patch' } }) })));
    await useApp.getState().submitPrompt('Make a small change.');
    expect(useApp.getState().acceptedLevel).toEqual(base);
    expect(useApp.getState().pendingRule).toBeNull();
    expect(useApp.getState().error).toContain('failed validation');
  });

  it('discards an older response after the author changes scenes', async () => {
    let resolveResponse!: (value: ReturnType<typeof compileResponse>) => void;
    const response = new Promise<ReturnType<typeof compileResponse>>((resolve) => { resolveResponse = resolve; });
    vi.stubGlobal('fetch', vi.fn(() => response));
    const pendingRequest = useApp.getState().submitPrompt('Rename the gallery.');
    expect(useApp.getState().busy).toBe(true);

    useApp.getState().loadScene('blank-canvas');
    resolveResponse(compileResponse({
      type: 'patch',
      rationale: 'A stale response.',
      assumptions: [],
      operations: [{ kind: 'setModuleLabel', id: 'gallery', label: 'stale rename' }],
    }));
    await pendingRequest;

    expect(useApp.getState().sceneId).toBe('blank-canvas');
    expect(useApp.getState().acceptedLevel).toEqual(blankCanvasLevel);
    expect(useApp.getState().pendingRule).toBeNull();
    expect(useApp.getState().preview).toBeNull();
    expect(useApp.getState().busy).toBe(false);
  });

  it('makes repeated approval clicks idempotent', async () => {
    const result = {
      type: 'patch',
      rationale: 'Rename the foyer.',
      assumptions: [],
      operations: [{ kind: 'setModuleLabel', id: 'gallery', label: 'renamed foyer' }],
    };
    vi.stubGlobal('fetch', vi.fn(async () => compileResponse(result)));
    await useApp.getState().submitPrompt('Rename the foyer.');
    useApp.getState().applyPatch();
    useApp.getState().applyPatch();
    expect(useApp.getState().acceptedLevel.modules.find((module) => module.id === 'gallery')?.label).toBe('renamed foyer');
    expect(useApp.getState().promptHistory).toEqual(['Rename the foyer.']);
    expect(useApp.getState().history).toHaveLength(1);
  });
});

describe('automatic AI↔engine revision', () => {
  const unwinnable = {
    type: 'patch',
    rationale: 'Key in a side room; the vault needs it.',
    assumptions: [],
    operations: [
      { kind: 'addModule', module: { id: 'side-room', template: 'flat', x: 6, z: 7, h: 0, ports: ['E'] } },
      { kind: 'setModulePorts', id: 'start-walk', ports: ['N', 'S', 'W'] },
      { kind: 'addItem', itemType: 'key', id: 'vault-key', moduleId: 'side-room' },
      { kind: 'addDoor', door: { id: 'side-door', a: 'start-walk', b: 'side-room', conditions: { requiresKey: 'vault-key' } } },
      { kind: 'addDoor', door: { id: 'vault-door', a: 'start-walk', b: 'goal-pad', conditions: { requiresKey: 'vault-key' } } },
    ],
  };
  const fixed = {
    ...unwinnable,
    rationale: 'The side room stays open so the key can be collected.',
    operations: unwinnable.operations.filter((operation) => !(operation.kind === 'addDoor' && operation.door?.id === 'side-door')),
  };

  function respond(result: unknown) {
    return {
      ok: true,
      json: async () => ({ result, baseRevision: revisionId(blankCanvasLevel), cached: false, attempts: [{ model: 'm', outcome: 'schema_valid', latencyMs: 1, costUsd: 0.001 }], totalCostUsd: 0.001, generationCostUsd: 0.001 }),
    };
  }

  it('sends an unwinnable additive build back once and stages the verified revision', async () => {
    useApp.setState({ acceptedLevel: blankCanvasLevel, sceneId: 'blank-canvas', acceptedSceneId: 'blank-canvas' });
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      bodies.push(body);
      return respond(body.revision === undefined ? unwinnable : fixed);
    }));
    await useApp.getState().submitPrompt('Put the vault key in a side room and lock the goal with it.');
    expect(bodies).toHaveLength(2);
    expect(bodies[1]!.revision).toEqual({ operations: unwinnable.operations });
    const pending = useApp.getState().pendingRule;
    expect(pending?.kind).toBe('patch');
    if (pending?.kind !== 'patch') return;
    expect(pending.revision?.outcome).toBe('fixed');
    expect(pending.revision?.findings[0]).toMatch(/^The level cannot be won/);
    expect(pending.operations).toEqual(fixed.operations);
    expect(useApp.getState().lastCompileMeta?.attempts).toBe(2);
    expect(useApp.getState().acceptedLevel).toBe(blankCanvasLevel);
  });

  it('never auto-revises an edit that removes things', () => {
    const removal = [{ kind: 'removeModule' as const, id: 'gallery-ramp' }];
    const broken = structuredClone(base);
    broken.modules = broken.modules.filter((module) => module.id !== 'gallery-ramp');
    expect(shouldAutoRevise(base, broken, removal)).toBe(false);
  });
});
