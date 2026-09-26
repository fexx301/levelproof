import { compileResultSchema, normalizeWirePayload, type CompileResult } from '../../shared/compile-result.js';
import { applyOperations, applyRuleProposal } from '../../src/core/level.js';
import { engineFindings } from '../../src/core/engine-findings.js';
import { verify } from '../../src/core/verifier.js';
import type { CompileProgress, ThemeKey } from '../../shared/api.js';
import type { Level, Operation } from '../../shared/schema.js';
import { OperationStream, operationLabel, reasoningHeadlines } from '../../shared/stream-progress.js';
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
  type StreamDelta,
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
  signal?: AbortSignal,
  onDelta?: (delta: StreamDelta) => void,
) => Promise<ProviderResult>;

export interface CompileInput {
  level: Level;
  prompt: string;
  clarificationContext?: string;
  selection?: string[];
  protectedIds?: string[];
  history?: string[];
  theme?: ThemeKey;
  /**
   * AI↔engine revision: the operations of an earlier attempt (empty when the
   * current scene itself is being repaired). The engine re-checks them here;
   * its findings — never client text — go back to the model.
   */
  revision?: { operations: Operation[] };
}

export interface AttemptRecord {
  model: string;
  outcome: 'schema_valid' | 'schema_invalid' | 'rejected' | 'error';
  latencyMs: number;
  costUsd: number | null;
  errorKind?: 'rate_limited' | 'timeout' | 'budget' | 'outage' | 'unknown';
}

export interface CompileOutcome {
  result: CompileResult | null;
  /** Server-attached (§11): the revision the result was computed against. */
  baseRevision: string;
  /** Server-echoed presentation theme. */
  theme?: ThemeKey;
  cached: boolean;
  attempts: AttemptRecord[];
  totalCostUsd: number | null;
  generationCostUsd: number | null;
  error?: 'missing_provider_config' | 'invalid_output' | 'cancelled' | 'nothing_to_revise';
  /** The provider's failure class when the final attempt errored. */
  providerError?: 'rate_limited' | 'timeout' | 'budget' | 'outage' | 'unknown';
}

// The Vercel handlers declare maxDuration = 60; the service must finish
// cleanly inside it. 52s leaves margin, and per-attempt timeouts are
// clamped to the remaining budget (below) so no attempt can straddle the
// platform kill.
const SERVICE_DEADLINE_MS = 52_000;
const MIN_ATTEMPT_BUDGET_MS = 4_000;

function tryParse(raw: string): CompileResult | null {
  try {
    const check = compileResultSchema.safeParse(normalizeWirePayload(raw));
    return check.success ? check.data : null;
  } catch {
    return null;
  }
}

/** The exact cache identity of a compile request under this configuration. */
function compileIdentity(primary: ProviderConfig, env: NodeJS.ProcessEnv, input: CompileInput): string {
  const fallbackModel = env.LLM_FALLBACK_MODEL;
  const hasFallback = fallbackModel !== undefined && fallbackModel !== primary.model;
  return compileCacheKey({
    level: input.level,
    prompt: input.prompt,
    clarificationContext: input.clarificationContext,
    selection: input.selection,
    protectedIds: input.protectedIds,
    history: input.history,
    revision: input.revision === undefined ? undefined : JSON.stringify(input.revision.operations),
    models: JSON.stringify({
      baseUrl: primary.baseUrl,
      chain: (hasFallback ? [primary.model, fallbackModel] : [primary.model]).map((model) => ({
        model,
        options: callOptionsFor(model!),
      })),
    }),
    promptVersion: PROMPT_VERSION,
  });
}

/**
 * Cache-only lookup with the same identity as compile(): the endpoint serves
 * a hit without charging the daily model budget, because it costs nothing.
 */
export async function peekCompile(env: NodeJS.ProcessEnv, input: CompileInput): Promise<CompileOutcome | null> {
  const primary = providerConfigFromEnv(env);
  if (!primary) return null;
  const hit = await compileCache.get(compileIdentity(primary, env, input));
  if (hit === null) return null;
  return {
    result: hit.value,
    baseRevision: revisionId(input.level),
    theme: input.theme,
    cached: true,
    attempts: hit.attempts,
    totalCostUsd: 0,
    generationCostUsd: hit.generationCostUsd,
  };
}

/**
 * False when the answer is deterministic and no model is called: a revision
 * request whose operations the engine finds nothing wrong with. The handler
 * uses this to charge the daily model budget only for real model work.
 */
export function compileNeedsModel(input: CompileInput): boolean {
  if (input.revision === undefined) return true;
  const applied = applyOperations(input.level, input.revision.operations);
  if (!applied.ok) return true;
  return engineFindings(applied.level, verify(applied.level)).length > 0;
}

