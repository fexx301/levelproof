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
  | { ok: false; kind: ProviderErrorKind; error: string };

export interface StructuredOptions {
  jsonSchema?: Record<string, unknown>;
  schemaName?: string;
  maxTokens?: number;
  temperature?: number;
  /** OpenRouter unified reasoning effort; low keeps interactive latencies. */
  reasoningEffort?: 'low' | 'medium' | 'high';
}

export function providerConfigFromEnv(env: NodeJS.ProcessEnv, model?: string): ProviderConfig | null {
  const baseUrl = env.LLM_BASE_URL;
  const apiKey = env.LLM_API_KEY;
  const chosen = model ?? env.LLM_MODEL;
  if (!baseUrl || !apiKey || !chosen) return null;
  const timeoutMs = Number(env.LLM_TIMEOUT_MS ?? 30000);
  return { baseUrl, apiKey, model: chosen, timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : 30000 };
}

export async function chatCompletion(
  config: ProviderConfig,
  messages: ChatMessage[],
  options: StructuredOptions = {},
  requestSignal?: AbortSignal,
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
    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
    };
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.length === 0) {
      return { ok: false, kind: 'unknown', error: 'Empty completion content.' };
    }
    return {
      ok: true,
      content,
      usage: {
        promptTokens: data.usage?.prompt_tokens ?? 0,
        completionTokens: data.usage?.completion_tokens ?? 0,
        costUsd: typeof data.usage?.cost === 'number' ? data.usage.cost : null,
      },
    };
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
