import { compileOkResponseSchema, type AdventureContext } from '../../shared/api.js';
import type { Level } from '../../shared/schema.js';
import {
  chapterFindings,
  chapterPlayable,
  measureChapter,
  nextDifficultyBand,
  openingAdventureContext,
  type AdventureIntent,
  type ChapterMeasure,
  type ChapterStats,
  type DifficultyBand,
} from '../core/adventure.js';
import { blankCanvasLevel } from '../core/fixtures/blank-canvas.js';
import { applyOperations } from '../core/level.js';
import { MAX_AUTO_REVISIONS } from '../core/revision-policy.js';
import { findRepairs } from '../core/search.js';
import { revisionId } from '../core/serialize.js';
import {
  ADVENTURE_INITIAL,
  applyProgress,
  claimCompileContext,
  compileContextIsCurrent,
  CompileStalledError,
  dismissLanding,
  postCompile,
  progressStart,
  SCENES,
  useApp,
  type AdventureChapter,
} from './store.js';

/**
 * Endless verified adventure (§12). After a win, the model writes the next
 * chapter as a new world; the engine decides whether it may be played. A
 * chapter must be fair (winnable, nobody can get stuck, rules hold) — never
 * negotiable — and should meet the difficulty band chosen from how the
 * player did. The loop mirrors the editor's revision loop but with the
 * chapter policy, then falls back to the deterministic repair search, then
 * to an honest "try again". Chapters stay out of the editor's conversation,
 * selection, and kept objects.
 */

/** The adventure's chapter in play, if the level on screen is still it. */
export function currentChapter(): AdventureChapter | null {
  const state = useApp.getState();
  const last = state.adventure.chapters.at(-1);
  const level = state.draft?.level ?? state.acceptedLevel;
  return last !== undefined && last.revision === revisionId(level) ? last : null;
}

function openingChapter(level: Level): AdventureChapter {
  const state = useApp.getState();
  const scene = SCENES.find((candidate) => candidate.id === state.sceneId);
  const measure = measureChapter(level);
  return {
    number: 1,
    title: scene?.label ?? 'Where it began',
    narration: 'The first world.',
    shortest: measure.shortest ?? 0,
    gates: measure.gatesOnRoute,
    explored: measure.exploredStates,
    inBand: true,
    revision: revisionId(level),
  };
}

/** Closer to the band is better; unfair chapters are worst. */
function bandDistance(measure: ChapterMeasure, band: DifficultyBand): number {
  if (!measure.accepted || measure.shortest === null) return Number.POSITIVE_INFINITY;
  if (measure.shortest < band.minMoves) return band.minMoves - measure.shortest;
  if (measure.shortest > band.maxMoves) return measure.shortest - band.maxMoves;
  return 0;
}

interface Candidate {
  level: Level;
  story: { title: string; narration: string } | null;
  measure: ChapterMeasure;
}

/** Write, verify, and enter the next chapter. */
export async function continueAdventure(words: string, intent: AdventureIntent): Promise<void> {
  const state = useApp.getState();
  if (state.busy) return;
  const level = state.draft?.level ?? state.acceptedLevel;
  const chapters = currentChapter() !== null ? state.adventure.chapters : [openingChapter(level)];
  const finished = chapters.at(-1)!;
  const stats: ChapterStats = {
    moves: Math.max(0, state.play.moves ?? finished.shortest),
    hints: state.adventure.run.hints,
    deadEnds: state.adventure.run.deadEnds,
    restarts: state.adventure.run.restarts,
    shortest: finished.shortest,
  };
  const band = nextDifficultyBand(stats, intent);
  const adventure: AdventureContext = {
    chapter: finished.number + 1,
    story: chapters.slice(-6).map((chapter) => ({ title: chapter.title.slice(0, 60), narration: chapter.narration.slice(0, 400) })),
    band,
    intent,
    lastStats: stats,
  };
  await writeChapter(words.trim().length > 0 ? words.trim().slice(0, 500) : 'Continue the adventure.', adventure, chapters);
}

