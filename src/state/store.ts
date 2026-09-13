import { create } from 'zustand';
import type { RuleProposalResult, CompileResult } from '../../shared/compile-result.js';
import { compileOkResponseSchema, explainOkResponseSchema } from '../../shared/api.js';
import type { Level, Operation } from '../../shared/schema.js';
import { unfamiliarLevel } from '../core/fixtures/unfamiliar.js';
import { vaultEmptyLevel } from '../core/fixtures/vault-empty.js';
import { twinKeysLevel, overpassLevel, gauntletLevel } from '../core/fixtures/gallery.js';
import { blankCanvasLevel } from '../core/fixtures/blank-canvas.js';
import { applyOperations, requirementText } from '../core/level.js';
import { findRepairs, touchesProtected, type RepairCandidate } from '../core/search.js';
import { verify, type Report } from '../core/verifier.js';
import type { MoveRecord } from '../core/movement.js';
import { decodeLevelShare, encodeLevelShare, revisionId } from '../core/serialize.js';

/** Gallery scenes (§12): the seeded vault plus three verified showcase levels. */
export const SCENES = [
  { id: 'balcony-vault', label: 'The Balcony Vault', level: vaultEmptyLevel },
  { id: 'blank-canvas', label: 'Blank canvas', level: blankCanvasLevel },
  { id: 'twin-keys', label: 'The Twin Keys', level: twinKeysLevel },
  { id: 'overpass', label: 'The Overpass', level: overpassLevel },
  { id: 'gauntlet', label: 'The Gauntlet', level: gauntletLevel },
] as const;

export type SceneId = (typeof SCENES)[number]['id'];

interface SavedScene {
  id: string;
  name: string;
  savedAt: number;
  level: Level;
}

const SAVES_KEY = 'levelproof:saves';

function loadSaves(): SavedScene[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(SAVES_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is SavedScene =>
        entry !== null && typeof entry === 'object' && 'id' in entry && 'name' in entry && 'level' in entry,
    );
  } catch {
    return [];
  }
}

function persistSaves(saves: SavedScene[]): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(SAVES_KEY, JSON.stringify(saves));
  } catch {
    // Storage full or unavailable: the in-session list still works.
  }
}

/** One-time window state: a shared puzzle (?p=) opens directly in play
 * mode (its "Back to editing" is the remix); otherwise the scene seed. */
