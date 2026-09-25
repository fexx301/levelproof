import { beforeEach, describe, expect, it } from 'vitest';
import { resetCache } from '../api/_lib/cache';
import { compile, type CallModel } from '../api/_lib/compile-service';
import { buildSystemPrompt, PROMPT_VERSION } from '../api/_lib/prompt';
import type { ProviderResult } from '../api/_lib/provider';
import { vaultEmptyLevel } from '../src/core/fixtures/vault-empty';
import { applyOperations } from '../src/core/level';
import { revisionId } from '../src/core/serialize';

/** §10 three-attempt bound and §10.2 full-input cache, with an injected model. */

const ENV = {
  LLM_BASE_URL: 'https://provider.test/v1',
  LLM_API_KEY: 'test-key',
  LLM_MODEL: 'primary-model',
  LLM_FALLBACK_MODEL: 'fallback-model',
  LLM_TIMEOUT_MS: '5000',
};

const validPatch = JSON.stringify({
  type: 'patch',
  rationale: 'place a key',
  assumptions: [],
  operations: [],
});

const invalid = '{"type": "nonsense"}';

const ok = (content: string): ProviderResult => ({
  ok: true,
  content,
  usage: { promptTokens: 100, completionTokens: 50, costUsd: 0.001 },
});

const outage: ProviderResult = { ok: false, kind: 'outage', error: 'boom' };

function scriptedModel(script: ProviderResult[]): { calls: string[]; fn: CallModel } {
  const calls: string[] = [];
  let index = 0;
  const fn: CallModel = async (config) => {
    calls.push(config.model);
    const step = script[Math.min(index, script.length - 1)]!;
    index++;
    return step;
  };
  return { calls, fn };
}

beforeEach(() => {
  resetCache();
});

describe('compile prompt guardrails', () => {
  it('defaults unspecified doors to open and forbids invented conditions', () => {
    const prompt = buildSystemPrompt(vaultEmptyLevel, revisionId(vaultEmptyLevel));

    expect(PROMPT_VERSION).toBe('prompt-11');
    expect(prompt).toContain('A door with no explicitly requested lock or switch behavior is an OPEN, passable door');
    expect(prompt).toContain('Never invent a key, switch, or other condition for a door');
    expect(prompt).toContain('if the intended condition or location is materially ambiguous, ask one concise clarification');
    expect(prompt).toContain('omit conditions unless explicitly requested (an unconditioned door is open)');
  });
});

describe('three-attempt bound (§10)', () => {
  it('returns the primary result on the first attempt', async () => {
    const { calls, fn } = scriptedModel([ok(validPatch)]);
    const outcome = await compile(ENV, { level: vaultEmptyLevel, prompt: 'p1' }, { callModel: fn });
    expect(outcome.result?.type).toBe('patch');
    expect(outcome.cached).toBe(false);
    expect(outcome.attempts).toHaveLength(1);
    expect(outcome.attempts[0]).toMatchObject({ model: 'primary-model', outcome: 'schema_valid' });
    expect(calls).toEqual(['primary-model']);
  });

  it('retries the primary once with a schema correction, then succeeds', async () => {
    const { calls, fn } = scriptedModel([ok(invalid), ok(validPatch)]);
    const outcome = await compile(ENV, { level: vaultEmptyLevel, prompt: 'p2' }, { callModel: fn });
    expect(outcome.result?.type).toBe('patch');
    expect(outcome.attempts).toHaveLength(2);
    expect(outcome.attempts.map((a) => a.outcome)).toEqual(['schema_invalid', 'schema_valid']);
    expect(calls).toEqual(['primary-model', 'primary-model']);
  });

  it('falls back to the evaluated fallback after two primary failures', async () => {
    const { calls, fn } = scriptedModel([ok(invalid), ok(invalid), ok(validPatch)]);
    const outcome = await compile(ENV, { level: vaultEmptyLevel, prompt: 'p3' }, { callModel: fn });
    expect(outcome.result?.type).toBe('patch');
    expect(outcome.attempts).toHaveLength(3);
    expect(outcome.attempts[2]).toMatchObject({ model: 'fallback-model', outcome: 'schema_valid' });
    expect(calls).toEqual(['primary-model', 'primary-model', 'fallback-model']);
  });

  it('never exceeds three attempts and reports invalid output', async () => {
    const { calls, fn } = scriptedModel([ok(invalid), ok(invalid), ok(invalid), ok(validPatch)]);
    const outcome = await compile(ENV, { level: vaultEmptyLevel, prompt: 'p4' }, { callModel: fn });
    expect(outcome.result).toBeNull();
    expect(outcome.error).toBe('invalid_output');
    expect(outcome.attempts).toHaveLength(3);
    expect(calls).toHaveLength(3);
  });

  it('skips the correction retry on a provider error and goes straight to the fallback', async () => {
    const { calls, fn } = scriptedModel([outage, ok(validPatch)]);
    const outcome = await compile(ENV, { level: vaultEmptyLevel, prompt: 'p5' }, { callModel: fn });
    expect(outcome.result?.type).toBe('patch');
    expect(outcome.attempts.map((a) => a.outcome)).toEqual(['error', 'schema_valid']);
    expect(calls).toEqual(['primary-model', 'fallback-model']);
  });

  it('charges every attempt to usage accounting', async () => {
    const { fn } = scriptedModel([ok(invalid), ok(invalid), ok(validPatch)]);
    const outcome = await compile(ENV, { level: vaultEmptyLevel, prompt: 'p6' }, { callModel: fn });
    expect(outcome.totalCostUsd).toBeCloseTo(0.003, 6);
  });
});

