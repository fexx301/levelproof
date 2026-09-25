import { create } from 'zustand';
import type { RuleProposalResult, CompileResult } from '../../shared/compile-result.js';
import {
  compileOkResponseSchema,
  compileStreamEventSchema,
  explainOkResponseSchema,
  themeKeySchema,
  type CompileProgress,
  type ThemeKey,
} from '../../shared/api.js';
import { levelSchema, type Level, type Operation } from '../../shared/schema.js';
import { unfamiliarLevel } from '../core/fixtures/unfamiliar.js';
import { vaultEmptyLevel } from '../core/fixtures/vault-empty.js';
import { twinKeysLevel, overpassLevel, gauntletLevel } from '../core/fixtures/gallery.js';
import { blankCanvasLevel } from '../core/fixtures/blank-canvas.js';
import { applyOperations, applyRuleProposal, requirementText } from '../core/level.js';
import { findRepairs, touchesProtected, type RepairCandidate } from '../core/search.js';
import { verify, type Report } from '../core/verifier.js';
import { buildFailureEvidence, type FailureEvidence } from '../core/failure-evidence.js';
import { engineFindings } from '../core/engine-findings.js';
import { summarizeChange } from '../core/operation-description.js';
import { shouldAutoRevise } from '../core/revision-policy.js';
import type { MoveRecord } from '../core/movement.js';
import { validateRoute } from '../core/replay.js';
import { decodeLevelShare, encodeLevelShare, revisionId } from '../core/serialize.js';
import type { PreviewState } from '../core/preview.js';
import {
  prependSavedScene,
  persistSavedScenes,
  readSavedScenes,
  safeBrowserStorage,
  type SavedScene,
  type AcceptedSavedScene,
} from './persistence.js';
import {
  clearRecovery as clearRecoveryRecord,
  persistRecovery,
  readRecovery,
  type RecoverySnapshot,
} from './recovery.js';

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
let activeCompileController: AbortController | null = null;
let activeExplainController: AbortController | null = null;

/** Invalidate any compile that was started against an older scene context. */
function invalidateContext(): void {
  contextGeneration += 1;
  activeCompileController?.abort();
  activeExplainController?.abort();
}

/** Only a fully verified green level may enter the accepted checkpoint. */
export function isAcceptedCheckpoint(value: unknown): value is Level {
  const parsed = levelSchema.safeParse(value);
  return parsed.success && verify(parsed.data).accepted;
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
  /** Saved drafts do not share a known parent revision with the current checkpoint. */
  lineageKnown?: boolean;
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
      /** AI↔engine loop: the engine findings a revision answered, and whether it fixed them. */
      revision?: { findings: string[]; outcome: 'fixed' | 'improved' | 'unresolved' };
      /** An AI proposal that repairs the current draft rather than a new request. */
      aiFix?: boolean;
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
  totalCostUsd: number | null;
  generationCostUsd: number | null;
  attempts: number;
  model: string;
}

export interface CompileProgressState {
  startedAt: number;
  stage: 'sending' | CompileProgress['stage'] | 'revising';
  /** Headlines of the model's reasoning summary, in order. */
  headlines: string[];
  operations: number;
  /** The most recent streamed operation labels (unvalidated until the end). */
  recent: string[];
  attempt: number;
  note: string | null;
  /** True while the model is revising against the engine's findings. */
  revising?: boolean;
}

function progressStart(note: string | null = null, stage: CompileProgressState['stage'] = 'sending'): CompileProgressState {
  return { startedAt: Date.now(), stage, headlines: [], operations: 0, recent: [], attempt: 1, note };
}

function applyProgress(state: CompileProgressState, event: CompileProgress): CompileProgressState {
  switch (event.stage) {
    case 'thinking':
      return {
        ...state,
        stage: 'thinking',
        attempt: event.attempt,
        headlines: event.headline !== undefined && !state.headlines.includes(event.headline) ? [...state.headlines, event.headline] : state.headlines,
      };
    case 'writing':
      return {
        ...state,
        stage: 'writing',
        attempt: event.attempt,
        operations: event.operations,
        recent: event.latest !== undefined ? [...state.recent, event.latest].slice(-40) : state.recent,
      };
    case 'checking':
      return { ...state, stage: 'checking', attempt: event.attempt };
    case 'retrying':
      return { ...state, stage: 'retrying', attempt: event.attempt, note: event.reason, operations: 0, recent: [] };
  }
}

/**
 * POST /api/compile, preferring the streamed form. Progress events update the
 * UI; the final result carries exactly what the plain endpoint returns. An
 * older server (or a test fixture) answering with plain JSON still works.
 */
