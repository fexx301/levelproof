import type { CompileResult } from '../../shared/compile-result.js';
import { useApp } from '../state/store.js';

/**
 * Result cards (§12): rule review with explicit approval, clarification
 * with entity-bound choices that resubmit with context, unsupported with
 * alternatives, and the patch rationale.
 */
export function ResultCards() {
  const pendingRule = useApp((s) => s.pendingRule);
  const lastResult = useApp((s) => s.lastResult);
  const lastPrompt = useApp((s) => s.lastPrompt);
  const busy = useApp((s) => s.busy);
  const approveRule = useApp((s) => s.approveRule);
  const declineRule = useApp((s) => s.declineRule);
  const submitPrompt = useApp((s) => s.submitPrompt);

  if (pendingRule) {
    const removed = pendingRule.proposal.oldRequirements.filter(
      (r) => !pendingRule.proposal.newRequirements.some((n) => n.keyId === r.keyId),
    );
    const added = pendingRule.proposal.newRequirements.filter(
      (r) => !pendingRule.proposal.oldRequirements.some((n) => n.keyId === r.keyId),
    );
    return (
      <section className="card card--rule" aria-label="Rule proposal">
        <h2 className="card-title">Rule changed — review required</h2>
        <p className="card-text">{pendingRule.proposal.reason}</p>
        <ul className="rule-diff">
          {removed.map((r) => (
            <li key={`remove-${r.keyId}`} className="rule-removed">
              Remove: collect “{r.keyId}” before the goal
            </li>
          ))}
          {added.map((r) => (
            <li key={`add-${r.keyId}`} className="rule-added">
              Add: collect “{r.keyId}” before the goal
            </li>
          ))}
          {removed.length === 0 && added.length === 0 && <li>No requirement changes</li>}
        </ul>
        {pendingRule.proposal.operations.length > 0 && (
          <p className="card-note">
            Carries {pendingRule.proposal.operations.length} geometry operation(s), held for the same
            review.
          </p>
        )}
        <div className="card-actions">
          <button type="button" onClick={approveRule}>
            Approve
          </button>
          <button type="button" onClick={declineRule}>
            Decline
          </button>
        </div>
      </section>
    );
  }

  const result: CompileResult | null = lastResult;
  if (!result) return null;

  if (result.type === 'clarification') {
    return (
      <section className="card card--clarification" aria-label="Clarification">
        <h2 className="card-title">One question</h2>
        <p className="card-text">{result.question}</p>
        <div className="choice-list">
          {result.choices.map((choice) => (
            <button
              key={choice.id}
              type="button"
              className="choice-button"
              disabled={busy || !lastPrompt}
              onClick={() => void submitPrompt(lastPrompt!, choice.label)}
            >
              {choice.label}
            </button>
          ))}
        </div>
      </section>
    );
  }

  if (result.type === 'unsupported') {
    return (
      <section className="card card--unsupported" aria-label="Unsupported request">
        <h2 className="card-title">Unsupported</h2>
        <p className="card-text">{result.reason}</p>
        <p className="card-note">Supported alternatives:</p>
        <ul className="alternative-list">
          {result.alternatives.map((alternative) => (
            <li key={alternative}>{alternative}</li>
          ))}
        </ul>
      </section>
    );
  }

  if (result.type === 'patch') {
    return (
      <section className="card" aria-label="Applied edit">
        <h2 className="card-title">Edit compiled</h2>
        <p className="card-text">{result.rationale}</p>
        {result.assumptions.length > 0 && (
          <p className="card-note">Assumed: {result.assumptions.join('; ')}</p>
        )}
      </section>
    );
  }

  return null;
}