describe('patch self-repair (§10: the engine rejects before the user sees)', () => {
  // A patch that overlaps an existing module — the exact battery failure mode.
  const overlapping = JSON.stringify({
    type: 'patch',
    rationale: 'add a bridge',
    assumptions: [],
    operations: [
      {
        kind: 'addModule',
        module: { id: 'bad-bridge', template: 'bridge', x: 1, z: 2, h: 1, ports: ['W', 'E'] },
      },
    ],
  });

  const corrected = JSON.stringify({
    type: 'patch',
    rationale: 'add a bridge on a free cell',
    assumptions: [],
    operations: [
      {
        kind: 'addModule',
        module: { id: 'good-bridge', template: 'bridge', x: 6, z: 5, h: 0, ports: ['W', 'E'] },
      },
    ],
  });

  it('marks an engine-rejected patch and retries with the exact reasons', async () => {
    const { calls, fn } = scriptedModel([ok(overlapping), ok(corrected)]);
    const outcome = await compile(ENV, { level: vaultEmptyLevel, prompt: 'p7' }, { callModel: fn });
    expect(outcome.result?.type).toBe('patch');
    expect(outcome.attempts.map((a) => a.outcome)).toEqual(['rejected', 'schema_valid']);
    expect(calls).toEqual(['primary-model', 'primary-model']);
    if (outcome.result?.type === 'patch') {
      const applied = applyOperations(vaultEmptyLevel, outcome.result.operations);
      expect(applied.ok).toBe(true);
    }
  });

  it('fails closed when every retry is still rejected', async () => {
    const { fn } = scriptedModel([ok(overlapping), ok(overlapping), ok(overlapping), ok(corrected)]);
    const outcome = await compile(ENV, { level: vaultEmptyLevel, prompt: 'p8' }, { callModel: fn });
    expect(outcome.result).toBeNull();
    expect(outcome.error).toBe('invalid_output');
    expect(outcome.attempts.map((a) => a.outcome)).toEqual(['rejected', 'rejected', 'rejected']);
  });

  it('pre-applies rule_proposal geometry too, so approval can never strand the author', async () => {
    const badRule = JSON.stringify({
      type: 'rule_proposal',
      reason: 'move the goal',
      oldRequirements: [],
      newRequirements: [],
      operations: [{ kind: 'moveGoal', moduleId: 'nowhere' }],
    });
    const { fn } = scriptedModel([ok(badRule), ok(invalid), ok(invalid)]);
    const outcome = await compile(ENV, { level: vaultEmptyLevel, prompt: 'p9' }, { callModel: fn });
    expect(outcome.result).toBeNull();
    expect(outcome.attempts[0]?.outcome).toBe('rejected');
  });
});

