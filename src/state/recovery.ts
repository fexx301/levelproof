import { z } from 'zod';
import { compileResultSchema } from '../../shared/compile-result.js';
import { themeKeySchema } from '../../shared/api.js';
import { levelSchema } from '../../shared/schema.js';
import { applyOperations, applyRuleProposal } from '../core/level.js';
import { revisionId } from '../core/serialize.js';
import { verify } from '../core/verifier.js';
import type { StorageLike } from './persistence.js';

export const RECOVERY_KEY = 'levelproof:session-recovery';
export const RECOVERY_VERSION = 1;

const promptHistorySchema = z.array(z.string().min(1).max(2000)).max(6);
const themeSchema = themeKeySchema.nullable();

const historyEntrySchema = z.strictObject({
  level: levelSchema,
  label: z.string().max(200),
  theme: themeSchema,
  promptHistory: promptHistorySchema,
});

const checkpointSchema = z.strictObject({
  level: levelSchema,
  theme: themeSchema,
  promptHistory: promptHistorySchema,
  history: z.array(historyEntrySchema).max(12),
  sceneId: z.string().max(160),
});

const pendingResultSchema = compileResultSchema.refine(
  (result) => result.type === 'patch' || result.type === 'rule_proposal',
);

const recoverySchema = z.strictObject({
  version: z.literal(RECOVERY_VERSION),
  acceptedLevel: levelSchema,
  acceptedSceneId: z.string().max(160),
  sceneId: z.string().max(160),
  acceptedTheme: themeSchema,
  acceptedPromptHistory: promptHistorySchema,
  theme: themeSchema,
  promptHistory: promptHistorySchema,
  promptDraft: z.string().max(2000),
  draft: z.strictObject({
    level: levelSchema,
    viaRule: z.boolean(),
    returnSceneId: z.string().max(160).nullable(),
    lineageKnown: z.boolean().optional(),
  }).nullable(),
  pending: z.strictObject({
    base: levelSchema,
    result: pendingResultSchema,
    prompt: z.string().min(1).max(2000),
    nextTheme: themeSchema,
    baseRevision: z.string().max(80),
  }).nullable(),
  selection: z.array(z.string().max(160)).max(8),
  protectedIds: z.array(z.string().max(160)).max(256),
  history: z.array(historyEntrySchema).max(12),
  previousAccepted: checkpointSchema.nullable(),
  lastPrompt: z.string().max(2000).nullable(),
  changeSummary: z.string().max(500).nullable(),
  lastCompileMeta: z.strictObject({
    cached: z.boolean(),
    totalCostUsd: z.number().nullable(),
    generationCostUsd: z.number().nullable(),
    attempts: z.number().int().nonnegative(),
    model: z.string().max(200),
  }).nullable(),
});

export type RecoverySnapshot = z.infer<typeof recoverySchema>;
export type RecoveryRead =
  | { status: 'empty' }
  | { status: 'ready'; snapshot: RecoverySnapshot }
  | { status: 'malformed' }
  | { status: 'unavailable' };
export type RecoveryWrite = { ok: true } | { ok: false; error: string };

/** Parse both structure and the invariant that the accepted checkpoint is green. */
export function parseRecoverySnapshot(value: unknown): RecoverySnapshot | null {
  const parsed = recoverySchema.safeParse(value);
  if (!parsed.success || !verify(parsed.data.acceptedLevel).accepted) return null;
  if (parsed.data.draft !== null) {
    const report = verify(parsed.data.draft.level);
    if (!report.valid || report.accepted) return null;
  }
  if (parsed.data.previousAccepted !== null && !verify(parsed.data.previousAccepted.level).accepted) return null;
  if (parsed.data.pending !== null) {
    const activeBase = parsed.data.draft?.level ?? parsed.data.acceptedLevel;
    const pending = parsed.data.pending;
    if (revisionId(activeBase) !== pending.baseRevision || revisionId(pending.base) !== pending.baseRevision) return null;
    if (pending.result.type !== 'patch' && pending.result.type !== 'rule_proposal') return null;
    const applied = pending.result.type === 'patch'
      ? applyOperations(activeBase, pending.result.operations)
      : applyRuleProposal(activeBase, pending.result);
    if (!applied.ok) return null;
  }
  return parsed.data;
}

export function readRecovery(storage: StorageLike | undefined): RecoveryRead {
  if (storage === undefined) return { status: 'unavailable' };
  try {
    const raw = storage.getItem(RECOVERY_KEY);
    if (raw === null) return { status: 'empty' };
    const snapshot = parseRecoverySnapshot(JSON.parse(raw) as unknown);
    return snapshot === null ? { status: 'malformed' } : { status: 'ready', snapshot };
  } catch {
    return { status: 'malformed' };
  }
}

export function persistRecovery(storage: StorageLike | undefined, snapshot: RecoverySnapshot): RecoveryWrite {
  if (storage === undefined) {
    return { ok: false, error: 'This browser does not provide local storage. Draft recovery is unavailable.' };
  }
  try {
    storage.setItem(RECOVERY_KEY, JSON.stringify(snapshot));
    return { ok: true };
  } catch {
    return { ok: false, error: 'The draft could not be saved for recovery. Current work is only in this tab.' };
  }
}

export function clearRecovery(storage: StorageLike | undefined): RecoveryWrite {
  if (storage?.removeItem === undefined) {
    return { ok: false, error: 'This browser cannot clear the unreadable recovery entry.' };
  }
  try {
    storage.removeItem(RECOVERY_KEY);
    return { ok: true };
  } catch {
    return { ok: false, error: 'The unreadable recovery entry could not be removed.' };
  }
}
