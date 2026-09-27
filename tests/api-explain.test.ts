import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from '../api/explain';
import { resetCache } from '../api/_lib/cache';
import { resetRequestBudget } from '../api/_lib/request-guard';
import { baselineLevel } from '../src/core/fixtures/baseline';
import { trapLevel } from '../src/core/fixtures/trap';

/**
 * /api/explain is public and spends provider money: the handler must validate
 * input, answer non-failing checks without a model call or budget charge,
 * serve cached answers free, cap fresh calls, and keep the burst window.
 */

const ENV = {
  NODE_ENV: 'test',
  LLM_BASE_URL: 'https://provider.test/v1',
  LLM_API_KEY: 'test-key',
  LLM_MODEL: 'primary-model',
  API_RATE_LIMIT_REQUESTS: '100',
  API_DAILY_REQUEST_LIMIT: '1',
};
const saved: Record<string, string | undefined> = {};

const grounded = JSON.stringify({
  explanation:
    'Your winning route walks entrance to lower-hall and up the gallery-ramp, but a player who crosses to bridge-landing and presses seal-switch on vault-approach seals gallery-door behind them with no brass-key in hand, so they can never return and the Recovery check fails.',
});

function providerReply(content: string): Response {
  return Response.json({ choices: [{ message: { content } }], usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.001 } });
}

function explainRequest(body: unknown, ip = '192.0.2.50'): Request {
  return new Request('https://levelproof.test/api/explain', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  for (const [key, value] of Object.entries(ENV)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  resetCache();
  resetRequestBudget();
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.unstubAllGlobals();
});

describe('/api/explain handler', () => {
  it('rejects malformed JSON and invalid requests before any model call', async () => {
    const provider = vi.fn(async () => providerReply(grounded));
    vi.stubGlobal('fetch', provider);
    expect((await POST(explainRequest('{not json'))).status).toBe(400);
    expect((await POST(explainRequest({ level: trapLevel, check: 'nonsense' }))).status).toBe(400);
    expect(provider).not.toHaveBeenCalled();
  });

  it('answers a check that is not failing with 422, no model call, and no budget charge', async () => {
    const provider = vi.fn(async () => providerReply(grounded));
    vi.stubGlobal('fetch', provider);
    for (let i = 0; i < 3; i++) {
      const response = await POST(explainRequest({ level: baselineLevel, check: 'recovery' }));
      expect(response.status).toBe(422);
      expect((await response.json()).error).toBe('check_not_failing');
    }
    expect(provider).not.toHaveBeenCalled();
    // The single daily slot is still there for real model work.
    expect((await POST(explainRequest({ level: trapLevel, check: 'recovery' }))).status).toBe(200);
  });

  it('serves cached explanations free and caps fresh model calls', async () => {
    const provider = vi.fn(async () => providerReply(grounded));
    vi.stubGlobal('fetch', provider);
    const first = await POST(explainRequest({ level: trapLevel, check: 'recovery' }));
    expect(first.status).toBe(200);
    expect((await first.json()).cached).toBe(false);
    for (let i = 0; i < 3; i++) {
      const again = await POST(explainRequest({ level: trapLevel, check: 'recovery' }));
      expect(again.status).toBe(200);
      expect((await again.json()).cached).toBe(true);
    }
    expect(provider).toHaveBeenCalledTimes(1);
    // A different (still failing) level needs the model: the daily cap (1) refuses it.
    const renamed = structuredClone(trapLevel);
    renamed.modules[0]!.label = 'front steps';
    const fresh = await POST(explainRequest({ level: renamed, check: 'recovery' }));
    expect(fresh.status).toBe(429);
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it('keeps the per-address burst window on every request', async () => {
    process.env.API_RATE_LIMIT_REQUESTS = '2';
    process.env.API_DAILY_REQUEST_LIMIT = '100';
    vi.stubGlobal('fetch', vi.fn(async () => providerReply(grounded)));
    expect((await POST(explainRequest({ level: baselineLevel, check: 'recovery' }, '192.0.2.60'))).status).toBe(422);
    expect((await POST(explainRequest({ level: baselineLevel, check: 'recovery' }, '192.0.2.60'))).status).toBe(422);
    expect((await POST(explainRequest({ level: baselineLevel, check: 'recovery' }, '192.0.2.60'))).status).toBe(429);
  });
});

describe('API request hygiene', () => {
  it('refuses non-JSON bodies (blind cross-site posts) and marks responses no-store/nosniff', async () => {
    const provider = vi.fn(async () => providerReply(grounded));
    vi.stubGlobal('fetch', provider);
    const plain = await POST(new Request('https://levelproof.test/api/explain', {
      method: 'POST',
      headers: { 'content-type': 'text/plain', 'x-forwarded-for': '192.0.2.70' },
      body: JSON.stringify({ level: trapLevel, check: 'recovery' }),
    }));
    expect(plain.status).toBe(415);
    expect(provider).not.toHaveBeenCalled();
    const ok = await POST(explainRequest({ level: baselineLevel, check: 'recovery' }, '192.0.2.71'));
    expect(ok.headers.get('Cache-Control')).toBe('no-store');
    expect(ok.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });
});
