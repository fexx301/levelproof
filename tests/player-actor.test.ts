import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { Cardinal } from '../shared/schema';
import { compileLevel } from '../src/core/topology';
import { baselineLevel } from '../src/core/fixtures/baseline';
import { PlayerActor, type ActorContext, type PlayerStateInfo } from '../src/render/actors';

function harness(heldDirection?: () => Cardinal | null) {
  let tick: (dt: number, elapsed: number) => void = () => {};
  const ctx: ActorContext = {
    scene: new THREE.Scene(),
    compiled: compileLevel(structuredClone(baselineLevel)),
    world: { updateState: () => {}, collectKey: () => {}, activateSwitch: () => {}, resetWorld: () => {} },
    follow: () => {},
    register: (update) => {
      tick = update;
      return () => {};
    },
  };
  let latest: PlayerStateInfo | null = null;
  const player = new PlayerActor(ctx, { onState: (info) => { latest = info; }, heldDirection });
  let clock = 0;
  const frame = () => {
    clock += 1 / 60;
    tick(1 / 60, clock * 1000);
  };
  return { player, frame, state: () => latest! };
}

describe('player runs', () => {
  it('carries a held key through a landing without standing still for a frame', () => {
    let held: Cardinal | null = 'N';
    const { player, frame, state } = harness(() => held);
    player.move('N');
    const previous = player.mesh.position.clone();
    let stillFrames = 0;
    for (let i = 0; i < 600 && state().moves < 2; i++) {
      frame();
      if (player.mesh.position.distanceTo(previous) < 0.01) stillFrames++;
      previous.copy(player.mesh.position);
    }
    expect(state().moves).toBe(2);
    expect(state().at).toBe('gallery-ramp');
    expect(stillFrames).toBe(0);
    held = null;
    for (let i = 0; i < 600; i++) frame();
    // Released during the third move: it lands, and nothing more.
    expect(state().moves).toBe(3);
  });

  it('stops at the landing when nothing is held or buffered', () => {
    const { player, frame, state } = harness(() => null);
    player.move('N');
    for (let i = 0; i < 600; i++) frame();
    expect(state().moves).toBe(1);
    expect(state().at).toBe('lower-hall');
  });

  it('takes a press made during a move once the move lands', () => {
    const { player, frame, state } = harness();
    player.move('N');
    frame();
    player.move('N');
    for (let i = 0; i < 600; i++) frame();
    expect(state().moves).toBe(2);
    // Key auto-repeat does not buffer, so releasing a held key never adds a move.
    player.move('N');
    frame();
    player.move('N', false);
    for (let i = 0; i < 600; i++) frame();
    expect(state().moves).toBe(3);
  });
});
