#!/usr/bin/env node
/**
 * Adventure battery: chains chapters exactly as play will — each chapter is
 * built on the blank canvas with the story so far, the band chosen from
 * simulated player stats, and the player's words — through the real compile
 * service (cache off), revising up to MAX_AUTO_REVISIONS times while the
 * engine says the chapter is not playable (unfair or outside the band).
 *
 * Reports per chapter: playable on the first try / after revisions, rounds,
 * shortest route vs band, locked doors on the route, story present,
 * environment, latency, and cost. Summary: playable rates, p50/p95 latency,
 * cost per chapter.
 *
 * Usage: npx tsx scripts/adventure-battery.ts --confirm-live-ai --budget-usd 0.25 [--chains 2] [--chapters 5]
 */
import { readFileSync } from 'node:fs';
import { resetCache } from '../api/_lib/cache';
import { compile } from '../api/_lib/compile-service';
import type { AdventureContext } from '../shared/api';
import { chapterPlayable, measureChapter, nextDifficultyBand, type AdventureIntent, type ChapterStats } from '../src/core/adventure';
import { blankCanvasLevel } from '../src/core/fixtures/blank-canvas';
import { applyOperations } from '../src/core/level';
import { MAX_AUTO_REVISIONS } from '../src/core/revision-policy';
import type { Level } from '../shared/schema';
import { LiveBudget, LiveEvaluationStop, requireLiveBudget } from './live-budget';

interface Step {
  words: string;
  intent: AdventureIntent;
  /** How the simulated player did on the previous chapter. */
  played: 'clean' | 'ok' | 'struggled';
}

const OPENINGS = ['A haunted forest keep with a dragon guarding the treasure', 'A sunken pirate cove'];
const STEPS: Step[] = [
  { words: 'Surprise me', intent: 'steady', played: 'clean' },
  { words: 'Take me underground', intent: 'steady', played: 'ok' },
  { words: 'Harder, with more traps', intent: 'harder', played: 'clean' },
  { words: 'Somewhere icy', intent: 'steady', played: 'struggled' },
  { words: 'Easier please', intent: 'easier', played: 'struggled' },
];

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

function simulatedStats(shortest: number, played: Step['played']): ChapterStats {
  if (played === 'clean') return { moves: shortest, hints: 0, deadEnds: 0, restarts: 0, shortest };
  if (played === 'ok') return { moves: shortest + 4, hints: 1, deadEnds: 0, restarts: 1, shortest };
  return { moves: shortest + 12, hints: 4, deadEnds: 2, restarts: 3, shortest };
}

const percentile = (values: number[], p: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
};

try {
  const args = process.argv.slice(2);
  const limit = requireLiveBudget(args, 'Usage: npx tsx scripts/adventure-battery.ts --confirm-live-ai --budget-usd 0.25 [--chains 2] [--chapters 5]');
  const flag = (name: string, fallback: number): number => {
    const index = args.indexOf(name);
    return index >= 0 ? Number(args[index + 1]) : fallback;
  };
  const chains = Math.min(flag('--chains', 2), OPENINGS.length);
  const chapters = Math.min(flag('--chapters', 5), STEPS.length + 1);
  loadDotEnv();
  process.env.LEVELPROOF_SHARED_CACHE = 'off';
  const budget = new LiveBudget(limit);
  console.log(`adventure battery on ${process.env.LLM_MODEL} (fallback ${process.env.LLM_FALLBACK_MODEL}) · ${chains} chain(s) × ${chapters} chapters`);

  const latencies: number[] = [];
  const costs: number[] = [];
  let firstTry = 0;
  let playable = 0;
  let total = 0;

  for (let chain = 0; chain < chains; chain++) {
    const story: AdventureContext['story'] = [];
    let lastStats: ChapterStats | null = null;
    console.log(`\n=== chain ${chain + 1}: "${OPENINGS[chain]}"`);
    for (let chapter = 1; chapter <= chapters; chapter++) {
      const step = chapter === 1 ? null : STEPS[chapter - 2]!;
      const intent = step?.intent ?? 'steady';
      const band = nextDifficultyBand(lastStats, intent);
      const adventure: AdventureContext = {
        chapter,
        story: story.slice(-6),
        band,
        intent,
        ...(lastStats !== null ? { lastStats } : {}),
      };
      const prompt = chapter === 1 ? OPENINGS[chain]! : step!.words;
      const started = performance.now();
      resetCache();
      let spent = 0;
      let rounds = 0;
      let best: { level: Level; story?: { title: string; narration: string } } | null = null;
      let latest: Parameters<typeof compile>[1]['revision'] | undefined;
      let firstPlayable = false;
      for (let attempt = 0; attempt <= MAX_AUTO_REVISIONS; attempt++) {
        budget.ensureCanCall(`chapter ${chapter}`);
        const outcome = await compile(process.env, { level: blankCanvasLevel, prompt, adventure, ...(latest !== undefined ? { revision: latest } : {}) });
        budget.record(outcome.totalCostUsd, `chapter ${chapter}`);
        spent += outcome.totalCostUsd ?? 0;
        if (outcome.result === null || outcome.result.type !== 'patch') break;
        const applied = applyOperations(blankCanvasLevel, outcome.result.operations);
        if (!applied.ok) break;
        const measure = measureChapter(applied.level);
        const ok = chapterPlayable(measure, band);
        if (attempt === 0) firstPlayable = ok;
        const candidate = { level: applied.level, ...(outcome.result.story !== undefined ? { story: outcome.result.story } : {}) };
        if (best === null || ok) best = candidate;
        if (ok) break;
        rounds += 1;
        latest = { operations: outcome.result.operations };
      }
      const ms = Math.round(performance.now() - started);
      total += 1;
      latencies.push(ms);
      costs.push(spent);
      if (best === null) {
        console.log(`FAIL  ch${chapter} ${String(ms).padStart(6)} ms | no applicable chapter`);
        break;
      }
      const measure = measureChapter(best.level);
      const ok = chapterPlayable(measure, band);
      if (ok) playable += 1;
      if (firstPlayable) firstTry += 1;
      console.log(
        `${ok ? 'PASS' : 'FAIL'}  ch${chapter} ${String(ms).padStart(6)} ms | "${prompt.slice(0, 26)}" band ${band.minMoves}-${band.maxMoves} → shortest ${measure.shortest ?? '-'} gates ${measure.gatesOnRoute} accepted=${measure.accepted} rounds=${rounds} env=${best.level.scenery?.environment ?? '-'}/${best.level.scenery?.lighting ?? '-'} $${spent.toFixed(4)}\n        ${best.story ? `“${best.story.title}” — ${best.story.narration}` : '(no story)'}`,
      );
      if (!ok) break;
      story.push(best.story ?? { title: `Chapter ${chapter}`, narration: 'The adventure continues.' });
      lastStats = simulatedStats(measure.shortest ?? band.minMoves, STEPS[chapter - 1]?.played ?? 'ok');
    }
  }
  console.log(
    `\nplayable ${playable}/${total} · first try ${firstTry}/${total} · latency p50 ${percentile(latencies, 0.5)} ms p95 ${percentile(latencies, 0.95)} ms · cost/chapter p50 $${percentile(costs, 0.5).toFixed(4)}`,
  );
  console.log(`Known provider-reported spend: $${budget.spentUsd.toFixed(5)} / $${limit.toFixed(5)}.`);
} catch (error) {
  if (error instanceof LiveEvaluationStop) console.error(error.message);
  else console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 2;
}
