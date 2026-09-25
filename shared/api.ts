import { z } from 'zod';
import { compileResultSchema } from './compile-result.js';
import { BOUNDS, idSchema, levelSchema } from './schema.js';

/** Wire contract for POST /api/compile (§10). */

/** Presentation themes are deliberately kept outside Level semantics. */
export const THEME_KEYS = ['limestone', 'ivory', 'patina', 'basalt', 'futuristic'] as const;
export const themeKeySchema = z.enum(THEME_KEYS);
export type ThemeKey = z.infer<typeof themeKeySchema>;

export const compileRequestSchema = z.strictObject({
  level: levelSchema,
  prompt: z.string().min(1).max(2000),
  clarificationContext: z.string().max(2000).optional(),
  /** Entity ids the author selected in the scene (§12): "this"/"that" refer
   * to these. Participates in the cache key via the service. */
  selection: z.array(idSchema).max(8).optional(),
  /** Objects the creator marked "Keep these"; the model must preserve them. */
  protectedIds: z.array(idSchema).max(BOUNDS.maxModules + BOUNDS.maxKeys + BOUNDS.maxSwitches + BOUNDS.maxDoors).optional(),
  /** Recent conversation turns (oldest first), for follow-ups like "raise
   * the bridge" — the scene already reflects earlier applied edits. */
  history: z.array(z.strictObject({ prompt: z.string().min(1).max(2000) })).max(6).optional(),
  /** Presentation theme the author asked for ("make it a stone ruin").
   * Presentation only — never part of level semantics. */
  theme: themeKeySchema.optional(),
});
export type CompileRequest = z.infer<typeof compileRequestSchema>;

export const attemptRecordSchema = z.strictObject({
  model: z.string(),
  outcome: z.enum(['schema_valid', 'schema_invalid', 'rejected', 'error']),
  latencyMs: z.number(),
  /** Null means the provider did not return reliable usage for this attempt. */
  costUsd: z.number().nullable(),
  /** Present only on error attempts: the provider's failure class. */
  errorKind: z.enum(['rate_limited', 'timeout', 'budget', 'outage', 'unknown']).optional(),
});
export type AttemptRecord = z.infer<typeof attemptRecordSchema>;

export const compileOkResponseSchema = z.strictObject({
  result: compileResultSchema,
  /** Server-attached: the revision the result was computed against (§11).
   * Never model-emitted — the model cannot know it. */
  baseRevision: z.string(),
  /** Server-echoed presentation theme (the author's choice, not the model's). */
  theme: themeKeySchema.optional(),
  cached: z.boolean(),
  attempts: z.array(attemptRecordSchema),
  totalCostUsd: z.number().nullable(),
  /** Cost of the original generation, retained when this response is cached. */
  /** Optional for compatibility with deployed servers predating this metadata. */
  generationCostUsd: z.number().nullable().optional(),
});
export type CompileOkResponse = z.infer<typeof compileOkResponseSchema>;

export const compileErrorResponseSchema = z.strictObject({
  error: z.string(),
  issues: z.array(z.string()).optional(),
  providerError: z.enum(['rate_limited', 'timeout', 'budget', 'outage', 'unknown']).optional(),
  attempts: z.array(attemptRecordSchema).optional(),
  totalCostUsd: z.number().nullable().optional(),
  generationCostUsd: z.number().nullable().optional(),
});
export type CompileErrorResponse = z.infer<typeof compileErrorResponseSchema>;

/** Wire contract for POST /api/explain (§10): the engine recomputes the
 * verdict server-side; the model only phrases it. */
export const explainRequestSchema = z.strictObject({
  level: levelSchema,
  check: z.enum(['solution', 'requirements', 'recovery']),
});
export type ExplainRequest = z.infer<typeof explainRequestSchema>;

export const explainOkResponseSchema = z.strictObject({
  explanation: z.string(),
  cached: z.boolean(),
  attempts: z.array(attemptRecordSchema),
  totalCostUsd: z.number().nullable(),
  /** Optional for compatibility with deployed servers predating this metadata. */
  generationCostUsd: z.number().nullable().optional(),
});
export type ExplainOkResponse = z.infer<typeof explainOkResponseSchema>;
