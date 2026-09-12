import { z } from 'zod';
import { compileResultSchema } from './compile-result.js';
import { idSchema, levelSchema } from './schema.js';

/** Wire contract for POST /api/compile (§10). */

export const compileRequestSchema = z.strictObject({
  level: levelSchema,
  prompt: z.string().min(1).max(2000),
  clarificationContext: z.string().max(2000).optional(),
  /** Entity ids the author selected in the scene (§12): "this"/"that" refer
   * to these. Participates in the cache key via the service. */
  selection: z.array(idSchema).max(8).optional(),
});
export type CompileRequest = z.infer<typeof compileRequestSchema>;

export const attemptRecordSchema = z.strictObject({
  model: z.string(),
  outcome: z.enum(['schema_valid', 'schema_invalid', 'rejected', 'error']),
  latencyMs: z.number(),
  costUsd: z.number(),
  /** Present only on error attempts: the provider's failure class. */
  errorKind: z.enum(['rate_limited', 'timeout', 'budget', 'outage', 'unknown']).optional(),
});
export type AttemptRecord = z.infer<typeof attemptRecordSchema>;

export const compileOkResponseSchema = z.strictObject({
  result: compileResultSchema,
  /** Server-attached: the revision the result was computed against (§11).
   * Never model-emitted — the model cannot know it. */
  baseRevision: z.string(),
  cached: z.boolean(),
  attempts: z.array(attemptRecordSchema),
  totalCostUsd: z.number(),
});
export type CompileOkResponse = z.infer<typeof compileOkResponseSchema>;

export const compileErrorResponseSchema = z.strictObject({
  error: z.string(),
  issues: z.array(z.string()).optional(),
  attempts: z.array(attemptRecordSchema).optional(),
  totalCostUsd: z.number().optional(),
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
  totalCostUsd: z.number(),
});
export type ExplainOkResponse = z.infer<typeof explainOkResponseSchema>;
