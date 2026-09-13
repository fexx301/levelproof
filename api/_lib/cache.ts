import type { CompileResult } from '../../shared/compile-result.js';
import type { Level } from '../../shared/schema.js';
import { canonicalJson, fnv1a32 } from '../../src/core/serialize.js';

/**
 * Demo-path caches (§10.2). Full-input identity: canonical level content and
 * active rules, request payload, model configuration, and the prompt version
 * all participate in the key; stored input must match exactly before reuse.
 * In-memory and bounded — instance-local (a cold serverless start begins
 * empty, which simply means a fresh provider call, never a stale verdict).
 */

const MAX_ENTRIES = 100;

class BoundedCache<T> {
  private readonly entries = new Map<string, { result: T; createdAt: number }>();

  get(key: string): T | null {
    return this.entries.get(key)?.result ?? null;
  }

  set(key: string, result: T): void {
    if (this.entries.size >= MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { result, createdAt: Date.now() });
  }

  clear(): void {
    this.entries.clear();
  }
}

export const compileCache = new BoundedCache<CompileResult>();
export const explainCache = new BoundedCache<string>();

export interface CacheKeyInput {
  level: Level;
  /** The request payload identity: the prompt (compile) or check kind (explain). */
  payload: string;
  models: string;
  promptVersion: string;
}

export function cacheKey(input: CacheKeyInput): string {
  return fnv1a32(
    canonicalJson(input.level) +
      '\u0000' +
      input.payload +
      '\u0000' +
      input.models +
      '\u0000' +
      input.promptVersion,
  );
}

/** Kept for the compile path: full-input key including clarification
 * context and the author's scene selection. */
export function compileCacheKey(input: {
  level: Level;
  prompt: string;
  clarificationContext?: string;
  selection?: string[];
  history?: string[];
  models: string;
  promptVersion: string;
}): string {
  return cacheKey({
    level: input.level,
    payload:
      input.prompt +
      '\u0001' +
      (input.clarificationContext ?? '') +
      '\u0001' +
      (input.selection?.join(',') ?? '') +
      '\u0001' +
      (input.history?.join('\u0002') ?? ''),
    models: input.models,
    promptVersion: input.promptVersion,
  });
}

/** Tests only: clear the module-local stores. */
export function resetCache(): void {
  compileCache.clear();
  explainCache.clear();
}
