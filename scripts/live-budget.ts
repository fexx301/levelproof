/** Explicitly authorized evaluation ceiling. Keep live runs opt-in regardless. */
export const MAX_LIVE_EVAL_BUDGET_USD = 1;

export class LiveEvaluationStop extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LiveEvaluationStop';
  }
}

/** Live scripts require deliberate opt-in and share one conservative ceiling. */
export function requireLiveBudget(args: string[], usage: string): number {
  if (!args.includes('--confirm-live-ai')) {
    throw new LiveEvaluationStop(`Live AI calls are disabled by default. ${usage}`);
  }
  const budgetIndex = args.indexOf('--budget-usd');
  const rawBudget = budgetIndex < 0 ? undefined : args[budgetIndex + 1];
  const budget = rawBudget === undefined ? Number.NaN : Number(rawBudget);
  if (!Number.isFinite(budget) || budget <= 0 || budget > MAX_LIVE_EVAL_BUDGET_USD) {
    throw new LiveEvaluationStop(
      `Supply --budget-usd between 0 and ${MAX_LIVE_EVAL_BUDGET_USD}; the live evaluator will stop when reported or estimated spend reaches this ceiling. A provider-side hard spending cap is still required.`,
    );
  }
  return budget;
}

/** Post-response guard. A missing cost makes further paid calls unsafe. */
export class LiveBudget {
  private total = 0;

  constructor(readonly limitUsd: number) {}

  get spentUsd(): number {
    return this.total;
  }

  ensureCanCall(label: string): void {
    if (this.total >= this.limitUsd) {
      throw new LiveEvaluationStop(`Stopping before ${label}: the $${this.limitUsd.toFixed(5)} software ceiling has been reached.`);
    }
  }

  record(costUsd: number | null, label: string): void {
    if (costUsd === null || !Number.isFinite(costUsd) || costUsd < 0) {
      throw new LiveEvaluationStop(`Stopping after ${label}: provider cost is unknown; no further live calls were made.`);
    }
    this.total += costUsd;
    if (this.total > this.limitUsd) {
      throw new LiveEvaluationStop(
        `Stopping after ${label}: measured spend $${this.total.toFixed(5)} exceeded the $${this.limitUsd.toFixed(5)} software ceiling. A single completed request can cross the ceiling; use a provider-side hard cap.`,
      );
    }
  }
}