/**
 * Start a fresh adventure from one sentence: chapter 1 is written on the
 * blank canvas with the opening band. Its request is identical for identical
 * words, so the welcome's example worlds are prewarmed (scripts/prewarm.ts).
 */
export async function startAdventure(words: string): Promise<void> {
  if (useApp.getState().busy || words.trim().length === 0) return;
  await writeChapter(words.trim().slice(0, 500), openingAdventureContext(), []);
}


async function writeChapter(prompt: string, adventure: AdventureContext, chapters: AdventureChapter[]): Promise<void> {
  const band = adventure.band;
  const { generation, controller } = claimCompileContext();
  useApp.setState({
    busy: true,
    error: null,
    compileProgress: progressStart(`Writing chapter ${adventure.chapter}`),
    adventure: { ...useApp.getState().adventure, chapters, writing: true, error: null },
  });
  const stop = (error: string | null): void => {
    if (!compileContextIsCurrent(generation)) return;
    useApp.setState({ busy: false, compileProgress: null, adventure: { ...useApp.getState().adventure, writing: false, error } });
  };

  let best: Candidate | null = null;
  let revision: { operations: unknown[] } | undefined;
  // One fresh retry when a request yields nothing usable at all (a malformed
  // answer on every attempt is intermittent; a second try usually succeeds).
  let freshRetryLeft = 1;
  try {
    for (let round = 0; round <= MAX_AUTO_REVISIONS; round++) {
      const response = await postCompile(
        // Chapters never carry the editor's conversation, selection, or kept objects.
        { level: blankCanvasLevel, prompt, selection: [], protectedIds: [], history: [], adventure, ...(revision !== undefined ? { revision } : {}) },
        controller.signal,
        (event) => {
          if (!compileContextIsCurrent(generation)) return;
          const current = useApp.getState().compileProgress ?? progressStart();
          useApp.setState({ compileProgress: applyProgress(current, event) });
        },
      );
      if (!compileContextIsCurrent(generation)) return;
      // A refusal from the service is not the AI failing: say what it is and
      // do not spend the retry on a request that will be refused again.
      if (!response.ok && (response.status === 429 || response.status === 503)) {
        if (best === null) {
          stop(
            response.status === 429
              ? 'Too many requests from this network right now — wait a minute, then try again. Nothing was changed.'
              : 'The service is busy for a moment — try again shortly. Nothing was changed.',
          );
          return;
        }
        break;
      }
      const parsed = response.ok ? compileOkResponseSchema.safeParse(response.body) : null;
      const result = parsed?.success === true && parsed.data.result.type === 'patch' ? parsed.data.result : null;
      const applied = result === null ? null : applyOperations(blankCanvasLevel, result.operations);
      if (result === null || applied === null || !applied.ok) {
        if (best === null && freshRetryLeft > 0) {
          freshRetryLeft -= 1;
          revision = undefined;
          round -= 1;
          continue;
        }
        break;
      }
      const candidate: Candidate = { level: applied.level, story: result.story ?? null, measure: measureChapter(applied.level) };
      if (best === null || bandDistance(candidate.measure, band) < bandDistance(best.measure, band)) best = candidate;
      if (chapterPlayable(candidate.measure, band)) break;
      // Tell the player what the engine sent back, then revise.
      const finding = chapterFindings(applied.level, band)[0] ?? null;
      useApp.setState({ compileProgress: { ...progressStart(finding, 'revising'), revising: true, startedAt: useApp.getState().compileProgress?.startedAt ?? Date.now() } });
      revision = { operations: result.operations };
    }
  } catch (error) {
    if (!compileContextIsCurrent(generation) || controller.signal.aborted && !(error instanceof CompileStalledError)) return;
    stop(error instanceof CompileStalledError ? error.message : 'The AI service could not be reached. Try again.');
    return;
  }
  if (!compileContextIsCurrent(generation)) return;

  // Fairness is not negotiable: an unfair best gets the deterministic repair
  // search; if nothing fair exists, say so rather than send the player in.
  let chosen: Candidate | null = best !== null && best.measure.accepted ? best : null;
  if (chosen === null && best !== null) {
    const repairs = findRepairs(blankCanvasLevel, best.level, best.measure.report, [], 1500);
    const fixed = repairs.candidates[0];
    if (fixed !== undefined) {
      const repaired = applyOperations(best.level, fixed.operations);
      if (repaired.ok) chosen = { level: repaired.level, story: best.story, measure: measureChapter(repaired.level) };
    }
  }
  if (chosen === null || !chosen.measure.accepted) {
    stop('The AI could not build a fair chapter this time — nothing was changed. Try again, or pick another direction.');
    return;
  }
  enterChapter(chosen, adventure.chapter, band, chapters);
}

