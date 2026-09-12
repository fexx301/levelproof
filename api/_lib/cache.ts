import type { CompileResult } from '../../shared/compile-result.js';
import type { Level } from '../../shared/schema.js';
import { canonicalJson, fnv1a32 } from '../../src/core/serialize.js';

/**
 * Demo-path compilation cache (§10.2). Full-input identity: canonical level
 * content and active rules, prompt, clarification context, model
 * configuration, and the system-prompt version all participate in the key;
 * stored input must match exactly before reuse. In-memory and bounded —
 * instance-local (a cold serverless start begins empty, which simply means
 * a fresh provider call, never a stale verdict).
 */

const MAX_ENTRIES = 100;

const entries = new Map<string, { result: CompileResult; createdAt: number }>();

export interface CacheKeyInput {
  level: Level;
  prompt: string;
  clarificationContext?: string;
  models: string;
  promptVersion: string;
}

export function cacheKey(input: CacheKeyInput): string {
  return fnv1a32(
    canonicalJson(input.level) +
      '\u0000' +
      input.prompt +
      '\u0000' +
      (input.clarificationContext ?? '') +
      '\u0000' +
      input.models +
      '\u0000' +
      input.promptVersion,
  );
}

export function cacheGet(key: string): CompileResult | null {
  return entries.get(key)?.result ?? null;
}

export function cacheSet(key: string, result: CompileResult): void {
  if (entries.size >= MAX_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (oldest !== undefined) entries.delete(oldest);
  }
  entries.set(key, { result, createdAt: Date.now() });
}

/** Tests only: clear the module-local store. */
export function resetCache(): void {
  entries.clear();
}
