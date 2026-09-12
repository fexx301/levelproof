import { useMemo } from 'react';
import { actorBridge } from '../render/bridge';
import { compileLevel } from '../core/topology';
import type { Report } from '../core/verifier';
import type { Level } from '../../shared/schema';
import { useApp } from '../state/store';

/**
 * Manual play (§12): WASD or arrows in fixed world-cardinal directions,
 * R restart, Escape exit, on-screen direction buttons. One transition
 * completes before the next input. When the player's exact state matches
 * the checker's dead-end witness, the failure is called out — the player
 * has reproduced the same trapped state as the ghost.
 */
export function PlayPanel({ level, report }: { level: Level; report: Report }) {
  const play = useApp((s) => s.play);
  const exitToAuthoring = useApp((s) => s.exitToAuthoring);

  const compiled = useMemo(() => compileLevel(level), [level]);
  const deadEnd =
    report.checks.recovery.status === 'fail' ? report.checks.recovery.witness?.endState : undefined;
  const reproduced =
    deadEnd !== undefined &&
    play.at === deadEnd.moduleId &&
    masksMatch(compiled.keyBit, deadEnd.keyMask, play.keys) &&
    masksMatch(compiled.switchBit, deadEnd.switchMask, play.switches);

  return (
    <section className="panel panel--active" aria-label="Play">
      <h2 className="panel-title">Play the draft</h2>
      <p className="panel-note">WASD / arrows · R restart · Escape exits. Compass: N is away from you.</p>
      <div className="dpad">
        <span />
        <button type="button" onClick={() => actorBridge.player()?.move('N')} aria-label="Move north">
          N
        </button>
        <span />
        <button type="button" onClick={() => actorBridge.player()?.move('W')} aria-label="Move west">
          W
        </button>
        <span className="dpad-center">{play.at || '—'}</span>
        <button type="button" onClick={() => actorBridge.player()?.move('E')} aria-label="Move east">
          E
        </button>
        <span />
        <button type="button" onClick={() => actorBridge.player()?.move('S')} aria-label="Move south">
          S
        </button>
        <span />
      </div>
      <div className="inventory">
        {play.keys.length === 0 && play.switches.length === 0 && (
          <span className="inventory-empty">Inventory: empty</span>
        )}
        {play.keys.map((key) => (
          <span key={key} className="inventory-chip inventory-chip--key">
            Key: {key}
          </span>
        ))}
        {play.switches.map((pad) => (
          <span key={pad} className="inventory-chip inventory-chip--switch">
            Switch on: {pad}
          </span>
        ))}
      </div>
      {play.atGoal && (
        <p className={`banner ${play.goalViolated ? 'banner--fail' : 'banner--pass'}`} role="status">
          {play.goalViolated ? 'Goal reached — rule violated' : 'Goal reached'}
        </p>
      )}
      {reproduced && !play.atGoal && (
        <p className="banner banner--fail" role="status">
          You reproduced the failure — the same trapped state as the ghost. No winning route remains.
        </p>
      )}
      <button type="button" onClick={exitToAuthoring}>
        Back to editing (Escape)
      </button>
    </section>
  );
}

function masksMatch(bits: Map<string, number>, mask: number, held: string[]): boolean {
  const expected = [...bits.entries()].filter(([, bit]) => (mask & bit) !== 0).map(([id]) => id).sort();
  const actual = [...held].sort();
  return expected.length === actual.length && expected.every((id, index) => id === actual[index]);
}