function enterChapter(chosen: Candidate, number: number, band: DifficultyBand, chapters: AdventureChapter[]): void {
  const state = useApp.getState();
  const chapter: AdventureChapter = {
    number,
    title: chosen.story?.title ?? `Chapter ${number}`,
    narration: chosen.story?.narration ?? 'The adventure continues.',
    shortest: chosen.measure.shortest ?? 0,
    gates: chosen.measure.gatesOnRoute,
    explored: chosen.measure.exploredStates,
    band,
    inBand: chapterPlayable(chosen.measure, band),
    revision: revisionId(chosen.level),
  };
  const label = `Chapter ${number}: ${chapter.title}`;
  useApp.setState({
    // The chapter becomes the accepted checkpoint; the editor starts clean on it.
    acceptedLevel: chosen.level,
    acceptedSceneId: '',
    sceneId: '',
    acceptedTheme: null,
    theme: null,
    acceptedPromptHistory: [],
    promptHistory: [],
    draft: null,
    selection: [],
    protectedIds: [],
    pendingRule: null,
    preview: null,
    lastResult: null,
    lastPrompt: null,
    changeSummary: label,
    previousAccepted: {
      level: state.acceptedLevel,
      theme: state.acceptedTheme,
      promptHistory: [...state.acceptedPromptHistory],
      history: state.history,
      sceneId: state.acceptedSceneId,
    },
    history: [{ level: chosen.level, label, theme: null, promptHistory: [] }, ...state.history].slice(0, 12),
    busy: false,
    compileProgress: null,
    adventure: { chapters: [...chapters, chapter], writing: false, error: null, intro: chapter, run: { ...ADVENTURE_INITIAL.run } },
  });
  if (useApp.getState().landing) dismissLanding();
  useApp.getState().startPlay();
  // Entering the chapter resets play; the new chapter's tally starts at zero.
  useApp.setState({ adventure: { ...useApp.getState().adventure, run: { ...ADVENTURE_INITIAL.run } } });
}

export function dismissChapterCard(): void {
  useApp.setState({ adventure: { ...useApp.getState().adventure, intro: null } });
}

// How the player is doing on the chapter in play: dead ends (walking into a
// state with no way to win), hints, and restarts feed the next band.
useApp.subscribe((state, previous) => {
  if (state.mode !== 'playing' || previous.mode !== 'playing' || state.play === previous.play) return;
  const now = state.play;
  const before = previous.play;
  const run = { ...state.adventure.run };
  let changed = false;
  if ((now.doomed === true || now.trapped) && !(before.doomed === true || before.trapped)) {
    run.deadEnds += 1;
    changed = true;
  }
  // Being caught by a guard is a setback, like walking into a dead end.
  const capturesNow = now.captures ?? 0;
  const capturesBefore = before.captures ?? 0;
  if (capturesNow > capturesBefore) {
    run.deadEnds += capturesNow - capturesBefore;
    changed = true;
  }
  const hintsNow = now.hints ?? 0;
  const hintsBefore = before.hints ?? 0;
  if (hintsNow > hintsBefore) {
    run.hints += hintsNow - hintsBefore;
    changed = true;
  }
  // Replaying a chapter already won is not a struggle.
  if ((now.moves ?? 0) === 0 && (before.moves ?? 0) > 0 && !before.atGoal) {
    run.restarts += 1;
    changed = true;
  }
  if (changed) useApp.setState({ adventure: { ...state.adventure, run } });
});
