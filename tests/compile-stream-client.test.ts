import { afterEach, describe, expect, it, vi } from 'vitest';
import { postCompile } from '../src/state/store';
import type { CompileProgress } from '../shared/api';

/** The browser side of the streamed compile: NDJSON progress, then one result. */
function streamedResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8' } });
}

afterEach(() => vi.unstubAllGlobals());

describe('streamed compile client', () => {
  it('forwards progress split across chunks and returns the final result body', async () => {
    const lines = [
      JSON.stringify({ event: 'progress', progress: { stage: 'thinking', attempt: 1, headline: 'Planning the Keep' } }),
      JSON.stringify({ event: 'progress', progress: { stage: 'writing', attempt: 1, operations: 1, latest: '+ flat: gatehouse' } }),
      JSON.stringify({ event: 'result', status: 200, body: { result: { type: 'unsupported', reason: 'x', alternatives: ['y'] } } }),
    ].join('\n') + '\n';
    const chunks = [lines.slice(0, 17), lines.slice(17, 90), lines.slice(90, 91), lines.slice(91)];
    vi.stubGlobal('fetch', vi.fn(async () => streamedResponse(chunks)));
    const events: CompileProgress[] = [];
    const outcome = await postCompile({ prompt: 'p' }, new AbortController().signal, (event) => events.push(event));
    expect(events).toEqual([
      { stage: 'thinking', attempt: 1, headline: 'Planning the Keep' },
      { stage: 'writing', attempt: 1, operations: 1, latest: '+ flat: gatehouse' },
    ]);
    expect(outcome).toEqual({ ok: true, status: 200, body: { result: { type: 'unsupported', reason: 'x', alternatives: ['y'] } } });
  });

  it('reports a streamed failure with its real status, even without a trailing newline', async () => {
    const final = JSON.stringify({ event: 'result', status: 502, body: { error: 'compilation_failed', providerError: 'timeout' } });
    vi.stubGlobal('fetch', vi.fn(async () => streamedResponse([`${JSON.stringify({ event: 'progress', progress: { stage: 'thinking', attempt: 1 } })}\n`, final])));
    const outcome = await postCompile({ prompt: 'p' }, new AbortController().signal, () => undefined);
    expect(outcome).toEqual({ ok: false, status: 502, body: { error: 'compilation_failed', providerError: 'timeout' } });
  });

  it('fails loudly when the stream ends without a result', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => streamedResponse([`${JSON.stringify({ event: 'progress', progress: { stage: 'checking', attempt: 1 } })}\n`])));
    await expect(postCompile({ prompt: 'p' }, new AbortController().signal, () => undefined)).rejects.toThrow('without a result');
  });

  it('still accepts a plain JSON response from an older server', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'request_limit_reached' }), { status: 429, headers: { 'Content-Type': 'application/json' } })));
    const outcome = await postCompile({ prompt: 'p' }, new AbortController().signal, () => undefined);
    expect(outcome).toEqual({ ok: false, status: 429, body: { error: 'request_limit_reached' } });
  });
});
