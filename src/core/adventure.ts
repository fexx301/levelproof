import type { AdventureContext } from '../../shared/api.js';
import type { Level } from '../../shared/schema.js';
import { engineFindings } from './engine-findings.js';
import { verify, type Report } from './verifier.js';

/**
 * Endless verified adventure (§12): after each win the model writes the next
 * chapter as a fresh level, and the engine — not the model — decides whether
 * it may be played. A chapter is playable only when it is fully accepted
 * (winnable, nobody can get stuck, every rule holds) AND its difficulty,
 * measured by the engine as the shortest winning route, lies in the band
 * chosen from how the player did. Everything here is deterministic; the
 * server uses it to write revision findings and the client to decide.
 */

/** How the player did on the chapter they just finished. */
export interface ChapterStats {
  /** Moves in the winning run. */
  moves: number;
  /** Hints used across every attempt at the chapter. */
  hints: number;
  /** Times the player walked into a dead end (or got trapped). */
  deadEnds: number;
  restarts: number;
  /** The engine's shortest winning route for that chapter. */
  shortest: number;
}

/** Target shortest-route length (moves) for the next chapter, inclusive. */
export interface DifficultyBand {
  minMoves: number;
  maxMoves: number;
}

export type AdventureIntent = 'harder' | 'easier' | 'steady';

export const BAND_LIMITS = { floor: 4, ceiling: 24 } as const;
/** The opening chapter: a gentle start. */
export const FIRST_CHAPTER_BAND: DifficultyBand = { minMoves: 5, maxMoves: 10 };

function clampBand(min: number, max: number): DifficultyBand {
  const minMoves = Math.max(BAND_LIMITS.floor, Math.min(BAND_LIMITS.ceiling - 2, Math.round(min)));
  const maxMoves = Math.max(minMoves + 2, Math.min(BAND_LIMITS.ceiling, Math.round(max)));
  return { minMoves, maxMoves };
}

/**
 * The next chapter's band from the last one. A clean win (no hints, no dead
 * ends, no restarts) steps up; a struggle steps down; the player's own words
 * ("harder", "easier") override the direction.
 */
export function nextDifficultyBand(previous: ChapterStats | null, intent: AdventureIntent = 'steady'): DifficultyBand {
  if (previous === null) return FIRST_CHAPTER_BAND;
  const base = Math.max(BAND_LIMITS.floor, previous.shortest);
  const clean = previous.hints === 0 && previous.deadEnds === 0 && previous.restarts === 0;
  const struggled = previous.hints >= 3 || previous.deadEnds >= 2 || previous.restarts >= 3;
  let direction: -1 | 0 | 1 = clean ? 1 : struggled ? -1 : 0;
  if (intent === 'harder') direction = 1;
  if (intent === 'easier') direction = -1;
  if (direction === 1) return clampBand(base + 2, base + 6);
  if (direction === -1) return clampBand(base - 4, base);
  return clampBand(base - 1, base + 3);
}

export interface ChapterMeasure {
  report: Report;
  accepted: boolean;
  /** Shortest winning route in moves (null when the goal is unreachable). */
  shortest: number | null;
  /** Doors with a key or switch condition that the shortest route crosses. */
  gatesOnRoute: number;
  exploredStates: number;
}

/** What the engine says about a candidate chapter. */
export function measureChapter(level: Level): ChapterMeasure {
  const report = verify(level);
  const route = report.checks.solution.status === 'pass' ? report.checks.solution.witness?.route ?? null : null;
  const gated = new Set(
    level.doors
      .filter((door) => {
        const c = door.conditions ?? {};
        return c.requiresKey !== undefined || (c.requiresKeys?.length ?? 0) > 0 || c.requiresSwitch !== undefined;
      })
      .map((door) => door.id),
  );
  return {
    report,
    accepted: report.accepted,
    shortest: route === null ? null : route.length,
    gatesOnRoute: route === null ? 0 : route.filter((move) => move.doorId !== undefined && gated.has(move.doorId)).length,
    exploredStates: report.exploredCount,
  };
}

/** True when the chapter may be played: accepted and inside the band. */
export function chapterPlayable(measure: ChapterMeasure, band: DifficultyBand): boolean {
  return measure.accepted && measure.shortest !== null && measure.shortest >= band.minMoves && measure.shortest <= band.maxMoves;
}

/**
 * Engine findings for a chapter attempt, sent back to the model on revision.
 * Fairness comes first (the ordinary findings); only an accepted chapter is
 * judged on difficulty, because a rule-breaking shortcut would otherwise
 * measure as "short".
 */
export function chapterFindings(level: Level, band: DifficultyBand): string[] {
  const measure = measureChapter(level);
  if (!measure.accepted) {
    const findings = engineFindings(level, measure.report);
    return findings.length > 0 ? findings : ['The chapter is not fair yet: every check must pass (winnable, nobody stuck, rules hold).'];
  }
  if (measure.shortest === null) return ['The goal is unreachable.'];
  if (measure.shortest < band.minMoves) {
    return [
      `Too easy: the shortest winning route is ${measure.shortest} moves (${measure.gatesOnRoute} locked door${measure.gatesOnRoute === 1 ? '' : 's'} on it); this chapter must take ${band.minMoves}-${band.maxMoves} moves. Lengthen the route — more rooms, a key or switch off the direct path, a locked door the player must go around — keeping it winnable with no dead ends.`,
    ];
  }
  if (measure.shortest > band.maxMoves) {
    return [
      `Too long: the shortest winning route is ${measure.shortest} moves; this chapter must take ${band.minMoves}-${band.maxMoves} moves. Shorten the route or bring the key closer, keeping it winnable with no dead ends.`,
    ];
  }
  return [];
}

/**
 * The chapter-1 request context. Deterministic, so identical opening words
 * share one cache key — the welcome's example worlds are prewarmed with it.
 */
export function openingAdventureContext(): AdventureContext {
  return { chapter: 1, story: [], band: { ...FIRST_CHAPTER_BAND }, intent: 'steady' };
}
