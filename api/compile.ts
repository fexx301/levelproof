import { compile } from './_lib/compile-service.js';
import { compileRequestSchema } from '../shared/api.js';

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

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }

  const parsed = compileRequestSchema.safeParse(body);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
    return Response.json({ error: 'invalid_request', issues }, { status: 400 });
  }

  const outcome = await compile(process.env, parsed.data);

  if (outcome.result === null) {
    return Response.json(
      {
        error: outcome.error === 'missing_provider_config' ? 'provider_not_configured' : 'compilation_failed',
        attempts: outcome.attempts,
        totalCostUsd: outcome.totalCostUsd,
      },
      { status: outcome.error === 'missing_provider_config' ? 503 : 502 },
    );
  }

  return Response.json({
    result: outcome.result,
    cached: outcome.cached,
    attempts: outcome.attempts,
    totalCostUsd: outcome.totalCostUsd,
  });
}
