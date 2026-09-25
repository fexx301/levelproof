import { useEffect, useMemo } from 'react';
import type { Cardinal } from '../../shared/schema.js';
import { actorBridge } from '../render/bridge.js';
import { compileLevel } from '../core/topology.js';
import type { Report } from '../core/verifier.js';
import type { Level } from '../../shared/schema.js';
import { useApp, type PlayHint } from '../state/store.js';
import { CARDINAL_NAMES, relativeCardinal, type MoveIntent } from './relative-direction.js';

const INTENTS: MoveIntent[] = ['forward', 'back', 'left', 'right'];

/** Ask the live player for the next winning move (H key or the Hint button). */
export function requestHint(): void {
  const result = actorBridge.player()?.hint();
  if (result === undefined) return;
  const hint: PlayHint =
    result.kind === 'move'
      ? { kind: 'move', direction: result.move.action, destination: result.move.destination, movesToGoal: result.movesToGoal }
      : { kind: result.kind };
  useApp.setState({ playHint: hint });
}

const ARROWS: Record<MoveIntent, string> = { forward: '↑', back: '↓', left: '←', right: '→' };

/**
 * Manual play (§12): WASD or arrows relative to the camera (W / ↑ always
 * walks away from the viewer), R restart, Escape exit, on-screen direction
 * buttons laid out the same way. The camera follows the player unless the
 * author switches to the overview. One transition completes before the next
 * input. When the player's exact state matches the checker's dead-end
 * witness, the failure is called out — the player has reproduced the same
 * trapped state as the ghost.
 */
export function PlayPanel({ level, report }: { level: Level; report: Report }) {
  const play = useApp((s) => s.play);
  const hasDraft = useApp((s) => s.draft !== null);
  const facing = useApp((s) => s.facing);
  const followCamera = useApp((s) => s.followCamera);
  const exitToAuthoring = useApp((s) => s.exitToAuthoring);
  const viaShare = useApp((s) => s.viaShare);
  const compiled = useMemo(() => compileLevel(level), [level]);
  const deadEnd =
    report.checks.recovery.status === 'fail' ? report.checks.recovery.witness?.endState : undefined;
  const reproduced =
    deadEnd !== undefined &&
    play.at === deadEnd.moduleId &&
    masksMatch(compiled.keyBit, deadEnd.keyMask, play.keys) &&
    masksMatch(compiled.switchBit, deadEnd.switchMask, play.switches);
  const placeName = (id: string): string => compiled.moduleById.get(id)?.label ?? id.replace(/-/g, ' ');
  const won = play.atGoal && !play.goalViolated;
  const playHint = useApp((s) => s.playHint);
  // A hint answers "from here": any move or restart retires it.
  useEffect(() => {
    useApp.setState({ playHint: null });
  }, [play.moves, play.at]);
  useEffect(() => () => useApp.setState({ playHint: null }), []);
  const hintIntent =
    playHint?.kind === 'move' ? INTENTS.find((intent) => relativeCardinal(facing, intent) === playHint.direction) : undefined;

  const moveButton = (intent: MoveIntent) => {
    const direction: Cardinal = relativeCardinal(facing, intent);
    return (
      <button
        type="button"
        className={hintIntent === intent ? 'dpad-hint' : undefined}
        onClick={() => actorBridge.player()?.move(direction)}
        aria-label={`Move ${CARDINAL_NAMES[direction]} (${intent})`}
        title={`${intent} · ${CARDINAL_NAMES[direction]}`}
      >
        {ARROWS[intent]}
      </button>
    );
  };

  return (
    <section className="panel panel--active" aria-label="Play">
      <div className="play-head">
        <h2 className="panel-title">{hasDraft ? 'Play the draft' : 'Play the level'}</h2>
        <button
          type="button"
          className="play-camera-toggle"
          aria-pressed={followCamera}
          onClick={() => useApp.setState({ followCamera: !followCamera })}
        >
          {followCamera ? 'Camera: following' : 'Camera: overview'}
        </button>
      </div>
      <p className="panel-note">WASD or arrows move relative to the camera · drag to look around · H hint · R restarts · Esc exits</p>
      <div className="dpad">
        <span />
        {moveButton('forward')}
        <span />
        {moveButton('left')}
        <span className="dpad-center" role="status" data-module={play.at}>{play.at ? placeName(play.at) : '—'}</span>
        {moveButton('right')}
        <span />
        {moveButton('back')}
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
      <div className="ghost-controls">
        <button type="button" onClick={() => actorBridge.player()?.restart()}>
          Restart
        </button>
        <button type="button" onClick={requestHint} disabled={won} aria-keyshortcuts="H">
          Hint
        </button>
      </div>
      {playHint && !won && (
        <p className="play-hint" role="status" aria-live="polite">
          {hintText(playHint, placeName, hintIntent)}
        </p>
      )}
      {won && (
        <div className="play-win">
          <p className="play-win-title">Level complete</p>
          <p className="play-win-note">
            Reached the goal in {play.moves ?? 0} move{play.moves === 1 ? '' : 's'}, following every rule
            {(play.hints ?? 0) > 0 ? ` (${play.hints} hint${play.hints === 1 ? '' : 's'})` : ''}.
          </p>
          <div className="card-actions">
            <button type="button" onClick={() => actorBridge.player()?.restart()}>Play again</button>
            <button type="button" onClick={exitToAuthoring}>{viaShare ? 'Remix this puzzle' : 'Back to editing'}</button>
          </div>
        </div>
      )}
      {play.atGoal && play.goalViolated && (
        <p className="banner banner--fail">Goal reached — but a design rule was broken on the way.</p>
      )}
      {reproduced && !play.atGoal && (
        <p className="banner banner--fail">
          You reproduced the failure — the same trapped state as the ghost. No winning route remains.
        </p>
      )}
      {play.trapped && !play.atGoal && !reproduced && (
        <p className="banner banner--fail">
          Trapped — no route to the goal remains. R restarts.
        </p>
      )}
      {play.doomed && !play.trapped && !play.atGoal && !reproduced && (
        <p className="banner banner--fail">
          Dead end — you can still move, but no winning route remains from here (every continuation was checked). R
          restarts.
        </p>
      )}
    </section>
  );
}

function masksMatch(bits: Map<string, number>, mask: number, held: string[]): boolean {
  const expected = [...bits.entries()].filter(([, bit]) => (mask & bit) !== 0).map(([id]) => id).sort();
  const actual = [...held].sort();
  return expected.length === actual.length && expected.every((id, index) => id === actual[index]);
}

function hintText(hint: PlayHint, placeName: (id: string) => string, intent: MoveIntent | undefined): string {
  switch (hint.kind) {
    case 'move': {
      const key = intent === undefined ? '' : ` (${ARROWS[intent]})`;
      const rest = hint.movesToGoal === 1 ? 'That reaches the goal.' : `${hint.movesToGoal} moves from the goal on the shortest winning route.`;
      return `Next: go ${CARDINAL_NAMES[hint.direction]}${key} to ${placeName(hint.destination)}. ${rest}`;
    }
    case 'stranded':
      return 'No winning route remains from here — every continuation was checked. R restarts.';
    case 'rule_broken':
      return 'You reached the goal, but a design rule was broken on the way. R restarts.';
    case 'at_goal':
      return 'You are already at the goal.';
    case 'unknown':
      return 'Too many possibilities to search from here. Try restarting.';
  }
}
