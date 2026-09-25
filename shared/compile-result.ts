import { z } from 'zod';
import { BOUNDS, idSchema, operationSchema, requirementSchema } from './schema.js';
import { normalizeSceneryVocabulary } from './scenery-aliases.js';

/**
 * The four compile results (§10): patch, clarification, rule_proposal,
 * unsupported. Model output is validated strictly here; unknown fields and
 * operation kinds are rejected, never accommodated (§2.6). Shared by the
 * server (validation) and the client (rendering).
 */

export const clarificationChoiceSchema = z.strictObject({
  id: idSchema,
  label: z.string().min(1).max(200),
});

export const compileResultSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('patch'),
    rationale: z.string().min(1).max(2000),
    assumptions: z.array(z.string().max(500)).max(8).default([]),
    operations: z.array(operationSchema).max(BOUNDS.maxOpsPerPatch),
  }),
  z.strictObject({
    type: z.literal('clarification'),
    question: z.string().min(1).max(500),
    choices: z.array(clarificationChoiceSchema).min(2).max(6),
  }),
  z.strictObject({
    type: z.literal('rule_proposal'),
    reason: z.string().min(1).max(2000),
    oldRequirements: z.array(requirementSchema).max(BOUNDS.maxRequirements),
    newRequirements: z.array(requirementSchema).max(BOUNDS.maxRequirements),
    operations: z.array(operationSchema).max(BOUNDS.maxOpsPerPatch).default([]),
  }),
  z.strictObject({
    type: z.literal('unsupported'),
    reason: z.string().min(1).max(1000),
    alternatives: z.array(z.string().min(1).max(300)).min(1).max(4),
  }),
]);

export type CompileResult = z.infer<typeof compileResultSchema>;
export type RuleProposalResult = Extract<CompileResult, { type: 'rule_proposal' }>;

/**
 * The strict wire contract forces null placeholders for type-specific
 * fields, and some providers wrap JSON in markdown fences. Neither carries
 * meaning, so strip both recursively before strict validation. Cosmetic
 * scenery words are mapped to the supported vocabulary (never gameplay).
 */
export function normalizeWirePayload(raw: string): unknown {
  return normalizeSceneryVocabulary(stripNulls(JSON.parse(stripCodeFences(raw))));
}

function stripCodeFences(raw: string): string {
  const trimmed = raw.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  return fenced ? fenced[1]! : trimmed;
}

function stripNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNulls);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      const stripped = stripNulls(nested);
      if (stripped === null) continue;
      out[key] = stripped;
    }
    return out;
  }
  return value;
}
