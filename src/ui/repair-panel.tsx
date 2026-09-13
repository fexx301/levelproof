import { useApp } from '../state/store.js';
import type { Operation } from '../../shared/schema.js';
import type { Report } from '../core/verifier.js';

/** Template-derived consequence text: what the repair keeps and what it
 * changes, so "checked repair" is tangible before applying. */
function consequenceText(operations: Operation[]): string {
  for (const op of operations) {
    if (op.kind === 'moveItem') {
      const isSwitch = op.id.includes('switch') || op.id.includes('seal');
      if (isSwitch) {
        return 'The sealing door stays exactly as you built it — only the trigger moves. The keyless route can no longer press it.';
      }
      return 'The key moves onto the shortcut itself, so every route through it collects the key.';
    }
    if (op.kind === 'addDoor' && op.door.conditions?.requiresKey !== undefined) {
      return 'The shortcut stays — but its entrance now needs the key, so the keyless route is gone.';
    }
    if (op.kind === 'removeDoor') {
      return 'The sealing door is removed; the trap mechanic goes with it.';
    }
    if (op.kind === 'setDoorConditions') {
      return 'The door stays open permanently and the switch is removed — no more trap.';
    }
  }
  return 'The checker re-verified every active rule on the repaired scene — it accepts.';
}

/**
 * Checked repairs (§9, §12): only fully checked candidates are shown. A
 * candidate previews in the scene first (old position red, proposed green);
 * applying stashes the failing route so it can be replayed on the repaired
 * scene. Apply errors render here, next to the button that caused them.
 */
export function RepairPanel({ report }: { report: Report }) {
  const draft = useApp((s) => s.draft);
  const repair = useApp((s) => s.repair);
  const runRepairs = useApp((s) => s.runRepairs);
  const applyRepair = useApp((s) => s.applyRepair);
  const previewRepair = useApp((s) => s.previewRepair);
  const clearPreview = useApp((s) => s.clearPreview);
  const preview = useApp((s) => s.preview);
  const repairReplay = useApp((s) => s.repairReplay);
  const watchReplay = useApp((s) => s.watchReplay);

  const protectedIds = useApp((s) => s.protectedIds);

  if (!draft || draft.report.accepted) {
    // A repair was applied and the level is green again: offer the replay of
    // the previously failing route on the repaired scene. repairReplay is set
    // only by applyRepair and cleared on every level-lineage change.
    if (repairReplay !== null) {
      return (
        <section className="panel" aria-label="Repairs">
          <h2 className="panel-title">Repairs</h2>
          <p className="panel-note">Repaired and accepted.</p>
          <button type="button" onClick={watchReplay}>
            Replay the failing route
          </button>
          <p className="panel-note">The same moves on the repaired scene — no longer fatal.</p>
        </section>
      );
    }
    return null;
  }

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
          {protectedIds.length > 0 && (
            <p className="panel-note">
              Keeping {protectedIds.join(', ')} — repairs that move or remove them are excluded.
            </p>
          )}
          {repair.candidates.map((candidate, index) => {
            const isPreviewing =
              preview?.source === 'repair' &&
              candidate.operations.length === preview.operations.length &&
              JSON.stringify(candidate.operations) === JSON.stringify(preview.operations);
            return (
              <div key={candidate.key} className="repair-card">
                <p className="repair-description">{candidate.description}</p>
                {isPreviewing ? (
                  <>
                    <p className="repair-consequence">{consequenceText(candidate.operations)}</p>
                    <div className="card-actions">
                      <button type="button" onClick={() => applyRepair(index)}>
                        Apply
                      </button>
                      <button type="button" onClick={clearPreview}>
                        Cancel
                      </button>
                    </div>
                  </>
                ) : (
                  <button type="button" onClick={() => previewRepair(index)}>
                    Preview
                  </button>
                )}
              </div>
            );
          })}
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
