import { create } from 'zustand';
import type { RuleProposalResult, CompileResult } from '../../shared/compile-result.js';
import { compileOkResponseSchema, explainOkResponseSchema, themeKeySchema, type ThemeKey } from '../../shared/api.js';
import { levelSchema, type Level, type Operation } from '../../shared/schema.js';
import { unfamiliarLevel } from '../core/fixtures/unfamiliar.js';
import { vaultEmptyLevel } from '../core/fixtures/vault-empty.js';
import { twinKeysLevel, overpassLevel, gauntletLevel } from '../core/fixtures/gallery.js';
import { blankCanvasLevel } from '../core/fixtures/blank-canvas.js';
import { applyOperations, applyRuleProposal, requirementText } from '../core/level.js';
import { findRepairs, touchesProtected, type RepairCandidate } from '../core/search.js';
import { verify, type Report } from '../core/verifier.js';
import type { MoveRecord } from '../core/movement.js';
import { decodeLevelShare, encodeLevelShare, revisionId } from '../core/serialize.js';
import type { PreviewState } from '../core/preview.js';
import {
  prependSavedScene,
  persistSavedScenes,
  readSavedScenes,
  type SavedScene,
  type AcceptedSavedScene,
} from './persistence.js';

/** Gallery scenes (§12): the seeded vault plus three verified showcase levels. */
export const SCENES = [
  { id: 'balcony-vault', label: 'The Balcony Vault', level: vaultEmptyLevel },
  { id: 'blank-canvas', label: 'Blank canvas', level: blankCanvasLevel },
  { id: 'twin-keys', label: 'The Twin Keys', level: twinKeysLevel },
  { id: 'overpass', label: 'The Overpass', level: overpassLevel },
  { id: 'gauntlet', label: 'The Gauntlet', level: gauntletLevel },
] as const;

export type SceneId = (typeof SCENES)[number]['id'];

let contextGeneration = 0;

/** Invalidate any compile that was started against an older scene context. */
function invalidateContext(): void {
  contextGeneration += 1;
}

/** Only a fully verified green level may enter the accepted checkpoint. */
export function isAcceptedCheckpoint(value: unknown): value is Level {
  const parsed = levelSchema.safeParse(value);
  return parsed.success && verify(parsed.data).accepted;
}

function browserStorage(): Storage | undefined {
  return typeof localStorage === 'undefined' ? undefined : localStorage;
}

/** One-time window state: a shared puzzle (?p=) opens directly in play
 * mode (its "Back to editing" is the remix); otherwise the scene seed. */
export function decodeAcceptedShare(payload: string): Level | null {
  const shared = decodeLevelShare(payload);
  return shared !== null && isAcceptedCheckpoint(shared) ? shared : null;
}

function initialWindowState(): { level: Level; mode: Mode; viaShare: boolean; theme: ThemeKey | null } {
  if (typeof window !== 'undefined') {
    const params = new URLSearchParams(window.location.search);
    const shared = decodeAcceptedShare(params.get('p') ?? '');
    const parsedTheme = themeKeySchema.safeParse(params.get('theme'));
    if (shared !== null) {
      return {
        level: shared,
        mode: 'playing',
        viaShare: true,
        theme: parsedTheme.success ? parsedTheme.data : null,
      };
    }
  }
  return { level: initialLevel(), mode: 'authoring', viaShare: false, theme: null };
}

/**
 * Accepted/draft revision state (§11) plus the watch/play/repair modes
 * (§12). One accepted checkpoint, at most one structurally valid editable
 * draft, one-step undo. A complete passing edit becomes accepted; a failing
 * or incomplete draft stays visible and labeled with **Return to accepted**
 * always available. The ghost replays verifier witnesses only; manual play
 * uses the same core `step` as the checker.
 */

type Mode = 'authoring' | 'watching' | 'playing';
type WitnessKind = 'solution' | 'dead_end' | 'bypass' | 'replay';

interface DraftState {
  level: Level;
  report: Report;
  viaRule: boolean;
  /** Accepted checkpoint to return to when this draft was opened from a save. */
  returnSceneId: string | null;
}

interface RevisionEntry {
  level: Level;
  label: string;
  theme: ThemeKey | null;
  promptHistory: string[];
}

interface Checkpoint {
  level: Level;
  theme: ThemeKey | null;
  promptHistory: string[];
  history: RevisionEntry[];
  sceneId: string;
}

type PendingChange =
  | {
      kind: 'patch';
      base: Level;
      candidate: Level;
      operations: Operation[];
      rationale: string;
      assumptions: string[];
      prompt: string;
      nextTheme: ThemeKey | null;
      baseRevision: string;
    }
  | {
      kind: 'rule';
      base: Level;
      candidate: Level;
      proposal: RuleProposalResult;
      prompt: string;
      nextTheme: ThemeKey | null;
      baseRevision: string;
    };

interface CompileMeta {
  cached: boolean;
  totalCostUsd: number;
  attempts: number;
  model: string;
}

