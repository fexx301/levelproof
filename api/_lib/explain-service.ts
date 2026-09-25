import { z } from 'zod';
import { normalizeWirePayload } from '../../shared/compile-result.js';
import type { Level } from '../../shared/schema.js';
import { verify, type Report } from '../../src/core/verifier.js';
import { requirementText } from '../../src/core/level.js';
import { cacheKey, explainCache } from './cache.js';
import { sceneSummary } from './prompt.js';
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
 * Explanation service (§10). The engine recomputes the verdict server-side
 * from the submitted level — the client never supplies one — and the model's
 * only job is to phrase the engine's authoritative facts as one causal
 * paragraph for the author. Output is schema-checked AND grounding-checked:
 * any hyphenated id-like token that is not a real scene id invalidates the
 * attempt. The engine's own explanation is always available client-side, so
 * a failed explanation degrades gracefully, never silently misleads.
 */

export type ExplainCheck = 'solution' | 'requirements' | 'recovery';

export interface AttemptRecord {
  model: string;
  outcome: 'schema_valid' | 'schema_invalid' | 'error';
  latencyMs: number;
  costUsd: number | null;
}

export interface ExplainOutcome {
  explanation: string | null;
  cached: boolean;
  attempts: AttemptRecord[];
  totalCostUsd: number | null;
  generationCostUsd: number | null;
  error?: 'missing_provider_config' | 'check_not_failing' | 'invalid_output' | 'cancelled';
}

export interface ExplainInput {
  level: Level;
  check: ExplainCheck;
}

/** Bump when the explanation prompt changes; participates in the cache key. */
export const EXPLAIN_PROMPT_VERSION = 'explain-1';

// Fits Vercel's 60s maxDuration with margin; per-attempt timeouts are
// clamped to the remaining budget.
const SERVICE_DEADLINE_MS = 52_000;
const MIN_ATTEMPT_BUDGET_MS = 4_000;

const explanationSchema = z.strictObject({
  explanation: z.string().min(40).max(600),
});

const CHECK_NAMES: Record<ExplainCheck, string> = {
  solution: 'Solution',
  requirements: 'Design requirements',
  recovery: 'Recovery',
};

/**
 * Grounding check: every hyphenated id-like token in the text must be a real
 * scene id (module, key, switch, or door). Plain English words pass; invented
 * compound ids like "secret-passage" do not.
 */
export function groundingViolation(text: string, level: Level): string | null {
  const known = new Set<string>();
  for (const m of level.modules) {
    known.add(m.id);
    // Labels are scene facts too; the model may hyphenate them in prose
    // ("upper-foyer" for the labeled module "upper foyer").
    if (m.label !== undefined) known.add(m.label.toLowerCase().replace(/\s+/g, '-'));
  }
  for (const k of level.keys) known.add(k.id);
  for (const s of level.switches) known.add(s.id);
  for (const d of level.doors) known.add(d.id);
  const tokens = text.toLowerCase().match(/[a-z][a-z0-9-]*[a-z0-9]/g) ?? [];
  for (const token of tokens) {
    if (token.includes('-') && !known.has(token)) return token;
  }
  return null;
}

