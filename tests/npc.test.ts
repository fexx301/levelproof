import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from '../api/npc';
import { resetCache } from '../api/_lib/cache';
import type { CallModel } from '../api/_lib/explain-service';
import { buildNpcSystemPrompt, resolveFacts, voiceNpc } from '../api/_lib/npc-service';
import type { ProviderResult } from '../api/_lib/provider';
import { resetRequestBudget } from '../api/_lib/request-guard';
import type { NpcRequest } from '../shared/api';
import type { Level } from '../shared/schema';
import { nextStep } from '../src/core/hint';
import { initialState } from '../src/core/movement';
import { npcFacts, npcNear, plainNpcLine } from '../src/core/npc';
import { compileLevel } from '../src/core/topology';
import { baselineLevel } from '../src/core/fixtures/baseline';
import { trapLevel } from '../src/core/fixtures/trap';

/**
 * Talking characters (§12): scenery that speaks the engine's next step. The
 * facts come from the same hint search as H; the model only voices them, and
 * a line that invents ids or skips the objective is refused.
 */

/** The vault with a merchant at the entrance (cell 1,5). */
const withMerchant: Level = { ...baselineLevel, props: [...(baselineLevel.props ?? []), { id: 'old-merchant', prop: 'merchant', x: 1, z: 5 }] };

const ENV = {
  NODE_ENV: 'test',
  LLM_BASE_URL: 'https://provider.test/v1',
  LLM_API_KEY: 'test-key',
  LLM_MODEL: 'primary-model',
  LLM_FALLBACK_MODEL: 'fallback-model',
  LLM_TIMEOUT_MS: '5000',
  API_RATE_LIMIT_REQUESTS: '100',
  API_DAILY_REQUEST_LIMIT: '100',
};
const saved: Record<string, string | undefined> = {};

const ok = (line: string): ProviderResult => ({ ok: true, content: JSON.stringify({ line }), usage: { promptTokens: 10, completionTokens: 10, costUsd: 0.0005 } });

const request = (overrides: Partial<NpcRequest> = {}): NpcRequest => ({
  level: withMerchant,
  npcId: 'old-merchant',
  state: { moduleId: 'entrance', keys: [], switches: [], phase: 0 },
  visited: ['entrance'],
  ...overrides,
});

