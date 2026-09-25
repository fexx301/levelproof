import * as THREE from 'three';
import type { Cardinal } from '../../shared/schema.js';
import { centerPoint } from '../core/catalog.js';
import { goalRequirementViolated, initialState, step, transitions, type GameState, type MoveRecord } from '../core/movement.js';
import type { CompiledLevel } from '../core/topology.js';
import { createGhostVisual, type GhostMotion, type GhostVisual } from './ghost-visual.js';

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
const FINISH_SETTLE_SECONDS = 0.72;
/** Contract floor (§12): reduced motion means a stepped ghost, no pulse. Read live so mid-session preference changes are honored. */
export function reducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export interface GhostTickState {
  playing: boolean;
  finished: boolean;
  pausedAtEvidence: boolean;
  moveIndex: number;
  totalMoves: number;
  keys: string[];
  switches: string[];
}

export interface GhostFinishInfo {
  endState: GameState;
  kind: 'solution' | 'bypass' | 'dead_end' | 'replay';
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

/** Engine-state hooks the scene implements: doors that seal, plates that
 * depress, keys that vanish. The actors report; the engine's state decides. */
export interface WorldEvents {
  updateState(state: GameState): void;
  collectKey(keyId: string): void;
  activateSwitch(switchId: string): void;
  resetWorld(): void;
}

export interface ActorContext {
  scene: THREE.Scene;
  compiled: CompiledLevel;
  register: (update: (dt: number, elapsed: number) => void) => () => void;
  follow: (target: THREE.Object3D | null) => void;
  world: WorldEvents;
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

/** Trail/emissive colors mirror the shell: fail red, pass green (§12). */
const TRAIL_FAIL = 0x8a3630;
const TRAIL_PASS = 0x4fbe82;

function actorBody(color: number, emissive: number, opacity: number): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.CapsuleGeometry(ACTOR_RADIUS_CM, ACTOR_BODY_CM, 6, 12),
    new THREE.MeshStandardMaterial({
      color,
      emissive,
      emissiveIntensity: 1.0,
      transparent: opacity < 1,
      opacity,
      roughness: 0.5,
    }),
  );
  mesh.castShadow = true;
  return mesh;
}

/** Bright contact ring at the actor's feet so it grounds and stays findable. */
function underRing(color: number): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.RingGeometry(30, 42, 24),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.75, side: THREE.DoubleSide }),
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = -(ACTOR_CENTER_OFFSET_CM - 12);
  return mesh;
}

class PolylineCurve extends THREE.Curve<THREE.Vector3> {
  private readonly lengths: number[] = [0];
  constructor(private readonly points: THREE.Vector3[]) {
    super();
    for (let i = 1; i < points.length; i++) {
      this.lengths.push(this.lengths[i - 1]! + points[i]!.distanceTo(points[i - 1]!));
    }
  }
  override getPoint(t: number, target = new THREE.Vector3()): THREE.Vector3 {
    const total = this.lengths[this.lengths.length - 1]!;
    const d = Math.max(0, Math.min(1, t)) * total;
    for (let i = 1; i < this.points.length; i++) {
      if (d <= this.lengths[i]! || i === this.points.length - 1) {
        const seg = this.lengths[i]! - this.lengths[i - 1]!;
        const k = seg === 0 ? 0 : (d - this.lengths[i - 1]!) / seg;
        return target.copy(this.points[i - 1]!).lerp(this.points[i]!, k);
      }
    }
    return target.copy(this.points[0]!);
  }
}
/**
 * The witness route rendered as an unlit tube on the floor plus an end
 * marker ring at the route's final state. Fail routes read red; the one
 * winning route reads pass green.
 */