describe('full-input cache (§10.2)', () => {
  it('serves an identical request from the cache without a provider call', async () => {
    const { calls, fn } = scriptedModel([ok(validPatch)]);
    const input = { level: vaultEmptyLevel, prompt: 'cache me' };
    const first = await compile(ENV, input, { callModel: fn });
    expect(first.cached).toBe(false);
    const second = await compile(ENV, input, { callModel: fn });
    expect(second.cached).toBe(true);
    expect(second.result).toEqual(first.result);
    expect(second.totalCostUsd).toBe(0);
    expect(second.generationCostUsd).toBe(first.generationCostUsd);
    expect(second.attempts).toEqual(first.attempts);
    expect(calls).toHaveLength(1);
  });

  it('keeps unknown provider usage unknown instead of presenting it as zero cost', async () => {
    const unmetered: ProviderResult = {
      ok: true,
      content: validPatch,
      usage: { promptTokens: 100, completionTokens: 50, costUsd: null },
    };
    const { fn } = scriptedModel([unmetered]);
    const first = await compile(ENV, { level: vaultEmptyLevel, prompt: 'unmetered request' }, { callModel: fn });
    expect(first.totalCostUsd).toBeNull();
    expect(first.attempts[0]?.costUsd).toBeNull();
    const cached = await compile(ENV, { level: vaultEmptyLevel, prompt: 'unmetered request' }, { callModel: fn });
    expect(cached.cached).toBe(true);
    expect(cached.totalCostUsd).toBe(0);
    expect(cached.generationCostUsd).toBeNull();
    expect(cached.attempts[0]?.costUsd).toBeNull();
  });

  it('passes cancellation through to the provider and does not schedule retries', async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const fn: CallModel = async (_config, _messages, _options, signal) => {
      receivedSignal = signal;
      controller.abort();
      return { ok: false, kind: 'cancelled', error: 'cancelled' };
    };
    const outcome = await compile(ENV, { level: vaultEmptyLevel, prompt: 'cancel me' }, {
      callModel: fn,
      signal: controller.signal,
    });
    expect(receivedSignal).toBe(controller.signal);
    expect(outcome.error).toBe('cancelled');
    expect(outcome.attempts).toHaveLength(0);
  });

  it('differentiates on prompt, clarification context, and level content', async () => {
    const { calls, fn } = scriptedModel([ok(validPatch), ok(validPatch), ok(validPatch)]);
    await compile(ENV, { level: vaultEmptyLevel, prompt: 'one' }, { callModel: fn });
    await compile(ENV, { level: vaultEmptyLevel, prompt: 'two' }, { callModel: fn });
    await compile(
      ENV,
      { level: vaultEmptyLevel, prompt: 'one', clarificationContext: 'the side balcony' },
      { callModel: fn },
    );
    expect(calls).toHaveLength(3);
  });

  it('tells the model which entities are protected and separates their cache entries', async () => {
    const messages: string[] = [];
    let calls = 0;
    const fn: CallModel = async (_config, requestMessages) => {
      calls++;
      messages.push(requestMessages[1]?.content ?? '');
      return ok(validPatch);
    };

    await compile(ENV, { level: vaultEmptyLevel, prompt: 'Make a small change.', protectedIds: ['brass-key'] }, { callModel: fn });
    await compile(ENV, { level: vaultEmptyLevel, prompt: 'Make a small change.' }, { callModel: fn });

    expect(calls).toBe(2);
    expect(messages[0]).toContain('marked these scene entities Keep these: brass-key');
    expect(messages[0]).toContain('Do not add, remove, move, rename');
    expect(messages[1]).not.toContain('Keep these');
  });
});

