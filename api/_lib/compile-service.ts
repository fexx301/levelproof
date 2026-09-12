import { compileResultSchema, normalizeWirePayload, type CompileResult } from '../../shared/compile-result.js';
import { applyOperations } from '../../src/core/level.js';
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
  outcome: 'schema_valid' | 'schema_invalid' | 'rejected' | 'error';
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

  const attempt = async (
    model: string,
    messages: ChatMessage[],
  ): Promise<{ parsed: CompileResult | null; rejection?: string[] }> => {
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
    let rejection: string[] | undefined;
    if (!response.ok) {
      outcome = 'error';
    } else {
      parsed = tryParse(response.content);
      if (parsed === null) {
        outcome = 'schema_invalid';
      } else if (parsed.type === 'patch' || parsed.type === 'rule_proposal') {
        // Pre-apply with the same core the client uses: a patch the engine
        // would reject never reaches the user — it gets one correction turn
        // with the engine's exact reasons instead.
        const applied = applyOperations(input.level, parsed.operations);
        if (applied.ok) {
          outcome = 'schema_valid';
        } else {
          outcome = 'rejected';
          rejection = applied.errors;
          parsed = null;
        }
      } else {
        outcome = 'schema_valid';
      }
    }
    attempts.push({ model, outcome, latencyMs, costUsd });
    return { parsed, rejection };
  };

  const finish = (result: CompileResult): CompileOutcome => {
    compileCache.set(key, result);
    return { result, cached: false, attempts, totalCostUsd };
  };

  // Attempt 1: the primary model.
  let outcome1 = await attempt(primary.model, baseMessages);
  if (outcome1.parsed) return finish(outcome1.parsed);

  // Attempt 2: one correction retry on the primary — for malformed JSON the
  // note is generic; for an engine-rejected patch it carries the exact
  // rejection reasons so the model can fix its own placement. A provider
  // failure skips straight to the fallback.
  const first = attempts[0]?.outcome;
  if (
    (first === 'schema_invalid' || first === 'rejected') &&
    performance.now() - started < SERVICE_DEADLINE_MS
  ) {
    const correction: ChatMessage[] = [
      ...baseMessages,
      {
        role: 'user',
        content:
          first === 'rejected'
            ? `Your previous patch was rejected by the puzzle engine:\n${outcome1.rejection?.map((r) => `- ${r}`).join('\n')}\nCheck the scene's occupiedGrid and module list, then respond with a corrected patch that still satisfies the request.`
 : 'Your previous response did not match the required JSON contract. Respond again with a single corrected JSON object.',
      },
    ];
    const outcome2 = await attempt(primary.model, correction);
    if (outcome2.parsed) return finish(outcome2.parsed);
  }

  // Attempt 3: the evaluated fallback model, fresh messages.
  if (hasFallback && performance.now() - started < SERVICE_DEADLINE_MS) {
    const outcome3 = await attempt(fallbackModel!, baseMessages);
    if (outcome3.parsed) return finish(outcome3.parsed);
  }

  return { result: null, cached: false, attempts, totalCostUsd, error: 'invalid_output' };
}