function buildTrail(steps: PathStep[], kind: GhostFinishInfo['kind']): THREE.Group {
  const group = new THREE.Group();
  const color = kind === 'solution' || kind === 'replay' ? TRAIL_PASS : TRAIL_FAIL;
  const points = steps.flatMap((s) => s.points);
  if (points.length >= 2) {
    const lifted = points.map((p) => new THREE.Vector3(p.x, p.y + 12, p.z));
    const total = new PolylineCurve(lifted).getLength();
    const tube = new THREE.Mesh(
      new THREE.TubeGeometry(new PolylineCurve(lifted), Math.max(8, Math.ceil(total / 24)), 10, 6),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8 }),
    );
    group.add(tube);
    const end = lifted[lifted.length - 1]!;
    // A faint vertical beam at the destination reads through walls: the
    // viewer sees where the route ends before the ghost gets there.
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(10, 10, 280, 8, 1, true),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.3, side: THREE.DoubleSide }),
    );
    beam.position.set(end.x, end.y + 150, end.z);
    group.add(beam);
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(40, 62, 28),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, side: THREE.DoubleSide }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(end.x, end.y + 2, end.z);
    group.add(ring);
  }
  return group;
}

export class GhostActor {
  readonly mesh: THREE.Group;
  private readonly ctx: ActorContext;
  private readonly steps: PathStep[];
  private readonly callbacks: GhostCallbacks;
  private readonly kind: GhostFinishInfo['kind'];
  private readonly missingKeys: string[];
  private readonly unregister: () => void;
  private readonly visual: GhostVisual;
  private readonly trail: THREE.Group;
  private readonly pauseAfterMoveIndex: number | null;
  private readonly previousPosition = new THREE.Vector3();
  private readonly positionDelta = new THREE.Vector3();
  private readonly horizontalDelta = new THREE.Vector3();
  private readonly velocity = new THREE.Vector3();
  private readonly direction = new THREE.Vector3(0, 0, 1);
  private readonly visualMotion: GhostMotion = {
    velocity: this.velocity,
    direction: this.direction,
    turning: 0,
    playing: false,
    finished: false,
  };
  private index = 0;
  private distance = 0;
  private stepClock = 0;
  private playing = false;
  private finished = false;
  private finishVisualPlaying = false;
  private finishVisualClock = 0;
  private stepMode = false;
  private breakpointPending = false;
  private pausedAtEvidence = false;
  private keys: string[] = [];
  private switches: string[] = [];
  private endState: GameState;
  private disposed = false;

  constructor(
    ctx: ActorContext,
    route: MoveRecord[],
    kind: GhostFinishInfo['kind'],
    missingKeys: string[],
    callbacks: GhostCallbacks,
    pauseAfterMoveIndex: number | null = null,
  ) {
    this.ctx = ctx;
    this.steps = pathSteps(route);
    this.kind = kind;
    this.missingKeys = missingKeys;
    this.callbacks = callbacks;
    this.pauseAfterMoveIndex = pauseAfterMoveIndex !== null && pauseAfterMoveIndex > 0 ? pauseAfterMoveIndex : null;
    this.breakpointPending = this.pauseAfterMoveIndex !== null;
    this.endState = route.length > 0 ? route[route.length - 1]!.after : initialState(ctx.compiled);
    this.mesh = new THREE.Group();
    this.visual = createGhostVisual({ reducedMotion });
    this.mesh.add(this.visual.object);
    if (this.steps.length > 0) {
      const start = this.steps[0]!.points[0]!;
      this.mesh.position.set(start.x, start.y + ACTOR_CENTER_OFFSET_CM, start.z);
      this.seedDirection();
      this.visual.setDirection(this.direction);
    }
    this.previousPosition.copy(this.mesh.position);
    ctx.scene.add(this.mesh);
    ctx.world.resetWorld();
    ctx.world.updateState(route.length > 0 ? route[0]!.before : initialState(ctx.compiled));
    // The witness route is drawn on the floor ahead of the ghost: the viewer
    // sees the doomed path, not just a pawn in the dark.
    this.trail = buildTrail(this.steps, kind);
    ctx.scene.add(this.trail);
    ctx.follow(this.mesh);
    this.unregister = ctx.register(this.update);
    this.emit();
  }

