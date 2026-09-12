import * as THREE from 'three';
import type { Cardinal } from '../../shared/schema';
import { centerPoint } from '../core/catalog';
import { initialState, step, transitions, type GameState, type MoveRecord } from '../core/movement';
import type { CompiledLevel } from '../core/topology';

/**
 * Actors walk catalog-owned polylines at a constant speed (§12). Rendering
 * is cosmetic: every step comes from core `step`, and the ghost only ever
 * walks a verifier-produced witness route — a fabricated route is never
 * animated.
 */

const WALK_SPEED_CM_S = 300;
const ACTOR_RADIUS_CM = 25;
const ACTOR_BODY_CM = 110;
const ACTOR_CENTER_OFFSET_CM = ACTOR_BODY_CM / 2 + ACTOR_RADIUS_CM;

export interface GhostTickState {
  playing: boolean;
  finished: boolean;
  moveIndex: number;
  totalMoves: number;
  keys: string[];
  switches: string[];
}

export interface GhostFinishInfo {
  endState: GameState;
  kind: 'solution' | 'bypass' | 'dead_end';
  missingKeys: string[];
}

export interface GhostCallbacks {
  onTick: (state: GhostTickState) => void;
  onArrive: (move: MoveRecord) => void;
  onFinish: (info: GhostFinishInfo) => void;
}

export interface PlayerStateInfo {
  at: string;
  keys: string[];
  switches: string[];
  trapped: boolean;
  atGoal: boolean;
  goalViolated: boolean;
}

export interface PlayerCallbacks {
  onState: (info: PlayerStateInfo) => void;
}

export interface ActorContext {
  scene: THREE.Scene;
  compiled: CompiledLevel;
  register: (update: (dt: number, elapsed: number) => void) => () => void;
  follow: (target: THREE.Object3D | null) => void;
}

interface PathStep {
  move: MoveRecord;
  points: THREE.Vector3[];
  length: number;
}

function pathSteps(route: MoveRecord[]): PathStep[] {
  return route.map((move) => {
    const points = move.segments.map((p) => new THREE.Vector3(p.x, p.y, p.z));
    let length = 0;
    for (let i = 1; i < points.length; i++) {
      length += points[i]!.distanceTo(points[i - 1]!);
    }
    return { move, points, length };
  });
}

function pointAt(step: PathStep, distance: number): THREE.Vector3 {
  let remaining = Math.max(0, Math.min(distance, step.length));
  for (let i = 1; i < step.points.length; i++) {
    const segment = step.points[i]!.distanceTo(step.points[i - 1]!);
    if (remaining <= segment || i === step.points.length - 1) {
      const t = segment === 0 ? 0 : remaining / segment;
      return step.points[i - 1]!.clone().lerp(step.points[i]!, t);
    }
    remaining -= segment;
  }
  return step.points[0]!.clone();
}

function actorMesh(color: number, opacity: number): THREE.Mesh {
  return new THREE.Mesh(
    new THREE.CapsuleGeometry(ACTOR_RADIUS_CM, ACTOR_BODY_CM, 6, 12),
    new THREE.MeshStandardMaterial({ color, transparent: opacity < 1, opacity, roughness: 0.6 }),
  );
}

export class GhostActor {
  readonly mesh: THREE.Mesh;
  private readonly ctx: ActorContext;
  private readonly steps: PathStep[];
  private readonly callbacks: GhostCallbacks;
  private readonly kind: GhostFinishInfo['kind'];
  private readonly missingKeys: string[];
  private readonly unregister: () => void;
  private index = 0;
  private distance = 0;
  private playing = false;
  private finished = false;
  private stepMode = false;
  private keys: string[] = [];
  private switches: string[] = [];
  private endState: GameState;

  constructor(ctx: ActorContext, route: MoveRecord[], kind: GhostFinishInfo['kind'], missingKeys: string[], callbacks: GhostCallbacks) {
    this.ctx = ctx;
    this.steps = pathSteps(route);
    this.kind = kind;
    this.missingKeys = missingKeys;
    this.callbacks = callbacks;
    this.endState = route.length > 0 ? route[route.length - 1]!.after : initialState(ctx.compiled);
    this.mesh = actorMesh(0xc9564a, 0.55);
    if (this.steps.length > 0) {
      const start = this.steps[0]!.points[0]!;
      this.mesh.position.set(start.x, start.y + ACTOR_CENTER_OFFSET_CM, start.z);
    }
    ctx.scene.add(this.mesh);
    ctx.follow(this.mesh);
    this.unregister = ctx.register(this.update);
    this.emit();
  }

  play(): void {
    if (this.finished) this.restart();
    this.stepMode = false;
    this.playing = true;
    this.emit();
  }

  pause(): void {
    this.playing = false;
    this.stepMode = false;
    this.emit();
  }

  step(): void {
    if (this.finished) this.restart();
    this.stepMode = true;
    this.playing = true;
    this.emit();
  }

  restart(): void {
    this.index = 0;
    this.distance = 0;
    this.finished = false;
    this.keys = [];
    this.switches = [];
    if (this.steps.length > 0) {
      const start = this.steps[0]!.points[0]!;
      this.mesh.position.set(start.x, start.y + ACTOR_CENTER_OFFSET_CM, start.z);
    }
    this.emit();
  }

  dispose(): void {
    this.unregister();
    this.ctx.follow(null);
    this.ctx.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }

