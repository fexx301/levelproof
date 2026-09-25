import { afterEach, describe, expect, it, vi } from 'vitest';
import { BoundedCache, cacheKey } from '../api/_lib/cache';
import { vaultEmptyLevel } from '../src/core/fixtures/vault-empty';
import { revisionId } from '../src/core/serialize';

afterEach(() => vi.useRealTimers());

describe('cache identity and freshness', () => {
  it('uses an exact, unambiguous input identity instead of a short delimiter hash', () => {
    const first = cacheKey({ level: vaultEmptyLevel, payload: 'a\u0000b', models: 'c', promptVersion: 'v1' });
    const second = cacheKey({ level: vaultEmptyLevel, payload: 'a', models: 'b\u0000c', promptVersion: 'v1' });
    expect(first).not.toBe(second);
  });

  it('expires warm-instance results after one hour', () => {
    vi.useFakeTimers();
    const cache = new BoundedCache<string>();
    cache.set('same input', { value: 'result', attempts: [], generationCostUsd: 0.01 });
    expect(cache.get('same input')?.value).toBe('result');
    vi.advanceTimersByTime(60 * 60 * 1000 + 1);
    expect(cache.get('same input')).toBeNull();
  });

  it('uses a 64-bit scene revision for stale-response binding', () => {
    expect(revisionId(vaultEmptyLevel)).toMatch(/^rev-[0-9a-f]{16}$/);
  });
});