  play(): void {
    if (this.disposed) return;
    if (this.finished) this.restart();
    if (this.steps.length === 0) return;
    if (this.index >= this.steps.length) {
      this.pausedAtEvidence = false;
      this.finish();
      return;
    }
    this.pausedAtEvidence = false;
    this.stepMode = false;
    this.playing = true;
    this.emit();
  }

  pause(): void {
    if (this.disposed) return;
    this.playing = false;
    this.finishVisualPlaying = false;
    this.stepMode = false;
    this.emit();
  }

  step(): void {
    if (this.disposed) return;
    if (this.finished) this.restart();
    if (this.steps.length === 0) return;
    if (this.index >= this.steps.length) {
      this.pausedAtEvidence = false;
      this.finish();
      return;
    }
    this.pausedAtEvidence = false;
    this.stepMode = true;
    this.playing = true;
    this.emit();
  }

  restart(): void {
    if (this.disposed) return;
    this.index = 0;
    this.distance = 0;
    this.stepClock = 0;
    this.finished = false;
    this.breakpointPending = this.pauseAfterMoveIndex !== null;
    this.pausedAtEvidence = false;
    this.finishVisualPlaying = false;
    this.finishVisualClock = 0;
    this.keys = [];
    this.switches = [];
    this.ctx.world.resetWorld();
    this.ctx.world.updateState(initialState(this.ctx.compiled));
    if (this.steps.length > 0) {
      const start = this.steps[0]!.points[0]!;
      this.mesh.position.set(start.x, start.y + ACTOR_CENTER_OFFSET_CM, start.z);
    }
    this.velocity.set(0, 0, 0);
    this.previousPosition.copy(this.mesh.position);
    this.visual.reset();
    if (this.steps.length > 0) {
      this.seedDirection();
      this.visual.setDirection(this.direction);
    } else {
      this.direction.set(0, 0, 1);
    }
    this.emit();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unregister();
    this.ctx.follow(null);
    this.ctx.world.resetWorld();
    this.ctx.scene.remove(this.mesh);
    this.ctx.scene.remove(this.trail);
    this.visual.dispose();
    this.trail.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.geometry.dispose();
        const materials = Array.isArray(child.material) ? child.material : [child.material];
        for (const material of materials) material.dispose();
      }
    });
  }

  private update = (dt: number, elapsed: number): void => {
    if (this.disposed) return;
    if (this.finished) {
      this.visualMotion.playing = this.finishVisualPlaying;
      this.visualMotion.finished = true;
      this.visualMotion.turning = 0;
      this.visual.update(this.finishVisualPlaying ? dt : 0, elapsed, this.visualMotion);
      if (this.finishVisualPlaying) {
        const finishDelta = Math.min(Math.max(Number.isFinite(dt) ? dt : 0, 0), 0.1);
        this.finishVisualClock += finishDelta;
        if (this.finishVisualClock >= FINISH_SETTLE_SECONDS) this.finishVisualPlaying = false;
      }
      return;
    }
    if (!this.playing || this.steps.length === 0) {
      // A zero-delta visual tick is enough to adopt a live reduced-motion
      // preference while paused, without advancing cloth or expression time.
      this.visualMotion.playing = false;
      this.visualMotion.finished = false;
      this.visualMotion.turning = 0;
      this.visual.update(0, elapsed, this.visualMotion);
      return;
    }
    if (reducedMotion()) {
      // Stepped ghost: one discrete move per interval, no interpolation.
      this.stepClock += dt;
      if (this.stepClock < 0.6) {
        this.visualMotion.playing = true;
        this.visualMotion.finished = false;
        this.visualMotion.turning = 0;
        this.visual.update(0, elapsed, this.visualMotion);
        return;
      }
      this.stepClock = 0;
      this.distance += this.steps[this.index]!.length;
    } else {
      this.distance += WALK_SPEED_CM_S * dt;
    }
    while (this.index < this.steps.length && this.distance >= this.steps[this.index]!.length) {
      this.distance -= this.steps[this.index]!.length;
      const completed = this.steps[this.index]!;
      const endpoint = completed.points[completed.points.length - 1]!;
      this.mesh.position.set(endpoint.x, endpoint.y + ACTOR_CENTER_OFFSET_CM, endpoint.z);
      this.index++;
      this.arrive(completed.move);
      if (this.breakpointPending && this.index >= this.pauseAfterMoveIndex!) {
        this.breakpointPending = false;
        this.pausedAtEvidence = true;
        this.updateVisual(dt, elapsed);
        this.playing = false;
        this.stepMode = false;
        this.distance = 0;
        this.emit();
        return;
      }
      if (this.index >= this.steps.length) {
        this.updateVisual(dt, elapsed);
        this.finish();
        return;
      }
      if (this.stepMode) {
        this.updateVisual(dt, elapsed);
        this.playing = false;
        this.distance = 0;
        this.emit();
        return;
      }
    }
    const current = this.steps[Math.min(this.index, this.steps.length - 1)]!;
    const position = pointAt(current, this.distance);
    this.mesh.position.set(position.x, position.y + ACTOR_CENTER_OFFSET_CM, position.z);
    this.updateVisual(dt, elapsed);
  };

  private arrive(move: MoveRecord): void {
    this.ctx.world.updateState(move.after);
    if (move.events.collectedKey) {
      this.keys = [...this.keys, move.events.collectedKey];
      this.ctx.world.collectKey(move.events.collectedKey);
    }
    if (move.events.activatedSwitch) {
      this.switches = [...this.switches, move.events.activatedSwitch];
      this.ctx.world.activateSwitch(move.events.activatedSwitch);
    }
    this.visual.trigger(move.events.collectedKey ? 'key' : move.events.activatedSwitch ? 'switch' : 'arrive');
    this.callbacks.onArrive(move);
    this.emit();
  }

  private finish(): void {
    this.finished = true;
    this.playing = false;
    this.pausedAtEvidence = false;
    this.finishVisualPlaying = true;
    this.finishVisualClock = 0;
    this.velocity.set(0, 0, 0);
    this.visual.trigger({ type: 'finish', kind: this.kind });
    this.emit();
    this.callbacks.onFinish({ endState: this.endState, kind: this.kind, missingKeys: this.missingKeys });
  }

  private seedDirection(): void {
    for (const step of this.steps) {
      for (let i = 1; i < step.points.length; i++) {
        this.direction.subVectors(step.points[i]!, step.points[i - 1]!);
        this.direction.y = 0;
        if (this.direction.lengthSq() > 0.0001) {
          this.direction.normalize();
          return;
        }
      }
    }
    this.direction.set(0, 0, 1);
  }

  private updateVisual(dt: number, elapsed: number): void {
    const seconds = Math.max(Math.min(Math.max(Number.isFinite(dt) ? dt : 0, 0), 0.1), 0.000001);
    this.positionDelta.subVectors(this.mesh.position, this.previousPosition);
    this.velocity.copy(this.positionDelta).divideScalar(seconds);
    this.horizontalDelta.copy(this.positionDelta);
    this.horizontalDelta.y = 0;
    let turning = 0;
    if (this.horizontalDelta.lengthSq() > 0.0001) {
      this.horizontalDelta.normalize();
      const dot = THREE.MathUtils.clamp(this.direction.dot(this.horizontalDelta), -1, 1);
      const cross = this.direction.x * this.horizontalDelta.z - this.direction.z * this.horizontalDelta.x;
      turning = Math.sign(cross || 1) * Math.acos(dot) / Math.PI;
      this.direction.copy(this.horizontalDelta);
    }
    this.previousPosition.copy(this.mesh.position);
    this.visualMotion.playing = this.playing;
    this.visualMotion.finished = this.finished;
    this.visualMotion.turning = turning;
    this.visual.update(dt, elapsed, this.visualMotion);
  }

  private emit(): void {
    this.callbacks.onTick({
      playing: this.playing,
      finished: this.finished,
      pausedAtEvidence: this.pausedAtEvidence,
      moveIndex: this.index,
      totalMoves: this.steps.length,
      keys: this.keys,
      switches: this.switches,
    });
  }
}

