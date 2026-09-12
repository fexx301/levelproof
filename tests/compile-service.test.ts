import { beforeEach, describe, expect, it } from 'vitest';
import { resetCache } from '../api/_lib/cache';
import { compile, type CallModel } from '../api/_lib/compile-service';
import type { ProviderResult } from '../api/_lib/provider';
import { vaultEmptyLevel } from '../src/core/fixtures/vault-empty';

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

describe('full-input cache (§10.2)', () => {
  it('serves an identical request from the cache without a provider call', async () => {
    const { calls, fn } = scriptedModel([ok(validPatch)]);
    const input = { level: vaultEmptyLevel, prompt: 'cache me' };
    const first = await compile(ENV, input, { callModel: fn });
    expect(first.cached).toBe(false);
    const second = await compile(ENV, input, { callModel: fn });
    expect(second.cached).toBe(true);
    expect(second.result).toEqual(first.result);
    expect(second.attempts).toHaveLength(0);
    expect(calls).toHaveLength(1);
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
});
