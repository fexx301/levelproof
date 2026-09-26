import { createHmac } from 'node:crypto';

const DEFAULT_WINDOW_SECONDS = 60;
/** Upper bound on one shared-counter round trip (request + JSON read). */
const COUNTER_TIMEOUT_MS = 3000;
const DEFAULT_WINDOW_REQUESTS = 8;
// The daily cap guards provider spend: only requests that reach the model
// count toward it (cached answers are free and exempt).
const DEFAULT_DAILY_REQUESTS = 500;
const MAX_BODY_BYTES = 512 * 1024;

/** One atomic counter: increment, set expiry on first use, compare to a limit. */
const COUNTER_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1])) end
if count > tonumber(ARGV[2]) then return {0, count} end
return {1, count}
`;

interface LocalBucket {
  window: number;
  requests: number;
}

const localBuckets = new Map<string, LocalBucket>();
const localDailyCounts = new Map<string, number>();

export interface RequestGuardOptions {
  fetcher?: typeof fetch;
  now?: () => number;
  /** Shared-counter timeout (tests shorten it). */
  counterTimeoutMs?: number;
}

function positiveInteger(value: string | undefined, fallback: number, max: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
}

function requestIp(request: Request): string {
  const trustedForwarded = request.headers.get('x-vercel-forwarded-for');
  const forwarded = trustedForwarded ?? request.headers.get('x-forwarded-for');
  const first = forwarded?.split(',')[0]?.trim();
  return first || request.headers.get('x-real-ip')?.trim() || 'unknown';
}

function reject(status: number, error: string): Response {
  return Response.json({ error }, { status, headers: { 'Cache-Control': 'no-store' } });
}

/**
 * Rate-limit failures must fail closed, but operators still need a safe signal
 * to distinguish missing configuration from an upstream Redis rejection. Never
 * include credentials, URLs, IPs, or response bodies here.
 */
function reportProtectionFailure(reason: string): void {
  console.warn(`[levelproof] request protection unavailable: ${reason}`);
}

interface GuardConfig {
  now: number;
  windowSeconds: number;
  windowLimit: number;
  dailyLimit: number;
  route: string;
  ip: string;
  /** Null when running without the shared store (local development only). */
  store: { url: URL; token: string } | null;
}

/** Resolve limits and the shared store; a Response means fail closed. */
function guardConfig(request: Request, env: NodeJS.ProcessEnv, options: RequestGuardOptions): GuardConfig | Response {
  const now = options.now?.() ?? Date.now();
  const windowSeconds = positiveInteger(env.API_RATE_LIMIT_WINDOW_SECONDS, DEFAULT_WINDOW_SECONDS, 3600);
  const windowLimit = positiveInteger(env.API_RATE_LIMIT_REQUESTS, DEFAULT_WINDOW_REQUESTS, 10_000);
  const dailyLimit = positiveInteger(env.API_DAILY_REQUEST_LIMIT, DEFAULT_DAILY_REQUESTS, 1_000_000);
  // Deployment CLIs commonly receive secrets from stdin. Trim only surrounding
  // whitespace so a terminal newline cannot turn the Authorization header into
  // an invalid fetch request; the credential itself is otherwise untouched.
  const url = env.UPSTASH_REDIS_REST_URL?.trim();
  const token = env.UPSTASH_REDIS_REST_TOKEN?.replace(/[\r\n]/g, '').trim();
  const route = new URL(request.url).pathname;
  const ip = requestIp(request);
  const base = { now, windowSeconds, windowLimit, dailyLimit, route, ip };

  if (!url || !token) {
    if (env.NODE_ENV === 'production') {
      reportProtectionFailure('missing_upstash_credentials');
      return reject(503, 'request_protection_unavailable');
    }
    return { ...base, store: null };
  }
  try {
    const redisUrl = new URL(url);
    if (redisUrl.protocol !== 'https:') {
      reportProtectionFailure('invalid_upstash_url');
      return reject(503, 'request_protection_unavailable');
    }
    return { ...base, store: { url: redisUrl, token } };
  } catch {
    reportProtectionFailure('invalid_upstash_url');
    return reject(503, 'request_protection_unavailable');
  }
}

/** Increment one shared counter; null admits, a Response rejects. */
async function sharedCounter(
  request: Request,
  store: { url: URL; token: string },
  key: string,
  ttlSeconds: number,
  limit: number,
  options: RequestGuardOptions,
): Promise<Response | null> {
  // A stalled counter store must not stall admission: give up after a few
  // seconds and fail closed below. Deliberately not tied to the browser
  // request's signal — admission is counted even for a cancelled request.
  const signal = AbortSignal.timeout(options.counterTimeoutMs ?? COUNTER_TIMEOUT_MS);
  try {
    const response = await (options.fetcher ?? fetch)(store.url.toString(), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${store.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(['EVAL', COUNTER_SCRIPT, '1', key, String(ttlSeconds), String(limit)]),
      signal,
    });
    if (!response.ok) {
      reportProtectionFailure(`upstash_http_${response.status}`);
      return reject(503, 'request_protection_unavailable');
    }
    const payload: unknown = await response.json();
    if (
      payload === null ||
      typeof payload !== 'object' ||
      !('result' in payload) ||
      !Array.isArray(payload.result) ||
      payload.result.length < 1
    ) {
      reportProtectionFailure('upstash_invalid_response');
      return reject(503, 'request_protection_unavailable');
    }
    if (Number(payload.result[0]) !== 1) return reject(429, 'request_limit_reached');
    return null;
  } catch (error) {
    if (request.signal.aborted) return reject(499, 'request_cancelled');
    // Fetch deliberately hides network details from callers. Keep logs safe,
    // but retain the error class/code so an operator can distinguish an
    // aborted request from DNS/TLS/connectivity without exposing credentials.
    const code =
      error !== null && typeof error === 'object' && 'cause' in error &&
      error.cause !== null && typeof error.cause === 'object' && 'code' in error.cause &&
      typeof error.cause.code === 'string'
        ? error.cause.code.toLowerCase()
        : error instanceof Error
          ? error.name.toLowerCase()
          : 'unknown';
    reportProtectionFailure(`upstash_network_${code.replace(/[^a-z0-9_]/g, '_')}`);
    return reject(503, 'request_protection_unavailable');
  }
}

/**
 * Per-address burst window, applied to every request (cached or not): the
 * flood guard. Production must provide Upstash REST credentials; process-local
 * limits are only for local development and tests.
 */
export async function enforceRequestWindow(
  request: Request,
  env: NodeJS.ProcessEnv = process.env,
  options: RequestGuardOptions = {},
): Promise<Response | null> {
  const config = guardConfig(request, env, options);
  if (config instanceof Response) return config;
  const epochWindow = Math.floor(config.now / (config.windowSeconds * 1000));
  if (config.store === null) {
    const windowKey = `${config.route}:${config.ip}:${epochWindow}`;
    const bucket = localBuckets.get(windowKey) ?? { window: epochWindow, requests: 0 };
    bucket.requests += 1;
    localBuckets.set(windowKey, bucket);
    // Bound local-development state; production always uses the shared store.
    if (localBuckets.size > 2000) {
      for (const [key, value] of localBuckets) if (value.window < epochWindow - 2) localBuckets.delete(key);
    }
    return bucket.requests > config.windowLimit ? reject(429, 'request_limit_reached') : null;
  }
  // HMAC the client address with the Redis credential: raw IPs are not stored.
  const clientHash = createHmac('sha256', config.store.token).update(config.ip).digest('hex').slice(0, 32);
  const windowKey = `levelproof:limit:${config.route}:${clientHash}:${epochWindow}`;
  return sharedCounter(request, config.store, windowKey, config.windowSeconds * 2, config.windowLimit, options);
}

/**
 * Global daily budget for requests that will call the model. Cached answers
 * never reach this check, so prewarmed examples cannot exhaust it.
 */
export async function enforceDailyBudget(
  request: Request,
  env: NodeJS.ProcessEnv = process.env,
  options: RequestGuardOptions = {},
): Promise<Response | null> {
  const config = guardConfig(request, env, options);
  if (config instanceof Response) return config;
  const day = new Date(config.now).toISOString().slice(0, 10);
  if (config.store === null) {
    const daily = (localDailyCounts.get(day) ?? 0) + 1;
    localDailyCounts.set(day, daily);
    if (localDailyCounts.size > 100) {
      for (const key of localDailyCounts.keys()) if (key !== day) localDailyCounts.delete(key);
    }
    return daily > config.dailyLimit ? reject(429, 'request_limit_reached') : null;
  }
  return sharedCounter(request, config.store, `levelproof:daily:${day}`, 172800, config.dailyLimit, options);
}

/** Both checks in order: the burst window, then the daily model budget. */
export async function enforceRequestBudget(
  request: Request,
  env: NodeJS.ProcessEnv = process.env,
  options: RequestGuardOptions = {},
): Promise<Response | null> {
  return (await enforceRequestWindow(request, env, options)) ?? (await enforceDailyBudget(request, env, options));
}

export type LimitedJson = { ok: true; value: unknown } | { ok: false; status: 400 | 413 };

/** Parse a JSON body without allowing an unbounded request allocation. */
export async function readLimitedJson(request: Request, maxBytes = MAX_BODY_BYTES): Promise<LimitedJson> {
  const contentLength = request.headers.get('content-length');
  if (contentLength !== null && Number(contentLength) > maxBytes) return { ok: false, status: 413 };
  if (request.body === null) return { ok: false, status: 400 };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, status: 413 };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, status: 400 };
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { ok: true, value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown };
  } catch {
    return { ok: false, status: 400 };
  }
}

/** Tests only: reset local-development budgets. */
export function resetRequestBudget(): void {
  localBuckets.clear();
  localDailyCounts.clear();
}