export async function compile(
  env: NodeJS.ProcessEnv,
  input: CompileInput,
  deps: { callModel?: CallModel; signal?: AbortSignal; onProgress?: (progress: CompileProgress) => void } = {},
): Promise<CompileOutcome> {
  const callModel = deps.callModel ?? chatCompletion;
  const signal = deps.signal;
  const baseRevision = revisionId(input.level);
  const primary = providerConfigFromEnv(env);
  if (!primary) {
    return { result: null, baseRevision, theme: input.theme, cached: false, attempts: [], totalCostUsd: 0, generationCostUsd: null, error: 'missing_provider_config' };
  }
  const fallbackModel = env.LLM_FALLBACK_MODEL;
  const hasFallback = fallbackModel !== undefined && fallbackModel !== primary.model;
  const key = compileIdentity(primary, env, input);
  // The engine's own findings about the attempt being revised.
  let revisionNote: string | null = null;
  if (input.revision !== undefined) {
    const applied = applyOperations(input.level, input.revision.operations);
    const checked = applied.ok ? applied.level : input.level;
    const findings = applied.ok ? engineFindings(checked, verify(checked)) : applied.errors.map((error) => `The engine rejected it: ${error}`);
    if (findings.length === 0) {
      return { result: null, baseRevision, theme: input.theme, cached: false, attempts: [], totalCostUsd: 0, generationCostUsd: null, error: 'nothing_to_revise' };
    }
    revisionNote = input.revision.operations.length > 0
      ? `(ENGINE CHECK OF YOUR PREVIOUS ATTEMPT. The scene above is unchanged; your earlier patch was applied to a copy and verified by the puzzle engine.\nPrevious operations: ${JSON.stringify(input.revision.operations)}\nEngine findings:\n${findings.map((finding) => `- ${finding}`).join('\n')}\nRespond with a complete, corrected patch against the scene above. Deliver everything the author asked for — every requested room, item, trap, and scenery element — and fix these findings by moving, reconnecting, or re-gating things, never by deleting the author's mechanics.)`
      : `(ENGINE CHECK OF THE CURRENT SCENE — it fails these verified findings:\n${findings.map((finding) => `- ${finding}`).join('\n')}\nPropose the smallest patch that fixes every finding while keeping the author's idea: keep each trap, key, switch, and door the author built and prefer relocating or re-gating over removal. Never add or weaken design requirements.)`;
  }

  const hit = await compileCache.get(key);
  if (hit !== null) {
    return {
      result: hit.value,
      baseRevision,
      theme: input.theme,
      cached: true,
      attempts: hit.attempts,
      totalCostUsd: 0,
      generationCostUsd: hit.generationCostUsd,
    };
  }

  const baseMessages: ChatMessage[] = [
    {
      role: 'system',
      content:
        buildSystemPrompt(input.level, revisionId(input.level)) +
        (input.theme !== undefined
          ? `\n(The author pinned the architecture palette to "${input.theme}" in the editor; leave setScenery's architecture unset.)\n`
          : ''),
    },
    {
      role: 'user',
      content: [
        input.history && input.history.length > 0
          ? `(Earlier turns in this session, oldest first — the scene already reflects every applied edit; earlier turns are context only:\n${input.history.map((h) => `- "${h}"`).join('\n')})`
          : null,
        input.prompt,
        input.selection && input.selection.length > 0
          ? `(The author selected these scene entities: ${input.selection.join(', ')}. References like "this door" or "that switch" mean these.)`
          : null,
        input.protectedIds && input.protectedIds.length > 0
          ? `(The creator marked these scene entities Keep these: ${input.protectedIds.join(', ')}. Do not add, remove, move, rename, or change the connections or conditions of any listed entity. If the request cannot be done without changing a kept entity, respond with type "unsupported": name the kept entity in "reason" and offer unkeeping it as one of the "alternatives".)`
          : null,
        input.clarificationContext ? `(Clarification context: ${input.clarificationContext})` : null,
        revisionNote,
      ]
        .filter((part): part is string => part !== null)
        .join('\n\n'),
    },
  ];

  const attempts: AttemptRecord[] = [];
  const started = performance.now();
  let totalCostUsd: number | null = 0;
  let lastProviderError: 'rate_limited' | 'timeout' | 'budget' | 'outage' | 'unknown' | undefined;

  const progress = deps.onProgress;
  const attempt = async (
    model: string,
    messages: ChatMessage[],
  ): Promise<{ parsed: CompileResult | null; rejection?: string[]; cancelled?: boolean }> => {
    const attemptNumber = attempts.length + 1;
    let onDelta: ((delta: StreamDelta) => void) | undefined;
    if (progress !== undefined) {
      let reasoning = '';
      let sentHeadlines = 0;
      let operations = 0;
      const stream = new OperationStream();
      progress({ stage: 'thinking', attempt: attemptNumber });
      onDelta = (delta) => {
        if (delta.reasoning !== undefined) {
          reasoning += delta.reasoning;
          const headlines = reasoningHeadlines(reasoning);
          for (; sentHeadlines < headlines.length; sentHeadlines++) {
            progress({ stage: 'thinking', attempt: attemptNumber, headline: headlines[sentHeadlines]!.slice(0, 120) });
          }
        }
        if (delta.content !== undefined) {
          for (const operation of stream.push(delta.content)) {
            operations += 1;
            progress({ stage: 'writing', attempt: attemptNumber, operations, latest: operationLabel(operation).slice(0, 160) });
          }
        }
      };
    }
    if (signal?.aborted) return { parsed: null, cancelled: true };
    const elapsed = performance.now() - started;
    const remaining = SERVICE_DEADLINE_MS - elapsed;
    if (remaining < MIN_ATTEMPT_BUDGET_MS) return { parsed: null };
    const config: ProviderConfig = {
      ...primary,
      model,
      timeoutMs: Math.min(primary.timeoutMs, Math.max(MIN_ATTEMPT_BUDGET_MS, remaining)),
    };
    const t0 = performance.now();
    let response: ProviderResult;
    try {
      response = await callModel(config, messages, {
        ...callOptionsFor(model),
        schemaName: 'levelproof_result',
      }, signal, onDelta);
    } catch (error) {
      if (signal?.aborted) return { parsed: null, cancelled: true };
      response = { ok: false, kind: 'unknown', error: error instanceof Error ? error.message : String(error) };
    }
    const latencyMs = performance.now() - t0;
    if (!response.ok && response.kind === 'cancelled') return { parsed: null, cancelled: true };
    const costUsd = response.ok ? response.usage.costUsd : response.usage?.costUsd ?? null;
    totalCostUsd = totalCostUsd === null || costUsd === null ? null : totalCostUsd + costUsd;
    let outcome: AttemptRecord['outcome'];
    let parsed: CompileResult | null = null;
    let rejection: string[] | undefined;
    if (!response.ok && response.empty === true) {
      // An empty answer is invalid output: the primary gets its correction retry.
      outcome = 'schema_invalid';
    } else if (!response.ok) {
      if (response.kind === 'cancelled') return { parsed: null, cancelled: true };
      outcome = 'error';
      lastProviderError = response.kind;
    } else {
      progress?.({ stage: 'checking', attempt: attemptNumber });
      parsed = tryParse(response.content);
      if (parsed === null) {
        outcome = 'schema_invalid';
      } else if (parsed.type === 'patch' || parsed.type === 'rule_proposal') {
        // Pre-apply with the same core the client uses: a patch the engine
        // would reject never reaches the user — it gets one correction turn
        // with the engine's exact reasons instead.
        const applied = parsed.type === 'rule_proposal'
          ? applyRuleProposal(input.level, parsed)
          : applyOperations(input.level, parsed.operations);
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
    attempts.push({
      model,
      outcome,
      latencyMs,
      costUsd,
      ...(outcome === 'error' && lastProviderError !== undefined
        ? { errorKind: lastProviderError }
        : {}),
    });
    return { parsed, rejection };
  };

  const finish = async (result: CompileResult): Promise<CompileOutcome> => {
    await compileCache.set(key, {
      value: result,
      attempts,
      generationCostUsd: totalCostUsd,
    });
    return { result, baseRevision, theme: input.theme, cached: false, attempts, totalCostUsd, generationCostUsd: totalCostUsd };
  };

  // Attempt 1: the primary model.
  const outcome1 = await attempt(primary.model, baseMessages);
  if (outcome1.cancelled || signal?.aborted) {
    return { result: null, baseRevision, theme: input.theme, cached: false, attempts, totalCostUsd, generationCostUsd: null, error: 'cancelled' };
  }
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
    progress?.({
      stage: 'retrying',
      attempt: 2,
      reason: first === 'rejected'
        ? `The engine rejected attempt 1: ${outcome1.rejection?.[0] ?? 'invalid edit'}`.slice(0, 300)
        : 'Attempt 1 did not match the response contract; asking for a corrected answer.',
    });
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
    if (outcome2.cancelled || signal?.aborted) {
      return { result: null, baseRevision, theme: input.theme, cached: false, attempts, totalCostUsd, generationCostUsd: null, error: 'cancelled' };
    }
    if (outcome2.parsed) return finish(outcome2.parsed);
  }

  // Attempt 3: the evaluated fallback model, fresh messages.
  if (hasFallback && performance.now() - started < SERVICE_DEADLINE_MS) {
    progress?.({ stage: 'retrying', attempt: attempts.length + 1, reason: `Trying the fallback model ${fallbackModel}.`.slice(0, 300) });
    const outcome3 = await attempt(fallbackModel!, baseMessages);
    if (outcome3.cancelled || signal?.aborted) {
      return { result: null, baseRevision, theme: input.theme, cached: false, attempts, totalCostUsd, generationCostUsd: null, error: 'cancelled' };
    }
    if (outcome3.parsed) return finish(outcome3.parsed);
  }

  return {
    result: null,
    baseRevision,
    theme: input.theme,
    cached: false,
    attempts,
    totalCostUsd,
    generationCostUsd: null,
    error: 'invalid_output',
    ...(lastProviderError !== undefined ? { providerError: lastProviderError } : {}),
  };
}