describe('result binding and provider error classes (§10, §11)', () => {
  it('attaches the base revision the result was computed against', async () => {
    const { fn } = scriptedModel([ok(validPatch)]);
    const outcome = await compile(ENV, { level: vaultEmptyLevel, prompt: 'p10' }, { callModel: fn });
    expect(outcome.baseRevision).toBe(revisionId(vaultEmptyLevel));
  });

  it('records the provider error class on failed attempts and the outcome', async () => {
    const rateLimited: ProviderResult = { ok: false, kind: 'rate_limited', error: '429' };
    const { fn } = scriptedModel([rateLimited, rateLimited, rateLimited]);
    const outcome = await compile(ENV, { level: vaultEmptyLevel, prompt: 'p11' }, { callModel: fn });
    expect(outcome.result).toBeNull();
    expect(outcome.providerError).toBe('rate_limited');
    expect(outcome.attempts.every((a) => a.errorKind === 'rate_limited')).toBe(true);
  });
});

describe('AI↔engine revision requests', () => {
  const unwinnableOps = [
    { kind: 'addDoor' as const, door: { id: 'vault-door', a: 'vault-approach', b: 'vault-entry', conditions: { requiresKey: 'ghost-key' } } },
  ];

  it('sends the engine’s own findings about the earlier attempt to the model', async () => {
    // The key sits behind a door that needs that same key; the revised
    // attempt then locks the vault with it, so the goal becomes unreachable.
    const keyed = applyOperations(vaultEmptyLevel, [
      { kind: 'addItem', itemType: 'key', id: 'ghost-key', moduleId: 'key-balcony' },
      { kind: 'addDoor', door: { id: 'balcony-door', a: 'key-walk', b: 'key-balcony', conditions: { requiresKey: 'ghost-key' } } },
    ]);
    expect(keyed.ok).toBe(true);
    if (!keyed.ok) return;
    const seen: string[] = [];
    const fn: CallModel = async (_config, messages) => {
      seen.push(messages.at(-1)!.content);
      return ok(validPatch);
    };
    const outcome = await compile(ENV, { level: keyed.level, prompt: 'Lock the vault with the key.', revision: { operations: unwinnableOps } }, { callModel: fn });
    expect(outcome.result?.type).toBe('patch');
    expect(seen[0]).toContain('ENGINE CHECK OF YOUR PREVIOUS ATTEMPT');
    expect(seen[0]).toContain('The level cannot be won');
    expect(seen[0]).toContain('"vault-door"');
  });

  it('refuses to spend a model call when the engine finds nothing to fix', async () => {
    const model = scriptedModel([ok(validPatch)]);
    const outcome = await compile(ENV, { level: vaultEmptyLevel, prompt: 'Fix it.', revision: { operations: [] } }, { callModel: model.fn });
    expect(outcome.error).toBe('nothing_to_revise');
    expect(model.calls).toHaveLength(0);
  });

  it('streams reasoning headlines and each completed operation as progress', async () => {
    const patch = JSON.stringify({
      type: 'patch',
      rationale: 'dress the vault',
      assumptions: [],
      operations: [
        { kind: 'setScenery', environment: 'forest', lighting: 'night' },
        { kind: 'addProp', id: 'guardian', prop: 'dragon', x: 5, z: 1 },
      ],
    });
    const fn: CallModel = async (_config, _messages, _options, _signal, onDelta) => {
      onDelta?.({ reasoning: '**Reading the Vault**\n' });
      onDelta?.({ reasoning: 'thinking **Placing the Dragon**' });
      for (let i = 0; i < patch.length; i += 11) onDelta?.({ content: patch.slice(i, i + 11) });
      return ok(patch);
    };
    const events: unknown[] = [];
    const outcome = await compile(ENV, { level: vaultEmptyLevel, prompt: 'Make it a haunted forest with a dragon.' }, { callModel: fn, onProgress: (event) => events.push(event) });
    expect(outcome.result?.type).toBe('patch');
    expect(events).toEqual([
      { stage: 'thinking', attempt: 1 },
      { stage: 'thinking', attempt: 1, headline: 'Reading the Vault' },
      { stage: 'thinking', attempt: 1, headline: 'Placing the Dragon' },
      { stage: 'writing', attempt: 1, operations: 1, latest: '✦ scenery: forest, night' },
      { stage: 'writing', attempt: 1, operations: 2, latest: '✦ dragon: guardian' },
      { stage: 'checking', attempt: 1 },
    ]);
  });
});