interface GhostSlice {
  witnessKind: WitnessKind | null;
  playing: boolean;
  finished: boolean;
  moveIndex: number;
  totalMoves: number;
  keys: string[];
  switches: string[];
  endNote: string | null;
}

interface PlaySlice {
  at: string;
  keys: string[];
  switches: string[];
  trapped: boolean;
  atGoal: boolean;
  goalViolated: boolean;
}

interface RepairSlice {
  status: 'idle' | 'running' | 'done';
  candidates: RepairCandidate[];
  explored: number;
  durationMs: number;
  note: string | null;
  applyError: string | null;
}

export type CheckKind = 'solution' | 'requirements' | 'recovery';

interface ExplainSlice {
  byCheck: Partial<Record<CheckKind, { text: string; meta: CompileMeta }>>;
  busy: boolean;
  error: string | null;
}

interface AppState {
  acceptedLevel: Level;
  /** Current scene: a static scene id or "saved:<id>" for a saved puzzle. */
  sceneId: string;
  /** The one complete, validated preview payload rendered as scene markers. */
  preview: PreviewState | null;
  /** Identity of the accepted checkpoint, independent from an open draft. */
  acceptedSceneId: string;
  /** The failing witness route that existed before the applied repair. */
  repairReplay: MoveRecord[] | null;
  /** Entity ids selected in the scene (§12 "select, then describe"). */
  selection: string[];
  /** Recent prompts (oldest first) for conversational follow-ups (§12). */
  promptHistory: string[];
  /** One-line summary of the last applied change (§12 visible edit). */
  changeSummary: string | null;
  /** Presentation theme the author asked for (§12 visual expression). */
  theme: ThemeKey | null;
  /** Theme and conversation belonging to the accepted checkpoint. */
  acceptedTheme: ThemeKey | null;
  acceptedPromptHistory: string[];
  /** Revision history entries (§11): every accepted checkpoint this session. */
  history: RevisionEntry[];
  /** Entities the creator marked "keep this" (§9): repairs that move or
   * remove them are excluded from the search. */
  protectedIds: string[];
  savedScenes: SavedScene[];
  /** True when the session started from a shared link (?p=). */
  viaShare: boolean;
  /** Transient header feedback (Saved ✓ / Link copied). */
  headerNote: string | null;
  previousAccepted: Checkpoint | null;
  draft: DraftState | null;
  /** One staged change at a time; its kind discriminates patch vs rule review. */
  pendingRule: PendingChange | null;
  lastResult: CompileResult | null;
  lastPrompt: string | null;
  lastCompileMeta: CompileMeta | null;
  busy: boolean;
  error: string | null;
  mode: Mode;
  ghost: GhostSlice;
  play: PlaySlice;
  repair: RepairSlice;
  explain: ExplainSlice;
  explainCheck: (kind: CheckKind) => Promise<void>;
  submitPrompt: (prompt: string, clarificationContext?: string) => Promise<void>;
  approveRule: () => void;
  declineRule: () => void;
  applyPatch: () => void;
  declinePatch: () => void;
  discardDraft: () => void;
  undo: () => void;
  resetVault: () => void;
  loadScene: (id: string) => void;
  watchWitness: (kind: WitnessKind) => void;
  startPlay: () => void;
  exitToAuthoring: () => void;
  runRepairs: (report: Report) => void;
  applyRepair: (index: number) => void;
  previewRepair: (index: number) => void;
  clearPreview: () => void;
  watchReplay: () => void;
  toggleSelect: (id: string) => void;
  clearSelection: () => void;
  keepSelected: () => void;
  /** Restore a revision-history level as the accepted checkpoint. */
  loadLevel: (level: Level, theme?: ThemeKey | null, promptHistory?: string[]) => void;
  unkeep: (id: string) => void;
  saveScene: () => void;
  deleteSaved: (id: string) => void;
  shareCurrent: () => void;
  setTheme: (theme: ThemeKey | null) => void;
}

const GHOST_INITIAL: GhostSlice = {
  witnessKind: null,
  playing: false,
  finished: false,
  moveIndex: 0,
  totalMoves: 0,
  keys: [],
  switches: [],
  endNote: null,
};

const PLAY_INITIAL: PlaySlice = {
  at: '',
  keys: [],
  switches: [],
  trapped: false,
  atGoal: false,
  goalViolated: false,
};

const REPAIR_INITIAL: RepairSlice = {
  status: 'idle',
  candidates: [],
  explored: 0,
  durationMs: 0,
  note: null,
  applyError: null,
};

const EXPLAIN_INITIAL: ExplainSlice = {
  byCheck: {},
  busy: false,
  error: null,
};