function initialWindowState(): { level: Level; mode: Mode; viaShare: boolean } {
  if (typeof window !== 'undefined') {
    const shared = decodeLevelShare(new URLSearchParams(window.location.search).get('p') ?? '');
    if (shared !== null) return { level: shared, mode: 'playing', viaShare: true };
  }
  return { level: initialLevel(), mode: 'authoring', viaShare: false };
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
}

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
  /** Repair preview: the candidate's operations rendered as scene markers. */
  previewOps: Operation[] | null;
  /** The failing witness route that existed before the applied repair. */
  repairReplay: MoveRecord[] | null;
  /** Entity ids selected in the scene (§12 "select, then describe"). */
  selection: string[];
  /** Recent prompts (oldest first) for conversational follow-ups (§12). */
  promptHistory: string[];
  /** One-line summary of the last applied change (§12 visible edit). */
  changeSummary: string | null;
  /** Presentation theme the author asked for (§12 visual expression). */
  theme: 'limestone' | 'ivory' | 'patina' | 'basalt' | null;
  /** Revision history entries (§11): every accepted checkpoint this session. */
  history: { level: Level; label: string }[];
  /** Entities the creator marked "keep this" (§9): repairs that move or
   * remove them are excluded from the search. */
  protectedIds: string[];
  savedScenes: SavedScene[];
  /** True when the session started from a shared link (?p=). */
  viaShare: boolean;
  /** Transient header feedback (Saved ✓ / Link copied). */
  headerNote: string | null;
  previousAccepted: Level | null;
  draft: DraftState | null;
  pendingRule: { proposal: RuleProposalResult; base: Level } | null;
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
  loadLevel: (level: Level) => void;
  unkeep: (id: string) => void;
  saveScene: () => void;
  deleteSaved: (id: string) => void;
  shareCurrent: () => void;
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
function themeFromPrompt(prompt: string): 'limestone' | 'ivory' | 'patina' | 'basalt' | undefined {
  const p = prompt.toLowerCase();
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
  base: Level,
  level: Level,
  viaRule: boolean,
  summary: string | null = null,
): void {
  const report = verify(level);
  if (report.accepted) {
    set({ acceptedLevel: level, previousAccepted: base, draft: null, changeSummary: summary });
  } else {
    set({ draft: { level, report, viaRule }, changeSummary: summary });
  }
  set({ pendingRule: null, mode: 'authoring', ghost: GHOST_INITIAL, play: PLAY_INITIAL, repair: REPAIR_INITIAL, explain: EXPLAIN_INITIAL });
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
  previewOps: null,
  repairReplay: null,
  selection: [],
  protectedIds: [],
  promptHistory: [],
  changeSummary: null,
  theme: null,
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
  savedScenes: loadSaves(),
  ghost: GHOST_INITIAL,
  play: PLAY_INITIAL,
  repair: REPAIR_INITIAL,
  explain: EXPLAIN_INITIAL,

  explainCheck: async (kind) => {
    const state = get();
    if (state.explain.busy) return;
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
      if (!stillCurrent) return;
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
    if (state.busy || prompt.trim().length === 0) return;
    set({ busy: true, error: null });
    const selection = state.selection;
    const history = state.promptHistory;
    const base = state.draft?.level ?? state.acceptedLevel;
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
          ...(themeFromPrompt(prompt) !== undefined ? { theme: themeFromPrompt(prompt) } : {}),
        }),
      });
      const body: unknown = await response.json();
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
      if (!stillCurrent || baseRevision !== boundRevision) {
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
        promptHistory: [...history, prompt].slice(-6),
        ...(theme !== undefined ? { theme } : {}),
      });

      if (result.type === 'patch') {
        const applied = applyOperations(base, result.operations);
        if (!applied.ok) {
          set({ busy: false, error: `The proposed edit was rejected: ${applied.errors[0]}` });
          return;
        }
        const priorHistory = get().history;
        settleDraft(set, base, applied.level, false, summarizeOperations(result.operations));
        if (get().acceptedLevel === applied.level) {
          set({ history: [{ level: applied.level, label: lastPromptLabel(prompt) }, ...priorHistory].slice(0, 12) });
        }
        set({ repairReplay: null, previewOps: null, selection: [] });
      } else if (result.type === 'rule_proposal') {
        set({ pendingRule: { proposal: result, base }, repairReplay: null, previewOps: null, selection: [] });
      }
      set({ busy: false });
    } catch (error) {
      set({ busy: false, error: error instanceof Error ? error.message : 'Network error.' });
    }
  },

  approveRule: () => {
    const { pendingRule } = get();
    if (!pendingRule) return;
    const { proposal, base } = pendingRule;
    const applied = applyOperations(base, proposal.operations);
    if (!applied.ok) {
      set({ pendingRule: null, error: `The proposal was rejected: ${applied.errors[0]}` });
      return;
    }
    const level: Level = { ...applied.level, requirements: proposal.newRequirements };
    const priorHistory = get().history;
    const summary =
      proposal.newRequirements.length > 0
        ? `Rule: ${proposal.newRequirements.map(requirementText).join('; ')}`
        : summarizeOperations(proposal.operations);
    settleDraft(set, base, level, true, summary);
    if (get().acceptedLevel === level) {
      set({ history: [{ level, label: summary }, ...priorHistory].slice(0, 12) });
    }
    set({ pendingRule: null });
  },

  declineRule: () => set({ pendingRule: null }),

  discardDraft: () =>
    set({ draft: null, pendingRule: null, ghost: GHOST_INITIAL, play: PLAY_INITIAL, repair: REPAIR_INITIAL, previewOps: null, repairReplay: null, selection: [] }),

  undo: () => {
    const { previousAccepted } = get();
    if (!previousAccepted) return;
    set({
      acceptedLevel: previousAccepted,
      previousAccepted: null,
      draft: null,
      pendingRule: null,
      mode: 'authoring',
      ghost: GHOST_INITIAL,
      play: PLAY_INITIAL,
      repair: REPAIR_INITIAL,
      previewOps: null,
      repairReplay: null,
      selection: [],
    });
  },

  resetVault: () =>
    set({
      acceptedLevel: initialLevel(),
      previousAccepted: null,
      draft: null,
      pendingRule: null,
      lastResult: null,
      lastPrompt: null,
      lastCompileMeta: null,
      error: null,
      mode: 'authoring',
      ghost: GHOST_INITIAL,
      play: PLAY_INITIAL,
      repair: REPAIR_INITIAL,
      explain: EXPLAIN_INITIAL,
      previewOps: null,
      repairReplay: null,
      sceneId: 'balcony-vault',
    }),

  loadScene: (id) => {
    const scene = SCENES.find((s) => s.id === id);
    const saved = id.startsWith('saved:') ? get().savedScenes.find((sv) => sv.id === id.slice('saved:'.length)) : undefined;
    if (!scene && !saved) return;
    set({
      acceptedLevel: scene ? scene.level : saved!.level,
      previousAccepted: null,
      draft: null,
      pendingRule: null,
      lastResult: null,
      lastPrompt: null,
      lastCompileMeta: null,
      error: null,
      mode: 'authoring',
      ghost: GHOST_INITIAL,
      play: PLAY_INITIAL,
      repair: REPAIR_INITIAL,
      explain: EXPLAIN_INITIAL,
      previewOps: null,
      repairReplay: null,
      sceneId: id,
    });
  },

  watchWitness: (kind) =>
    set({
      mode: 'watching',
      ghost: { ...GHOST_INITIAL, witnessKind: kind },
      play: PLAY_INITIAL,
    }),


  startPlay: () => set({ mode: 'playing', ghost: GHOST_INITIAL, play: PLAY_INITIAL }),

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
    settleDraft(set, acceptedLevel, applied.level, false, `Repair: ${candidate.description}`);
    if (get().acceptedLevel === applied.level) {
      set({ history: [{ level: applied.level, label: `Repair: ${candidate.description}` }, ...priorHistory].slice(0, 12) });
    }
    set({ previewOps: null, repairReplay: failing.length > 0 ? failing : null });
  },

  previewRepair: (index) => {
    const { repair } = get();
    const candidate = repair.candidates[index];
    set({ previewOps: candidate ? candidate.operations : null });
  },

  clearPreview: () => set({ previewOps: null }),

  watchReplay: () => {
    const { repairReplay } = get();
    if (repairReplay === null || repairReplay.length === 0) return;
    set({
      mode: 'watching',
      ghost: { ...GHOST_INITIAL, witnessKind: 'replay' },
      play: PLAY_INITIAL,
      previewOps: null,
    });
  },

  toggleSelect: (id) => {
    const { selection } = get();
    set({
      selection: selection.includes(id) ? selection.filter((s) => s !== id) : [...selection, id],
    });
  },

  clearSelection: () => set({ selection: [] }),

  loadLevel: (level) => {
    set({
      acceptedLevel: level,
      previousAccepted: null,
      draft: null,
      pendingRule: null,
      lastResult: null,
      lastPrompt: null,
      lastCompileMeta: null,
      error: null,
      mode: 'authoring',
      ghost: GHOST_INITIAL,
      play: PLAY_INITIAL,
      repair: REPAIR_INITIAL,
      explain: EXPLAIN_INITIAL,
      previewOps: null,
      repairReplay: null,
      selection: [],
    });
  },

  keepSelected: () => {
    const { selection, protectedIds } = get();
    if (selection.length === 0) return;
    const merged = [...new Set([...protectedIds, ...selection])];
    // Protections change what the search may offer: stale candidates and
    // their preview markers are void until the creator searches again.
    set({ protectedIds: merged, repair: REPAIR_INITIAL, previewOps: null });
  },

  unkeep: (id) => {
    const { protectedIds } = get();
    set({
      protectedIds: protectedIds.filter((p) => p !== id),
      repair: REPAIR_INITIAL,
      previewOps: null,
    });
  },

  saveScene: () => {
    const { draft, acceptedLevel, savedScenes } = get();
    const level = draft?.level ?? acceptedLevel;
    const entry: SavedScene = {
      id: `save-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      name: `Puzzle ${savedScenes.length + 1}`,
      savedAt: Date.now(),
      level,
    };
    const next = [entry, ...savedScenes].slice(0, 20);
    persistSaves(next);
    set({ savedScenes: next, headerNote: 'Saved ✓' });
    window.setTimeout(() => {
      if (get().headerNote === 'Saved ✓') set({ headerNote: null });
    }, 2500);
  },

  deleteSaved: (id) => {
    const next = get().savedScenes.filter((sv) => sv.id !== id);
    persistSaves(next);
    set({ savedScenes: next });
  },

  shareCurrent: () => {
    const { draft, acceptedLevel } = get();
    const level = draft?.level ?? acceptedLevel;
    const url = `${window.location.origin}/?p=${encodeLevelShare(level)}`;
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
}));

