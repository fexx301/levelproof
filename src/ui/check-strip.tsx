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

function statusText(status: CheckedResult['status']): string {
  switch (status) {
    case 'pass':
      return 'pass';
    case 'fail':
      return 'fail';
    case 'unknown':
      return 'check incomplete';
    case 'not_applicable':
      return 'not applicable';
  }
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
  const checks: Array<{ name: string; result: CheckedResult; kind: CheckKind }> = [
    { name: 'Solution', result: report.checks.solution, kind: 'solution' },
    { name: 'Design requirements', result: report.checks.requirements, kind: 'requirements' },
    { name: 'Recovery', result: report.checks.recovery, kind: 'recovery' },
  ];
  return (
    <section className="check-strip" aria-label="Verification checks">
      <div className="check-strip-pin">
        <div className="check-strip-head">
          <h2>Checks</h2>
          <a href="#rules">Under these game rules</a>
        </div>
        <p className={`acceptance${report.accepted ? ' is-accepted' : ''}`} role="status">
          {report.accepted ? 'Accepted' : 'Not accepted'}
        </p>
      </div>
      {checks.map(({ name, result, kind }) => (
        <div key={name} className={`check check--${result.status}`}>
          <h3 className="check-name">
            <span>{name}</span>
            <span className="check-status">{statusText(result.status)}</span>
          </h3>
          <p className="check-explanation">{result.explanation}</p>
          <ExplainCheck kind={kind} failing={result.status === 'fail'} />
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
        <p className="inspector-body">
          {report.revisionId} · catalog {report.catalogVersion} · verifier {report.verifierVersion} ·{' '}
          {report.exploredCount} states explored · {ms.toFixed(1)} ms
          {!report.complete && ` · ${report.completionExplanation}`}
          {report.invalidReasons.length > 0 && ` · ${report.invalidReasons.join(' · ')}`}
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
      <p className="check-note">
        Exhaustive bounded exploration — one successful route never proves no bypasses or dead ends.
      </p>
    </section>
  );
}

/**
 * Grounded failure narration (§10): on a failed check the author can ask
 * the model to phrase the engine's causal story. The engine's verdict and
 * explanation above always stand on their own — this adds narrative, never
 * authority. Costs are disclosed like compiles.
 */
function ExplainCheck({ kind, failing }: { kind: CheckKind; failing: boolean }) {
  const explain = useApp((s) => s.explain);
  const explainCheck = useApp((s) => s.explainCheck);
  if (!failing) return null;
  const entry = explain.byCheck[kind];
  return (
    <div className="explain-check">
      {entry ? (
        <>
          <p className="explain-text" aria-live="polite">
            {entry.text}
          </p>
          <p className="explain-meta">
            {entry.meta.cached ? 'Cached explanation' : 'Fresh explanation'} · {entry.meta.model} · $
            {entry.meta.totalCostUsd.toFixed(5)} · {entry.meta.attempts} attempt
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
