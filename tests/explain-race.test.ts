import { afterEach, describe, expect, it, vi } from 'vitest';
import { useApp } from '../src/state/store';

/** Explanations have their own request identity: a cancelled one never touches a newer one. */

afterEach(() => vi.unstubAllGlobals());

describe('explanation requests', () => {
  it('cancel then retry: the cancelled request cannot clear the new one', async () => {
    let releaseSecond: (value: Response) => void = () => {};
    let call = 0;
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => {
      call += 1;
      if (call === 1) {
        // Rejects only once aborted, like a real in-flight request.
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => setTimeout(() => reject(new DOMException('Aborted', 'AbortError')), 5));
        });
      }
      return new Promise<Response>((resolve) => { releaseSecond = resolve; });
    }));
    const first = useApp.getState().explainCheck('solution');
    useApp.getState().cancelExplain();
    const second = useApp.getState().explainCheck('solution');
    expect(useApp.getState().explain.busy).toBe(true);
    await first; // the old request's abort lands now
    expect(useApp.getState().explain.busy).toBe(true);
    expect(useApp.getState().explain.error).toBeNull();
    releaseSecond(Response.json({ error: 'budget_exhausted' }, { status: 503 }));
    await second;
    expect(useApp.getState().explain.busy).toBe(false);
  });
});
