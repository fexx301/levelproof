import { peekNpc, resolveFacts, voiceNpc } from './_lib/npc-service.js';
import { npcRequestSchema } from '../shared/api.js';
import { enforceDailyBudget, enforceRequestWindow, readLimitedJson, requireJsonBody, withApiHeaders } from './_lib/request-guard.js';

/**
 * POST /api/npc — a character voices the engine's next step (§12). The
 * server recomputes that step from the submitted level and player state with
 * the shared core; the model only phrases it, and its line is grounding-
 * checked before it is returned. A cached line is served before the daily
 * model budget is charged.
 */
export const maxDuration = 60;

export async function POST(request: Request): Promise<Response> {
  return withApiHeaders(await handle(request));
}

async function handle(request: Request): Promise<Response> {
  if (request.method !== 'POST') {
    return Response.json({ error: 'method_not_allowed' }, { status: 405 });
  }
  const notJson = requireJsonBody(request);
  if (notJson !== null) return notJson;

  const burst = await enforceRequestWindow(request);
  if (burst !== null) return burst;

  const decoded = await readLimitedJson(request);
  if (!decoded.ok) {
    return Response.json(
      { error: decoded.status === 413 ? 'request_too_large' : 'invalid_json' },
      { status: decoded.status, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const parsed = npcRequestSchema.safeParse(decoded.value);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
    return Response.json({ error: 'invalid_request', issues }, { status: 400 });
  }
  // Nothing reaches the model (or the budget) unless the engine can answer.
  if (resolveFacts(parsed.data) === null) return Response.json({ error: 'invalid_request' }, { status: 400 });

  const cached = await peekNpc(process.env, parsed.data);
  const budget = cached === null ? await enforceDailyBudget(request) : null;
  if (budget !== null) return budget;
  const outcome = cached ?? await voiceNpc(process.env, parsed.data, { signal: request.signal });

  if (outcome.line === null) {
    const status = outcome.error === 'missing_provider_config' ? 503 : outcome.error === 'cancelled' ? 499 : outcome.error === 'invalid_request' ? 400 : 502;
    return Response.json(
      { error: outcome.error ?? 'npc_failed', attempts: outcome.attempts, totalCostUsd: outcome.totalCostUsd, generationCostUsd: outcome.generationCostUsd },
      { status },
    );
  }

  return Response.json({
    line: outcome.line,
    cached: outcome.cached,
    attempts: outcome.attempts,
    totalCostUsd: outcome.totalCostUsd,
    generationCostUsd: outcome.generationCostUsd,
  });
}
