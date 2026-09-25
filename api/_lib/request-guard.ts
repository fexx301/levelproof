import { createHmac } from 'node:crypto';

const DEFAULT_WINDOW_SECONDS = 60;
const DEFAULT_WINDOW_REQUESTS = 8;
const DEFAULT_DAILY_REQUESTS = 300;
const MAX_BODY_BYTES = 512 * 1024;

const WINDOW_SCRIPT = `
local windowCount = redis.call('INCR', KEYS[1])
if windowCount == 1 then redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1])) end
if windowCount > tonumber(ARGV[2]) then return {0, windowCount, 0} end
local dailyCount = redis.call('INCR', KEYS[2])
if dailyCount == 1 then redis.call('EXPIRE', KEYS[2], tonumber(ARGV[3])) end
if dailyCount > tonumber(ARGV[4]) then return {0, windowCount, dailyCount} end
return {1, windowCount, dailyCount}
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

function localAdmission(
  route: string,
  ip: string,
  now: number,
  windowSeconds: number,
  windowLimit: number,
  dailyLimit: number,
): boolean {
  const window = Math.floor(now / (windowSeconds * 1000));
  const windowKey = `${route}:${ip}:${window}`;
  const bucket = localBuckets.get(windowKey) ?? { window, requests: 0 };
  bucket.requests += 1;
  localBuckets.set(windowKey, bucket);
  if (bucket.requests > windowLimit) return false;

  const day = new Date(now).toISOString().slice(0, 10);
  const dailyKey = day;
  const daily = (localDailyCounts.get(dailyKey) ?? 0) + 1;
  localDailyCounts.set(dailyKey, daily);

  // Bound local-development state; production always uses the shared store.
  if (localBuckets.size > 2000) {
    for (const [key, value] of localBuckets) if (value.window < window - 2) localBuckets.delete(key);
  }
  if (localDailyCounts.size > 100) {
    for (const key of localDailyCounts.keys()) if (key !== day) localDailyCounts.delete(key);
  }
  return daily <= dailyLimit;
}

/**
 * Shared, atomic request budget for the paid AI endpoints. Production must
 * provide Upstash REST credentials; process-local limits are only for local
 * development and tests, where multiple serverless instances do not exist.
 */
export async function enforceRequestBudget(
  request: Request,
  env: NodeJS.ProcessEnv = process.env,
  options: RequestGuardOptions = {},
): Promise<Response | null> {
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

  if (!url || !token) {
    if (env.NODE_ENV === 'production') {
      reportProtectionFailure('missing_upstash_credentials');
      return reject(503, 'request_protection_unavailable');
    }
    return localAdmission(route, ip, now, windowSeconds, windowLimit, dailyLimit)
      ? null
      : reject(429, 'request_limit_reached');
  }

  let redisUrl: URL;
  try {
    redisUrl = new URL(url);
    if (redisUrl.protocol !== 'https:') {
      reportProtectionFailure('invalid_upstash_url');
      return reject(503, 'request_protection_unavailable');
    }
  } catch {
    reportProtectionFailure('invalid_upstash_url');
    return reject(503, 'request_protection_unavailable');
  }

  const day = new Date(now).toISOString().slice(0, 10);
  const epochWindow = Math.floor(now / (windowSeconds * 1000));
  // HMAC the client address with the Redis credential: raw IPs are not stored.
  const clientHash = createHmac('sha256', token).update(ip).digest('hex').slice(0, 32);
  const windowKey = `levelproof:limit:${route}:${clientHash}:${epochWindow}`;
  const dailyKey = `levelproof:daily:${day}`;
  try {
    const response = await (options.fetcher ?? fetch)(redisUrl.toString(), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([
        'EVAL',
        WINDOW_SCRIPT,
        '2',
        windowKey,
        dailyKey,
        String(windowSeconds * 2),
        String(windowLimit),
        '172800',
        String(dailyLimit),
      ]),
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
