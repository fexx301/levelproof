import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Level, Operation } from '../shared/schema';
import { sentryLevel } from '../src/core/fixtures/gallery';
import { applyOperations } from '../src/core/level';
import { findRepairs, rescueAttempts } from '../src/core/search';
import { revisionId } from '../src/core/serialize';
import { verify } from '../src/core/verifier';
import { useApp } from '../src/state/store';

/**
 * "Too easy — make it harder" on The Sentry, as production answered it on
 * Oct 24 (three rounds, recorded): each time the AI put the new key behind
 * the very door it opens, so the change could never be won. In play, the
 * engine's checked repair moves the key out; the editor still shows the
 * failure.
 */

const ROUNDS: Operation[][] = [
  [
    { kind: 'addItem', itemType: 'key', id: 'garden-key', moduleId: 'herb-garden', look: 'key' },
    { kind: 'addDoor', door: { id: 'yard-gate', a: 'yard-west', b: 'yard-mid', conditions: { requiresKey: 'garden-key' } } },
  ],
  [
    { kind: 'addItem', itemType: 'key', id: 'armory-key', moduleId: 'herb-garden', look: 'key' },
    { kind: 'addDoor', door: { id: 'yard-east-gate', a: 'yard-mid', b: 'yard-east', conditions: { requiresKey: 'armory-key' } } },
  ],
  [
    { kind: 'setModulePorts', id: 'yard-mid', ports: ['E', 'W', 'N', 'S'] },
    { kind: 'addModule', module: { id: 'yard-alcove', template: 'flat', x: 4, z: 9, h: 0, label: 'yard alcove', ports: ['N'] } },
    { kind: 'addItem', itemType: 'key', id: 'herb-key', moduleId: 'herb-garden', look: 'key' },
    { kind: 'addDoor', door: { id: 'yard-gate', a: 'yard-mid', b: 'yard-east', conditions: { requiresKey: 'herb-key' } } },
  ],
];

const attempt = (operations: Operation[]): { operations: Operation[]; level: Level } => {
  const applied = applyOperations(sentryLevel, operations);
  if (!applied.ok) throw new Error(applied.errors.join('; '));
  return { operations, level: applied.level };
};

const shortest = (level: Level): number => verify(level).checks.solution.witness?.route.length ?? 0;

describe('a key locked behind its own door', () => {
  it('is a repair the search finds: move the key where the player can reach it', () => {
    const { level } = attempt(ROUNDS[0]!);
    expect(verify(level).checks.solution.status).toBe('fail');
    const top = findRepairs(sentryLevel, level, verify(level)).candidates[0];
    expect(top?.description).toMatch(/^Move key “garden-key” out from behind its door/);
    expect(top?.report.accepted).toBe(true);
  });

  it('rescues the attempt whose repaired route is longest, and replays from the base', () => {
    const rescued = rescueAttempts(sentryLevel, ROUNDS.map(attempt))!;
    expect(rescued.description).toContain('herb-key');
    expect(rescued.report.accepted).toBe(true);
    expect(shortest(rescued.level)).toBeGreaterThan(shortest(sentryLevel));
    const replayed = applyOperations(sentryLevel, rescued.operations);
    expect(replayed.ok && revisionId(replayed.level)).toBe(revisionId(rescued.level));
  });
});

describe('play reactions get a winnable change', () => {
  beforeEach(() => {
    useApp.setState({
      acceptedLevel: sentryLevel, draft: null, pendingRule: null, lastResult: null, lastPrompt: null, lastCompileMeta: null,
      busy: false, error: null, preview: null, repairReplay: null, selection: [], protectedIds: [], history: [], promptHistory: [],
      acceptedPromptHistory: [], theme: null, acceptedTheme: null, sceneId: 'sentry', acceptedSceneId: 'sentry',
    });
    let round = 0;
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        result: { type: 'patch', rationale: 'A new key-and-door challenge.', assumptions: [], operations: ROUNDS[Math.min(round++, 2)] },
        baseRevision: revisionId(sentryLevel), cached: true, attempts: [], totalCostUsd: 0, generationCostUsd: 0,
      }),
    })));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('while playing, a change no one can win comes back repaired and disclosed', async () => {
    useApp.setState({ mode: 'playing' });
    await useApp.getState().submitPrompt('That was too easy. Make this puzzle harder.');
    const pending = useApp.getState().pendingRule;
    expect(pending?.kind).toBe('patch');
    if (pending?.kind !== 'patch') return;
    expect(pending.engineRepair).toContain('out from behind its door');
    expect(verify(pending.candidate).accepted).toBe(true);
    useApp.getState().applyPatch();
    expect(verify(useApp.getState().acceptedLevel).accepted).toBe(true);
  });

  it('in the editor, the failure is still shown as asked', async () => {
    useApp.setState({ mode: 'authoring' });
    await useApp.getState().submitPrompt('That was too easy. Make this puzzle harder.');
    const pending = useApp.getState().pendingRule;
    expect(pending?.kind === 'patch' && pending.engineRepair).toBeFalsy();
    expect(pending !== null && verify(pending.candidate).checks.solution.status).toBe('fail');
  });
});
