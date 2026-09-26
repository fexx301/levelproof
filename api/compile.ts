import { compile, compileNeedsModel, peekCompile, type CompileOutcome } from './_lib/compile-service.js';
import { compileRequestSchema, type CompileProgress } from '../shared/api.js';
import { enforceDailyBudget, enforceRequestWindow, readLimitedJson } from './_lib/request-guard.js';

/**
 * POST /api/compile — validated model compilation request (§3, §10).
 * Server-side only: the provider key never leaves this environment, request
 * bodies are strictly validated before any provider call, and nothing
 * sensitive is logged. The client applies the returned operations
 * deterministically through the shared core. Named-method export: the
 * default export is treated as the legacy (req, res) signature.
 *
 * With `Accept: application/x-ndjson` the same compile streams live progress
 * (the model's reasoning headlines and each operation as it is written) and
 * ends with one "result" event holding the normal status and body.
 *
 * Every request passes the per-address burst window. A cached answer is
 * served before the daily model budget is charged — it costs nothing — so
 * prewarmed examples can never exhaust the budget for everyone.
 */
export const maxDuration = 60;

function outcomeResponse(outcome: CompileOutcome): { status: number; body: Record<string, unknown> } {
  if (outcome.result === null) {
    const status =
      outcome.error === 'missing_provider_config' ? 503
        : outcome.error === 'cancelled' ? 499
          : outcome.error === 'nothing_to_revise' ? 400
            : 502;
    return {
      status,
      body: {
        error:
          outcome.error === 'missing_provider_config'
            ? 'provider_not_configured'
            : outcome.error === 'cancelled'
              ? 'request_cancelled'
              : outcome.error === 'nothing_to_revise'
                ? 'nothing_to_revise'
                : 'compilation_failed',
        ...(outcome.providerError !== undefined ? { providerError: outcome.providerError } : {}),
        attempts: outcome.attempts,
        totalCostUsd: outcome.totalCostUsd,
        generationCostUsd: outcome.generationCostUsd,
      },
    };
  }
  return {
    status: 200,
    body: {
      result: outcome.result,
      baseRevision: outcome.baseRevision,
      ...(outcome.theme !== undefined ? { theme: outcome.theme } : {}),
      cached: outcome.cached,
      attempts: outcome.attempts,
      totalCostUsd: outcome.totalCostUsd,
      generationCostUsd: outcome.generationCostUsd,
    },
  };
}

export async function POST(request: Request): Promise<Response> {
  if (request.method !== 'POST') {
    return Response.json({ error: 'method_not_allowed' }, { status: 405 });
  }

  const burst = await enforceRequestWindow(request);
  if (burst !== null) return burst;

  const decoded = await readLimitedJson(request);
  if (!decoded.ok) {
    return Response.json(
      { error: decoded.status === 413 ? 'request_too_large' : 'invalid_json' },
      { status: decoded.status, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const parsed = compileRequestSchema.safeParse(decoded.value);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
    return Response.json({ error: 'invalid_request', issues }, { status: 400 });
  }

  const input = {
    ...parsed.data,
    history: parsed.data.history?.map((h) => h.prompt),
  };

  const streamed = (request.headers.get('accept') ?? '').includes('application/x-ndjson');
  const cached = await peekCompile(process.env, input);
  if (cached !== null) {
    const { status, body } = outcomeResponse(cached);
    if (!streamed) return Response.json(body, { status });
    return new Response(`${JSON.stringify({ event: 'result', status, body })}\n`, {
      status: 200,
      headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }

  // Deterministic answers (nothing to revise) never call the model, so they
  // are not charged to the daily model budget.
  const budget = compileNeedsModel(input) ? await enforceDailyBudget(request) : null;
  if (budget !== null) return budget;

  if (streamed) {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (event: unknown): void => {
          try {
            controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
          } catch {
            // The client went away; the compile is cancelled through its signal.
          }
        };
        const onProgress = (progress: CompileProgress): void => send({ event: 'progress', progress });
        try {
          const outcome = await compile(process.env, input, { signal: request.signal, onProgress });
          const { status, body } = outcomeResponse(outcome);
          send({ event: 'result', status, body });
        } catch {
          send({ event: 'result', status: 500, body: { error: 'compilation_failed' } });
        } finally {
          try {
            controller.close();
          } catch {
            // Already closed by a disconnect.
          }
        }
      },
    });
    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no',
      },
    });
  }

  const outcome = await compile(process.env, input, { signal: request.signal });
  const { status, body } = outcomeResponse(outcome);
  return Response.json(body, { status });
}
