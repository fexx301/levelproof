import type { StructuredOptions } from './provider.js';
import { compileResultJsonSchema } from './wire-schema.js';

/**
 * Per-model request configuration, from the recorded evaluation
 * (docs/model-eval.md, 2026-09-11). Gemini models reject strict structured
 * output for our vocabulary and run fence-stripped plain JSON with strict
 * Zod validation; the others use the per-type anyOf strict envelope.
 */

export interface ModelCallOptions {
  useSchema: boolean;
  reasoningEffort?: 'low' | 'medium' | 'high';
  maxTokens?: number;
}

export const MODEL_OPTIONS: Record<string, ModelCallOptions> = {
  'openai/gpt-oss-120b': { useSchema: true, reasoningEffort: 'low' },
  'deepseek/deepseek-v4-flash': { useSchema: true, reasoningEffort: 'low', maxTokens: 4000 },
  'deepseek/deepseek-v3.2': { useSchema: true, reasoningEffort: 'low', maxTokens: 4000 },
  'qwen/qwen-plus': { useSchema: true, reasoningEffort: 'low', maxTokens: 4000 },
  'google/gemini-2.5-flash-lite': { useSchema: false },
  'google/gemini-3.7-flash': { useSchema: false },
};

export function callOptionsFor(model: string): StructuredOptions {
  const options = MODEL_OPTIONS[model] ?? { useSchema: true };
  return {
    ...(options.useSchema
      ? { jsonSchema: compileResultJsonSchema as unknown as Record<string, unknown> }
      : {}),
    ...(options.reasoningEffort !== undefined ? { reasoningEffort: options.reasoningEffort } : {}),
    ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
  };
}
