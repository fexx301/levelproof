import { create } from 'zustand';
import type { RuleProposalResult, CompileResult } from '../../shared/compile-result.js';
import { compileOkResponseSchema, explainOkResponseSchema } from '../../shared/api.js';
import type { Level } from '../../shared/schema.js';
import { unfamiliarLevel } from '../core/fixtures/unfamiliar.js';
import { vaultEmptyLevel } from '../core/fixtures/vault-empty.js';
import { twinKeysLevel, overpassLevel, gauntletLevel } from '../core/fixtures/gallery.js';
import { applyOperations } from '../core/level.js';
import { findRepairs, type RepairCandidate } from '../core/search.js';
import { verify, type Report } from '../core/verifier.js';
import { revisionId } from '../core/serialize.js';

/** Gallery scenes (§12): the seeded vault plus three verified showcase levels. */
export const SCENES = [
  { id: 'balcony-vault', label: 'The Balcony Vault', level: vaultEmptyLevel },
  { id: 'twin-keys', label: 'The Twin Keys', level: twinKeysLevel },
  { id: 'overpass', label: 'The Overpass', level: overpassLevel },
  { id: 'gauntlet', label: 'The Gauntlet', level: gauntletLevel },
] as const;

export type SceneId = (typeof SCENES)[number]['id'];

/**
 * Accepted/draft revision state (§11) plus the watch/play/repair modes
 * (§12). One accepted checkpoint, at most one structurally valid editable
 * draft, one-step undo. A complete passing edit becomes accepted; a failing
 * or incomplete draft stays visible and labeled with **Return to accepted**
 * always available. The ghost replays verifier witnesses only; manual play
 * uses the same core `step` as the checker.
 */

type Mode = 'authoring' | 'watching' | 'playing';
type WitnessKind = 'solution' | 'dead_end' | 'bypass';

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
  sceneId: SceneId;
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
  loadScene: (id: SceneId) => void;
  watchWitness: (kind: WitnessKind) => void;
  startPlay: () => void;
  exitToAuthoring: () => void;
  runRepairs: (report: Report) => void;
  applyRepair: (index: number) => void;
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

function explainErrorText(body: unknown): string {
  if (body !== null && typeof body === 'object' && 'error' in body) {
    if (body.error === 'check_not_failing') return 'That check is not failing.';
    if (body.error === 'provider_not_configured') return 'Explanation service is not configured.';
  }
  return 'Explanation unavailable — the engine verdict above stands.';
}
function extractError(body: unknown): string {
  if (body !== null && typeof body === 'object' && 'error' in body) {
    const record = body as { error: unknown; issues?: string[] };
    const base = String(record.error);
    return record.issues && record.issues.length > 0 ? `${base}: ${record.issues[0]}` : base;
  }
  return 'Compilation failed.';
}

/** Apply a passing/failing edit as the new draft; auto-accept when green (§11.3). */
function settleDraft(set: (partial: Partial<AppState>) => void, base: Level, level: Level, viaRule: boolean): void {
  const report = verify(level);
  if (report.accepted) {
    set({ acceptedLevel: level, previousAccepted: base, draft: null });
  } else {
    set({ draft: { level, report, viaRule } });
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

export const useApp = create<AppState>()((set, get) => ({
  acceptedLevel: initialLevel(),
  sceneId: 'balcony-vault',
  previousAccepted: null,
  draft: null,
  pendingRule: null,
  lastResult: null,
  lastPrompt: null,
  lastCompileMeta: null,
  busy: false,
  error: null,
  mode: 'authoring',
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
    const base = state.draft?.level ?? state.acceptedLevel;
    try {
      const response = await fetch('/api/compile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ level: base, prompt, clarificationContext }),
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
      const { result, cached, attempts, totalCostUsd } = parsed.data;
      const model = attempts.length > 0 ? (attempts.at(-1)?.model ?? 'unknown') : 'cache';
      set({
        lastResult: result,
        lastPrompt: prompt,
        lastCompileMeta: { cached, totalCostUsd, attempts: attempts.length, model },
      });

      if (result.type === 'patch') {
        const applied = applyOperations(base, result.operations);
        if (!applied.ok) {
          set({ busy: false, error: `The proposed edit was rejected: ${applied.errors[0]}` });
          return;
        }
        settleDraft(set, base, applied.level, false);
      } else if (result.type === 'rule_proposal') {
        set({ pendingRule: { proposal: result, base } });
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
    settleDraft(set, base, level, true);
    set({ pendingRule: null });
  },

  declineRule: () => set({ pendingRule: null }),

  discardDraft: () => set({ draft: null, pendingRule: null, ghost: GHOST_INITIAL, play: PLAY_INITIAL, repair: REPAIR_INITIAL }),

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
      sceneId: 'balcony-vault',
    }),

  loadScene: (id) => {
    const scene = SCENES.find((s) => s.id === id);
    if (!scene) return;
    set({
      acceptedLevel: scene.level,
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
    const result = findRepairs(acceptedLevel, draft.level, report);
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
    const { draft, repair, acceptedLevel } = get();
    if (!draft || repair.candidates.length === 0) return;
    const candidate = repair.candidates[index];
    if (!candidate) return;
    const applied = applyOperations(draft.level, candidate.operations);
    if (!applied.ok) {
      set({ repair: { ...repair, applyError: `The repair was rejected: ${applied.errors[0]}` } });
      return;
    }
    settleDraft(set, acceptedLevel, applied.level, false);
  },
}));

