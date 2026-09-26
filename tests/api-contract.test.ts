import { describe, expect, it } from 'vitest';
import { compileOkResponseSchema, explainOkResponseSchema } from '../shared/api';

describe('API response metadata compatibility', () => {
  it('accepts a valid compile result from a server without generation-cost metadata', () => {
    const response = compileOkResponseSchema.safeParse({
      result: { type: 'patch', rationale: 'No geometry change.', assumptions: [], operations: [] },
      baseRevision: 'revision-1',
      cached: false,
      attempts: [{ model: 'legacy-server', outcome: 'schema_valid', latencyMs: 10, costUsd: 0.01 }],
      totalCostUsd: 0.01,
    });

    expect(response.success).toBe(true);
    if (response.success) expect(response.data.generationCostUsd).toBeUndefined();
  });

  it('accepts an explanation from a server without generation-cost metadata', () => {
    const response = explainOkResponseSchema.safeParse({
      explanation: 'The player becomes stranded.',
      cached: false,
      attempts: [{ model: 'legacy-server', outcome: 'schema_valid', latencyMs: 10, costUsd: 0.01 }],
      totalCostUsd: 0.01,
    });

    expect(response.success).toBe(true);
    if (response.success) expect(response.data.generationCostUsd).toBeUndefined();
  });

  it('does not relax strict result validation while allowing the legacy metadata omission', () => {
    const response = compileOkResponseSchema.safeParse({
      result: { type: 'patch', rationale: 'Bad operation is never accepted.', assumptions: [], operations: [{ kind: 'unknown' }] },
      baseRevision: 'revision-1',
      cached: false,
      attempts: [],
      totalCostUsd: 0,
    });

    expect(response.success).toBe(false);
  });
});

describe('provider URL safety', () => {
  it('only sends the API key over HTTPS (or to this machine)', async () => {
    const { secureProviderUrl } = await import('../api/_lib/provider');
    expect(secureProviderUrl('https://openrouter.ai/api/v1')).toBe(true);
    expect(secureProviderUrl('http://localhost:8080/v1')).toBe(true);
    expect(secureProviderUrl('http://openrouter.ai/api/v1')).toBe(false);
    expect(secureProviderUrl('not a url')).toBe(false);
  });
});
