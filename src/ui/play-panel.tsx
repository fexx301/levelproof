import { useEffect, useMemo, useRef } from 'react';
import type { Cardinal } from '../../shared/schema.js';
import { actorBridge } from '../render/bridge.js';
import { compileLevel, type CompiledLevel } from '../core/topology.js';
import { cycleOpen } from '../core/hazards.js';
import { transitions } from '../core/movement.js';
import type { Report } from '../core/verifier.js';
import type { Level } from '../../shared/schema.js';
import { playSound } from '../render/sound.js';
import { setPadHeld } from './held-input.js';
import { PlayReact } from './play-react.js';
import { AdventureContinue, AdventureStrip } from './adventure-panel.js';
import { useApp, type PlayHint } from '../state/store.js';
import { CARDINAL_NAMES, relativeCardinal, type MoveIntent } from './relative-direction.js';

const INTENTS: MoveIntent[] = ['forward', 'back', 'left', 'right'];

/** Ask the live player for the next winning move (H key or the Hint button). */
export function requestHint(): void {
  const result = actorBridge.player()?.hint();
  if (result === undefined) return;
  const hint: PlayHint =
    result.kind === 'move' || result.kind === 'rule_blocked'
      ? { kind: result.kind, direction: result.move.action, destination: result.move.destination, movesToGoal: result.movesToGoal }
      : { kind: result.kind };
  useApp.setState({ playHint: hint });
  if (result.kind === 'move' || result.kind === 'rule_blocked') playSound('hint');
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
    (play.phase ?? 0) === deadEnd.phase &&
    masksMatch(compiled.keyBit, deadEnd.keyMask, play.keys) &&
    masksMatch(compiled.switchBit, deadEnd.switchMask, play.switches);
  const placeName = (id: string): string => compiled.moduleById.get(id)?.label ?? id.replace(/-/g, ' ');
  const won = play.atGoal && !play.goalViolated;
  const pointerPressed = useRef(false);
  useEffect(() => () => setPadHeld(null), []);
  const playHint = useApp((s) => s.playHint);
  // A hint answers "from here": any move or restart retires it.
  useEffect(() => {
    useApp.setState({ playHint: null });
  }, [play.moves, play.at, play.phase]);
  useEffect(() => () => useApp.setState({ playHint: null }), []);
  const hintIntent =
    playHint?.kind === 'move' || playHint?.kind === 'rule_blocked' ? INTENTS.find((intent) => relativeCardinal(facing, intent) === playHint.direction) : undefined;
  const hazards = compiled.cycle > 1;
  const guardName = (id: string): string => id.replace(/-/g, ' ');
  const guardsPaused = useApp((s) => s.guardsPaused);
  // Moves that would walk into a guard from exactly where the player stands:
  // said before the move, with the way out (waiting lets the guard pass).
  const danger = useMemo(() => {
    if (!hazards || compiled.patrols.length === 0 || play.atGoal || !play.at) return null;
    const mask = (bits: Map<string, number>, held: string[]): number => held.reduce((acc, id) => acc | (bits.get(id) ?? 0), 0);
    const state = { moduleId: play.at, keyMask: mask(compiled.keyBit, play.keys), switchMask: mask(compiled.switchBit, play.switches), phase: play.phase ?? 0 };
    const moves = transitions(compiled, state);
    const stay = moves.find((move) => move.action === 'wait');
    // Standing here gets the player caught: time passes on its own, so say it first.
    if (stay?.events.caught !== undefined) return { guard: stay.events.caught, rooms: [], waitIsSafe: false, here: true };
    const caught = moves.filter((move) => move.action !== 'wait' && move.events.caught !== undefined);
    if (caught.length === 0) return null;
    return { guard: caught[0]!.events.caught!, rooms: [...new Set(caught.map((move) => placeName(move.destination)))], waitIsSafe: stay !== undefined, here: false };
  }, [compiled, hazards, play.at, play.keys, play.switches, play.phase, play.atGoal]);
  const waitHinted =
    ((playHint?.kind === 'move' || playHint?.kind === 'rule_blocked') && playHint.direction === 'wait') || danger?.waitIsSafe === true;

  const moveButton = (intent: MoveIntent) => {
    const direction: Cardinal = relativeCardinal(facing, intent);
    const release = () => setPadHeld(null);
    return (
      <button
        type="button"
        className={hintIntent === intent ? 'dpad-hint' : undefined}
        // Press moves at once; holding keeps running through landings.
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          pointerPressed.current = true;
          event.currentTarget.setPointerCapture?.(event.pointerId);
          setPadHeld(intent);
          actorBridge.player()?.move(direction);
        }}
        onPointerUp={release}
        // A cancelled touch produces no click, so nothing will consume the
        // flag; clear it or the next keyboard activation would be swallowed.
        onPointerCancel={() => {
          release();
          pointerPressed.current = false;
        }}
        onLostPointerCapture={release}
        onContextMenu={(event) => event.preventDefault()}
        // Keyboard activation (Enter / Space) arrives as a click with no pointer press.
        onClick={() => {
          if (pointerPressed.current) {
            pointerPressed.current = false;
            return;
          }
          actorBridge.player()?.move(direction);
        }}
        aria-label={`Move ${CARDINAL_NAMES[direction]} (${intent})`}
        title={`${intent} · ${CARDINAL_NAMES[direction]}`}
      >
        {ARROWS[intent]}
      </button>
    );
  };

  return (
    <section className="panel panel--active" aria-label="Play">
      <AdventureStrip />
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
      <p className="panel-note play-keys-note">
        WASD or arrows move relative to the camera · drag to look around{hazards ? ' · Space waits a turn' : ''} · H hint · R restarts · Esc exits
      </p>
      <p className="panel-note play-touch-note">Hold an arrow to keep running{hazards ? ' · tap the middle to wait a turn' : ''} · drag the world to look around</p>
      <div className="dpad">
        {/* Hint and Restart sit in the pad's top corners: always in thumb reach. */}
        <button type="button" className="dpad-aux" onClick={requestHint} disabled={won} aria-keyshortcuts="H">
          Hint
        </button>
        {moveButton('forward')}
        <button type="button" className="dpad-aux" onClick={() => actorBridge.player()?.restart()} aria-keyshortcuts="R">
          Restart
        </button>
        {moveButton('left')}
        {hazards ? (
          // With guards or timed gates, the centre of the pad waits a turn
          // (always within thumb reach) and still names where you stand.
          <button
            type="button"
            className={waitHinted ? 'dpad-center dpad-wait dpad-hint' : 'dpad-center dpad-wait'}
            data-module={play.at}
            onClick={() => actorBridge.player()?.move('wait')}
            aria-keyshortcuts="Space"
            aria-label={`Wait a turn${play.at ? ` at ${placeName(play.at)}` : ''}`}
            title="Stay where you are for one turn (Space)"
          >
            <span>{play.at ? placeName(play.at) : '—'}</span>
            <span className="dpad-wait-label">wait</span>
          </button>
        ) : (
          <span className="dpad-center" role="status" data-module={play.at}>{play.at ? placeName(play.at) : '—'}</span>
        )}
        {moveButton('right')}
        <span />
        {moveButton('back')}
        <span />
      </div>
      {hazards && (
        <div className="play-turn">
          <p className="play-turn-note" role="status" data-phase={play.phase ?? 0}>
            {turnNote(compiled, play.phase ?? 0, guardsPaused)}
          </p>
          <button
            type="button"
            className="play-pause"
            aria-pressed={guardsPaused}
            onClick={() => useApp.setState({ guardsPaused: !guardsPaused })}
            title="Standing still lets time pass; pause to take your time"
          >
            {guardsPaused ? 'Resume guards' : 'Pause guards'}
          </button>
        </div>
      )}
      {play.caughtBy && (
        <p className="banner banner--fail play-caught" role="status">
          Caught by the {guardName(play.caughtBy)} — back to the start, empty-handed. Red rings mark where each guard steps next turn: when one lies on your path, wait a turn and let the guard pass.
        </p>
      )}
      {danger !== null && !play.caughtBy && (
        <p className="play-danger" role="status">
          {danger.here
            ? `The ${guardName(danger.guard)} steps onto your square next turn — move out of its way.`
            : `The ${guardName(danger.guard)} steps into ${danger.rooms.join(' and ')} next turn — going there now gets you caught.${danger.waitIsSafe ? ' Wait a turn (Space, tap the middle, or just stand still) and it will step aside.' : ' Step back and let it pass.'}`}
        </p>
      )}
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
          <AdventureContinue />
        </div>
      )}
      {/* After a win, the next step is the next chapter; before it, change this one. */}
      {!won && <PlayReact />}
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

