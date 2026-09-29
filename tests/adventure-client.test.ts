import { afterEach, describe, expect, it, vi } from 'vitest';
import { continueAdventure } from '../src/state/adventure';
import { useApp } from '../src/state/store';
import { revisionId } from '../src/core/serialize';
import type { Level } from '../shared/schema';

/** The client's chapter loop: fresh retry, revisions, and the fairness gate. */

const fairButShort = {
  type: 'patch',
  rationale: 'crypt',
  assumptions: [],
  operations: [{ kind: 'setScenery', environment: 'cavern', lighting: 'night', architecture: 'basalt' }],
  story: { title: 'The Crypt', narration: 'You descend.' },
};

afterEach(() => vi.unstubAllGlobals());

describe('adventure chapter loop', () => {
  it('retries once from scratch when the first request yields nothing, then enters a fair chapter', async () => {
    const bodies: Array<{ revision?: unknown; adventure?: { chapter: number } }> = [];
    let call = 0;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { level: Level; revision?: unknown; adventure?: { chapter: number } };
      bodies.push(body);
      call += 1;
      if (call === 1) return Response.json({ error: 'compilation_failed' }, { status: 502 });
      return Response.json({ result: fairButShort, baseRevision: revisionId(body.level), cached: false, attempts: [], totalCostUsd: 0.001, generationCostUsd: 0.001 });
    }));
    await continueAdventure('Surprise me.', 'steady');
    const state = useApp.getState();
    expect(state.adventure.error).toBeNull();
    expect(state.adventure.chapters.map((chapter) => chapter.number)).toEqual([1, 2]);
    expect(state.adventure.chapters[1]!.title).toBe('The Crypt');
    // Fair but shorter than the band: the engine sent it back for both revision rounds.
    expect(state.adventure.chapters[1]!.inBand).toBe(false);
    expect(call).toBe(4);
    expect(bodies[1]!.revision).toBeUndefined(); // the fresh retry
    expect(bodies[2]!.revision).toBeDefined();
    expect(bodies.every((body) => body.adventure?.chapter === 2)).toBe(true);
    expect(state.mode).toBe('playing');
    expect(state.acceptedLevel.scenery?.environment).toBe('cavern');
  });
});

describe('adventure refusals', () => {
  it('names a rate limit plainly and does not retry into it', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls += 1;
      return Response.json({ error: 'request_limit_reached' }, { status: 429 });
    }));
    const before = useApp.getState().acceptedLevel;
    await continueAdventure('Surprise me.', 'steady');
    const state = useApp.getState();
    expect(calls).toBe(1);
    expect(state.adventure.error).toMatch(/Too many requests/);
    expect(state.busy).toBe(false);
    expect(state.acceptedLevel).toBe(before);
  });
});