export async function postCompile(
  body: Record<string, unknown>,
  signal: AbortSignal,
  onProgress: (event: CompileProgress) => void,
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const response = await fetch('/api/compile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson, application/json' },
    signal,
    body: JSON.stringify(body),
  });
  // Minimal fetch doubles may omit headers; treat them as plain JSON.
  const contentType = response.headers?.get?.('content-type') ?? '';
  if (!contentType.includes('application/x-ndjson') || response.body === null || response.body === undefined) {
    return { ok: response.ok, status: response.status, body: await response.json() };
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let final: { status: number; body: unknown } | null = null;
  const handle = (line: string): void => {
    if (line.trim().length === 0) return;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      return;
    }
    const event = compileStreamEventSchema.safeParse(raw);
    if (!event.success) return;
    if (event.data.event === 'progress') onProgress(event.data.progress);
    else final = { status: event.data.status, body: event.data.body };
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      handle(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
    }
  }
  handle(buffer);
  if (final === null) throw new Error('The compile stream ended without a result.');
  const settled = final as { status: number; body: unknown };
  return { ok: settled.status >= 200 && settled.status < 300, status: settled.status, body: settled.body };
}

export { shouldAutoRevise };

/** Fewer failing checks is better; an unwinnable level is worst. */
function reportScore(report: Report): number {
  if (!report.valid) return 100;
  return (report.checks.solution.status === 'fail' ? 10 : 0) +
    (report.checks.requirements.status === 'fail' ? 3 : 0) +
    (report.checks.recovery.status === 'fail' ? 2 : 0) +
    (report.complete ? 0 : 1);
}

export const AI_FIX_PROMPT = 'Fix the failing checks in this puzzle without losing its idea.';

interface GhostSlice {
  witnessKind: WitnessKind | null;
  playing: boolean;
  finished: boolean;
  pausedAtEvidence: boolean;
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
  /** The gallery scene this editing lineage started from ("Start over" target). */
  originSceneId: SceneId;
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
  /** Text currently in the prompt field; retained across reloads. */
  promptDraft: string;
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
  /** Live progress of the running compile (streamed model plan and operations). */
  compileProgress: CompileProgressState | null;
  error: string | null;
  mode: Mode;
  ghost: GhostSlice;
  play: PlaySlice;
  repair: RepairSlice;
  explain: ExplainSlice;
  /** Temporary, verifier-owned evidence shown by the failure replay. */
  evidence: FailureEvidence | null;
  recoveryStatus: 'ready' | 'malformed' | 'unavailable';
  explainCheck: (kind: CheckKind) => Promise<void>;
  submitPrompt: (prompt: string, clarificationContext?: string) => Promise<void>;
  /** Ask the model to repair the failing draft; the engine judges the result. */
  requestAiFix: () => Promise<void>;
  cancelCompile: () => void;
  approveRule: () => void;
  declineRule: () => void;
  applyPatch: () => void;
  declinePatch: () => void;
  discardDraft: () => void;
  undo: () => void;
  resetVault: () => void;
  loadScene: (id: string) => void;
  watchWitness: (kind: WitnessKind) => void;
  showProblem: (kind: CheckKind) => void;
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
  clearRecovery: () => void;
  retryRecovery: () => void;
  setPromptDraft: (value: string) => void;
}

const GHOST_INITIAL: GhostSlice = {
  witnessKind: null,
  playing: false,
  finished: false,
  pausedAtEvidence: false,
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

/** Short label for a revision-history entry. */
function lastPromptLabel(prompt: string): string {
  const trimmed = prompt.trim().replace(/\s+/g, ' ');
  return trimmed.length > 42 ? `${trimmed.slice(0, 42)}…` : trimmed;
}

function explainErrorText(body: unknown): string {
  if (body !== null && typeof body === 'object' && 'error' in body) {
    if (body.error === 'check_not_failing') return 'That check is not failing.';
    if (body.error === 'provider_not_configured') return 'Explanation service is not configured.';
    if (body.error === 'request_limit_reached') return 'The shared request quota is reached. Wait for its window to reset, then try again.';
    if (body.error === 'request_protection_unavailable') return 'AI requests are temporarily paused because request protection is unavailable.';
  }
  return 'Explanation unavailable — the engine verdict above stands.';
}

function extractError(body: unknown): string {
  if (body !== null && typeof body === 'object' && 'error' in body) {
    const base = String(body.error);
    if (base === 'request_limit_reached') return 'Request limit reached. Wait briefly before trying again.';
    if (base === 'request_protection_unavailable') return 'AI service temporarily paused: shared request protection is unavailable.';
    if (base === 'request_too_large') return 'This request is too large. Shorten the prompt or remove extra context.';
    if (base === 'provider_not_configured') return 'AI provider is not configured. Your prompt is still available for retry.';
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
        lineageKnown: current.draft?.lineageKnown ?? true,
      },
      theme: nextTheme,
      promptHistory: [...nextPromptHistory],
      changeSummary: summary,
    });
  }
  set({ pendingRule: null, mode: 'authoring', ghost: GHOST_INITIAL, play: PLAY_INITIAL, repair: REPAIR_INITIAL, explain: EXPLAIN_INITIAL, evidence: null });
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
const initialStorage = safeBrowserStorage();
const initialSavedScenes = readSavedScenes(initialStorage);
const initialRecoveryRead = initialStorage === undefined
  ? { status: 'unavailable' as const }
  : initialWindow.viaShare
    ? { status: 'empty' as const }
    : readRecovery(initialStorage);