  private update = (dt: number, elapsed: number): void => {
    if (this.finished) {
      // Hold at the trapped state, pulsing gently so the eye finds it.
      const material = this.mesh.material as THREE.MeshStandardMaterial;
      material.opacity = 0.45 + 0.18 * Math.sin(elapsed * 0.004);
      return;
    }
    if (!this.playing || this.steps.length === 0) return;
    this.distance += WALK_SPEED_CM_S * dt;
    while (this.index < this.steps.length && this.distance >= this.steps[this.index]!.length) {
      this.distance -= this.steps[this.index]!.length;
      const completed = this.steps[this.index]!;
      this.index++;
      this.arrive(completed.move);
      if (this.index >= this.steps.length) {
        this.finish();
        return;
      }
      if (this.stepMode) {
        this.playing = false;
        break;
      }
    }
    const current = this.steps[Math.min(this.index, this.steps.length - 1)]!;
    const position = pointAt(current, this.distance);
    this.mesh.position.set(position.x, position.y + ACTOR_CENTER_OFFSET_CM, position.z);
  };

  private arrive(move: MoveRecord): void {
    if (move.events.collectedKey) this.keys = [...this.keys, move.events.collectedKey];
    if (move.events.activatedSwitch) this.switches = [...this.switches, move.events.activatedSwitch];
    this.callbacks.onArrive(move);
    this.emit();
  }

  private finish(): void {
    this.finished = true;
    this.playing = false;
    this.emit();
    this.callbacks.onFinish({ endState: this.endState, kind: this.kind, missingKeys: this.missingKeys });
  }

  private emit(): void {
    this.callbacks.onTick({
      playing: this.playing,
      finished: this.finished,
      moveIndex: this.index,
      totalMoves: this.steps.length,
      keys: this.keys,
      switches: this.switches,
    });
  }
}

export class PlayerActor {
  readonly mesh: THREE.Mesh;
  private readonly ctx: ActorContext;
  private readonly callbacks: PlayerCallbacks;
  private readonly unregister: () => void;
  private state: GameState;
  private keys: string[] = [];
  private switches: string[] = [];
  private animation: { points: THREE.Vector3[]; length: number; distance: number; move: MoveRecord } | null = null;

  constructor(ctx: ActorContext, callbacks: PlayerCallbacks) {
    this.ctx = ctx;
    this.callbacks = callbacks;
    this.state = initialState(ctx.compiled);
    this.mesh = actorMesh(0xd7d2c4, 1);
    this.placeAtSpawn();
    ctx.scene.add(this.mesh);
    ctx.follow(this.mesh);
    this.unregister = ctx.register(this.update);
    this.emit();
  }

  /** One transition completes before the next input (§12). */
  move(dir: Cardinal): void {
    if (this.animation) return;
    const move = step(this.ctx.compiled, this.state, dir);
    if (!move) return;
    const points = move.segments.map((p) => new THREE.Vector3(p.x, p.y, p.z));
    let length = 0;
    for (let i = 1; i < points.length; i++) length += points[i]!.distanceTo(points[i - 1]!);
    this.animation = { points, length, distance: 0, move };
  }

  restart(): void {
    this.animation = null;
    this.state = initialState(this.ctx.compiled);
    this.keys = [];
    this.switches = [];
    this.placeAtSpawn();
    this.emit();
  }

  private placeAtSpawn(): void {
    const spawn = this.ctx.compiled.moduleById.get(this.ctx.compiled.spawn);
    if (!spawn) return;
    const center = centerPoint(spawn);
    this.mesh.position.set(center.x, center.y + ACTOR_CENTER_OFFSET_CM, center.z);
  }

  dispose(): void {
    this.unregister();
    this.ctx.follow(null);
    this.ctx.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.MeshStandardMaterial).dispose();
  }


  private update = (dt: number): void => {
    if (!this.animation) return;
    this.animation.distance += WALK_SPEED_CM_S * dt;
    if (this.animation.distance >= this.animation.length) {
      const move = this.animation.move;
      this.animation = null;
      this.state = move.after;
      if (move.events.collectedKey) this.keys = [...this.keys, move.events.collectedKey];
      if (move.events.activatedSwitch) this.switches = [...this.switches, move.events.activatedSwitch];
      this.emit();
      return;
    }
    const { points, distance } = this.animation;
    let remaining = distance;
    for (let i = 1; i < points.length; i++) {
      const segment = points[i]!.distanceTo(points[i - 1]!);
      if (remaining <= segment) {
        const t = segment === 0 ? 0 : remaining / segment;
        const position = points[i - 1]!.clone().lerp(points[i]!, t);
        this.mesh.position.set(position.x, position.y + ACTOR_CENTER_OFFSET_CM, position.z);
        return;
      }
      remaining -= segment;
    }
  };

  private emit(): void {
    const atGoal = this.state.moduleId === this.ctx.compiled.goal;
    const trapped = !atGoal && transitions(this.ctx.compiled, this.state).length === 0;
    const goalViolated =
      atGoal &&
      this.ctx.compiled.level.requirements.some((requirement) => {
        const bit = this.ctx.compiled.keyBit.get(requirement.keyId);
        return bit !== undefined && (this.state.keyMask & bit) === 0;
      });
    this.callbacks.onState({
      at: this.state.moduleId,
      keys: this.keys,
      switches: this.switches,
      trapped,
      atGoal,
      goalViolated,
    });
  }
}