/** One-line human summary of an applied patch (§12 visible edits). */
function summarizeOperations(operations: Operation[]): string {
  const counts = new Map<string, number>();
  const names: string[] = [];
  for (const op of operations) {
    if (op.kind === 'addModule') names.push(`${op.module.template} "${op.module.id}"`);
    else if (op.kind === 'removeModule') names.push(`removed "${op.id}"`);
    else if (op.kind === 'moveModule') names.push(`moved "${op.id}"`);
    else if (op.kind === 'addItem') names.push(`${op.itemType} "${op.id}"`);
    else if (op.kind === 'removeItem') names.push(`removed ${op.kind === 'removeItem' ? 'item' : ''} "${op.id}"`);
    else if (op.kind === 'moveItem') names.push(`moved "${op.id}"`);
    else if (op.kind === 'addDoor') names.push(`door "${op.door.id}"`);
    else if (op.kind === 'removeDoor') names.push(`removed door "${op.id}"`);
    else if (op.kind === 'moveSpawn') names.push('spawn moved');
    else if (op.kind === 'moveGoal') names.push('goal moved');
    else if (op.kind === 'setModulePorts') names.push(`re-ported "${op.id}"`);
    else if (op.kind === 'setDoorConditions') names.push(`re-conditioned door "${op.id}"`);
    void counts;
  }
  if (names.length === 0) return 'No changes.';
  const shown = names.slice(0, 3).join(', ');
  return names.length > 3 ? `${shown} +${names.length - 3} more` : shown;
}

/** Theme words in a prompt → the theme side-channel (presentation only). */
function themeFromPrompt(prompt: string): ThemeKey | undefined {
  const p = prompt.toLowerCase();
  if (/futuristic|sci-fi|science fiction|neon|cyber|future vault/.test(p)) return 'futuristic';
  if (/stone ruin|limestone|castle|crypt|dungeon/.test(p)) return 'limestone';
  if (/ivory|observatory|white tower|marble|moonlit/.test(p)) return 'ivory';
  if (/patina|verdigris|relay|steampunk|copper|factory|workshop/.test(p)) return 'patina';
  if (/basalt|volcanic|dark fortress|shadow|obsidian/.test(p)) return 'basalt';
  return undefined;
}

/** Short label for a revision-history entry. */
function lastPromptLabel(prompt: string): string {
  const trimmed = prompt.trim().replace(/\s+/g, ' ');
  return trimmed.length > 42 ? `${trimmed.slice(0, 42)}…` : trimmed;
}

function explainErrorText(body: unknown): string {
  if (body !== null && typeof body === 'object' && 'error' in body) {
    if (body.error === 'check_not_failing') return 'That check is not failing.';
    if (body.error === 'provider_not_configured') return 'Explanation service is not configured.';
  }
  return 'Explanation unavailable — the engine verdict above stands.';
}

function extractError(body: unknown): string {
  if (body !== null && typeof body === 'object' && 'error' in body) {
    const base = String(body.error);
    const issue =
      'issues' in body && Array.isArray(body.issues) && body.issues.length > 0
        ? `: ${String(body.issues[0])}`
        : '';
    const kind =
      'providerError' in body && typeof body.providerError === 'string' ? ` (${body.providerError})` : '';
    return `${base}${issue}${kind}`;
  }
  return 'Compilation failed.';
}

/** Apply a passing/failing edit as the new draft; auto-accept when green
 * (§11.3). The summary line makes the edit visible; callers that accept a
 * new checkpoint push it onto the revision history themselves (they hold
 * the pre-update state). */
function settleDraft(
  set: (partial: Partial<AppState>) => void,
  get: () => AppState,
  base: Level,
  level: Level,
  viaRule: boolean,
  summary: string | null = null,
  nextTheme: ThemeKey | null = get().theme,
  nextPromptHistory: string[] = get().promptHistory,
): boolean {
  const current = get();
  const report = verify(level);
  if (report.accepted) {
    set({
      acceptedLevel: level,
      acceptedSceneId: '',
      sceneId: '',
      acceptedTheme: nextTheme,
      acceptedPromptHistory: [...nextPromptHistory],
      previousAccepted: {
        level: current.acceptedLevel,
        theme: current.acceptedTheme,
        promptHistory: [...current.acceptedPromptHistory],
        history: current.history,
        sceneId: current.acceptedSceneId,
      },
      draft: null,
      theme: nextTheme,
      promptHistory: [...nextPromptHistory],
      changeSummary: summary,
    });
  } else {
    // A failing draft is not an accepted checkpoint. Keep the real accepted
    // snapshot untouched while the author explores the candidate.
    set({
      draft: {
        level,
        report,
        viaRule,
        returnSceneId: current.draft?.returnSceneId ?? current.acceptedSceneId,
      },
      theme: nextTheme,
      promptHistory: [...nextPromptHistory],
      changeSummary: summary,
    });
  }
  set({ pendingRule: null, mode: 'authoring', ghost: GHOST_INITIAL, play: PLAY_INITIAL, repair: REPAIR_INITIAL, explain: EXPLAIN_INITIAL });
  void base;
  return report.accepted;
}

