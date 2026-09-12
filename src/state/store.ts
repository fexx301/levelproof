import { create } from 'zustand';
import type { CompileResult, RuleProposalResult } from '../../shared/compile-result';
import { compileOkResponseSchema } from '../../shared/api';
import type { Level } from '../../shared/schema';
import { vaultEmptyLevel } from '../core/fixtures/vault-empty';
import { applyOperations } from '../core/level';
import { verify, type Report } from '../core/verifier';

/**
 * Accepted/draft revision state (§11). One accepted checkpoint, at most one
 * structurally valid editable draft, one-step undo. A complete passing edit
 * becomes accepted; a failing or incomplete draft stays visible and labeled
 * with **Return to accepted** always available. Every compile refers to its
 * base revision; stale results are simply replaced.
 */

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

interface AppState {
  acceptedLevel: Level;
  previousAccepted: Level | null;
  draft: DraftState | null;
  pendingRule: { proposal: RuleProposalResult; base: Level } | null;
  lastResult: CompileResult | null;
  lastPrompt: string | null;
  lastCompileMeta: CompileMeta | null;
  busy: boolean;
  error: string | null;
  submitPrompt: (prompt: string, clarificationContext?: string) => Promise<void>;
  approveRule: () => void;
  declineRule: () => void;
  discardDraft: () => void;
  undo: () => void;
  resetVault: () => void;
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
}

export const useApp = create<AppState>()((set, get) => ({
  acceptedLevel: vaultEmptyLevel,
  previousAccepted: null,
  draft: null,
  pendingRule: null,
  lastResult: null,
  lastPrompt: null,
  lastCompileMeta: null,
  busy: false,
  error: null,

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
        set({ busy: false, error: extractError(body) });
        return;
      }
      const parsed = compileOkResponseSchema.safeParse(body);
      if (!parsed.success) {
        set({ busy: false, error: 'The compile response failed validation.' });
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

  discardDraft: () => set({ draft: null }),

  undo: () => {
    const { previousAccepted } = get();
    if (!previousAccepted) return;
    set({ acceptedLevel: previousAccepted, previousAccepted: null, draft: null, pendingRule: null });
  },

  resetVault: () =>
    set({
      acceptedLevel: vaultEmptyLevel,
      previousAccepted: null,
      draft: null,
      pendingRule: null,
      lastResult: null,
      lastPrompt: null,
      lastCompileMeta: null,
      error: null,
    }),
}));
