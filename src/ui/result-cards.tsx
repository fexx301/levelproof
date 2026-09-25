import type { CompileResult } from '../../shared/compile-result.js';
import { useEffect, useRef } from 'react';
import { useApp } from '../state/store.js';
import { requirementId, requirementText } from '../core/level.js';
import { verify } from '../core/verifier.js';
import { describeOperations, summarizeChange } from '../core/operation-description.js';
import { SCENERY_OPERATION_KINDS, type Level, type Operation } from '../../shared/schema.js';
import type { ThemeKey } from '../../shared/api.js';
import type { Report } from '../core/verifier.js';
import { answerText, CHECK_QUESTIONS, DisclosureGlyph } from './check-strip.js';
import type { CheckKind } from '../state/store.js';

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
  const draft = useApp((s) => s.draft);
  const busy = useApp((s) => s.busy);
  const approveRule = useApp((s) => s.approveRule);
  const declineRule = useApp((s) => s.declineRule);
  const applyPatch = useApp((s) => s.applyPatch);
  const declinePatch = useApp((s) => s.declinePatch);
  const submitPrompt = useApp((s) => s.submitPrompt);
  const previewRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const target = previewRef.current;
    if (pendingChange === null || target === null || typeof window === 'undefined' || typeof target.scrollIntoView !== 'function') return;
    target.scrollIntoView({
      block: 'nearest',
      inline: 'nearest',
      behavior: 'auto',
    });
  }, [pendingChange]);

  const sceneChanges = (operations: Operation[], before: Level, candidate: Level, title: string) => {
    const descriptions = describeOperations(operations, before, candidate);
    if (descriptions.length === 0) return <p className="card-note">No scene geometry changes.</p>;
    const list = (
      <ul className="preview-change-list" aria-label={title}>
        {descriptions.map((description, index) => <li key={`change-${index}`}>{description}</li>)}
      </ul>
    );
    return (
      <div className="preview-changes">
        <div className="preview-legend" aria-label="Scene marker key">
          <span className="preview-legend-before">Before / removed</span>
          <span className="preview-legend-after">Proposed / added</span>
        </div>
        {descriptions.length <= 4 ? (
          <>
            <p className="card-title">{title}</p>
            {list}
          </>
        ) : (
          <details className="preview-details">
            <summary><DisclosureGlyph />{title}: all {descriptions.length} changes</summary>
            {list}
          </details>
        )}
      </div>
    );
  };

  if (pendingChange?.kind === 'patch') {
    const candidateReport = verify(pendingChange.candidate);
    const hasScenery = pendingChange.operations.some((operation) => SCENERY_OPERATION_KINDS.has(operation.kind));
    const revision = pendingChange.revision;
    return (
      <section ref={previewRef} className="card card--preview" aria-label="Edit preview">
        <div className="card-heading-row">
          <h2 className="card-title">{pendingChange.aiFix ? 'AI fix — preview' : 'Edit preview'}</h2>
          <span className="preview-badge">{pendingChange.operations.length} op{pendingChange.operations.length === 1 ? '' : 's'}</span>
        </div>
        <p className="card-summary">{summarizeChange(pendingChange.base, pendingChange.candidate)}</p>
        <p className="card-text">{pendingChange.rationale}</p>
        {revision !== undefined && <RevisionNote revision={revision} aiFix={pendingChange.aiFix === true} />}
        <EnginePrecheck report={candidateReport} />
        <p className="card-note">
          Nothing has changed yet — the scene shows the proposal. Apply {candidateReport.accepted ? 'accepts it as your new checkpoint.' : 'keeps it as a draft you can repair; your accepted checkpoint stays safe.'}
        </p>
        {sceneChanges(pendingChange.operations, pendingChange.base, pendingChange.candidate, 'Proposed scene changes')}
        {hasScenery && (
          <p className="card-note">Scenery (trees, statues, creatures, water) is decoration: the engine ignores it, and it never blocks or changes play.</p>
        )}
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
      <section ref={previewRef} className="card card--rule" aria-label="Rule proposal">
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
          <>
            <p className="card-note">These scene changes are part of the same approval:</p>
            {sceneChanges(pendingChange.proposal.operations, pendingChange.base, pendingChange.candidate, 'Scene changes')}
          </>
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
        <h2 className="card-title">{draft ? 'Edit applied — draft' : 'Edit applied — accepted'}</h2>
        <p className="card-text">{result.rationale}</p>
        {draft && <p className="card-note">The accepted checkpoint is still safe. Use Repairs or Return to accepted when you are ready.</p>}
        {result.assumptions.length > 0 && (
          <p className="card-note">Assumed: {result.assumptions.join('; ')}</p>
        )}
      </section>
    );
  }

  return (
    <section className="card" aria-label="Applied rule">
      <h2 className="card-title">Rule applied{draft ? ' — draft' : ' — accepted'}</h2>
      <p className="card-text">The reviewed requirement change is now part of the current scene.</p>
      {draft && <p className="card-note">The accepted checkpoint remains available while this draft is repaired or discarded.</p>}
    </section>
  );
}

/** What the engine would conclude if the proposal were applied. */
function EnginePrecheck({ report }: { report: Report }) {
  const rows: Array<{ kind: CheckKind; status: Report['checks']['solution']['status'] }> = [
    { kind: 'solution', status: report.checks.solution.status },
    { kind: 'requirements', status: report.checks.requirements.status },
    { kind: 'recovery', status: report.checks.recovery.status },
  ];
  return (
    <div className="precheck" aria-label="Engine pre-check of this proposal">
      <p className="precheck-title">Engine pre-check</p>
      <ul>
        {rows.map((row) => (
          <li key={row.kind} className={`precheck-row precheck-row--${row.status}`}>
            <span>{CHECK_QUESTIONS[row.kind].question}</span>
            <strong>{answerText(row.kind, row.status)}</strong>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The AI↔engine loop, disclosed: what the engine found and what the revision did. */
function RevisionNote({ revision, aiFix }: { revision: { findings: string[]; outcome: 'fixed' | 'improved' | 'unresolved' }; aiFix: boolean }) {
  const headline = aiFix
    ? revision.outcome === 'fixed'
      ? 'The AI proposed a fix and the engine confirms every check passes.'
      : revision.outcome === 'improved'
        ? 'The AI proposed a fix that resolves some findings; review what remains.'
        : 'The AI’s proposal does not resolve the findings — the checked repairs below may do better.'
    : revision.outcome === 'fixed'
      ? 'Revised once: the model’s first build could not be won, so the engine’s findings went back to the model and this revision fixes them.'
      : revision.outcome === 'improved'
        ? 'Revised once after the engine’s check; the revision is better but still fails a check.'
        : 'The model’s first build could not be won and its revision did not fix it; showing the first build so you can repair it.';
  return (
    <div className={`revision-note revision-note--${revision.outcome}`}>
      <p>{headline}</p>
      <details>
        <summary><DisclosureGlyph />What the engine found</summary>
        <ul>
          {revision.findings.map((finding) => <li key={finding}>{finding}</li>)}
        </ul>
      </details>
    </div>
  );
}
