import { explain, explainNeedsModel, peekExplain } from './_lib/explain-service.js';
import { explainRequestSchema } from '../shared/api.js';
import { enforceDailyBudget, enforceRequestWindow, readLimitedJson } from './_lib/request-guard.js';

/**
 * POST /api/explain — grounded failure narration (§10). The server recomputes
 * the verdict from the submitted level with the shared core; the model only
 * phrases the engine's facts, and its output is schema- and grounding-checked
 * before it is returned. Server-side only, like /api/compile. A cached
 * narration is served before the daily model budget is charged.
 */
export const maxDuration = 60;

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

  const parsed = explainRequestSchema.safeParse(decoded.value);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
    return Response.json({ error: 'invalid_request', issues }, { status: 400 });
  }

  const cached = await peekExplain(process.env, parsed.data);
  const budget = cached === null && explainNeedsModel(parsed.data) ? await enforceDailyBudget(request) : null;
  if (budget !== null) return budget;
  const outcome = cached ?? await explain(process.env, parsed.data, { signal: request.signal });

  if (outcome.explanation === null) {
    const status =
      outcome.error === 'check_not_failing' ? 422 : outcome.error === 'missing_provider_config' ? 503 : 502;
    return Response.json(
      {
        error: outcome.error ?? 'explain_failed',
        attempts: outcome.attempts,
        totalCostUsd: outcome.totalCostUsd,
        generationCostUsd: outcome.generationCostUsd,
      },
      { status: outcome.error === 'cancelled' ? 499 : status },
    );
  }

  return Response.json({
    explanation: outcome.explanation,
    cached: outcome.cached,
    attempts: outcome.attempts,
    totalCostUsd: outcome.totalCostUsd,
    generationCostUsd: outcome.generationCostUsd,
  });
}
