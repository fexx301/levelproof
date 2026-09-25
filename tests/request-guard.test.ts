import { beforeEach, describe, expect, it, vi } from 'vitest';
import { enforceRequestBudget, readLimitedJson, resetRequestBudget } from '../api/_lib/request-guard';

const request = (path = '/api/compile', ip = '192.0.2.10', body?: string) => new Request(`https://levelproof.test${path}`, {
  method: 'POST',
  headers: { 'x-forwarded-for': ip, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
  ...(body === undefined ? {} : { body }),
});

describe('paid API request boundary', () => {
  beforeEach(() => resetRequestBudget());

  it('enforces per-address windows and one shared daily quota in local development', async () => {
    const env = {
      NODE_ENV: 'test',
      API_RATE_LIMIT_WINDOW_SECONDS: '60',
      API_RATE_LIMIT_REQUESTS: '1',
      API_DAILY_REQUEST_LIMIT: '1',
    } as NodeJS.ProcessEnv;
    const now = () => Date.UTC(2026, 8, 22, 12);

    expect(await enforceRequestBudget(request(), env, { now })).toBeNull();
    expect((await enforceRequestBudget(request(), env, { now }))?.status).toBe(429);
    expect((await enforceRequestBudget(request('/api/explain', '192.0.2.11'), env, { now }))?.status).toBe(429);
  });

  it('fails closed in production when shared quotas are not configured', async () => {
    const response = await enforceRequestBudget(request(), { NODE_ENV: 'production' } as NodeJS.ProcessEnv);
    expect(response?.status).toBe(503);
    expect(await response?.json()).toEqual({ error: 'request_protection_unavailable' });
  });

  it('uses the shared atomic store and fails closed when that store is unavailable', async () => {
    const env = {
      NODE_ENV: 'production',
      UPSTASH_REDIS_REST_URL: 'https://redis.example.test',
      UPSTASH_REDIS_REST_TOKEN: 'test-secret',
    } as NodeJS.ProcessEnv;
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe('POST');
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer test-secret' });
      return Response.json({ result: [1, 1, 1] });
    });
    expect(await enforceRequestBudget(request(), env, { fetcher })).toBeNull();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    fetcher.mockResolvedValueOnce(new Response('unavailable', { status: 503 }));
    expect((await enforceRequestBudget(request(), env, { fetcher }))?.status).toBe(503);
    expect(warning).toHaveBeenCalledWith('[levelproof] request protection unavailable: upstash_http_503');
    warning.mockRestore();
  });

  it('accepts credentials pasted with surrounding terminal whitespace', async () => {
    const env = {
      NODE_ENV: 'production',
      UPSTASH_REDIS_REST_URL: ' https://redis.example.test\n',
      UPSTASH_REDIS_REST_TOKEN: ' test-\nsecret\r\n',
    } as NodeJS.ProcessEnv;
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer test-secret' });
      return Response.json({ result: [1, 1, 1] });
    });

    expect(await enforceRequestBudget(request(), env, { fetcher })).toBeNull();
  });

  it('reports a safe upstream network code without exposing the endpoint or token', async () => {
    const env = {
      NODE_ENV: 'production',
      UPSTASH_REDIS_REST_URL: 'https://redis.example.test',
      UPSTASH_REDIS_REST_TOKEN: 'test-secret',
    } as NodeJS.ProcessEnv;
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetcher = vi.fn(async () => {
      throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
    });

    expect((await enforceRequestBudget(request(), env, { fetcher }))?.status).toBe(503);
    expect(warning).toHaveBeenCalledWith('[levelproof] request protection unavailable: upstash_network_econnreset');
    expect(warning.mock.calls.flat().join(' ')).not.toContain('test-secret');
    expect(warning.mock.calls.flat().join(' ')).not.toContain('redis.example.test');
    warning.mockRestore();
  });

  it('does not couple Redis admission to an already-cancelled browser request', async () => {
    const env = {
      NODE_ENV: 'production',
      UPSTASH_REDIS_REST_URL: 'https://redis.example.test',
      UPSTASH_REDIS_REST_TOKEN: 'test-secret',
    } as NodeJS.ProcessEnv;
    const controller = new AbortController();
    const abortedRequest = new Request('https://levelproof.test/api/compile', {
      method: 'POST',
      signal: controller.signal,
    });
    controller.abort();
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.signal).toBeUndefined();
      return Response.json({ result: [1, 1, 1] });
    });

    expect(await enforceRequestBudget(abortedRequest, env, { fetcher })).toBeNull();
  });

  it('caps the streamed body and distinguishes invalid JSON', async () => {
    const tooLarge = await readLimitedJson(request('/api/compile', '192.0.2.10', JSON.stringify({ value: 'x'.repeat(50) })), 20);
    expect(tooLarge).toEqual({ ok: false, status: 413 });
    const invalid = await readLimitedJson(request('/api/compile', '192.0.2.10', '{bad'), 100);
    expect(invalid).toEqual({ ok: false, status: 400 });
    const valid = await readLimitedJson(request('/api/compile', '192.0.2.10', '{"ok":true}'), 100);
    expect(valid).toEqual({ ok: true, value: { ok: true } });
  });
});
