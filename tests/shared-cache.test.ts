import { afterEach, describe, expect, it, vi } from 'vitest';
import { SharedCache } from '../api/_lib/cache';

/** The shared tier is a lookup aid only: an entry is reused on an exact identity match. */
function fakeRedis() {
  const store = new Map<string, string>();
  const fetcher = vi.fn(async (_url: string, init: { body: string }) => {
    const [command, key, value] = JSON.parse(init.body) as string[];
    if (command === 'SET') store.set(key!, value!);
    const result = command === 'GET' ? store.get(key!) ?? null : 'OK';
    return { ok: true, json: async () => ({ result }) };
  });
  return { store, fetcher };
}

const ENV = { UPSTASH_REDIS_REST_URL: 'https://redis.test', UPSTASH_REDIS_REST_TOKEN: 'token' };

afterEach(() => vi.unstubAllGlobals());

describe('shared compile cache', () => {
  it('serves a cold instance from the shared store', async () => {
    const redis = fakeRedis();
    vi.stubGlobal('fetch', redis.fetcher);
    await new SharedCache<string>('test', ENV).set('identity', { value: 'result', attempts: [], generationCostUsd: 0.01 });
    const cold = new SharedCache<string>('test', ENV);
    expect((await cold.get('identity'))?.value).toBe('result');
    expect(redis.store.size).toBe(1);
  });

  it('never reuses an entry whose stored identity differs', async () => {
    const redis = fakeRedis();
    vi.stubGlobal('fetch', redis.fetcher);
    const cache = new SharedCache<string>('test', ENV);
    await cache.set('identity', { value: 'result', attempts: [], generationCostUsd: 0 });
    const [key] = [...redis.store.keys()];
    redis.store.set(key!, JSON.stringify({ identity: 'someone else', entry: { value: 'wrong', attempts: [], generationCostUsd: 0 } }));
    expect(await new SharedCache<string>('test', ENV).get('identity')).toBeNull();
  });

  it('treats a store failure as a miss and works without configuration', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    const cache = new SharedCache<string>('test', ENV);
    await cache.set('identity', { value: 'kept locally', attempts: [], generationCostUsd: 0 });
    expect((await cache.get('identity'))?.value).toBe('kept locally');
    expect(await new SharedCache<string>('test', ENV).get('identity')).toBeNull();
    expect(await new SharedCache<string>('test', {}).get('identity')).toBeNull();
  });
});
