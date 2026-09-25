import { compile } from './_lib/compile-service.js';
import { compileRequestSchema } from '../shared/api.js';
import { enforceRequestBudget, readLimitedJson } from './_lib/request-guard.js';

/**
 * POST /api/compile — validated model compilation request (§3, §10).
 * Server-side only: the provider key never leaves this environment, request
 * bodies are strictly validated before any provider call, and nothing
 * sensitive is logged. The client applies the returned operations
 * deterministically through the shared core. Named-method export: the
 * default export is treated as the legacy (req, res) signature.
 */
export const maxDuration = 60;

export async function POST(request: Request): Promise<Response> {
  if (request.method !== 'POST') {
    return Response.json({ error: 'method_not_allowed' }, { status: 405 });
  }

  const protection = await enforceRequestBudget(request);
  if (protection !== null) return protection;

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
  const outcome = await compile(process.env, input, { signal: request.signal });

  if (outcome.result === null) {
    return Response.json(
      {
        error:
          outcome.error === 'missing_provider_config'
            ? 'provider_not_configured'
            : outcome.error === 'cancelled'
              ? 'request_cancelled'
              : 'compilation_failed',
        ...(outcome.providerError !== undefined ? { providerError: outcome.providerError } : {}),
        attempts: outcome.attempts,
        totalCostUsd: outcome.totalCostUsd,
        generationCostUsd: outcome.generationCostUsd,
      },
      { status: outcome.error === 'missing_provider_config' ? 503 : outcome.error === 'cancelled' ? 499 : 502 },
    );
  }

  return Response.json({
    result: outcome.result,
    baseRevision: outcome.baseRevision,
    ...(outcome.theme !== undefined ? { theme: outcome.theme } : {}),
    cached: outcome.cached,
    attempts: outcome.attempts,
    totalCostUsd: outcome.totalCostUsd,
    generationCostUsd: outcome.generationCostUsd,
  });
}
