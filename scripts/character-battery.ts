#!/usr/bin/env node
/**
 * Character battery: opening chapters for prompts that name people (and two
 * that name none), through the real compile service (cache off) with the
 * engine-guided revision loop, then the character voice for every character
 * placed, from the spawn. Grades:
 *   - fair: the engine accepts the chapter;
 *   - cast: a prompt that names a role gets a character for it;
 *   - story: every role the narration names stands in the world, and the
 *     narration has nobody selling, giving, or trading (word check, printed
 *     for review);
 *   - voice: the line passes the server's checks (it names the objective).
 *
 * Usage: npx tsx scripts/character-battery.ts --confirm-live-ai --budget-usd 0.30
 */
import { readFileSync } from 'node:fs';
import { resetCache } from '../api/_lib/cache';
import { compile } from '../api/_lib/compile-service';
import { voiceNpc } from '../api/_lib/npc-service';
import { chapterPlayable, measureChapter, openingAdventureContext } from '../src/core/adventure';
import { blankCanvasLevel } from '../src/core/fixtures/blank-canvas';
import { applyOperations } from '../src/core/level';
import { initialState } from '../src/core/movement';
import { isNpc, type NpcKind } from '../src/core/npc';
import { MAX_AUTO_REVISIONS } from '../src/core/revision-policy';
import { compileLevel } from '../src/core/topology';
import type { Level } from '../shared/schema';
import { LiveBudget, LiveEvaluationStop, requireLiveBudget } from './live-budget';

const CASES: Array<{ prompt: string; roles: NpcKind[] }> = [
  { prompt: 'A medieval quest hub town with a merchant who sells you a sword', roles: ['merchant'] },
  { prompt: "A wizard's tower where an old wizard guides you to the crystal", roles: ['sage'] },
  { prompt: 'A space station with a robot helper and a locked reactor room', roles: ['robot'] },
  { prompt: 'A mountain village where a friendly guide shows you the path to the shrine', roles: ['guide'] },
  { prompt: 'A desert bazaar full of traders, and a vault behind the spice market', roles: ['merchant'] },
  { prompt: 'A classroom in space where students learn about the planets', roles: [] },
  { prompt: 'An abandoned lighthouse on a cliff during a storm', roles: [] },
  { prompt: 'A cozy Japanese tea house garden with a koi pond', roles: [] },
];

/** Words that name a role in a story, by the character that would stand for it. */
const ROLE_WORDS: Record<NpcKind, RegExp> = {
  merchant: /\b(merchant|shopkeeper|trader|vendor|innkeeper|peddler|blacksmith)s?\b/i,
  guide: /\b(guide|villager|ranger|scout|captain)s?\b/i,
  sage: /\b(wizard|sage|elder|hermit|oracle|monk|witch|mage|teacher|professor)s?\b/i,
  robot: /\b(robot|android|droid|automaton)s?\b/i,
};
const TRADE = /\b(sells?|selling|sold|buys?|buying|trades?|trading|gives?|giving|hands? you|offers? you)\b/i;