function witnessFacts(report: Report, check: ExplainCheck): string {
  const result = report.checks[check];
  const lines: string[] = [
    `- check: ${CHECK_NAMES[check]} — status: ${result.status}`,
    `- engine explanation: "${result.explanation}"`,
    `- active requirements: ${report.requirements.length === 0 ? 'none' : report.requirements.map((r) => requirementText(r).replace(/[“”]/g, '"')).join('; ')}`,
  ];
  const witness = 'witness' in result ? result.witness : undefined;
  if (witness) {
    const path = [witness.route[0]?.source ?? '—', ...witness.route.map((m) => m.destination)];
    lines.push(`- witness route (module ids in order): ${path.join(' -> ')}`);
    const events = witness.route
      .map((m) => {
        const parts = [`moves to ${m.destination}`];
        if (m.events.collectedKey) parts.push(`collects ${m.events.collectedKey}`);
        if (m.events.activatedSwitch) parts.push(`activates ${m.events.activatedSwitch}`);
        if (m.doorId) parts.push(`passes door ${m.doorId}`);
        return `  - ${parts.join(', ')}`;
      })
      .join('\n');
    lines.push(`- witness events:\n${events}`);
    lines.push(`- route ends at: ${witness.endState.moduleId} (goal is ${report.checks.solution.status === 'pass' ? 'reachable elsewhere' : 'the goal module'})`);
    if (witness.missingKeys && witness.missingKeys.length > 0) {
      lines.push(`- missing keys on this route: ${witness.missingKeys.join(', ')}`);
    }
    if (witness.violationText !== undefined) {
      lines.push(`- requirement violated: this winning route reaches the goal ${witness.violationText}`);
    }
  }
  return lines.join('\n');
}

export function buildExplainSystemPrompt(level: Level, check: ExplainCheck, report: Report): string {
  return `You explain verified puzzle-check failures to the puzzle's author in LevelProof, a 3D puzzle editor. A deterministic engine has already explored every reachable state and produced the verdict; the engine's findings are final. Your ONLY job is to phrase the causal story clearly.

SCENE (authoritative):
${sceneSummary(level)}

ENGINE REPORT (authoritative, already recomputed server-side):
${witnessFacts(report, check)}

RULES:
- One paragraph, 2-4 sentences, at most 70 words, addressed to the author.
- Explain causally what happens on the witness route and why that makes the ${CHECK_NAMES[check]} check fail.
- Use ONLY the ids, facts, and events given above. Never invent modules, items, doors, routes, or outcomes.
- Do not add advice, repairs, or your own verdict; you are explaining the engine's finding.

Respond with a single JSON object and nothing else:
{"explanation":"..."}`;
}

export type CallModel = (
  config: ProviderConfig,
  messages: ChatMessage[],
  options: StructuredOptions,
  signal?: AbortSignal,
) => Promise<ProviderResult>;

