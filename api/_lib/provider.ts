/**
 * OpenRouter provider adapter (§3, §10). Server-side and script-side only:
 * keys stay here, never in src/core or the client. Error kinds map to the
 * four UI-facing failure classes (rate limiting, outage, invalid output,
 * budget exhaustion).
 */

export type ProviderErrorKind = 'rate_limited' | 'timeout' | 'budget' | 'outage' | 'unknown' | 'cancelled';

export interface ProviderConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ProviderUsage {
  promptTokens: number;
  completionTokens: number;
  costUsd: number | null;
}

export type ProviderResult =
  | { ok: true; content: string; usage: ProviderUsage }
  | { ok: false; kind: ProviderErrorKind; error: string; usage?: ProviderUsage; empty?: boolean };

export interface StructuredOptions {
  jsonSchema?: Record<string, unknown>;
  schemaName?: string;
  maxTokens?: number;
  temperature?: number;
  /** OpenRouter unified reasoning effort; low keeps interactive latencies. */
  reasoningEffort?: 'low' | 'medium' | 'high';
}

export function secureProviderUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}

export function providerConfigFromEnv(env: NodeJS.ProcessEnv, model?: string): ProviderConfig | null {
  const baseUrl = env.LLM_BASE_URL;
  const apiKey = env.LLM_API_KEY;
  const chosen = model ?? env.LLM_MODEL;
  if (!baseUrl || !apiKey || !chosen) return null;
  // The API key travels with every request: only send it over HTTPS (plain
  // http is allowed for a provider on this machine, e.g. a local proxy).
  if (!secureProviderUrl(baseUrl)) {
    console.warn('[levelproof] LLM_BASE_URL must be https:// (or http://localhost); the provider is disabled.');
    return null;
  }
  const timeoutMs = Number(env.LLM_TIMEOUT_MS ?? 30000);
  return { baseUrl, apiKey, model: chosen, timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : 30000 };
}

/** Incremental output while a streamed completion is generated. */
export interface StreamDelta {
  reasoning?: string;
  content?: string;
}

interface CompletionChunk {
  choices?: Array<{ delta?: { content?: string; reasoning?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
  error?: { message?: string; code?: number | string };
}

/** Read an OpenAI-style SSE stream, forwarding deltas and returning the whole. */
async function readStream(
  response: Response,
  onDelta: (delta: StreamDelta) => void,
): Promise<ProviderResult> {
  if (response.body === null) return { ok: false, kind: 'unknown', error: 'Empty stream.' };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let usage: CompletionChunk['usage'];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line.startsWith('data:')) continue; // keep-alive comments
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      let chunk: CompletionChunk;
      try {
        chunk = JSON.parse(payload) as CompletionChunk;
      } catch {
        continue;
      }
      if (chunk.error !== undefined) {
        const message = chunk.error.message ?? 'stream error';
        return { ok: false, kind: String(chunk.error.code) === '429' ? 'rate_limited' : 'outage', error: message.slice(0, 300) };
      }
      const delta = chunk.choices?.[0]?.delta;
      if (delta?.reasoning) onDelta({ reasoning: delta.reasoning });
      if (delta?.content) {
        content += delta.content;
        onDelta({ content: delta.content });
      }
      if (chunk.usage !== undefined) usage = chunk.usage;
    }
  }
  const accounted: ProviderUsage = {
    promptTokens: usage?.prompt_tokens ?? 0,
    completionTokens: usage?.completion_tokens ?? 0,
    costUsd: typeof usage?.cost === 'number' ? usage.cost : null,
  };
  if (content.length === 0) return { ok: false, kind: 'unknown', error: 'Empty completion content.', usage: accounted, empty: true };
  return { ok: true, content, usage: accounted };
}

export async function chatCompletion(
  config: ProviderConfig,
  messages: ChatMessage[],
  options: StructuredOptions = {},
  requestSignal?: AbortSignal,
  onDelta?: (delta: StreamDelta) => void,
): Promise<ProviderResult> {
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), config.timeoutMs);
  const signal = requestSignal === undefined
    ? timeoutController.signal
    : AbortSignal.any([requestSignal, timeoutController.signal]);
  try {
    const body: Record<string, unknown> = {
      model: config.model,
      messages,
      max_tokens: options.maxTokens ?? 2000,
      temperature: options.temperature ?? 0,
    };
    if (options.jsonSchema) {
      body.response_format = {
        type: 'json_schema',
        json_schema: {
          name: options.schemaName ?? 'levelproof_result',
          strict: true,
          schema: options.jsonSchema,
        },
      };
    }
    if (options.reasoningEffort !== undefined) {
      body.reasoning = { effort: options.reasoningEffort };
    }
    // Always request usage accounting: cost disclosure and the evaluation
    // budgets depend on it, and some responses omit it otherwise.
    body.usage = { include: true };
    if (onDelta !== undefined) {
      // Streaming lets the editor show the model's plan and each operation as
      // it is written; usage accounting arrives in the final chunk.
      body.stream = true;
    }
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
        'X-Title': 'LevelProof',
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      const brief = text.slice(0, 300);
      if (response.status === 429) return { ok: false, kind: 'rate_limited', error: `429: ${brief}` };
      if (response.status === 402) return { ok: false, kind: 'budget', error: `402: ${brief}` };
      if (response.status >= 500) return { ok: false, kind: 'outage', error: `${response.status}: ${brief}` };
      return { ok: false, kind: 'unknown', error: `${response.status}: ${brief}` };
    }
    if (onDelta !== undefined) return await readStream(response, onDelta);
    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
    };
    const content = data.choices?.[0]?.message?.content;
    const usage: ProviderUsage = {
      promptTokens: data.usage?.prompt_tokens ?? 0,
      completionTokens: data.usage?.completion_tokens ?? 0,
      costUsd: typeof data.usage?.cost === 'number' ? data.usage.cost : null,
    };
    if (typeof content !== 'string' || content.length === 0) {
      // A reasoning model can spend its turn thinking and return no answer;
      // that is invalid output (retry the primary), not a provider outage.
      return { ok: false, kind: 'unknown', error: 'Empty completion content.', usage, empty: true };
    }
    return { ok: true, content, usage };
  } catch (error) {
    if (requestSignal?.aborted) {
      return { ok: false, kind: 'cancelled', error: 'The request was cancelled by the client.' };
    }
    if (error instanceof Error && error.name === 'AbortError') {
      return { ok: false, kind: 'timeout', error: `Timed out after ${config.timeoutMs} ms.` };
    }
    return { ok: false, kind: 'outage', error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}
