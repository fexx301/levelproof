import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from '../api/compile';
import { resetCache } from '../api/_lib/cache';
import { resetRequestBudget } from '../api/_lib/request-guard';
import { vaultEmptyLevel } from '../src/core/fixtures/vault-empty';

/**
 * The daily cap guards provider spend: cached answers are free, so they are
 * served before the budget is charged. The per-address burst window still
 * applies to every request.
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

function providerReply(content: string): Response {
  return Response.json({ choices: [{ message: { content } }], usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.001 } });
}

const patch = (label: string) => JSON.stringify({
  type: 'patch',
  rationale: 'Rename the foyer.',
  assumptions: [],
  operations: [{ kind: 'setModuleLabel', id: 'gallery', label }],
});

function compileRequest(prompt: string, ip = '192.0.2.20'): Request {
  return new Request('https://levelproof.test/api/compile', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify({ level: vaultEmptyLevel, prompt }),
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

describe('daily model budget', () => {
  it('serves cached answers without charging the budget, and still caps fresh model calls', async () => {
    const provider = vi.fn(async () => providerReply(patch('grand foyer')));
    vi.stubGlobal('fetch', provider);

    const first = await POST(compileRequest('Rename the foyer to grand foyer.'));
    expect(first.status).toBe(200);
    expect((await first.json()).cached).toBe(false);

    for (let i = 0; i < 5; i++) {
      const again = await POST(compileRequest('Rename the foyer to grand foyer.'));
      expect(again.status).toBe(200);
      expect((await again.json()).cached).toBe(true);
    }
    expect(provider).toHaveBeenCalledTimes(1);

    const fresh = await POST(compileRequest('Rename the foyer to east foyer.'));
    expect(fresh.status).toBe(429);
    expect(await fresh.json()).toEqual({ error: 'request_limit_reached' });
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it('streams a cached answer as a single result event', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => providerReply(patch('grand foyer'))));
    await POST(compileRequest('Rename the foyer to grand foyer.'));
    const streamed = await POST(new Request('https://levelproof.test/api/compile', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/x-ndjson', 'x-forwarded-for': '192.0.2.21' },
      body: JSON.stringify({ level: vaultEmptyLevel, prompt: 'Rename the foyer to grand foyer.' }),
    }));
    const lines = (await streamed.text()).trim().split('\n').map((line) => JSON.parse(line));
    expect(lines).toHaveLength(1);
    expect(lines[0].event).toBe('result');
    expect(lines[0].body.cached).toBe(true);
  });

  it('keeps the per-address burst window on cached requests', async () => {
    process.env.API_RATE_LIMIT_REQUESTS = '2';
    process.env.API_DAILY_REQUEST_LIMIT = '100';
    vi.stubGlobal('fetch', vi.fn(async () => providerReply(patch('grand foyer'))));
    expect((await POST(compileRequest('Rename the foyer to grand foyer.', '192.0.2.30'))).status).toBe(200);
    expect((await POST(compileRequest('Rename the foyer to grand foyer.', '192.0.2.30'))).status).toBe(200);
    expect((await POST(compileRequest('Rename the foyer to grand foyer.', '192.0.2.30'))).status).toBe(429);
  });

  it('does not charge the budget for a revision the engine has nothing to say about', async () => {
    const provider = vi.fn(async () => providerReply(patch('grand foyer')));
    vi.stubGlobal('fetch', provider);
    // A harmless relabel: the engine finds nothing wrong, so no model call.
    for (let i = 0; i < 3; i++) {
      const response = await POST(new Request('https://levelproof.test/api/compile', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '192.0.2.40' },
        body: JSON.stringify({ level: vaultEmptyLevel, prompt: 'Rename the foyer.', revision: { operations: [{ kind: 'setModuleLabel', id: 'gallery', label: 'foyer' }] } }),
      }));
      expect(response.status).not.toBe(429);
    }
    expect(provider).not.toHaveBeenCalled();
    // The single daily slot is still available for real model work.
    expect((await POST(compileRequest('Rename the foyer to grand foyer.'))).status).toBe(200);
  });
});
