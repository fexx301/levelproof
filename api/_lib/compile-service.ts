import { compileResultSchema, normalizeWirePayload, type CompileResult } from '../../shared/compile-result.js';
import type { Level } from '../../shared/schema.js';
import { revisionId } from '../../src/core/serialize.js';
import { compileCache, compileCacheKey } from './cache.js';
import { buildSystemPrompt, PROMPT_VERSION } from './prompt.js';
import { callOptionsFor } from './model-options.js';
import {
  chatCompletion,
  providerConfigFromEnv,
  type ChatMessage,
  type ProviderConfig,
  type ProviderResult,
  type StructuredOptions,
} from './provider.js';

/**
 * Compilation service (§10). One request, at most three provider attempts:
 * primary, at most one schema-correction retry, at most one evaluated
 * fallback — all charged to usage accounting, under a total deadline.
 * Only schema-valid results are cached and returned; invalid output is
 * never accepted.
 */

export type CallModel = (
  config: ProviderConfig,
  messages: ChatMessage[],
  options: StructuredOptions,
) => Promise<ProviderResult>;

export interface CompileInput {
  level: Level;
  prompt: string;
  clarificationContext?: string;
}

export interface AttemptRecord {
  model: string;
  outcome: 'schema_valid' | 'schema_invalid' | 'error';
  latencyMs: number;
  costUsd: number;
}

export interface CompileOutcome {
  result: CompileResult | null;
  cached: boolean;
  attempts: AttemptRecord[];
  totalCostUsd: number;
  error?: string;
}

const SERVICE_DEADLINE_MS = 90_000;

function tryParse(raw: string): CompileResult | null {
  try {
    const check = compileResultSchema.safeParse(normalizeWirePayload(raw));
    return check.success ? check.data : null;
  } catch {
    return null;
  }
}

export async function compile(
  env: NodeJS.ProcessEnv,
  input: CompileInput,
  deps: { callModel?: CallModel } = {},
): Promise<CompileOutcome> {
  const callModel = deps.callModel ?? chatCompletion;
  const primary = providerConfigFromEnv(env);
  if (!primary) {
    return { result: null, cached: false, attempts: [], totalCostUsd: 0, error: 'missing_provider_config' };
  }
  const fallbackModel = env.LLM_FALLBACK_MODEL;
  const hasFallback = fallbackModel !== undefined && fallbackModel !== primary.model;

  const key = compileCacheKey({
    level: input.level,
    prompt: input.prompt,
    clarificationContext: input.clarificationContext,
    models: hasFallback ? `${primary.model},${fallbackModel}` : primary.model,
    promptVersion: PROMPT_VERSION,
  });
  const hit = compileCache.get(key);
  if (hit !== null) {
    return { result: hit, cached: true, attempts: [], totalCostUsd: 0 };
  }

  const baseMessages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt(input.level, revisionId(input.level)) },
    {
      role: 'user',
      content: input.clarificationContext
        ? `${input.prompt}\n\n(Clarification context: ${input.clarificationContext})`
        : input.prompt,
    },
  ];

  const attempts: AttemptRecord[] = [];
  const started = performance.now();
  let totalCostUsd = 0;

  const attempt = async (model: string, messages: ChatMessage[]): Promise<CompileResult | null> => {
    const config: ProviderConfig = { ...primary, model };
    const t0 = performance.now();
    const response = await callModel(config, messages, {
      ...callOptionsFor(model),
      schemaName: 'levelproof_result',
    });
    const latencyMs = performance.now() - t0;
    const costUsd = response.ok ? (response.usage.costUsd ?? 0) : 0;
    totalCostUsd += costUsd;
    let outcome: AttemptRecord['outcome'];
    let parsed: CompileResult | null = null;
    if (!response.ok) {
      outcome = 'error';
    } else {
      parsed = tryParse(response.content);
      outcome = parsed ? 'schema_valid' : 'schema_invalid';
    }
    attempts.push({ model, outcome, latencyMs, costUsd });
    return parsed;
  };

  const finish = (result: CompileResult): CompileOutcome => {
    compileCache.set(key, result);
    return { result, cached: false, attempts, totalCostUsd };
  };

  // Attempt 1: the primary model.
  let parsed = await attempt(primary.model, baseMessages);
  if (parsed) return finish(parsed);

  // Attempt 2: at most one schema-correction retry on the primary. A
  // provider-level failure skips straight to the fallback.
  const firstOutcome = attempts[0]?.outcome;
  if (firstOutcome === 'schema_invalid' && performance.now() - started < SERVICE_DEADLINE_MS) {
    const correction: ChatMessage[] = [
      ...baseMessages,
      {
        role: 'user',
        content:
          'Your previous response did not match the required JSON contract. Respond again with a single corrected JSON object.',
      },
    ];
    parsed = await attempt(primary.model, correction);
    if (parsed) return finish(parsed);
  }

  // Attempt 3: the evaluated fallback model, fresh messages.
  if (hasFallback && performance.now() - started < SERVICE_DEADLINE_MS) {
    parsed = await attempt(fallbackModel!, baseMessages);
    if (parsed) return finish(parsed);
  }

  return { result: null, cached: false, attempts, totalCostUsd, error: 'invalid_output' };
}