/** Seed scene: the empty vault, or the held-out unfamiliar layout via ?scene=unfamiliar (§8.4 gate). */
function initialLevel(): Level {
  if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('scene') === 'unfamiliar') {
    return unfamiliarLevel;
  }
  return vaultEmptyLevel;
}

const initialWindow = initialWindowState();

export const useApp = create<AppState>()((set, get) => ({
  acceptedLevel: initialWindow.level,
  sceneId: 'balcony-vault',
  acceptedSceneId: initialWindow.viaShare ? '' : 'balcony-vault',
  preview: null,
  repairReplay: null,
  selection: [],
  protectedIds: [],
  promptHistory: [],
  changeSummary: null,
  theme: initialWindow.theme,
  acceptedTheme: initialWindow.theme,
  acceptedPromptHistory: [],
  history: [],
  previousAccepted: null,
  draft: null,
  pendingRule: null,
  lastResult: null,
  lastPrompt: null,
  lastCompileMeta: null,
  busy: false,
  error: null,
  mode: initialWindow.mode,
  viaShare: initialWindow.viaShare,
  headerNote: null,
  savedScenes: readSavedScenes(browserStorage()),
  ghost: GHOST_INITIAL,
  play: PLAY_INITIAL,
  repair: REPAIR_INITIAL,
  explain: EXPLAIN_INITIAL,

  explainCheck: async (kind) => {
    const state = get();
    if (state.explain.busy) return;
    const generation = contextGeneration;
    const level = state.draft?.level ?? state.acceptedLevel;
    const boundRevision = revisionId(level);
    set({ explain: { ...state.explain, busy: true, error: null } });
    try {
      const response = await fetch('/api/explain', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ level, check: kind }),
      });
      const body: unknown = await response.json();
      // Stale results are ignored: the level moved on while we asked.
      const stillCurrent = revisionId(get().draft?.level ?? get().acceptedLevel) === boundRevision;
      if (generation !== contextGeneration || !stillCurrent) return;
      if (!response.ok) {
        set({ explain: { ...get().explain, busy: false, error: explainErrorText(body) } });
        return;
      }
      const parsed = explainOkResponseSchema.safeParse(body);
      if (!parsed.success) {
        set({ explain: { ...get().explain, busy: false, error: 'The explanation response failed validation.' } });
        return;
      }
      const { explanation, cached, attempts, totalCostUsd } = parsed.data;
      const model = attempts.length > 0 ? (attempts.at(-1)?.model ?? 'unknown') : 'cache';
      set({
        explain: {
          byCheck: { ...get().explain.byCheck, [kind]: { text: explanation, meta: { cached, totalCostUsd, attempts: attempts.length, model } } },
          busy: false,
          error: null,
        },
      });
    } catch {
      set({ explain: { ...get().explain, busy: false, error: 'Explanation unavailable — the engine verdict above stands.' } });
    }
  },

  submitPrompt: async (prompt, clarificationContext) => {
    const state = get();
    if (state.busy || state.pendingRule !== null || prompt.trim().length === 0) return;
    const generation = ++contextGeneration;
    set({ busy: true, error: null });
    const selection = state.selection;
    const history = state.promptHistory;
    const base = state.draft?.level ?? state.acceptedLevel;
    const requestedTheme = themeFromPrompt(prompt) ?? state.theme;
    // §11: every result binds to a base revision. If the scene changes while
    // the request is in flight (scene picker, reset), the result is stale and
    // is discarded instead of applied to the wrong level.
    const boundRevision = revisionId(base);
    try {
      const response = await fetch('/api/compile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          level: base,
          prompt,
          clarificationContext,
          selection,
          history: history.map((h) => ({ prompt: h })),
          ...(requestedTheme !== null ? { theme: requestedTheme } : {}),
        }),
      });
      const body: unknown = await response.json();
      if (generation !== contextGeneration) return;
      if (!response.ok) {
        set({ busy: false, error: extractError(body), lastResult: null, lastCompileMeta: null });
        return;
      }
      const parsed = compileOkResponseSchema.safeParse(body);
      if (!parsed.success) {
        set({ busy: false, error: 'The compile response failed validation.', lastResult: null, lastCompileMeta: null });
        return;
      }
      const { result, baseRevision, cached, attempts, totalCostUsd, theme } = parsed.data;
      const stillCurrent = revisionId(get().draft?.level ?? get().acceptedLevel) === boundRevision;
      if (generation !== contextGeneration || !stillCurrent || baseRevision !== boundRevision) {
        set({
          busy: false,
          error: 'The scene changed while compiling; the result was discarded.',
          lastResult: null,
          lastCompileMeta: null,
        });
        return;
      }
      const model = attempts.length > 0 ? (attempts.at(-1)?.model ?? 'unknown') : 'cache';
      set({
        lastResult: result,
        lastPrompt: prompt,
        lastCompileMeta: { cached, totalCostUsd, attempts: attempts.length, model },
      });
      const nextTheme = theme ?? requestedTheme;

      if (result.type === 'patch') {
        const applied = applyOperations(base, result.operations);
        if (!applied.ok) {
          set({ busy: false, error: `The proposed edit was rejected: ${applied.errors[0]}`, lastResult: null });
          return;
        }
        set({
          pendingRule: {
            kind: 'patch',
            base,
            candidate: applied.level,
            operations: result.operations,
            rationale: result.rationale,
            assumptions: result.assumptions,
            prompt,
            nextTheme,
            baseRevision: boundRevision,
          },
          repairReplay: null,
          preview: {
            source: 'ai',
            baseRevision: boundRevision,
            before: base,
            candidate: applied.level,
            operations: result.operations,
          },
          selection: [],
          busy: false,
        });
      } else if (result.type === 'rule_proposal') {
        const applied = applyRuleProposal(base, result);
        if (!applied.ok) {
          set({ busy: false, error: `The rule proposal was rejected: ${applied.errors[0]}`, lastResult: null });
          return;
        }
        set({
          pendingRule: { kind: 'rule', base, candidate: applied.level, proposal: result, prompt, nextTheme, baseRevision: boundRevision },
          repairReplay: null,
          preview: {
            source: 'ai',
            baseRevision: boundRevision,
            before: base,
            candidate: applied.level,
            operations: result.operations,
          },
          selection: [],
          busy: false,
        });
      } else {
        set({ pendingRule: null, preview: null, busy: false });
      }
    } catch (error) {
      if (generation === contextGeneration) {
        set({ busy: false, error: error instanceof Error ? error.message : 'Network error.' });
      }
    }
  },

  approveRule: () => {
    const { pendingRule } = get();
    if (!pendingRule || pendingRule.kind !== 'rule') return;
    const currentBase = get().draft?.level ?? get().acceptedLevel;
    if (revisionId(currentBase) !== pendingRule.baseRevision) {
      set({ pendingRule: null, preview: null, lastResult: null, error: 'The scene changed; review this rule again.' });
      return;
    }
    const { proposal, base } = pendingRule;
    const applied = applyRuleProposal(currentBase, proposal);
    if (!applied.ok) {
      set({ pendingRule: null, preview: null, lastResult: null, error: `The proposal was rejected: ${applied.errors[0]}` });
      return;
    }
    const level: Level = applied.level;
    const priorHistory = get().history;
    const nextPromptHistory = [...get().promptHistory, pendingRule.prompt].slice(-6);
    const summary =
      proposal.newRequirements.length > 0
        ? `Rule: ${proposal.newRequirements.map(requirementText).join('; ')}`
        : summarizeOperations(proposal.operations);
    const accepted = settleDraft(set, get, base, level, true, summary, pendingRule.nextTheme, nextPromptHistory);
    if (accepted) {
      set({
        history: [{ level, label: summary, theme: pendingRule.nextTheme, promptHistory: nextPromptHistory }, ...priorHistory].slice(0, 12),
      });
    }
    set({ pendingRule: null, preview: null, selection: [] });
  },

  declineRule: () => {
    const pending = get().pendingRule;
    if (!pending || pending.kind !== 'rule') return;
    set({ pendingRule: null, preview: null, lastResult: null, lastPrompt: null });
  },

  applyPatch: () => {
    const { pendingRule } = get();
    if (!pendingRule || pendingRule.kind !== 'patch') return;
    const currentBase = get().draft?.level ?? get().acceptedLevel;
    if (revisionId(currentBase) !== pendingRule.baseRevision) {
      set({ pendingRule: null, preview: null, lastResult: null, error: 'The scene changed; compile the edit again.' });
      return;
    }
    const applied = applyOperations(currentBase, pendingRule.operations);
    if (!applied.ok) {
      set({ pendingRule: null, preview: null, lastResult: null, error: `The edit was rejected: ${applied.errors[0]}` });
      return;
    }
    const priorHistory = get().history;
    const nextPromptHistory = [...get().promptHistory, pendingRule.prompt].slice(-6);
    const summary = summarizeOperations(pendingRule.operations);
    const accepted = settleDraft(set, get, pendingRule.base, applied.level, false, summary, pendingRule.nextTheme, nextPromptHistory);
    if (accepted) {
      set({
        history: [{ level: applied.level, label: lastPromptLabel(pendingRule.prompt), theme: pendingRule.nextTheme, promptHistory: nextPromptHistory }, ...priorHistory].slice(0, 12),
      });
    }
    set({ pendingRule: null, preview: null, selection: [] });
  },

  declinePatch: () => {
    const pending = get().pendingRule;
    if (!pending || pending.kind !== 'patch') return;
    set({ pendingRule: null, preview: null, lastResult: null, lastPrompt: null });
  },

  discardDraft: () => {
    invalidateContext();
    const { acceptedTheme, acceptedPromptHistory, draft, acceptedSceneId, sceneId } = get();
    set({
      draft: null,
      pendingRule: null,
      lastResult: null,
      lastPrompt: null,
      lastCompileMeta: null,
      error: null,
      busy: false,
      theme: acceptedTheme,
      promptHistory: [...acceptedPromptHistory],
      changeSummary: null,
      ghost: GHOST_INITIAL,
      play: PLAY_INITIAL,
      repair: REPAIR_INITIAL,
      preview: null,
      repairReplay: null,
      selection: [],
      sceneId: draft?.returnSceneId ?? (acceptedSceneId || sceneId),
    });
  },

  undo: () => {
    const { previousAccepted } = get();
    if (!previousAccepted) return;
    invalidateContext();
    set({
      acceptedLevel: previousAccepted.level,
      acceptedSceneId: previousAccepted.sceneId,
      sceneId: previousAccepted.sceneId,
      acceptedTheme: previousAccepted.theme,
      acceptedPromptHistory: [...previousAccepted.promptHistory],
      theme: previousAccepted.theme,
      promptHistory: [...previousAccepted.promptHistory],
      history: previousAccepted.history,
      previousAccepted: null,
      draft: null,
      pendingRule: null,
      lastResult: null,
      lastPrompt: null,
      lastCompileMeta: null,
      error: null,
      busy: false,
      changeSummary: null,
      mode: 'authoring',
      ghost: GHOST_INITIAL,
      play: PLAY_INITIAL,
      repair: REPAIR_INITIAL,
      preview: null,
      repairReplay: null,
      selection: [],
    });
  },

  resetVault: () => {
    invalidateContext();
    set({
      acceptedLevel: initialLevel(),
      acceptedTheme: null,
      acceptedPromptHistory: [],
      theme: null,
      promptHistory: [],
      history: [],
      previousAccepted: null,
      draft: null,
      pendingRule: null,
      lastResult: null,
      lastPrompt: null,
      lastCompileMeta: null,
      error: null,
      busy: false,
      changeSummary: null,
      mode: 'authoring',
      viaShare: false,
      headerNote: null,
      ghost: GHOST_INITIAL,
      play: PLAY_INITIAL,
      repair: REPAIR_INITIAL,
      explain: EXPLAIN_INITIAL,
      preview: null,
      repairReplay: null,
      selection: [],
      protectedIds: [],
      sceneId: 'balcony-vault',
      acceptedSceneId: 'balcony-vault',
    });
  },

  loadScene: (id) => {
    const scene = SCENES.find((s) => s.id === id);
    const saved = id.startsWith('saved:') ? get().savedScenes.find((sv) => sv.recordKey === id.slice('saved:'.length)) : undefined;
    if (!scene && !saved) return;

    if (saved?.status === 'unavailable') {
      set({ sceneId: id, error: `${saved.error} The entry remains available in My puzzles so you can remove or recover it.` });
      return;
    }

    const level = scene ? scene.level : saved!.level;
    const report = verify(level);
    if (!report.valid) {
      set({ sceneId: id, error: 'That saved scene is structurally invalid and cannot be rendered. Remove it from My puzzles.' });
      return;
    }
    invalidateContext();
    const savedTheme = saved?.theme ?? null;
    const parsedTheme = themeKeySchema.safeParse(savedTheme);
    const theme = parsedTheme.success ? parsedTheme.data : null;
    const savedPrompts = Array.isArray(saved?.promptHistory) ? saved.promptHistory : [];
    const promptHistory = savedPrompts.filter((prompt) => typeof prompt === 'string').slice(-6);

    if (saved !== undefined && !report.accepted) {
      const current = get();
      set({
        // Deliberately leave the accepted snapshot untouched. The saved
        // failure is an editable draft with an explicit return lineage.
        draft: {
          level,
          report,
          viaRule: false,
          returnSceneId: current.draft?.returnSceneId ?? current.acceptedSceneId,
        },
        theme,
        promptHistory,
        history: [],
        previousAccepted: null,
        pendingRule: null,
        lastResult: null,
        lastPrompt: null,
        lastCompileMeta: null,
        error: null,
        busy: false,
        mode: 'authoring',
        ghost: GHOST_INITIAL,
        play: PLAY_INITIAL,
        repair: REPAIR_INITIAL,
        explain: EXPLAIN_INITIAL,
        changeSummary: `Opened ${saved.name} as a draft`,
        preview: null,
        repairReplay: null,
        selection: [],
        protectedIds: [],
        viaShare: false,
        sceneId: id,
      });
      return;
    }

    set({
      acceptedLevel: level,
      acceptedSceneId: id,
      acceptedTheme: theme,
      acceptedPromptHistory: promptHistory,
      theme,
      promptHistory,
      history: [],
      previousAccepted: null,
      draft: null,
      pendingRule: null,
      lastResult: null,
      lastPrompt: null,
      lastCompileMeta: null,
      error: null,
      busy: false,
      mode: 'authoring',
      ghost: GHOST_INITIAL,
      play: PLAY_INITIAL,
      repair: REPAIR_INITIAL,
      explain: EXPLAIN_INITIAL,
      changeSummary: null,
      preview: null,
      repairReplay: null,
      selection: [],
      protectedIds: [],
      viaShare: false,
      sceneId: id,
    });
  },

  watchWitness: (kind) =>
    set({
      mode: 'watching',
      ghost: { ...GHOST_INITIAL, witnessKind: kind },
      play: PLAY_INITIAL,
    }),


  startPlay: () => {
    invalidateContext();
    set({ mode: 'playing', ghost: GHOST_INITIAL, play: PLAY_INITIAL, pendingRule: null, preview: null, lastResult: null, lastPrompt: null, lastCompileMeta: null, busy: false });
  },

  exitToAuthoring: () => set({ mode: 'authoring', ghost: GHOST_INITIAL, play: PLAY_INITIAL }),


  runRepairs: (report) => {
    const { draft, acceptedLevel } = get();
    if (!draft) return;
    set({ repair: { ...REPAIR_INITIAL, status: 'running' } });
    const { protectedIds } = get();
    const result = findRepairs(acceptedLevel, draft.level, report, protectedIds);
    set({
      repair: {
        status: 'done',
        candidates: result.candidates,
        explored: result.explored,
        durationMs: result.durationMs,
        note: result.note,
        applyError: null,
      },
    });
  },

  applyRepair: (index) => {
    const { draft, repair, acceptedLevel, protectedIds } = get();
    if (!draft || repair.candidates.length === 0) return;
    const candidate = repair.candidates[index];
    if (!candidate) return;
    if (protectedIds.length > 0 && touchesProtected(candidate.operations, new Set(protectedIds))) {
      set({
        repair: {
          ...repair,
          applyError: 'This repair moves or removes a kept entity — search again with your keep choices.',
        },
      });
      return;
    }
    const applied = applyOperations(draft.level, candidate.operations);
    if (!applied.ok) {
      set({ repair: { ...repair, applyError: `The repair was rejected: ${applied.errors[0]}` } });
      return;
    }
    // Stash the route that failed, so it can be replayed on the repaired
    // scene — the same moves, no longer fatal.
    const failing =
      draft.report.checks.recovery.witness?.route ?? draft.report.checks.requirements.witness?.route ?? [];
    const priorHistory = get().history;
    const nextTheme = get().theme;
    const nextPromptHistory = get().promptHistory;
    const accepted = settleDraft(set, get, acceptedLevel, applied.level, false, `Repair: ${candidate.description}`, nextTheme, nextPromptHistory);
    if (accepted) {
      set({
        history: [{ level: applied.level, label: `Repair: ${candidate.description}`, theme: nextTheme, promptHistory: nextPromptHistory }, ...priorHistory].slice(0, 12),
      });
    }
    set({ preview: null, repairReplay: failing.length > 0 ? failing : null });
  },

  previewRepair: (index) => {
    const { repair, draft } = get();
    const candidate = repair.candidates[index];
    if (!candidate || !draft) {
      set({ preview: null });
      return;
    }
    const applied = applyOperations(draft.level, candidate.operations);
    if (!applied.ok) {
      set({ preview: null, repair: { ...repair, applyError: `The repair preview was rejected: ${applied.errors[0]}` } });
      return;
    }
    set({
      preview: {
        source: 'repair',
        baseRevision: revisionId(draft.level),
        before: draft.level,
        candidate: applied.level,
        operations: candidate.operations,
      },
    });
  },

  clearPreview: () => set({ preview: null }),

  watchReplay: () => {
    const { repairReplay } = get();
    if (repairReplay === null || repairReplay.length === 0) return;
    set({
      mode: 'watching',
      ghost: { ...GHOST_INITIAL, witnessKind: 'replay' },
      play: PLAY_INITIAL,
      preview: null,
    });
  },

  toggleSelect: (id) => {
    const { selection } = get();
    set({
      selection: selection.includes(id) ? selection.filter((s) => s !== id) : [...selection, id],
    });
  },

  clearSelection: () => set({ selection: [] }),

  loadLevel: (level, theme = null, promptHistory = []) => {
    if (!isAcceptedCheckpoint(level)) {
      set({ error: 'Only a verified accepted level can become a checkpoint.' });
      return;
    }
    invalidateContext();
    const current = get();
    const contextSceneId = current.draft?.returnSceneId ?? current.acceptedSceneId;
    const nextPromptHistory = promptHistory.slice(-6);
    set({
      acceptedLevel: level,
      acceptedSceneId: contextSceneId,
      sceneId: contextSceneId,
      acceptedTheme: theme,
      acceptedPromptHistory: nextPromptHistory,
      theme,
      promptHistory: nextPromptHistory,
      previousAccepted: null,
      draft: null,
      pendingRule: null,
      lastResult: null,
      lastPrompt: null,
      lastCompileMeta: null,
      error: null,
      busy: false,
      mode: 'authoring',
      ghost: GHOST_INITIAL,
      play: PLAY_INITIAL,
      repair: REPAIR_INITIAL,
      explain: EXPLAIN_INITIAL,
      changeSummary: null,
      preview: null,
      repairReplay: null,
      selection: [],
      protectedIds: [],
      viaShare: false,
    });
  },

  keepSelected: () => {
    const { selection, protectedIds } = get();
    if (selection.length === 0) return;
    const merged = [...new Set([...protectedIds, ...selection])];
    // Protections change what the search may offer: stale candidates and
    // their preview markers are void until the creator searches again.
    set({ protectedIds: merged, repair: REPAIR_INITIAL, preview: null });
  },

  unkeep: (id) => {
    const { protectedIds } = get();
    set({
      protectedIds: protectedIds.filter((p) => p !== id),
      repair: REPAIR_INITIAL,
      preview: null,
    });
  },

  saveScene: () => {
    const { acceptedLevel, acceptedTheme, acceptedPromptHistory, savedScenes, draft, sceneId } = get();
    if (!isAcceptedCheckpoint(acceptedLevel)) {
      set({ error: 'Only a verified accepted level can be saved.' });
      return;
    }
    const savedAt = Date.now();
    let recordKey = `save-${savedAt}`;
    let suffix = 2;
    while (savedScenes.some((saved) => saved.recordKey === recordKey)) {
      recordKey = `save-${savedAt}-${suffix}`;
      suffix += 1;
    }
    const acceptedCount = savedScenes.filter((saved) => saved.status === 'accepted').length;
    const entry: AcceptedSavedScene = {
      recordKey,
      id: recordKey,
      name: `Puzzle ${acceptedCount + 1}`,
      savedAt,
      status: 'accepted',
      level: acceptedLevel,
      theme: acceptedTheme,
      promptHistory: [...acceptedPromptHistory],
    };
    const next = prependSavedScene(savedScenes, entry);
    const persisted = persistSavedScenes(browserStorage(), next);
    if (!persisted.ok) {
      set({ error: persisted.error });
      return;
    }
    const note = draft ? 'Accepted checkpoint saved ✓' : 'Saved ✓';
    const savedSceneId = `saved:${entry.recordKey}`;
    set({
      savedScenes: next,
      headerNote: note,
      acceptedSceneId: savedSceneId,
      sceneId: draft ? sceneId : savedSceneId,
      draft: draft ? { ...draft, returnSceneId: savedSceneId } : null,
      error: null,
    });
    if (typeof window !== 'undefined') {
      window.setTimeout(() => {
        if (get().headerNote === note) set({ headerNote: null });
      }, 2500);
    }
  },

  deleteSaved: (recordKey) => {
    const current = get();
    const next = current.savedScenes.filter((saved) => saved.recordKey !== recordKey);
    if (next.length === current.savedScenes.length) return;
    const persisted = persistSavedScenes(browserStorage(), next);
    if (!persisted.ok) {
      set({ error: persisted.error });
      return;
    }
    const savedSceneId = `saved:${recordKey}`;
    const acceptedWasDeleted = current.acceptedSceneId === savedSceneId;
    const draftReturnSceneId = current.draft?.returnSceneId === savedSceneId ? null : current.draft?.returnSceneId ?? null;
    let nextSceneId = current.sceneId;
    if (current.sceneId === savedSceneId) {
      nextSceneId = current.draft ? '' : acceptedWasDeleted ? '' : current.acceptedSceneId;
    }
    set({
      savedScenes: next,
      acceptedSceneId: acceptedWasDeleted ? '' : current.acceptedSceneId,
      sceneId: nextSceneId,
      draft: current.draft ? { ...current.draft, returnSceneId: draftReturnSceneId } : null,
      error: null,
    });
  },

  shareCurrent: () => {
    const { acceptedLevel, acceptedTheme } = get();
    if (!isAcceptedCheckpoint(acceptedLevel)) {
      set({ error: 'Only a verified accepted level can be shared.' });
      return;
    }
    const themeParam = acceptedTheme === null ? '' : `&theme=${encodeURIComponent(acceptedTheme)}`;
    const url = `${window.location.origin}/?p=${encodeLevelShare(acceptedLevel)}${themeParam}`;
    const done = (): void => {
      set({ headerNote: 'Share link copied' });
      window.setTimeout(() => {
        if (get().headerNote === 'Share link copied') set({ headerNote: null });
      }, 2500);
    };
    if (navigator.clipboard?.writeText !== undefined) {
      void navigator.clipboard.writeText(url).then(done, () => set({ headerNote: url }));
    } else {
      set({ headerNote: url });
    }
  },

  setTheme: (theme) => {
    const current = get();
    if (current.theme === theme) return;
    invalidateContext();
    set({
      theme,
      ...(current.draft === null ? { acceptedTheme: theme } : {}),
      pendingRule: null,
      preview: null,
      lastResult: null,
      lastPrompt: null,
      lastCompileMeta: null,
      error: null,
      busy: false,
    });
  },
}));
