import * as THREE from 'three';
import { playSound } from './sound.js';
import { CharacterRig, characterIfLoaded, preloadCharacter, type CharacterAsset } from './character.js';
import { createGhostVisual, type GhostFinishKind, type GhostMotion, type GhostVisual, type GhostVisualEvent } from './ghost-visual.js';

/**
 * The replay ghost as the same animated character the player controls,
 * rendered translucent: pale blue for a winning route, red for a failure.
 * The procedural sheet ghost stands in until the character has loaded (and
 * remains the fallback if it cannot load).
 */

export interface ActorVisual {
  readonly object: THREE.Object3D;
  /** False only while the character model is still downloading. */
  readonly ready: boolean;
  update(dt: number, elapsed: number, motion: GhostMotion): void;
  setDirection(direction: THREE.Vector3): void;
  trigger(event: GhostVisualEvent): void;
  reset(): void;
  dispose(): void;
}

const FAILURE_TINT = 0xff6a5a;
const ROUTE_TINT = 0x9fdcff;
const GHOST_OPACITY = 0.72;

export class CharacterGhostVisual implements ActorVisual {
  readonly object = new THREE.Group();
  private rig: CharacterRig | null = null;
  private fallback: GhostVisual | null = null;
  private disposed = false;
  private yaw = 0;
  private targetYaw = 0;
  private lastElapsed: number | null = null;
  private finishedKind: GhostFinishKind | null = null;
  private failed = false;

  constructor(
    private readonly kind: GhostFinishKind,
    private readonly floorOffsetCm: number,
    private readonly reducedMotion: () => boolean,
  ) {
    const asset = characterIfLoaded();
    if (asset !== null) this.attach(asset);
    else {
      this.fallback = createGhostVisual({ reducedMotion });
      this.object.add(this.fallback.object);
      preloadCharacter().then((loaded) => {
        if (!this.disposed) this.attach(loaded);
      }, () => {
        this.failed = true;
      });
    }
  }

  get ready(): boolean {
    return this.rig !== null || this.failed;
  }

  update(dt: number, elapsed: number, motion: GhostMotion): void {
    if (this.fallback !== null) {
      this.fallback.update(dt, elapsed, motion);
      return;
    }
    if (this.rig === null) return;
    // The actor freezes dt after its finish beat; the character keeps living
    // on real time so the cheer or head shake plays out.
    const realDt = this.lastElapsed === null ? 0 : Math.min(Math.max((elapsed - this.lastElapsed) / 1000, 0), 0.1);
    this.lastElapsed = elapsed;
    const speed = motion.playing && !motion.finished ? Math.hypot(motion.velocity.x, motion.velocity.z) : 0;
    if (this.finishedKind === null) this.rig.setLocomotion(speed);
    // Face where it is running; once finished it keeps the facing it was given.
    if (speed > 20 && Math.abs(motion.direction.x) + Math.abs(motion.direction.z) > 1e-6) {
      this.targetYaw = Math.atan2(motion.direction.x, motion.direction.z);
    }
    let delta = this.targetYaw - this.yaw;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    this.yaw += this.reducedMotion() ? delta : delta * Math.min(1, realDt * 12);
    this.rig.object.rotation.y = this.yaw;
    this.rig.update(this.reducedMotion() ? 0 : realDt);
  }

  setDirection(direction: THREE.Vector3): void {
    this.fallback?.setDirection(direction);
    if (Math.abs(direction.x) + Math.abs(direction.z) < 1e-6) return;
    this.targetYaw = Math.atan2(direction.x, direction.z);
  }

  trigger(event: GhostVisualEvent): void {
    this.fallback?.trigger(event);
    if (this.rig === null || typeof event === 'string') return;
    this.finishedKind = event.kind;
    const failure = event.kind === 'dead_end' || event.kind === 'bypass';
    if (failure) this.rig.perform('No', 'Idle');
    else this.rig.perform('Jump', 'Wave');
  }

  reset(): void {
    this.fallback?.reset();
    this.finishedKind = null;
    this.lastElapsed = null;
    this.rig?.loop('Idle');
  }

  dispose(): void {
    this.disposed = true;
    this.fallback?.dispose();
    this.rig?.dispose();
    this.rig = null;
  }

  private attach(asset: CharacterAsset): void {
    if (this.fallback !== null) {
      this.object.remove(this.fallback.object);
      this.fallback.dispose();
      this.fallback = null;
    }
    const failure = this.kind === 'dead_end' || this.kind === 'bypass';
    this.rig = new CharacterRig(asset, { ghost: { color: failure ? FAILURE_TINT : ROUTE_TINT, opacity: GHOST_OPACITY },
      onFootstep: () => playSound('ghostStep'),
    });
    this.rig.object.position.y = -this.floorOffsetCm;
    this.yaw = this.targetYaw;
    this.rig.object.rotation.y = this.yaw;
    this.object.add(this.rig.object);
  }
}