export class PlayerActor {
  readonly mesh: THREE.Group;
  private readonly ctx: ActorContext;
  private readonly callbacks: PlayerCallbacks;
  private readonly unregister: () => void;
  private state: GameState;
  private keys: string[] = [];
  private switches: string[] = [];
  private visitedModules: Set<string>;
  private animation: { points: THREE.Vector3[]; length: number; distance: number; move: MoveRecord } | null = null;

  constructor(ctx: ActorContext, callbacks: PlayerCallbacks) {
    this.ctx = ctx;
    this.callbacks = callbacks;
    this.state = initialState(ctx.compiled);
    this.visitedModules = new Set([this.state.moduleId]);
    this.mesh = new THREE.Group();
    this.mesh.add(actorBody(0xd7d2c4, 0x6e6a5e, 1), underRing(0xf2eee4));
    this.placeAtSpawn();
    ctx.scene.add(this.mesh);
    ctx.world.resetWorld();
    ctx.world.updateState(this.state);
    ctx.follow(this.mesh);
    this.unregister = ctx.register(this.update);
    this.emit();
  }

  /** One transition completes before the next input (§12). */
  move(dir: Cardinal): void {
    if (this.animation) return;
    const move = step(this.ctx.compiled, this.state, dir);
    if (!move) return;
    if (reducedMotion()) {
      // Reduced motion: instant transition, no interpolation.
      this.state = move.after;
      this.visitedModules.add(move.after.moduleId);
      this.ctx.world.updateState(move.after);
      if (move.events.collectedKey) {
        this.keys = [...this.keys, move.events.collectedKey];
        this.ctx.world.collectKey(move.events.collectedKey);
      }
      if (move.events.activatedSwitch) {
        this.switches = [...this.switches, move.events.activatedSwitch];
        this.ctx.world.activateSwitch(move.events.activatedSwitch);
      }
      const destination = move.segments[move.segments.length - 1]!;
      this.mesh.position.set(
        destination.x,
        destination.y + ACTOR_CENTER_OFFSET_CM,
        destination.z,
      );
      this.emit();
      return;
    }
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
    this.visitedModules = new Set([this.state.moduleId]);
    this.ctx.world.resetWorld();
    this.ctx.world.updateState(this.state);
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
    this.ctx.world.resetWorld();
    this.ctx.scene.remove(this.mesh);
    for (const child of this.mesh.children) {
      if (child instanceof THREE.Mesh) {
        child.geometry.dispose();
        (child.material as THREE.Material).dispose();
      }
    }
  }


  private update = (dt: number): void => {
    if (!this.animation) return;
    this.animation.distance += WALK_SPEED_CM_S * dt;
    if (this.animation.distance >= this.animation.length) {
      const move = this.animation.move;
      const endpoint = move.segments[move.segments.length - 1]!;
      this.mesh.position.set(endpoint.x, endpoint.y + ACTOR_CENTER_OFFSET_CM, endpoint.z);
      this.animation = null;
      this.state = move.after;
      this.visitedModules.add(move.after.moduleId);
      this.ctx.world.updateState(move.after);
      if (move.events.collectedKey) {
        this.keys = [...this.keys, move.events.collectedKey];
        this.ctx.world.collectKey(move.events.collectedKey);
      }
      if (move.events.activatedSwitch) {
        this.switches = [...this.switches, move.events.activatedSwitch];
        this.ctx.world.activateSwitch(move.events.activatedSwitch);
      }
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
    const goalViolated = goalRequirementViolated(this.ctx.compiled, this.state, this.visitedModules);
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
