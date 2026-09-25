import { createHash } from 'node:crypto';
import type { CompileResult } from '../../shared/compile-result.js';
import type { Level } from '../../shared/schema.js';
import { canonicalJson } from '../../src/core/serialize.js';

/**
 * Demo-path caches (§10.2). Full-input identity: canonical level content and
 * active rules, request payload, model configuration, and the prompt version
 * all participate in the key; stored input must match exactly before reuse.
 * Two tiers: a bounded in-memory cache per instance, and — when Upstash is
 * configured — a shared store so a cold serverless start still serves an
 * identical request instantly. The shared entry stores the full identity and
 * is only reused on an exact match; any store failure is simply a miss.
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

const DEFAULT_SHARED_TTL_SECONDS = 7 * 24 * 60 * 60;
const SHARED_TIMEOUT_MS = 1500;

interface SharedStore {
  url: string;
  token: string;
  ttlSeconds: number;
}

function sharedStore(env: NodeJS.ProcessEnv): SharedStore | null {
  if (env.LEVELPROOF_SHARED_CACHE === 'off') return null;
  const url = env.UPSTASH_REDIS_REST_URL?.trim();
  const token = env.UPSTASH_REDIS_REST_TOKEN?.replace(/[\r\n]/g, '').trim();
  if (!url || !token || !url.startsWith('https://')) return null;
  const ttl = Number(env.SHARED_CACHE_TTL_SECONDS);
  return { url, token, ttlSeconds: Number.isInteger(ttl) && ttl > 0 ? Math.min(ttl, 30 * 24 * 60 * 60) : DEFAULT_SHARED_TTL_SECONDS };
}

async function redis(store: SharedStore, command: string[]): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SHARED_TIMEOUT_MS);
  try {
    const response = await fetch(store.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${store.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(command),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as { result?: unknown };
    return payload.result ?? null;
  } finally {
    clearTimeout(timer);
  }
}

/** Memory first, then the shared store; never a partial or mismatched entry. */
export class SharedCache<T, A extends CachedAttempt = CachedAttempt> {
  readonly memory = new BoundedCache<T, A>();

  constructor(private readonly namespace: string, private readonly env: NodeJS.ProcessEnv = process.env) {}

  private storageKey(identity: string): string {
    return `levelproof:cache:${this.namespace}:${createHash('sha256').update(identity).digest('hex')}`;
  }

  async get(identity: string): Promise<CacheEntry<T, A> | null> {
    const local = this.memory.get(identity);
    if (local !== null) return local;
    const store = sharedStore(this.env);
    if (store === null) return null;
    try {
      const raw = await redis(store, ['GET', this.storageKey(identity)]);
      if (typeof raw !== 'string') return null;
      const stored = JSON.parse(raw) as { identity?: unknown; entry?: CacheEntry<T, A> };
      // The hash only locates the entry; the full identity must match exactly.
      if (stored.identity !== identity || stored.entry === undefined) return null;
      this.memory.set(identity, stored.entry);
      return stored.entry;
    } catch {
      return null;
    }
  }

  async set(identity: string, entry: CacheEntry<T, A>): Promise<void> {
    this.memory.set(identity, entry);
    const store = sharedStore(this.env);
    if (store === null) return;
    try {
      await redis(store, ['SET', this.storageKey(identity), JSON.stringify({ identity, entry }), 'EX', String(store.ttlSeconds)]);
    } catch {
      // A failed shared write only costs a future cache miss.
    }
  }

  clear(): void {
    this.memory.clear();
  }
}

export const compileCache = new SharedCache<CompileResult, CachedCompileAttempt>('compile');
export const explainCache = new SharedCache<string, CachedExplainAttempt>('explain');

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
  revision?: string;
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
      // Absent for ordinary compiles, so their keys are unchanged.
      ...(input.revision !== undefined ? [input.revision] : []),
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
