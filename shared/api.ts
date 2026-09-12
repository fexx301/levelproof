import { z } from 'zod';
import { compileResultSchema } from './compile-result.js';
import { levelSchema } from './schema.js';

/** Wire contract for POST /api/compile (§10). */

export const compileRequestSchema = z.strictObject({
  level: levelSchema,
  prompt: z.string().min(1).max(2000),
  clarificationContext: z.string().max(2000).optional(),
});
export type CompileRequest = z.infer<typeof compileRequestSchema>;

export const attemptRecordSchema = z.strictObject({
  model: z.string(),
  outcome: z.enum(['schema_valid', 'schema_invalid', 'error']),
  latencyMs: z.number(),
  costUsd: z.number(),
});
export type AttemptRecord = z.infer<typeof attemptRecordSchema>;

export const compileOkResponseSchema = z.strictObject({
  result: compileResultSchema,
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
