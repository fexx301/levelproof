import type { CompileResult } from '../../shared/compile-result.js';
import type { Level } from '../../shared/schema.js';
import { canonicalJson } from '../../src/core/serialize.js';

/**
 * Demo-path caches (§10.2). Full-input identity: canonical level content and
 * active rules, request payload, model configuration, and the prompt version
 * all participate in the key; stored input must match exactly before reuse.
 * In-memory and bounded — instance-local (a cold serverless start begins
 * empty, which simply means a fresh provider call, never a stale verdict).
 */

const MAX_ENTRIES = 100;
const MAX_AGE_MS = 60 * 60 * 1000;

export interface CachedAttempt<TOutcome extends string = 'schema_valid' | 'schema_invalid' | 'rejected' | 'error'> {
  model: string;
  outcome: TOutcome;
  latencyMs: number;
  costUsd: number | null;
  errorKind?: 'rate_limited' | 'timeout' | 'budget' | 'outage' | 'unknown';
}

export type CachedCompileAttempt = CachedAttempt;
export type CachedExplainAttempt = CachedAttempt<'schema_valid' | 'schema_invalid' | 'error'>;

export interface CacheEntry<T, A extends CachedAttempt = CachedAttempt> {
  value: T;
  /** Original generation metadata, not a new model call for the cache hit. */
  attempts: A[];
  generationCostUsd: number | null;
}

export class BoundedCache<T, A extends CachedAttempt = CachedAttempt> {
  private readonly entries = new Map<string, { identity: string; entry: CacheEntry<T, A>; createdAt: number }>();

  get(identity: string): CacheEntry<T, A> | null {
    const stored = this.entries.get(identity);
    if (stored?.identity !== identity) return null;
    if (Date.now() - stored.createdAt > MAX_AGE_MS) {
      this.entries.delete(identity);
      return null;
    }
    return stored.entry;
  }

  set(identity: string, entry: CacheEntry<T, A>): void {
    this.entries.delete(identity);
    if (this.entries.size >= MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(identity, { identity, entry, createdAt: Date.now() });
  }

  clear(): void {
    this.entries.clear();
  }
}

export const compileCache = new BoundedCache<CompileResult, CachedCompileAttempt>();
export const explainCache = new BoundedCache<string, CachedExplainAttempt>();

export interface CacheKeyInput {
  level: Level;
  /** The request payload identity: the prompt (compile) or check kind (explain). */
  payload: string;
  models: string;
  promptVersion: string;
}

export function cacheKey(input: CacheKeyInput): string {
  // Store the complete canonical identity. A short non-cryptographic hash
  // could collide and incorrectly reuse another user's generated change.
  return JSON.stringify([
    canonicalJson(input.level),
    input.payload,
    input.models,
    input.promptVersion,
  ]);
}

/** Kept for the compile path: full-input key including clarification
 * context and the author's scene selection. */
export function compileCacheKey(input: {
  level: Level;
  prompt: string;
  clarificationContext?: string;
  selection?: string[];
  protectedIds?: string[];
  history?: string[];
  models: string;
  promptVersion: string;
}): string {
  return cacheKey({
    level: input.level,
    payload: JSON.stringify([
      input.prompt,
      input.clarificationContext ?? null,
      input.selection ?? [],
      [...(input.protectedIds ?? [])].sort(),
      input.history ?? [],
    ]),
    models: input.models,
    promptVersion: input.promptVersion,
  });
}

/** Tests only: clear the module-local stores. */
export function resetCache(): void {
  compileCache.clear();
  explainCache.clear();
}
