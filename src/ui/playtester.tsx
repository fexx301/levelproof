import { actorBridge } from '../render/bridge.js';
import { useApp } from '../state/store.js';
import type { Report } from '../core/verifier.js';
import type { MoveRecord } from '../core/movement.js';

/**
 * Watch playtester (§12): replay a verifier witness as a ghost. The ghost
 * walks real witness routes only — restart, pause, step; inventory appears
 * as it happens; the ghost holds at the trapped state.
 */

export interface WitnessOption {
  kind: 'solution' | 'dead_end' | 'bypass';
  label: string;
  route: MoveRecord[];
  missingKeys: string[];
}

export function witnessOptions(report: Report): WitnessOption[] {
  const options: WitnessOption[] = [];
  const recovery = report.checks.recovery;
  if (recovery.status === 'fail' && recovery.witness) {
    options.push({
      kind: 'dead_end',
      label: 'The failure — a player gets stranded',
      route: recovery.witness.route,
      missingKeys: [],
    });
  }
  const requirements = report.checks.requirements;
  if (requirements.status === 'fail' && requirements.witness) {
    options.push({
      kind: 'bypass',
      label: 'The bypass — the goal is reached keyless',
      route: requirements.witness.route,
      missingKeys: requirements.witness.missingKeys ?? [],
    });
  }
  const solution = report.checks.solution;
  if (solution.status === 'pass' && solution.witness) {
    options.push({
      kind: 'solution',
      label: 'A winning route',
      route: solution.witness.route,
      missingKeys: [],
    });
  }
  return options;
}

export function PlaytesterPanel({ report }: { report: Report }) {
  const mode = useApp((s) => s.mode);
  const ghost = useApp((s) => s.ghost);
  const evidence = useApp((s) => s.evidence);
  const watchWitness = useApp((s) => s.watchWitness);
  const startPlay = useApp((s) => s.startPlay);
  const exitToAuthoring = useApp((s) => s.exitToAuthoring);
  const options = witnessOptions(report);
  if (mode !== 'watching') {
    return (
      <section className="panel" aria-label="Playtester">
        <h2 className="panel-title">Playtester</h2>
        <p className="panel-note">Watch the checker’s counterexample replayed as a ghost.</p>
        <div className="panel-actions">
          {options.map((option) => (
            <button key={option.kind} type="button" onClick={() => watchWitness(option.kind)}>
              {option.label}
            </button>
          ))}
          {options.length === 0 && <p className="panel-note">No witnesses in this report.</p>}
        </div>
        <div className="panel-actions">
          <button type="button" onClick={startPlay}>
            Play it yourself
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="panel panel--active" aria-label="Playtester">
      <h2 className="panel-title">Watch playtester</h2>
      {evidence && (
        <div className="evidence-card" aria-label="Verified failure evidence">
          <p className="evidence-kicker">Verified evidence · {evidence.check}</p>
          <p className="panel-note">{evidence.fact}</p>
          <p className="evidence-focus">
            Focus: <strong>{evidence.focusModuleId}</strong>
            {evidence.implicatedIds.length > 0 && ` · ${evidence.implicatedIds.join(', ')}`}
          </p>
          <p className="panel-note">The replay pauses after move {evidence.decisiveMoveIndex}. Use Play or Step to continue.</p>
          <p className="panel-note">{evidence.suggestedAction}</p>
        </div>
      )}
      {(() => {
        const current = options.find((option) => option.kind === ghost.witnessKind);
        return current ? <p className="panel-note">Replaying: {current.label}</p> : null;
      })()}
      <p className="panel-note" role="status">
        {ghost.pausedAtEvidence
          ? `Paused at decisive moment · move ${ghost.moveIndex} of ${ghost.totalMoves}`
          : `Move ${Math.min(ghost.moveIndex + (ghost.finished ? 0 : 1), ghost.totalMoves)} of ${ghost.totalMoves}`}
      </p>
      <div className="ghost-controls">
        <button
          type="button"
          onClick={() => {
            actorBridge.ghost()?.restart();
            actorBridge.ghost()?.play();
          }}
        >
          Restart
        </button>
        <button
          type="button"
          onClick={() => (ghost.playing ? actorBridge.ghost()?.pause() : actorBridge.ghost()?.play())}
        >
          {ghost.playing ? 'Pause' : 'Play'}
        </button>
        <button type="button" onClick={() => actorBridge.ghost()?.step()}>
          Step
        </button>
      </div>
      {evidence && (
        <button type="button" onClick={exitToAuthoring}>
          Back to repair
        </button>
      )}
      <div className="inventory">
        {ghost.keys.length === 0 && ghost.switches.length === 0 && (
          <span className="inventory-empty">Inventory: empty</span>
        )}
        {ghost.keys.map((key) => (
          <span key={key} className="inventory-chip inventory-chip--key">
            Key: {key}
          </span>
        ))}
        {ghost.switches.map((pad) => (
          <span key={pad} className="inventory-chip inventory-chip--switch">
            Switch on: {pad}
          </span>
        ))}
      </div>
      {ghost.endNote && (
        <p
          className={`ghost-endnote${ghost.witnessKind === 'dead_end' || ghost.witnessKind === 'bypass' ? '' : ' ghost-endnote--pass'}`}
          role="status"
        >
          {ghost.endNote}
        </p>
      )}
    </section>
  );
}
