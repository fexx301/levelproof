import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { GameState } from '../src/core/movement';
import { initialState } from '../src/core/movement';
import { centerPoint } from '../src/core/catalog';
import { compileLevel } from '../src/core/topology';
import { sentryLevel } from '../src/core/fixtures/gallery';
import { GuardView } from '../src/render/guards';
import { createMechanisms, type WorldVisuals } from '../src/render/mechanisms';
import { PlayerActor, type ActorContext, type PlayerStateInfo } from '../src/render/actors';

/** Hazard rendering (§6.4): guards, timed gates, waits, and captures follow the engine's turn. */

const compiled = compileLevel(sentryLevel);
const room = (id: string) => centerPoint(compiled.moduleById.get(id)!);

function world() {
  const guard = new GuardView(compiled.patrols[0]!, compiled, () => false);
  const pips = [0, 1, 2, 3].map(() => new THREE.Mesh(new THREE.SphereGeometry(), new THREE.MeshBasicMaterial({ transparent: true })));
  const visuals: WorldVisuals = {
    keys: new Map(),
    switches: new Map(),
    doors: new Map(),
    guards: new Map([['sentry', guard]]),
    timers: new Map([['drawbridge', { cycle: { period: 4, openTicks: 2 }, pips }]]),
  };
  const controller = createMechanisms(compiled, visuals, () => false);
  return { guard, pips, controller };
}

const at = (state: Partial<GameState>): GameState => ({ ...initialState(compiled), ...state });

describe('guards on the turn clock', () => {
  it('stands where the turn puts it, walks during a turn, and snaps back on reset', () => {
    const { guard, controller } = world();
    expect(guard.root.position.x).toBeCloseTo(room('yard-mid').x);
    controller.events.beginTurn(at({ phase: 0 }), 0.5);
    expect(guard.walking).toBe(true);
    for (let i = 0; i < 40; i++) controller.update(1 / 60);
    expect(guard.walking).toBe(false);
    expect(guard.root.position.z).toBeCloseTo(room('well').z);
    // The mover lands: the guard stays where the turn put it.
    controller.events.updateState(at({ phase: 1 }));
    expect(guard.root.position.z).toBeCloseTo(room('well').z);
    // A restart (or a capture) puts the world back at turn 0.
    controller.events.resetWorld();
    expect(guard.root.position.z).toBeCloseTo(room('yard-mid').z);
  });

  it('lets a walk already heading to the landing room finish', () => {
    const { guard, controller } = world();
    controller.events.beginTurn(at({ phase: 0 }), 0.5);
    controller.update(0.1);
    const midway = guard.root.position.z;
    controller.events.updateState(at({ phase: 1 }));
    expect(guard.walking).toBe(true);
    expect(guard.root.position.z).toBe(midway);
  });

  it('lights the timed gate pip for the current turn', () => {
    const { pips, controller } = world();
    controller.events.updateState(at({ phase: 2 }));
    expect(pips.map((pip) => pip.scale.x > 1)).toEqual([false, false, true, false]);
    expect((pips[2]!.material as THREE.MeshBasicMaterial).opacity).toBe(1);
  });
});

function harness(autoTurnSeconds?: () => number | null) {
  let tick: (dt: number, elapsed: number) => void = () => {};
  const turns: GameState[] = [];
  const caught: string[] = [];
  let resets = 0;
  const ctx: ActorContext = {
    scene: new THREE.Scene(),
    compiled,
    world: {
      updateState: () => {},
      collectKey: () => {},
      activateSwitch: () => {},
      resetWorld: () => { resets++; },
      beginTurn: (before) => turns.push(before),
      caught: (id) => caught.push(id),
    },
    follow: () => {},
    register: (update) => {
      tick = update;
      return () => {};
    },
  };
  let latest: PlayerStateInfo | null = null;
  const player = new PlayerActor(ctx, { onState: (info) => { latest = info; }, ...(autoTurnSeconds !== undefined ? { autoTurnSeconds } : {}) });
  const frames = (count: number) => {
    for (let i = 0; i < count; i++) tick(1 / 60, 0);
  };
  const walk = (actions: Parameters<PlayerActor['move']>[0][]) => {
    for (const action of actions) {
      player.move(action);
      frames(180);
    }
  };
  return { player, frames, walk, state: () => latest!, turns, caught, resets: () => resets };
}

describe('the player on a hazard level', () => {
  it('standing still, time passes by itself: one turn per pause, not counted as a move', () => {
    let seconds: number | null = 1.5;
    const { frames, state } = harness(() => seconds);
    frames(60); // one second: nothing yet
    expect(state().phase).toBe(0);
    frames(180); // the pause elapses and the wait plays out
    expect(state().phase).toBeGreaterThanOrEqual(1);
    expect(state().moves).toBe(0);
    seconds = null; // paused: the world waits for the player
    frames(60); // a turn already under way lands
    const phase = state().phase;
    frames(600);
    expect(state().phase).toBe(phase);
  });

  it('a wait is a whole turn, not a blink', () => {
    const { player, frames, state, turns } = harness();
    player.move('wait');
    expect(turns).toHaveLength(1);
    frames(6);
    expect(state().moves).toBe(0);
    frames(60);
    expect(state().moves).toBe(1);
    expect(state().phase).toBe(1);
    expect(state().at).toBe('gatehouse');
  });

  it('caught by the sentry: a beat, then back at the start with empty hands', () => {
    const { player, frames, walk, state, caught, resets } = harness();
    walk(['E', 'N', 'N', 'S', 'S']);
    expect(state().keys).toEqual(['tower-key']);
    const resetsBefore = resets();
    player.move('E'); // the sentry steps into the yard as the player does
    frames(180);
    expect(caught).toEqual(['sentry']);
    expect(state().captures).toBe(1);
    expect(state().caughtBy).toBe('sentry');
    expect(state().at).toBe('gatehouse');
    expect(state().keys).toEqual([]);
    expect(state().phase).toBe(0);
    expect(resets()).toBeGreaterThan(resetsBefore);
    expect(player.mesh.position.x).toBeCloseTo(room('gatehouse').x);
    // The next move clears the notice.
    player.move('E');
    frames(180);
    expect(state().caughtBy).toBeNull();
  });

  it('ignores input during the capture beat', () => {
    const { player, frames, walk, state } = harness();
    walk(['E', 'N', 'N', 'S', 'S']);
    player.move('E');
    let beat = 0;
    for (let i = 0; i < 180 && state().captures === 0; i++) {
      frames(1);
      beat = i;
    }
    expect(beat).toBeGreaterThan(0);
    player.move('E');
    frames(180);
    expect(state().moves).toBe(6);
  });

  it('wins the Sentry by waiting once, as the engine proved', () => {
    const { walk, state } = harness();
    walk(['E', 'N', 'N', 'S', 'S', 'wait', 'E', 'E', 'E', 'E']);
    expect(state().atGoal).toBe(true);
    expect(state().captures).toBe(0);
  });
});