beforeEach(() => {
  for (const [key, value] of Object.entries(ENV)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  resetCache();
  resetRequestBudget();
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.unstubAllGlobals();
});

describe('hint routes', () => {
  it('returns the whole shortest winning route, starting with the hinted move', () => {
    const compiled = compileLevel(baselineLevel);
    const hint = nextStep(compiled, initialState(compiled), new Set(['entrance']));
    expect(hint.kind).toBe('move');
    if (hint.kind !== 'move') return;
    expect(hint.route[0]).toBe(hint.move);
    expect(hint.route).toHaveLength(hint.movesToGoal);
    expect(hint.route.at(-1)!.destination).toBe('treasure-landing');
  });
});

describe('characters', () => {
  it('can be talked to from their own room or the one beside it, not from afar', () => {
    expect(npcNear(withMerchant, 'entrance')?.id).toBe('old-merchant');
    expect(npcNear(withMerchant, 'lower-hall')?.id).toBe('old-merchant');
    expect(npcNear(withMerchant, 'gallery')).toBeNull();
    expect(npcNear(baselineLevel, 'entrance')).toBeNull();
  });

  it('name the next key and its room, then the goal once it is held', () => {
    const compiled = compileLevel(withMerchant);
    const merchant = withMerchant.props!.at(-1)!;
    const start = initialState(compiled);
    const facts = npcFacts(compiled, merchant, start, new Set(['entrance']));
    expect(facts.situation).toBe('objective');
    expect(facts.objective).toEqual({ kind: 'key', name: 'brass key', room: 'side balcony' });
    expect(facts.nextRoom).toBe('lower hall');
    expect(facts.mustName).toEqual(['side balcony', 'brass key']);
    expect(plainNpcLine(facts)).toBe("Ah, a customer! You'll need the brass key — it's in side balcony. Start toward lower hall.");

    const holding = { ...start, keyMask: compiled.keyBit.get('brass-key')! };
    const later = npcFacts(compiled, merchant, holding, new Set(['entrance']));
    expect(later.situation).toBe('goal');
    expect(later.mustName).toEqual(['treasure landing']);
  });

  it('call a key by its look', () => {
    const lantern: Level = { ...withMerchant, keys: [{ id: 'brass-key', moduleId: 'key-balcony', look: 'lantern' }] };
    const compiled = compileLevel(lantern);
    const facts = npcFacts(compiled, lantern.props!.at(-1)!, initialState(compiled), new Set(['entrance']));
    expect(facts.objective?.name).toBe('lantern');
  });

  it('say so when no way on remains', () => {
    const trapped: Level = { ...trapLevel, props: [{ id: 'hermit', prop: 'sage', x: 2, z: 1 }] };
    const compiled = compileLevel(trapped);
    const facts = npcFacts(compiled, trapped.props![0]!, trapDeadState(trapped), new Set());
    expect(facts.situation).toBe('stranded');
    expect(plainNpcLine(facts)).toContain('Start again');
  });
});

describe('character voice service', () => {
  it('voices the facts, refuses lines that skip the objective or invent ids, and caches', async () => {
    const calls: string[] = [];
    const replies = [ok('Welcome, friend! The old-vault holds nothing for you.'), ok('Ah, a customer! Fetch the brass key from the side balcony, then come back for the treasure.')];
    const callModel: CallModel = async (config) => {
      calls.push(config.model);
      return replies.shift()!;
    };
    const first = await voiceNpc(process.env, request(), { callModel });
    expect(first.line).toContain('side balcony');
    expect(calls).toEqual(['primary-model', 'fallback-model']);
    expect(first.attempts.map((attempt) => attempt.outcome)).toEqual(['schema_invalid', 'schema_valid']);

    const again = await voiceNpc(process.env, request(), { callModel });
    expect(again.cached).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('gives the model places, never a move count it could pin on the wrong place', () => {
    const facts = resolveFacts(request())!;
    const prompt = buildNpcSystemPrompt(facts, 'a dusk meadow world');
    expect(prompt).toContain('what they need next: the brass key (a key), in side balcony');
    expect(prompt).not.toMatch(/moves left|\b\d+ moves?\b/);
    expect(prompt).toContain('No numbers, distances, or counts of moves or steps');
  });

  it('fails closed, without a model call, for anything but a real character and state', async () => {
    const callModel = vi.fn<CallModel>(async () => ok('unused'));
    expect((await voiceNpc(process.env, request({ npcId: 'gate-torch' }), { callModel })).error).toBe('invalid_request');
    expect((await voiceNpc(process.env, request({ state: { moduleId: 'entrance', keys: ['no-such-key'], switches: [], phase: 0 } }), { callModel })).error).toBe('invalid_request');
    expect((await voiceNpc(process.env, request({ state: { moduleId: 'nowhere', keys: [], switches: [], phase: 0 } }), { callModel })).error).toBe('invalid_request');
    expect(callModel).not.toHaveBeenCalled();
  });

  it('reports invalid output when no model names the objective', async () => {
    const outcome = await voiceNpc(process.env, request(), { callModel: async () => ok('Lovely weather in these parts, is it not?') });
    expect(outcome.line).toBeNull();
    expect(outcome.error).toBe('invalid_output');
  });
});

describe('/api/npc handler', () => {
  const post = (body: unknown) =>
    POST(new Request('https://levelproof.test/api/npc', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '192.0.2.80' }, body: JSON.stringify(body) }));

  it('rejects requests the engine cannot answer before any model call or budget charge', async () => {
    const provider = vi.fn(async () => Response.json({}));
    vi.stubGlobal('fetch', provider);
    expect((await post({ ...request(), npcId: 'gate-torch' })).status).toBe(400);
    expect((await post({ ...request(), state: { moduleId: 'entrance' } })).status).toBe(400);
    expect(provider).not.toHaveBeenCalled();
  });

  it('returns a voiced line', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      Response.json({ choices: [{ message: { content: JSON.stringify({ line: 'Ah, a customer! The brass key waits on the side balcony.' }) } }], usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.0005 } })));
    const response = await post(request());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.line).toContain('side balcony');
    expect(body.cached).toBe(false);
  });
});

/** The trap's dead state: the switch pressed with no key, behind the sealed door. */
function trapDeadState(level: Level) {
  const compiled = compileLevel(level);
  const dead = compiled.level.switches[0]!;
  return { moduleId: dead.moduleId, keyMask: 0, switchMask: compiled.switchBit.get(dead.id)!, phase: 0 };
}
