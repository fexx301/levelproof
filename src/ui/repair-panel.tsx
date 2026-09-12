import { useApp } from '../state/store.js';
import type { Report } from '../core/verifier.js';

/**
 * Checked repairs (§9, §12): only fully checked candidates are shown; a
 * chosen repair is applied to the exact draft revision and re-verified
 * before it can replace the accepted level. Apply errors render here, next
 * to the button that caused them.
 */
export function RepairPanel({ report }: { report: Report }) {
  const draft = useApp((s) => s.draft);
  const repair = useApp((s) => s.repair);
  const runRepairs = useApp((s) => s.runRepairs);
  const applyRepair = useApp((s) => s.applyRepair);

  if (!draft || draft.report.accepted) return null;

  return (
    <section className="panel" aria-label="Repairs">
      <h2 className="panel-title">Repairs</h2>
      {repair.status === 'idle' || repair.status === 'running' ? (
        <>
          <p className="panel-note">Search checked fixes that keep every active rule.</p>
          <button
            type="button"
            disabled={repair.status === 'running'}
            style={{ minWidth: '8rem' }}
            onClick={() => runRepairs(report)}
          >
            {repair.status === 'running' ? 'Searching…' : 'Find repairs'}
          </button>
        </>
      ) : (
        <>
          <p className="panel-note">
            {repair.note} {repair.explored} candidate{repair.explored === 1 ? '' : 's'} checked in{' '}
            {repair.durationMs.toFixed(1)} ms.
          </p>
          {repair.candidates.map((candidate, index) => (
            <div key={candidate.key} className="repair-card">
              <p className="repair-description">{candidate.description}</p>
              <button type="button" onClick={() => applyRepair(index)}>
                Apply
              </button>
            </div>
          ))}
          {repair.applyError && (
            <p className="compile-error" role="alert">
              {repair.applyError}
            </p>
          )}
        </>
      )}
    </section>
  );
}