const initialRecovery = initialRecoveryRead.status === 'ready' ? initialRecoveryRead.snapshot : null;

function recoveredSceneId(id: string, fallback: string): string {
  if (id === '') return '';
  if (SCENES.some((scene) => scene.id === id)) return id;
  if (id.startsWith('saved:')) {
    const key = id.slice('saved:'.length);
    if (initialSavedScenes.some((saved) => saved.recordKey === key && saved.status !== 'unavailable')) return id;
  }
  return fallback;
}

function restorePending(pending: RecoverySnapshot['pending']): PendingChange | null {
  if (pending === null) return null;
  if (pending.result.type === 'patch') {
    const applied = applyOperations(pending.base, pending.result.operations);
    if (!applied.ok) return null;
    return {
      kind: 'patch',
      base: pending.base,
      candidate: applied.level,
      operations: pending.result.operations,
      rationale: pending.result.rationale,
      assumptions: pending.result.assumptions,
      prompt: pending.prompt,
      nextTheme: pending.nextTheme,
      baseRevision: pending.baseRevision,
    };
  }
  if (pending.result.type !== 'rule_proposal') return null;
  const applied = applyRuleProposal(pending.base, pending.result);
  return applied.ok
    ? {
        kind: 'rule',
        base: pending.base,
        candidate: applied.level,
        proposal: pending.result,
        prompt: pending.prompt,
        nextTheme: pending.nextTheme,
        baseRevision: pending.baseRevision,
      }
    : null;
}

function makeRecoverySnapshot(state: AppState): RecoverySnapshot {
  const pending = state.pendingRule;
  const result: RecoverySnapshot['pending'] = pending === null
    ? null
    : {
        base: pending.base,
        result: pending.kind === 'patch'
          ? { type: 'patch', rationale: pending.rationale, assumptions: pending.assumptions, operations: pending.operations }
          : pending.proposal,
        prompt: pending.prompt,
        nextTheme: pending.nextTheme,
        baseRevision: pending.baseRevision,
      };
  return {
    version: 1,
    acceptedLevel: state.acceptedLevel,
    acceptedSceneId: state.acceptedSceneId,
    sceneId: state.sceneId,
    acceptedTheme: state.acceptedTheme,
    acceptedPromptHistory: state.acceptedPromptHistory,
    theme: state.theme,
    promptHistory: state.promptHistory,
    promptDraft: state.promptDraft,
    draft: state.draft === null
      ? null
      : {
          level: state.draft.level,
          viaRule: state.draft.viaRule,
          returnSceneId: state.draft.returnSceneId,
          ...(state.draft.lineageKnown !== undefined ? { lineageKnown: state.draft.lineageKnown } : {}),
        },
    pending: result,
    selection: state.selection,
    protectedIds: state.protectedIds,
    history: state.history,
    previousAccepted: state.previousAccepted,
    lastPrompt: state.lastPrompt,
    changeSummary: state.changeSummary,
    lastCompileMeta: state.lastCompileMeta,
  };
}

