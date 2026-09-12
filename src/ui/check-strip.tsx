import type { Level } from '../../shared/schema';
import type { CheckedResult, Report } from '../core/verifier';

/** Active-rule chips (§12): the requirements are visible before and after every edit. */
export function RuleChips({ level }: { level: Level }) {
  if (level.requirements.length === 0) {
    return <span className="rule-chip rule-chip--none">No rules set</span>;
  }
  return (
    <>
      {level.requirements.map((requirement) => (
        <span key={requirement.keyId} className="rule-chip">
          Collect “{requirement.keyId}” before the goal
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

/** The three-check strip with surfaced measurements (§7, §12). */
export function CheckStrip({ report, ms }: { report: Report; ms: number }) {
  const checks: Array<{ name: string; result: CheckedResult }> = [
    { name: 'Solution', result: report.checks.solution },
    { name: 'Design requirements', result: report.checks.requirements },
    { name: 'Recovery', result: report.checks.recovery },
  ];
  return (
    <section className="check-strip" aria-label="Verification checks">
      <p className={`acceptance${report.accepted ? ' is-accepted' : ''}`}>
        {report.accepted ? 'Accepted' : 'Not accepted'}
      </p>
      {checks.map(({ name, result }) => (
        <div key={name} className={`check check--${result.status}`}>
          <h3 className="check-name">
            <span>{name}</span>
            <span className="check-status">{statusText(result.status)}</span>
          </h3>
          <p className="check-explanation">{result.explanation}</p>
        </div>
      ))}
      <p className="check-meta">
        {report.revisionId} · catalog {report.catalogVersion} · verifier {report.verifierVersion} ·{' '}
        {report.exploredCount} states explored · {ms.toFixed(1)} ms
      </p>
      <p className="check-note">
        Under these game rules. Exhaustive bounded exploration — one successful route never proves
        no bypasses or dead ends.
      </p>
    </section>
  );
}