/** What the clock means right now: each timed gate's state, and guard warnings. */
function turnNote(compiled: CompiledLevel, phase: number, paused: boolean): string {
  const gates = compiled.level.doors.flatMap((door) => {
    const cycle = door.conditions?.cycle;
    if (cycle === undefined) return [];
    const name = door.id.replace(/-/g, ' ');
    const open = cycleOpen(cycle, phase);
    let turns = 1;
    while (turns < cycle.period && cycleOpen(cycle, phase + turns) === open) turns++;
    return [open ? `${name} open now (${turns} turn${turns === 1 ? '' : 's'} left)` : `${name} opens in ${turns} turn${turns === 1 ? '' : 's'}`];
  });
  const guards = compiled.patrols.length > 0 ? ['red rings: where guards step next'] : [];
  // Turn-based: nothing moves on a clock, which is easy to mistake for a stuck guard.
  const clock = paused
    ? 'Paused: guards and gates move only when you move or wait'
    : 'Guards and gates take one step per turn — every move, and every 1.5 s you stand still';
  return [clock, ...gates.slice(0, 2), ...guards].join(' · ');
}

function masksMatch(bits: Map<string, number>, mask: number, held: string[]): boolean {
  const expected = [...bits.entries()].filter(([, bit]) => (mask & bit) !== 0).map(([id]) => id).sort();
  const actual = [...held].sort();
  return expected.length === actual.length && expected.every((id, index) => id === actual[index]);
}

function hintText(hint: PlayHint, placeName: (id: string) => string, intent: MoveIntent | undefined): string {
  const stepText = (h: Extract<PlayHint, { direction: unknown }>): string =>
    h.direction === 'wait'
      ? 'wait one turn where you are (Space)'
      : `go ${CARDINAL_NAMES[h.direction]}${intent === undefined ? '' : ` (${ARROWS[intent]})`} to ${placeName(h.destination)}`;
  switch (hint.kind) {
    case 'move': {
      const rest = hint.movesToGoal === 1 ? 'That reaches the goal.' : `${hint.movesToGoal} moves from the goal on the shortest winning route.`;
      return `Next: ${stepText(hint)}. ${rest}`;
    }
    case 'rule_blocked':
      return `The goal is still reachable, but every remaining route breaks a design rule. Toward the goal: ${stepText(hint)}. R restarts for a clean win.`;
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