function loadDotEnv(): void {
  try {
    for (const line of readFileSync('.env', 'utf8').split('\n')) {
      const trimmed = line.trim();
      const eq = trimmed.indexOf('=');
      if (trimmed.length === 0 || trimmed.startsWith('#') || eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      if (process.env[key] === undefined) process.env[key] = trimmed.slice(eq + 1).trim();
    }
  } catch {
    // No .env — rely on the real environment.
  }
}

try {
  const limit = requireLiveBudget(process.argv.slice(2), 'Usage: npx tsx scripts/character-battery.ts --confirm-live-ai --budget-usd 0.30');
  loadDotEnv();
  process.env.LEVELPROOF_SHARED_CACHE = 'off';
  const budget = new LiveBudget(limit);
  console.log(`character battery on ${process.env.LLM_MODEL} (fallback ${process.env.LLM_FALLBACK_MODEL})`);
  const tally = { fair: 0, cast: 0, castOf: 0, story: 0, voiced: 0, voices: 0 };
  const voiceMs: number[] = [];
  for (const { prompt, roles } of CASES) {
    const adventure = openingAdventureContext();
    resetCache();
    const started = performance.now();
    let best: { level: Level; narration: string } | null = null;
    let revision: { operations: NonNullable<Parameters<typeof compile>[1]['revision']>['operations'] } | undefined;
    for (let attempt = 0; attempt <= MAX_AUTO_REVISIONS; attempt++) {
      budget.ensureCanCall(prompt);
      const outcome = await compile(process.env, { level: blankCanvasLevel, prompt, adventure, ...(revision !== undefined ? { revision } : {}) });
      budget.record(outcome.totalCostUsd, prompt);
      if (outcome.result === null || outcome.result.type !== 'patch') break;
      const applied = applyOperations(blankCanvasLevel, outcome.result.operations);
      if (!applied.ok) break;
      best = { level: applied.level, narration: outcome.result.story?.narration ?? '' };
      if (chapterPlayable(measureChapter(applied.level), adventure.band)) break;
      revision = { operations: outcome.result.operations };
    }
    const ms = Math.round(performance.now() - started);
    if (best === null) {
      console.log(`\nFAIL  "${prompt}" — no applicable chapter (${ms} ms)`);
      continue;
    }
    const fair = measureChapter(best.level).accepted;
    const npcs = (best.level.props ?? []).filter(isNpc);
    const kinds = new Set(npcs.map((npc) => npc.prop as NpcKind));
    const named = (Object.keys(ROLE_WORDS) as NpcKind[]).filter((kind) => ROLE_WORDS[kind].test(best!.narration));
    const unplaced = named.filter((kind) => !kinds.has(kind));
    const trade = TRADE.exec(best.narration)?.[0];
    const storyOk = unplaced.length === 0 && trade === undefined;
    if (fair) tally.fair += 1;
    if (roles.length > 0) {
      tally.castOf += 1;
      if (roles.every((role) => kinds.has(role))) tally.cast += 1;
    }
    if (storyOk) tally.story += 1;
    console.log(`\n${fair ? 'FAIR' : 'UNFAIR'}  "${prompt}" ${ms} ms · characters: ${npcs.map((npc) => `${npc.id} (${npc.prop})`).join(', ') || 'none'}`);
    console.log(`  story ${storyOk ? 'ok' : `CHECK${unplaced.length > 0 ? ` names ${unplaced.join('/')} with none placed` : ''}${trade !== undefined ? ` says "${trade}"` : ''}`}: ${best.narration}`);
    if (!fair) continue;
    const compiled = compileLevel(best.level);
    const spawn = initialState(compiled);
    for (const npc of npcs) {
      budget.ensureCanCall(`voice ${npc.id}`);
      const t0 = performance.now();
      const voice = await voiceNpc(process.env, {
        level: best.level,
        npcId: npc.id,
        state: { moduleId: spawn.moduleId, keys: [], switches: [], phase: 0 },
        visited: [spawn.moduleId],
      });
      budget.record(voice.totalCostUsd, `voice ${npc.id}`);
      const took = Math.round(performance.now() - t0);
      tally.voices += 1;
      if (voice.line !== null) {
        tally.voiced += 1;
        voiceMs.push(took);
      }
      console.log(`  voice ${npc.id}: ${voice.line ?? `(refused: ${voice.error}; ${voice.attempts.map((a) => `${a.model.split('/').at(-1)}:${a.outcome}`).join(', ')})`} [${took} ms]`);
    }
  }
  const median = [...voiceMs].sort((a, b) => a - b)[Math.floor(voiceMs.length / 2)] ?? 0;
  console.log(`\nfair ${tally.fair}/${CASES.length} · cast ${tally.cast}/${tally.castOf} · story ok ${tally.story}/${CASES.length} · voiced ${tally.voiced}/${tally.voices} (median ${median} ms)`);
  console.log(`Known provider-reported spend: $${budget.spentUsd.toFixed(5)} / $${limit.toFixed(5)}.`);
} catch (error) {
  if (error instanceof LiveEvaluationStop) console.error(error.message);
  else console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
}
