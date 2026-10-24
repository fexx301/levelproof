import { z } from 'zod';
import type { NpcRequest } from '../../shared/api.js';
import { normalizeWirePayload } from '../../shared/compile-result.js';
import { validateLevel } from '../../src/core/level.js';
import { isNpc, npcFacts, type NpcFacts } from '../../src/core/npc.js';
import { compileLevel } from '../../src/core/topology.js';
import { cacheKey, npcCache } from './cache.js';
import { groundingViolation, type AttemptRecord, type CallModel } from './explain-service.js';
import { callOptionsFor } from './model-options.js';
import { chatCompletion, providerConfigFromEnv, type ChatMessage, type ProviderConfig, type ProviderResult } from './provider.js';

/**
 * Character voice service (§12). The engine recomputes the player's next
 * objective server-side from the submitted state — the client never supplies
 * a hint — and the model only says it in character. A line must parse, pass
 * the scene grounding check, and name the objective; otherwise the client
 * keeps the engine's plain line, so a character never misleads.
 */

export interface NpcOutcome {
  line: string | null;
  cached: boolean;
  attempts: AttemptRecord[];
  totalCostUsd: number | null;
  generationCostUsd: number | null;
  error?: 'invalid_request' | 'missing_provider_config' | 'invalid_output' | 'cancelled';
}

/** Bump when the voice prompt changes; participates in the cache key. */
export const NPC_PROMPT_VERSION = 'npc-2';

const SERVICE_DEADLINE_MS = 30_000;
const MIN_ATTEMPT_BUDGET_MS = 4_000;

const lineSchema = z.strictObject({ line: z.string().min(10).max(240) });

const PERSONAS = {
  merchant: 'a friendly trader who talks like a shopkeeper — but sells, trades, and gives nothing',
  guide: 'a brisk, encouraging guide',
  sage: 'a calm, wise elder who speaks a little poetically but always names the place plainly',
  robot: 'a precise, polite robot who speaks in short, clipped sentences',
} as const;

/** The engine facts, or null when the request does not describe a real character and state. */
export function resolveFacts(input: NpcRequest): NpcFacts | null {
  if (validateLevel(input.level).length > 0) return null;
  const npc = (input.level.props ?? []).find((prop) => prop.id === input.npcId);
  if (npc === undefined || !isNpc(npc)) return null;
  const compiled = compileLevel(input.level);
  if (!compiled.moduleById.has(input.state.moduleId)) return null;
  const mask = (bits: Map<string, number>, ids: string[]): number | null => {
    let value = 0;
    for (const id of ids) {
      const bit = bits.get(id);
      if (bit === undefined) return null;
      value |= bit;
    }
    return value;
  };
  const keyMask = mask(compiled.keyBit, input.state.keys);
  const switchMask = mask(compiled.switchBit, input.state.switches);
  if (keyMask === null || switchMask === null || input.state.phase >= Math.max(1, compiled.cycle)) return null;
  const visited = new Set(input.visited.filter((id) => compiled.moduleById.has(id)));
  return npcFacts(compiled, npc, { moduleId: input.state.moduleId, keyMask, switchMask, phase: input.state.phase }, visited);
}

function factLines(facts: NpcFacts): string {
  const lines = [`- the player's final destination: ${facts.goalRoom}`];
  if (facts.situation === 'objective') lines.push(`- what they need next: the ${facts.objective!.name} (a ${facts.objective!.kind}), in ${facts.objective!.room}`);
  if (facts.situation === 'goal') lines.push('- they already hold everything they need: they should head for the final destination');
  if (facts.waitFirst) lines.push('- first they must wait one turn where they are and let a guard pass');
  if (facts.nextRoom !== undefined) lines.push(`- their first step: toward ${facts.nextRoom}`);
  if (facts.situation === 'at_goal') lines.push('- they have arrived: congratulate them');
  if (facts.situation === 'stranded') lines.push('- no way on remains from here: they must start again (the R key)');
  if (facts.situation === 'rule_blocked') lines.push('- the destination can only be reached now by breaking a rule: suggest starting again (the R key) for a clean win');
  if (facts.situation === 'unknown') lines.push('- the way is too tangled to see from here: suggest the Hint button');
  return lines.join('\n');
}

export function buildNpcSystemPrompt(facts: NpcFacts, world: string): string {
  const must = facts.mustName.length > 0 ? `\n- Name ${facts.mustName.map((name) => `"${name}"`).join(' or ')} exactly as written.` : '';
  return `You voice one character in LevelProof, a 3D puzzle game. A deterministic engine has already worked out the player's next step from exactly where they stand; your ONLY job is to say it in character.

CHARACTER: ${facts.npc.name}, ${PERSONAS[facts.npc.kind]}, in ${world}.

ENGINE FACTS (authoritative):
${factLines(facts)}

RULES:
- One or two sentences, at most 35 words, spoken by the character to the player.${must}
- Use ONLY these facts. Never invent places, items, routes, prices, trades, quests, or rewards; you give directions, nothing else.
- No numbers, distances, or counts of moves or steps: the facts give places, not how far they are.
- No compass directions (the player's controls follow the camera) and no quotation marks.

Respond with a single JSON object and nothing else:
{"line":"..."}`;
}

