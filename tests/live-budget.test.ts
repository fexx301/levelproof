import { describe, expect, it } from 'vitest';
import { LiveBudget, LiveEvaluationStop, requireLiveBudget } from '../scripts/live-budget';

describe('live evaluation spending guard', () => {
  it('requires explicit opt-in and a positive capped budget', () => {
    expect(() => requireLiveBudget([], 'Usage')).toThrow(/disabled by default/);
    expect(() => requireLiveBudget(['--confirm-live-ai'], 'Usage')).toThrow(/--budget-usd/);
    expect(() => requireLiveBudget(['--confirm-live-ai', '--budget-usd', '1.01'], 'Usage')).toThrow(/between 0/);
    expect(requireLiveBudget(['--confirm-live-ai', '--budget-usd', '1'], 'Usage')).toBe(1);
    expect(requireLiveBudget(['--confirm-live-ai', '--budget-usd', '0.12'], 'Usage')).toBe(0.12);
  });

  it('stops immediately on unknown costs or after crossing the ceiling', () => {
    const budget = new LiveBudget(0.1);
    budget.record(0.06, 'first call');
    expect(() => budget.record(null, 'second call')).toThrow(LiveEvaluationStop);
    expect(() => budget.record(0.05, 'third call')).toThrow(/exceeded/);
    expect(budget.spentUsd).toBeCloseTo(0.11);
  });

  it('refuses another call once spend reaches the ceiling', () => {
    const budget = new LiveBudget(0.1);
    budget.record(0.1, 'last allowed call');
    expect(() => budget.ensureCanCall('next call')).toThrow(/ceiling has been reached/);
  });
});
