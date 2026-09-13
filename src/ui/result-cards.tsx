import type { CompileResult } from '../../shared/compile-result.js';
import { useApp } from '../state/store.js';
import { requirementId, requirementText } from '../core/level.js';
import { verify } from '../core/verifier.js';
import type { ThemeKey } from '../../shared/api.js';

const THEME_LABELS: Record<ThemeKey, string> = {
  limestone: 'Limestone ruin',
  ivory: 'Ivory observatory',
  patina: 'Patina relay works',
  basalt: 'Basalt lockhouse',
  futuristic: 'Futuristic vault',
};

/**
 * Result cards (§12): rule review with explicit approval, clarification
 * with entity-bound choices that resubmit with context, unsupported with
 * alternatives, and the patch rationale.
 */
export function ResultCards() {
  const pendingChange = useApp((s) => s.pendingRule);
  const lastResult = useApp((s) => s.lastResult);
  const lastPrompt = useApp((s) => s.lastPrompt);
  const busy = useApp((s) => s.busy);
  const approveRule = useApp((s) => s.approveRule);
  const declineRule = useApp((s) => s.declineRule);
  const applyPatch = useApp((s) => s.applyPatch);
  const declinePatch = useApp((s) => s.declinePatch);
  const submitPrompt = useApp((s) => s.submitPrompt);

  if (pendingChange?.kind === 'patch') {
    const candidateReport = verify(pendingChange.candidate);
    return (
      <section className="card card--preview" aria-label="Edit preview">
        <div className="card-heading-row">
          <h2 className="card-title">Edit preview</h2>
          <span className="preview-badge">{pendingChange.operations.length} op{pendingChange.operations.length === 1 ? '' : 's'}</span>
        </div>
        <p className="card-text">{pendingChange.rationale}</p>
        <p className="card-note">
          Nothing has changed yet. Review the red/green scene markers, then apply when the edit looks right.
        </p>
        <p className="card-note">
          Apply will {candidateReport.accepted ? 'accept this checkpoint.' : 'leave a draft for repair or review.'}
        </p>
        {pendingChange.nextTheme !== null && (
          <p className="card-note">Theme on apply: {THEME_LABELS[pendingChange.nextTheme]}</p>
        )}
        {pendingChange.assumptions.length > 0 && (
          <p className="card-note">Assumed: {pendingChange.assumptions.join('; ')}</p>
        )}
        <div className="card-actions">
          <button type="button" onClick={applyPatch}>Apply edit</button>
          <button type="button" onClick={declinePatch}>Keep current</button>
        </div>
      </section>
    );
  }

  if (pendingChange?.kind === 'rule') {
    const removed = pendingChange.proposal.oldRequirements.filter(
      (r) => !pendingChange.proposal.newRequirements.some((n) => requirementId(n) === requirementId(r)),
    );
    const added = pendingChange.proposal.newRequirements.filter(
      (r) => !pendingChange.proposal.oldRequirements.some((n) => requirementId(n) === requirementId(r)),
    );
    return (
      <section className="card card--rule" aria-label="Rule proposal">
        <h2 className="card-title">Rule changed — review required</h2>
        <p className="card-text">{pendingChange.proposal.reason}</p>
        <ul className="rule-diff">
          {removed.map((r) => (
            <li key={`remove-${requirementId(r)}`} className="rule-removed">
              Remove: {requirementText(r)}
            </li>
          ))}
          {added.map((r) => (
            <li key={`add-${requirementId(r)}`} className="rule-added">
              Add: {requirementText(r)}
            </li>
          ))}
          {removed.length === 0 && added.length === 0 && <li>No requirement changes</li>}
        </ul>
        {pendingChange.proposal.operations.length > 0 && (
          <p className="card-note">
            Carries {pendingChange.proposal.operations.length} geometry operation(s), held for the same
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
        <h2 className="card-title">Edit applied</h2>
        <p className="card-text">{result.rationale}</p>
        {result.assumptions.length > 0 && (
          <p className="card-note">Assumed: {result.assumptions.join('; ')}</p>
        )}
      </section>
    );
  }

  return null;
}
