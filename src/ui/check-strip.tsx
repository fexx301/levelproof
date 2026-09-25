import type { Level } from '../../shared/schema.js';
import { requirementId, requirementText } from '../core/level.js';
import type { CheckedResult, Report } from '../core/verifier.js';
import type { CheckKind } from '../state/store.js';
import { useApp } from '../state/store.js';

/** Active-rule chips (§12): the requirements are visible before and after every edit. */
export function RuleChips({ level }: { level: Level }) {
  if (level.requirements.length === 0) {
    return <span className="rule-chip rule-chip--none">No rules set</span>;
  }
  return (
    <>
      {level.requirements.map((requirement) => (
        <span key={requirementId(requirement)} className="rule-chip">
          {requirementText(requirement)}
        </span>
      ))}
    </>
  );
}

/** Plain-language questions, each backed by the named exhaustive check. */
export const CHECK_QUESTIONS: Record<CheckKind, { question: string; technical: string }> = {
  solution: { question: 'Can it be won?', technical: 'Solution' },
  requirements: { question: 'Does it follow your rules?', technical: 'Design requirements' },
  recovery: { question: 'Can a player get stuck?', technical: 'Recovery' },
};

/** The answer to the question, not the raw status: "stuck? — Never". */
export function answerText(kind: CheckKind, status: CheckedResult['status']): string {
  if (status === 'unknown') return 'Check incomplete';
  if (status === 'not_applicable') return kind === 'requirements' ? 'No rules set' : 'Not applicable';
  if (kind === 'recovery') return status === 'pass' ? 'Never' : 'Yes';
  return status === 'pass' ? 'Yes' : 'No';
}


export function DisclosureGlyph() {
  return (
    <span className="disclosure-glyph" aria-hidden="true">
      ›
    </span>
  );
}

/**
 * The three-check strip (§12): always reachable at the panel's foot, the
 * verdict line forward and announced, the "Under these game rules" link
 * beside the indicators, and measurement details folded into a collapsible
 * inspector. Internal errors and incomplete-exploration explanations render
 * rather than silently blocking acceptance.
 */
export function CheckStrip({ report, ms }: { report: Report; ms: number }) {
  const checks: Array<{ result: CheckedResult; kind: CheckKind }> = [
    { result: report.checks.solution, kind: 'solution' },
    { result: report.checks.requirements, kind: 'requirements' },
    { result: report.checks.recovery, kind: 'recovery' },
  ];
  return (
    <section className="check-strip" aria-label="Verification checks">
      <div className="check-strip-pin">
        <div className="check-strip-head">
          <h2>Engine checks</h2>
          <a href="#rules">Under these game rules</a>
        </div>
        <p className={`acceptance${report.accepted ? ' is-accepted' : ''}`} role="status">
          <span>{report.accepted ? 'Accepted' : 'Not accepted'}</span>
          <span className="acceptance-note">{report.complete ? `${report.exploredCount} reachable states checked` : 'exploration incomplete'}</span>
        </p>
      </div>
      {checks.map(({ result, kind }) => (
        <div key={kind} className={`check check--${result.status}`}>
          <h3 className="check-name">
            <span>
              {CHECK_QUESTIONS[kind].question}
              <span className="check-technical">{CHECK_QUESTIONS[kind].technical}</span>
            </span>
            <span className="check-status">{answerText(kind, result.status)}</span>
          </h3>
          {result.status !== 'pass' && result.status !== 'not_applicable' && (
            <p className="check-explanation">{result.explanation}</p>
          )}
          <ExplainCheck kind={kind} failing={result.status === 'fail'} replayable={result.witness !== undefined} />
        </div>
      ))}
      {report.internalError && (
        <p className="compile-error" role="alert">
          Verifier check failed: {report.internalError}
        </p>
      )}
      <details className="inspector">
        <summary>
          <DisclosureGlyph />
          Inspector
        </summary>
        <ul className="inspector-body inspector-checks">
          {checks.map(({ result, kind }) => (
            <li key={kind}>{CHECK_QUESTIONS[kind].technical}: {result.explanation}</li>
          ))}
        </ul>
        <p className="inspector-body">
          {report.revisionId} · catalog {report.catalogVersion} · verifier {report.verifierVersion} ·{' '}
          {report.exploredCount} states explored · {ms.toFixed(1)} ms
          {!report.complete && ` · ${report.completionExplanation}`}
          {report.invalidReasons.length > 0 && ` · ${report.invalidReasons.join(' · ')}`}
        </p>
        <p className="check-note">
          Exhaustive bounded exploration — one successful route never proves no bypasses or dead ends.
        </p>
      </details>
      {report.recoveryMap !== undefined &&
        (report.recoveryMap.stranded.length > 0 || report.recoveryMap.unreachable.length > 0) && (
          <p className="analysis-note">
            {report.recoveryMap.stranded.length > 0 &&
              `${report.recoveryMap.stranded.length} red floor${report.recoveryMap.stranded.length === 1 ? '' : 's'} can strand a player`}
            {report.recoveryMap.stranded.length > 0 && report.recoveryMap.unreachable.length > 0 && ' · '}
            {report.recoveryMap.unreachable.length > 0 &&
              `${report.recoveryMap.unreachable.length} dimmed floor${report.recoveryMap.unreachable.length === 1 ? '' : 's'} unreachable`}
            .
          </p>
        )}
    </section>
  );
}

/**
 * Grounded failure narration (§10): on a failed check the author can ask
 * the model to phrase the engine's causal story. The engine's verdict and
 * explanation above always stand on their own — this adds narrative, never
 * authority. Costs are disclosed like compiles.
 */
function ExplainCheck({ kind, failing, replayable }: { kind: CheckKind; failing: boolean; replayable: boolean }) {
  const explain = useApp((s) => s.explain);
  const explainCheck = useApp((s) => s.explainCheck);
  const showProblem = useApp((s) => s.showProblem);
  if (!failing) return null;
  const entry = explain.byCheck[kind];
  return (
    <div className="explain-check">
      {replayable && (
        <button type="button" className="evidence-button" onClick={() => showProblem(kind)}>
          Show the problem
        </button>
      )}
      {entry ? (
        <>
          <p className="explain-text" aria-live="polite">
            {entry.text}
          </p>
          <p className="explain-meta">
            {entry.meta.cached ? 'Cached · no new model call' : 'Fresh'} · {entry.meta.model} ·{' '}
            {entry.meta.cached
              ? `original cost ${entry.meta.generationCostUsd === null ? 'unavailable' : `$${entry.meta.generationCostUsd.toFixed(5)}`}`
              : `this call ${entry.meta.totalCostUsd === null ? 'cost unavailable' : `$${entry.meta.totalCostUsd.toFixed(5)}`}`} ·{' '}
            {entry.meta.attempts} attempt
            {entry.meta.attempts === 1 ? '' : 's'}
          </p>
        </>
      ) : (
        <button type="button" className="explain-button" disabled={explain.busy} onClick={() => void explainCheck(kind)}>
          {explain.busy ? 'Explaining…' : 'Why did this fail?'}
        </button>
      )}
      {explain.error && <p className="explain-error">{explain.error}</p>}
    </div>
  );
}
