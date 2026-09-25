import { beforeEach, describe, expect, it } from 'vitest';
import { resetCache } from '../api/_lib/cache';
import {
  explain,
  groundingViolation,
  type CallModel,
} from '../api/_lib/explain-service';
import type { ProviderResult } from '../api/_lib/provider';
import { trapLevel } from '../src/core/fixtures/trap';
import { baselineLevel } from '../src/core/fixtures/baseline';

/**
 * §10 explain contract: the engine recomputes the verdict server-side, the
 * model only phrases it, output is schema- and grounding-checked, and
 * identical requests are served from the exact-match cache.
 */

const ENV = {
  LLM_BASE_URL: 'https://provider.test/v1',
  LLM_API_KEY: 'test-key',
  LLM_MODEL: 'primary-model',
  LLM_FALLBACK_MODEL: 'fallback-model',
  LLM_TIMEOUT_MS: '5000',
};

const ok = (content: string): ProviderResult => ({
  ok: true,
  content,
  usage: { promptTokens: 100, completionTokens: 50, costUsd: 0.001 },
});

const outage: ProviderResult = { ok: false, kind: 'outage', error: 'boom' };

const groundedExplanation = JSON.stringify({
  explanation:
    'Your winning route walks entrance to lower-hall and up the gallery-ramp, but a player who crosses to bridge-landing and presses seal-switch on vault-approach seals gallery-door behind them with no brass-key in hand, so they can never return and the Recovery check fails.',
});

beforeEach(() => {
  resetCache();
});

describe('grounding check', () => {
  it('accepts real scene ids and plain English', () => {
    expect(groundingViolation('the gallery-door seals after seal-switch', trapLevel)).toBeNull();
    expect(groundingViolation('the player is stranded with no key', trapLevel)).toBeNull();
  });

  it('rejects invented compound ids', () => {
    expect(groundingViolation('the secret-passage blocks the way', trapLevel)).toBe('secret-passage');
    expect(groundingViolation('a fake-module appears', trapLevel)).toBe('fake-module');
  });
});

describe('engine recomputes the verdict (§10)', () => {
  it('refuses to explain a check that is not failing', async () => {
    const calls: string[] = [];
    const fn: CallModel = async (config) => {
      calls.push(config.model);
      return ok(groundedExplanation);
    };
    const outcome = await explain(ENV, { level: baselineLevel, check: 'recovery' }, { callModel: fn });
    expect(outcome.error).toBe('check_not_failing');
    expect(outcome.explanation).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe('schema and grounding attempts', () => {
  it('rejects an ungrounded explanation, then accepts the correction', async () => {
    const ungrounded = JSON.stringify({
      explanation:
        'A secret-passage collapse strands the player after they touch the wrong lever, and the whole vault becomes unreachable from that side of the map entirely.',
    });
    let call = 0;
    const fn: CallModel = async () => {
      call += 1;
      return ok(call === 1 ? ungrounded : groundedExplanation);
    };
    const outcome = await explain(ENV, { level: trapLevel, check: 'recovery' }, { callModel: fn });
    expect(outcome.explanation).not.toBeNull();
    expect(outcome.attempts).toHaveLength(2);
    expect(outcome.attempts[0]?.outcome).toBe('schema_invalid');
    expect(outcome.attempts[1]?.outcome).toBe('schema_valid');
  });

  it('fails closed after primary outage and fallback outage', async () => {
    const fn: CallModel = async () => outage;
    const outcome = await explain(ENV, { level: trapLevel, check: 'recovery' }, { callModel: fn });
    expect(outcome.error).toBe('invalid_output');
    expect(outcome.explanation).toBeNull();
  });
});

describe('exact-match cache (§10.2)', () => {
  it('serves identical requests from the cache without a model call', async () => {
    let calls = 0;
    const fn: CallModel = async () => {
      calls += 1;
      return ok(groundedExplanation);
    };
    const first = await explain(ENV, { level: trapLevel, check: 'recovery' }, { callModel: fn });
    const second = await explain(ENV, { level: trapLevel, check: 'recovery' }, { callModel: fn });
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(second.explanation).toBe(first.explanation);
    expect(second.totalCostUsd).toBe(0);
    expect(second.generationCostUsd).toBe(first.generationCostUsd);
    expect(second.attempts).toEqual(first.attempts);
    expect(calls).toBe(1);
  });

  it('preserves unknown usage cost on a cached explanation', async () => {
    const unmetered: ProviderResult = {
      ok: true,
      content: groundedExplanation,
      usage: { promptTokens: 10, completionTokens: 20, costUsd: null },
    };
    const fn: CallModel = async () => unmetered;
    const first = await explain(ENV, { level: trapLevel, check: 'recovery' }, { callModel: fn });
    const cached = await explain(ENV, { level: trapLevel, check: 'recovery' }, { callModel: fn });
    expect(first.totalCostUsd).toBeNull();
    expect(cached.totalCostUsd).toBe(0);
    expect(cached.generationCostUsd).toBeNull();
  });

  it('separates cache entries per check kind', async () => {
    let calls = 0;
    const fn: CallModel = async () => {
      calls += 1;
      return ok(groundedExplanation);
    };
    await explain(ENV, { level: trapLevel, check: 'recovery' }, { callModel: fn });
    const other = await explain(ENV, { level: trapLevel, check: 'solution' }, { callModel: fn });
    // trapLevel's solution check passes, so this is refused without a call.
    expect(other.error).toBe('check_not_failing');
    expect(calls).toBe(1);
  });
});
