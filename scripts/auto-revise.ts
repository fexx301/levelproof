/**
 * The editor's AI↔engine revision loop (src/state/store.ts submitPrompt),
 * reproduced for the in-process evaluation scripts so their grades reflect
 * what an author actually sees: up to MAX_AUTO_REVISIONS rounds while the
 * best build is unwinnable, and a revision replaces the best only when it is
 * a patch that scores strictly better.
 */
import { compile } from '../api/_lib/compile-service';
import { applyOperations } from '../src/core/level';
import { MAX_AUTO_REVISIONS, shouldAutoRevise } from '../src/core/revision-policy';
import { reportScore } from '../src/core/report-score';
import { verify } from '../src/core/verifier';
import type { CompileInput } from '../api/_lib/compile-service';
import type { CompileResult } from '../shared/compile-result';
import type { Level } from '../shared/schema';

type Outcome = Awaited<ReturnType<typeof compile>>;

export interface RevisedCompile {
  outcome: Outcome;
  /** Every provider-reported cost, in call order (null = unknown). */
  costs: Array<number | null>;
  rounds: number;
}

export async function compileWithRevision(env: NodeJS.ProcessEnv, request: CompileInput, beforeCall: () => void = () => {}): Promise<RevisedCompile> {
  beforeCall();
  const first = await compile(env, request);
  const costs = [first.totalCostUsd];
  const result: CompileResult | null = first.result;
  if (result === null || result.type !== 'patch') return { outcome: first, costs, rounds: 0 };
  const applied = applyOperations(request.level as Level, result.operations);
  if (!applied.ok || !shouldAutoRevise(request.level as Level, applied.level, result.operations)) return { outcome: first, costs, rounds: 0 };
  let best: Outcome = first;
  let bestLevel = applied.level;
  let bestScore = reportScore(verify(applied.level));
  let latest = result.operations;
  let rounds = 0;
  while (rounds < MAX_AUTO_REVISIONS && verify(bestLevel).checks.solution.status === 'fail') {
    beforeCall();
    const revised = await compile(env, { ...request, revision: { operations: latest } });
    costs.push(revised.totalCostUsd);
    rounds += 1;
    if (revised.result === null || revised.result.type !== 'patch') break;
    latest = revised.result.operations;
    const revisedApplied = applyOperations(request.level as Level, revised.result.operations);
    if (!revisedApplied.ok) continue;
    const score = reportScore(verify(revisedApplied.level));
    if (score < bestScore) {
      best = revised;
      bestLevel = revisedApplied.level;
      bestScore = score;
    }
  }
  return { outcome: best, costs, rounds };
}