/** Grounded and on topic: real ids only, and the objective named. */
export function npcLineViolation(line: string, facts: NpcFacts, level: NpcRequest['level']): string | null {
  const invented = groundingViolation(line, level);
  if (invented !== null) return `unknown id ${invented}`;
  const lower = line.toLowerCase();
  if (facts.mustName.length > 0 && !facts.mustName.some((name) => lower.includes(name.toLowerCase()))) return 'objective not named';
  return null;
}

function identity(primary: ProviderConfig, env: NodeJS.ProcessEnv, input: NpcRequest): string {
  const fallback = env.LLM_FALLBACK_MODEL;
  const chain = fallback !== undefined && fallback !== primary.model ? [primary.model, fallback] : [primary.model];
  const payload = JSON.stringify({ npc: input.npcId, state: input.state, visited: [...input.visited].sort() });
  return cacheKey({ level: input.level, payload, models: JSON.stringify({ baseUrl: primary.baseUrl, chain }), promptVersion: NPC_PROMPT_VERSION });
}

/** Cache-only lookup: a cached line is served without the daily budget. */
export async function peekNpc(env: NodeJS.ProcessEnv, input: NpcRequest): Promise<NpcOutcome | null> {
  const primary = providerConfigFromEnv(env);
  if (!primary) return null;
  const hit = await npcCache.get(identity(primary, env, input));
  return hit === null ? null : { line: hit.value, cached: true, attempts: hit.attempts, totalCostUsd: 0, generationCostUsd: hit.generationCostUsd };
}

export async function voiceNpc(
  env: NodeJS.ProcessEnv,
  input: NpcRequest,
  deps: { callModel?: CallModel; signal?: AbortSignal } = {},
): Promise<NpcOutcome> {
  const none = (error: NpcOutcome['error'], attempts: AttemptRecord[] = [], totalCostUsd: number | null = 0): NpcOutcome =>
    ({ line: null, cached: false, attempts, totalCostUsd, generationCostUsd: null, error });
  const facts = resolveFacts(input);
  if (facts === null) return none('invalid_request');
  const primary = providerConfigFromEnv(env);
  if (!primary) return none('missing_provider_config');
  const key = identity(primary, env, input);
  const hit = await npcCache.get(key);
  if (hit !== null) return { line: hit.value, cached: true, attempts: hit.attempts, totalCostUsd: 0, generationCostUsd: hit.generationCostUsd };

  const scenery = input.level.scenery;
  const world = scenery?.environment !== undefined ? `a ${scenery.lighting ?? 'day'} ${scenery.environment} world` : 'a puzzle world';
  const messages: ChatMessage[] = [
    { role: 'system', content: buildNpcSystemPrompt(facts, world) },
    { role: 'user', content: 'The player walks up to you. Speak.' },
  ];
  const callModel = deps.callModel ?? chatCompletion;
  const fallback = env.LLM_FALLBACK_MODEL;
  const models = fallback !== undefined && fallback !== primary.model ? [primary.model, fallback] : [primary.model];
  const attempts: AttemptRecord[] = [];
  const started = performance.now();
  let totalCostUsd: number | null = 0;
  for (const model of models) {
    if (deps.signal?.aborted) return none('cancelled', attempts, totalCostUsd);
    const remaining = SERVICE_DEADLINE_MS - (performance.now() - started);
    if (remaining < MIN_ATTEMPT_BUDGET_MS) break;
    // Plain JSON for every model: the strict compile envelope does not apply here.
    const { jsonSchema: _compileSchema, ...options } = callOptionsFor(model);
    void _compileSchema;
    const t0 = performance.now();
    let response: ProviderResult;
    try {
      response = await callModel({ ...primary, model, timeoutMs: Math.min(primary.timeoutMs, remaining) }, messages, { ...options, schemaName: 'levelproof_npc_line' }, deps.signal);
    } catch (error) {
      response = { ok: false, kind: 'unknown', error: error instanceof Error ? error.message : String(error) };
    }
    if (!response.ok && response.kind === 'cancelled') return none('cancelled', attempts, totalCostUsd);
    const costUsd = response.ok ? response.usage.costUsd : null;
    totalCostUsd = totalCostUsd === null || costUsd === null ? null : totalCostUsd + costUsd;
    let line: string | null = null;
    if (response.ok) {
      const parsed = lineSchema.safeParse(safeJson(response.content));
      if (parsed.success && npcLineViolation(parsed.data.line, facts, input.level) === null) line = parsed.data.line;
    }
    attempts.push({ model, outcome: !response.ok ? 'error' : line === null ? 'schema_invalid' : 'schema_valid', latencyMs: performance.now() - t0, costUsd });
    if (line !== null) {
      await npcCache.set(key, { value: line, attempts, generationCostUsd: totalCostUsd });
      return { line, cached: false, attempts, totalCostUsd, generationCostUsd: totalCostUsd };
    }
  }
  return none('invalid_output', attempts, totalCostUsd);
}

function safeJson(raw: string): unknown {
  try {
    return normalizeWirePayload(raw);
  } catch {
    return null;
  }
}