export const useApp = create<AppState>()((set, get) => ({
  acceptedLevel: initialRecovery?.acceptedLevel ?? initialWindow.level,
  sceneId: initialRecovery === null
    ? 'balcony-vault'
    : recoveredSceneId(initialRecovery.sceneId, recoveredSceneId(initialRecovery.acceptedSceneId, 'balcony-vault')),
  acceptedSceneId: initialRecovery === null
    ? initialWindow.viaShare ? '' : 'balcony-vault'
    : recoveredSceneId(initialRecovery.acceptedSceneId, ''),
  originSceneId: (() => {
    const candidates = [initialRecovery?.sceneId, initialRecovery?.acceptedSceneId];
    return (SCENES.find((scene) => candidates.includes(scene.id))?.id ?? 'balcony-vault') as SceneId;
  })(),
  preview: initialRecovery?.pending === null || initialRecovery === null
    ? null
    : (() => {
        const pending = restorePending(initialRecovery.pending);
        if (pending === null) return null;
        const operations = pending.kind === 'patch' ? pending.operations : pending.proposal.operations;
        return {
          source: 'ai' as const,
          baseRevision: pending.baseRevision,
          before: pending.base,
          candidate: pending.candidate,
          operations,
        };
      })(),
  repairReplay: null,
  selection: initialRecovery?.selection ?? [],
  protectedIds: initialRecovery?.protectedIds ?? [],
  promptHistory: initialRecovery?.promptHistory ?? [],
  promptDraft: initialRecovery?.promptDraft ?? '',
  changeSummary: initialRecovery?.changeSummary ?? null,
  theme: initialRecovery === null ? initialWindow.theme : initialRecovery.theme,
  acceptedTheme: initialRecovery === null ? initialWindow.theme : initialRecovery.acceptedTheme,
  acceptedPromptHistory: initialRecovery?.acceptedPromptHistory ?? [],
  history: initialRecovery?.history ?? [],
  previousAccepted: initialRecovery?.previousAccepted ?? null,
  draft: initialRecovery?.draft === null || initialRecovery === null
    ? null
    : {
        ...initialRecovery.draft,
        report: verify(initialRecovery.draft.level),
      },
  pendingRule: initialRecovery === null ? null : restorePending(initialRecovery.pending),
  lastResult: initialRecovery?.pending?.result ?? null,
  lastPrompt: initialRecovery?.lastPrompt ?? null,
  lastCompileMeta: initialRecovery?.lastCompileMeta ?? null,
  busy: false,
  compileProgress: null,
  error: null,
  mode: initialWindow.mode,
  viaShare: initialWindow.viaShare,
  headerNote: null,
  savedScenes: initialSavedScenes,
  ghost: GHOST_INITIAL,
  play: PLAY_INITIAL,
  repair: REPAIR_INITIAL,
  explain: EXPLAIN_INITIAL,
  evidence: null,
  recoveryStatus: initialRecoveryRead.status === 'malformed'
    ? 'malformed'
    : initialRecoveryRead.status === 'unavailable'
      ? 'unavailable'
      : 'ready',

  explainCheck: async (kind) => {
    const state = get();
    if (state.explain.busy) return;
    const generation = contextGeneration;
    activeExplainController?.abort();
    const controller = new AbortController();
    activeExplainController = controller;
    const level = state.draft?.level ?? state.acceptedLevel;
    const boundRevision = revisionId(level);
    set({ explain: { ...state.explain, busy: true, error: null } });
    try {
      const response = await fetch('/api/explain', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ level, check: kind }),
        signal: controller.signal,
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
      const { explanation, cached, attempts, totalCostUsd, generationCostUsd } = parsed.data;
      const model = attempts.length > 0 ? (attempts.at(-1)?.model ?? 'unknown') : 'cache';
      set({
        explain: {
          byCheck: { ...get().explain.byCheck, [kind]: { text: explanation, meta: { cached, totalCostUsd, generationCostUsd: generationCostUsd ?? null, attempts: attempts.length, model } } },
          busy: false,
          error: null,
        },
      });
    } catch {
      if (generation === contextGeneration) {
        set({ explain: { ...get().explain, busy: false, error: 'Explanation unavailable — the engine verdict above stands.' } });
      }
    } finally {
      if (activeExplainController === controller) {
        activeExplainController = null;
        if (generation !== contextGeneration && get().explain.busy) {
          set({ explain: { ...get().explain, busy: false } });
        }
      }
    }
  },

  showProblem: (kind) => {
    const state = get();
    const level = state.draft?.level ?? state.acceptedLevel;
    const report = verify(level);
    const evidence = buildFailureEvidence(level, report, kind);
    if (evidence === null) {
      set({ error: 'This check has no replayable witness yet.' });
      return;
    }
    set({
      mode: 'watching',
      evidence,
      ghost: { ...GHOST_INITIAL, witnessKind: evidence.witnessKind },
      play: PLAY_INITIAL,
      error: null,
    });
  },

  submitPrompt: async (prompt, clarificationContext) => {
    const state = get();
    if (state.busy || state.pendingRule !== null || prompt.trim().length === 0) return;
    const generation = ++contextGeneration;
    activeCompileController?.abort();
    const controller = new AbortController();
    activeCompileController = controller;
    set({ busy: true, error: null, evidence: null, promptDraft: prompt, compileProgress: progressStart() });
    const selection = state.selection;
    const history = state.promptHistory;
    const base = state.draft?.level ?? state.acceptedLevel;
    // The model chooses the architecture inside the level's scenery; only an
    // explicit editor choice pins it.
    const requestedTheme = state.theme;
    // §11: every result binds to a base revision. If the scene changes while
    // the request is in flight (scene picker, reset), the result is stale and
    // is discarded instead of applied to the wrong level.
    const boundRevision = revisionId(base);
    const onProgress = (event: CompileProgress): void => {
      if (generation !== contextGeneration) return;
      set({ compileProgress: applyProgress(get().compileProgress ?? progressStart(), event) });
    };
    const requestBody: Record<string, unknown> = {
      level: base,
      prompt,
      clarificationContext,
      selection,
      protectedIds: state.protectedIds,
      history: history.map((h) => ({ prompt: h })),
      ...(requestedTheme !== null ? { theme: requestedTheme } : {}),
    };
    const fail = (message: string, extra: Partial<AppState> = {}): void => {
      set({ busy: false, compileProgress: null, error: message, lastResult: null, lastCompileMeta: null, ...extra });
    };
    const stillCurrent = (): boolean => revisionId(get().draft?.level ?? get().acceptedLevel) === boundRevision;
    try {
      const first = await postCompile(requestBody, controller.signal, onProgress);
      if (generation !== contextGeneration) return;
      if (!first.ok) {
        fail(`${extractError(first.body)} Your prompt is still available — try again when the service is ready.`);
        return;
      }
      const parsed = compileOkResponseSchema.safeParse(first.body);
      if (!parsed.success) {
        fail('The compile response failed validation.');
        return;
      }
      const { result, baseRevision, cached, attempts, totalCostUsd, generationCostUsd, theme } = parsed.data;
      if (!stillCurrent() || baseRevision !== boundRevision) {
        fail('The scene changed while compiling; the result was discarded.');
        return;
      }
      const proposedOperations = result.type === 'patch' || result.type === 'rule_proposal' ? result.operations : [];
      const keptAtResponse = get().protectedIds;
      if (keptAtResponse.length > 0 && touchesProtected(proposedOperations, new Set(keptAtResponse))) {
        fail('The proposal changes an object marked Keep these. Nothing changed. Remove that object from Keep these or revise the request.', { lastPrompt: prompt });
        return;
      }
      const model = attempts.length > 0 ? (attempts.at(-1)?.model ?? 'unknown') : 'cache';
      let meta: CompileMeta = { cached, totalCostUsd, generationCostUsd: generationCostUsd ?? null, attempts: attempts.length, model };
      set({ lastResult: result, lastPrompt: prompt, lastCompileMeta: meta });
      const nextTheme = theme ?? requestedTheme;

      if (result.type === 'patch') {
        const applied = applyOperations(base, result.operations);
        if (!applied.ok) {
          fail(`The proposed edit was rejected: ${applied.errors[0]}`);
          return;
        }
        let chosen = { result, candidate: applied.level };
        let revision: { findings: string[]; outcome: 'fixed' | 'improved' | 'unresolved' } | undefined;
        if (shouldAutoRevise(base, applied.level, result.operations)) {
          // The AI↔engine loop: the engine found the build unwinnable, so the
          // model gets its verified findings and one chance to revise.
          const firstReport = verify(applied.level);
          const findings = engineFindings(applied.level, firstReport);
          set({ compileProgress: { ...progressStart(findings[0] ?? null, 'revising'), startedAt: get().compileProgress?.startedAt ?? Date.now(), revising: true } });
          revision = { findings, outcome: 'unresolved' };
          try {
            const second = await postCompile({ ...requestBody, revision: { operations: result.operations } }, controller.signal, onProgress);
            if (generation !== contextGeneration) return;
            const revised = second.ok ? compileOkResponseSchema.safeParse(second.body) : null;
            if (revised?.success && revised.data.result.type === 'patch' && revised.data.baseRevision === boundRevision && stillCurrent()) {
              const revisedResult = revised.data.result;
              const revisedApplied = applyOperations(base, revisedResult.operations);
              const kept = get().protectedIds;
              if (revisedApplied.ok && !(kept.length > 0 && touchesProtected(revisedResult.operations, new Set(kept)))) {
                const revisedReport = verify(revisedApplied.level);
                if (reportScore(revisedReport) < reportScore(firstReport)) {
                  chosen = { result: revisedResult, candidate: revisedApplied.level };
                  revision = { findings, outcome: revisedReport.checks.solution.status === 'fail' ? 'improved' : 'fixed' };
                }
              }
              meta = {
                cached: meta.cached && revised.data.cached,
                totalCostUsd: meta.totalCostUsd === null || revised.data.totalCostUsd === null ? null : meta.totalCostUsd + revised.data.totalCostUsd,
                generationCostUsd: meta.generationCostUsd === null || (revised.data.generationCostUsd ?? null) === null ? null : meta.generationCostUsd + (revised.data.generationCostUsd ?? 0),
                attempts: meta.attempts + revised.data.attempts.length,
                model: revised.data.attempts.at(-1)?.model ?? meta.model,
              };
            }
          } catch {
            if (generation !== contextGeneration || controller.signal.aborted) return;
          }
        }
        set({
          lastResult: chosen.result,
          lastCompileMeta: meta,
          pendingRule: {
            kind: 'patch',
            base,
            candidate: chosen.candidate,
            operations: chosen.result.operations,
            rationale: chosen.result.rationale,
            assumptions: chosen.result.assumptions,
            prompt,
            nextTheme,
            baseRevision: boundRevision,
            ...(revision !== undefined ? { revision } : {}),
          },
          repairReplay: null,
          preview: {
            source: 'ai',
            baseRevision: boundRevision,
            before: base,
            candidate: chosen.candidate,
            operations: chosen.result.operations,
          },
          selection: [],
          busy: false,
          compileProgress: null,
        });
      } else if (result.type === 'rule_proposal') {
        const applied = applyRuleProposal(base, result);
        if (!applied.ok) {
          fail(`The rule proposal was rejected: ${applied.errors[0]}`);
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
          compileProgress: null,
        });
      } else {
        set({ pendingRule: null, preview: null, busy: false, compileProgress: null });
      }
    } catch (error) {
      if (generation === contextGeneration) {
        const message = error instanceof Error ? error.message : 'Network error.';
        set({ busy: false, compileProgress: null, error: `${message} Your prompt is still available — try again when the service is ready.` });
      }
    } finally {
      if (activeCompileController === controller) activeCompileController = null;
    }
  },

  requestAiFix: async () => {
    const state = get();
    if (state.busy || state.pendingRule !== null || state.draft === null) return;
    const base = state.draft.level;
    const baseReport = verify(base);
    const findings = engineFindings(base, baseReport);
    if (findings.length === 0) return;
    const generation = ++contextGeneration;
    activeCompileController?.abort();
    const controller = new AbortController();
    activeCompileController = controller;
    const boundRevision = revisionId(base);
    set({ busy: true, error: null, evidence: null, preview: null, compileProgress: { ...progressStart(findings[0] ?? null, 'revising'), revising: true } });
    const onProgress = (event: CompileProgress): void => {
      if (generation !== contextGeneration) return;
      set({ compileProgress: applyProgress(get().compileProgress ?? progressStart(), event) });
    };
    const fail = (message: string): void => set({ busy: false, compileProgress: null, error: message });
    try {
      const response = await postCompile({
        level: base,
        prompt: AI_FIX_PROMPT,
        protectedIds: state.protectedIds,
        history: state.promptHistory.map((h) => ({ prompt: h })),
        ...(state.theme !== null ? { theme: state.theme } : {}),
        revision: { operations: [] },
      }, controller.signal, onProgress);
      if (generation !== contextGeneration) return;
      if (!response.ok) {
        fail(`${extractError(response.body)} The draft is unchanged.`);
        return;
      }
      const parsed = compileOkResponseSchema.safeParse(response.body);
      if (!parsed.success) {
        fail('The fix response failed validation. The draft is unchanged.');
        return;
      }
      const { result, baseRevision, cached, attempts, totalCostUsd, generationCostUsd } = parsed.data;
      if (baseRevision !== boundRevision || revisionId(get().draft?.level ?? get().acceptedLevel) !== boundRevision) {
        fail('The scene changed while the AI was working; the fix was discarded.');
        return;
      }
      set({
        lastResult: result,
        lastPrompt: AI_FIX_PROMPT,
        lastCompileMeta: { cached, totalCostUsd, generationCostUsd: generationCostUsd ?? null, attempts: attempts.length, model: attempts.at(-1)?.model ?? 'cache' },
      });
      if (result.type !== 'patch') {
        set({ busy: false, compileProgress: null, pendingRule: null, preview: null });
        return;
      }
      const kept = get().protectedIds;
      if (kept.length > 0 && touchesProtected(result.operations, new Set(kept))) {
        fail('The AI fix would change an object marked Keep these, so it was not offered.');
        return;
      }
      const applied = applyOperations(base, result.operations);
      if (!applied.ok) {
        fail(`The AI fix was rejected by the engine: ${applied.errors[0]}`);
        return;
      }
      const fixedReport = verify(applied.level);
      const outcome = fixedReport.accepted ? 'fixed' : reportScore(fixedReport) < reportScore(baseReport) ? 'improved' : 'unresolved';
      set({
        pendingRule: {
          kind: 'patch',
          base,
          candidate: applied.level,
          operations: result.operations,
          rationale: result.rationale,
          assumptions: result.assumptions,
          prompt: AI_FIX_PROMPT,
          nextTheme: get().theme,
          baseRevision: boundRevision,
          aiFix: true,
          revision: { findings, outcome },
        },
        preview: { source: 'ai', baseRevision: boundRevision, before: base, candidate: applied.level, operations: result.operations },
        repairReplay: null,
        selection: [],
        busy: false,
        compileProgress: null,
      });
    } catch (error) {
      if (generation === contextGeneration) {
        fail(`${error instanceof Error ? error.message : 'Network error.'} The draft is unchanged.`);
      }
    } finally {
      if (activeCompileController === controller) activeCompileController = null;
    }
  },

  cancelCompile: () => {
    if (!get().busy) return;
    contextGeneration += 1;
    activeCompileController?.abort();
    activeCompileController = null;
    set({ busy: false, compileProgress: null, error: 'Compile cancelled. Your prompt is still here.' });
  },

  approveRule: () => {
    const { pendingRule } = get();
    if (!pendingRule || pendingRule.kind !== 'rule') return;
    const kept = get().protectedIds;
    if (kept.length > 0 && touchesProtected(pendingRule.proposal.operations, new Set(kept))) {
      set({ error: 'This preview changes an object marked Keep these. Remove it from Keep these or revise the proposal before approving.' });
      return;
    }
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
        : summarizeChange(currentBase, level);
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
    set({ pendingRule: null, preview: null, lastResult: null, lastPrompt: null, evidence: null });
  },

  applyPatch: () => {
    const { pendingRule } = get();
    if (!pendingRule || pendingRule.kind !== 'patch') return;
    const kept = get().protectedIds;
    if (kept.length > 0 && touchesProtected(pendingRule.operations, new Set(kept))) {
      set({ error: 'This preview changes an object marked Keep these. Remove it from Keep these or revise the proposal before applying.' });
      return;
    }
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
    const summary = summarizeChange(currentBase, applied.level);
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
    set({ pendingRule: null, preview: null, lastResult: null, lastPrompt: null, evidence: null });
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
      compileProgress: null,
      theme: acceptedTheme,
      promptHistory: [...acceptedPromptHistory],
      changeSummary: null,
      ghost: GHOST_INITIAL,
      play: PLAY_INITIAL,
      repair: REPAIR_INITIAL,
      preview: null,
      repairReplay: null,
      selection: [],
      evidence: null,
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
      compileProgress: null,
      changeSummary: null,
      mode: 'authoring',
      ghost: GHOST_INITIAL,
      play: PLAY_INITIAL,
      repair: REPAIR_INITIAL,
      preview: null,
      repairReplay: null,
      selection: [],
      evidence: null,
    });
  },

  resetVault: () => {
    invalidateContext();
    const origin = get().originSceneId;
    const originScene = SCENES.find((scene) => scene.id === origin);
    set({
      acceptedLevel: originScene !== undefined && origin !== 'balcony-vault' ? originScene.level : initialLevel(),
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
      compileProgress: null,
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
      evidence: null,
      sceneId: origin,
      acceptedSceneId: origin,
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
          returnSceneId: current.acceptedSceneId,
          lineageKnown: false,
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
        compileProgress: null,
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
        evidence: null,
        viaShare: false,
        sceneId: id,
      });
      return;
    }

    set({
      ...(scene !== undefined ? { originSceneId: scene.id } : {}),
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
      compileProgress: null,
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
      evidence: null,
      viaShare: false,
      sceneId: id,
    });
  },

  watchWitness: (kind) =>
    set({
      mode: 'watching',
      ghost: { ...GHOST_INITIAL, witnessKind: kind },
      play: PLAY_INITIAL,
      evidence: null,
    }),


  startPlay: () => {
    invalidateContext();
    set({ mode: 'playing', ghost: GHOST_INITIAL, play: PLAY_INITIAL, pendingRule: null, preview: null, lastResult: null, lastPrompt: null, lastCompileMeta: null, busy: false, compileProgress: null, evidence: null });
  },

  exitToAuthoring: () => set({ mode: 'authoring', ghost: GHOST_INITIAL, play: PLAY_INITIAL, evidence: null }),


  runRepairs: (report) => {
    const { draft, acceptedLevel } = get();
    if (!draft) return;
    set({ repair: { ...REPAIR_INITIAL, status: 'running' } });
    const { protectedIds } = get();
    const repairBase = draft.lineageKnown === false ? draft.level : acceptedLevel;
    const result = findRepairs(repairBase, draft.level, report, protectedIds);
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
    const replayCheck = failing.length > 0 ? validateRoute(applied.level, failing) : null;
    set({
      preview: null,
      repairReplay: replayCheck?.ok === true ? failing : null,
      evidence: null,
      ...(replayCheck !== null && !replayCheck.ok
        ? { changeSummary: `Repair applied. The old witness could not be replayed: ${replayCheck.reason}` }
        : {}),
    });
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
    const level = get().draft?.level ?? get().acceptedLevel;
    const replayCheck = validateRoute(level, repairReplay);
    if (!replayCheck.ok) {
      set({ error: `The stored witness is stale and was not replayed: ${replayCheck.reason}` });
      return;
    }
    set({
      mode: 'watching',
      ghost: { ...GHOST_INITIAL, witnessKind: 'replay' },
      play: PLAY_INITIAL,
      preview: null,
      evidence: null,
    });
  },

  toggleSelect: (id) => {
    const { selection } = get();
    if (!selection.includes(id) && selection.length >= 8) {
      set({ error: 'Select up to 8 scene entities for one prompt.' });
      return;
    }
    set({
      selection: selection.includes(id) ? selection.filter((s) => s !== id) : [...selection, id],
      error: null,
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
      compileProgress: null,
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
      evidence: null,
    });
  },

  keepSelected: () => {
    const { selection, protectedIds } = get();
    if (selection.length === 0) return;
    const merged = [...new Set([...protectedIds, ...selection])];
    // Protections change what the search may offer: stale candidates and
    // their preview markers are void until the creator searches again.
    set({ protectedIds: merged, repair: REPAIR_INITIAL, preview: null, evidence: null });
  },

  unkeep: (id) => {
    const { protectedIds } = get();
    set({
      protectedIds: protectedIds.filter((p) => p !== id),
      repair: REPAIR_INITIAL,
      preview: null,
      evidence: null,
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
    const persisted = persistSavedScenes(safeBrowserStorage(), next);
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
    const persisted = persistSavedScenes(safeBrowserStorage(), next);
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
      compileProgress: null,
    });
  },

  clearRecovery: () => {
    const storage = safeBrowserStorage();
    const cleared = clearRecoveryRecord(storage);
    if (!cleared.ok) {
      set({ error: cleared.error });
      return;
    }
    const written = persistRecovery(storage, makeRecoverySnapshot(get()));
    if (!written.ok) {
      set({ recoveryStatus: 'unavailable', error: written.error });
      return;
    }
    set({ recoveryStatus: 'ready', error: null });
  },

  retryRecovery: () => {
    const result = persistRecovery(safeBrowserStorage(), makeRecoverySnapshot(get()));
    set({ recoveryStatus: result.ok ? 'ready' : 'unavailable', error: result.ok ? null : result.error });
  },

  setPromptDraft: (value) => set({ promptDraft: value.slice(0, 2000) }),
}));

const RECOVERY_FIELDS: Array<keyof AppState> = [
  'acceptedLevel',
  'acceptedSceneId',
  'sceneId',
  'acceptedTheme',
  'acceptedPromptHistory',
  'theme',
  'promptHistory',
  'promptDraft',
  'draft',
  'pendingRule',
  'selection',
  'protectedIds',
  'history',
  'previousAccepted',
  'lastPrompt',
  'changeSummary',
  'lastCompileMeta',
  'viaShare',
];

useApp.subscribe((state, previous) => {
  if (
    state.recoveryStatus === 'malformed' ||
    !RECOVERY_FIELDS.some((field) => state[field] !== previous[field])
  ) return;

  const result = persistRecovery(safeBrowserStorage(), makeRecoverySnapshot(state));
  const nextStatus = result.ok ? 'ready' : 'unavailable';
  if (state.recoveryStatus !== nextStatus) useApp.setState({ recoveryStatus: nextStatus });
});