export async function explain(
  env: NodeJS.ProcessEnv,
  input: ExplainInput,
  deps: { callModel?: CallModel; verifyFn?: (level: Level) => Report; signal?: AbortSignal } = {},
): Promise<ExplainOutcome> {
  const signal = deps.signal;
  // The engine recomputes the verdict server-side; nothing explains a check
  // that is not actually failing.
  const report = (deps.verifyFn ?? verify)(input.level);
  if (report.checks[input.check].status !== 'fail') {
    return { explanation: null, cached: false, attempts: [], totalCostUsd: 0, generationCostUsd: null, error: 'check_not_failing' };
  }

  const callModel = deps.callModel ?? chatCompletion;
  const primary = providerConfigFromEnv(env);
  if (!primary) {
    return { explanation: null, cached: false, attempts: [], totalCostUsd: 0, generationCostUsd: null, error: 'missing_provider_config' };
  }
  const fallbackModel = env.LLM_FALLBACK_MODEL;
  const hasFallback = fallbackModel !== undefined && fallbackModel !== primary.model;
  const models = JSON.stringify({
    baseUrl: primary.baseUrl,
    chain: (hasFallback ? [primary.model, fallbackModel] : [primary.model]).map((model) => ({
      model,
      options: callOptionsFor(model!),
    })),
  });

  const key = cacheKey({
    level: input.level,
    payload: input.check,
    models,
    promptVersion: EXPLAIN_PROMPT_VERSION,
  });
  const hit = explainCache.get(key);
  if (hit !== null) {
    return { explanation: hit.value, cached: true, attempts: hit.attempts, totalCostUsd: 0, generationCostUsd: hit.generationCostUsd };
  }

  const baseMessages: ChatMessage[] = [
    { role: 'system', content: buildExplainSystemPrompt(input.level, input.check, report) },
    { role: 'user', content: `Explain why the ${CHECK_NAMES[input.check]} check fails for this puzzle's author.` },
  ];

  const attempts: AttemptRecord[] = [];
  const started = performance.now();
  let totalCostUsd: number | null = 0;

  const attempt = async (model: string, messages: ChatMessage[]): Promise<{ text: string | null; cancelled?: boolean }> => {
    if (signal?.aborted) return { text: null, cancelled: true };
    const remaining = SERVICE_DEADLINE_MS - (performance.now() - started);
    if (remaining < MIN_ATTEMPT_BUDGET_MS) return { text: null };
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
        schemaName: 'levelproof_explanation',
      }, signal);
    } catch (error) {
      if (signal?.aborted) return { text: null, cancelled: true };
      response = { ok: false, kind: 'unknown', error: error instanceof Error ? error.message : String(error) };
    }
    const latencyMs = performance.now() - t0;
    if (!response.ok && response.kind === 'cancelled') return { text: null, cancelled: true };
    const costUsd = response.ok ? response.usage.costUsd : null;
    totalCostUsd = totalCostUsd === null || costUsd === null ? null : totalCostUsd + costUsd;
    let outcome: AttemptRecord['outcome'];
    let text: string | null = null;
    if (!response.ok) {
      outcome = 'error';
    } else {
      const parsed = explanationSchema.safeParse(safeJson(response.content));
      if (!parsed.success) {
        outcome = 'schema_invalid';
      } else if (groundingViolation(parsed.data.explanation, input.level) !== null) {
        outcome = 'schema_invalid';
      } else {
        outcome = 'schema_valid';
        text = parsed.data.explanation;
      }
    }
    attempts.push({ model, outcome, latencyMs, costUsd });
    return { text };
  };

  const finish = (text: string): ExplainOutcome => {
    explainCache.set(key, {
      value: text,
      attempts,
      generationCostUsd: totalCostUsd,
    });
    return { explanation: text, cached: false, attempts, totalCostUsd, generationCostUsd: totalCostUsd };
  };

  let outcome = await attempt(primary.model, baseMessages);
  if (outcome.cancelled || signal?.aborted) {
    return { explanation: null, cached: false, attempts, totalCostUsd, generationCostUsd: null, error: 'cancelled' };
  }
  if (outcome.text !== null) return finish(outcome.text);

  const firstOutcome = attempts[0]?.outcome;
  if (firstOutcome === 'schema_invalid' && performance.now() - started < SERVICE_DEADLINE_MS) {
    const correction: ChatMessage[] = [
      ...baseMessages,
      {
        role: 'user',
        content:
          'Your previous response was invalid (wrong JSON shape, or it referenced an id that does not exist in the scene). Respond again with a single corrected JSON object using only the given facts.',
      },
    ];
    outcome = await attempt(primary.model, correction);
    if (outcome.cancelled || signal?.aborted) {
      return { explanation: null, cached: false, attempts, totalCostUsd, generationCostUsd: null, error: 'cancelled' };
    }
    if (outcome.text !== null) return finish(outcome.text);
  }

  if (hasFallback && performance.now() - started < SERVICE_DEADLINE_MS) {
    outcome = await attempt(fallbackModel!, baseMessages);
    if (outcome.cancelled || signal?.aborted) {
      return { explanation: null, cached: false, attempts, totalCostUsd, generationCostUsd: null, error: 'cancelled' };
    }
    if (outcome.text !== null) return finish(outcome.text);
  }

  return { explanation: null, cached: false, attempts, totalCostUsd, generationCostUsd: null, error: 'invalid_output' };
}

function safeJson(raw: string): unknown {
  try {
    // The primary model often wraps JSON in a markdown fence; the shared
    // wire normalizer strips fences (and nulls) exactly like the compile path.
    return normalizeWirePayload(raw);
  } catch {
    return null;
  }
}
