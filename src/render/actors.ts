import * as THREE from 'three';
import type { Cardinal } from '../../shared/schema.js';
import { centerPoint } from '../core/catalog.js';
import { initialState, step, transitions, type GameState, type MoveRecord } from '../core/movement.js';
import type { CompiledLevel } from '../core/topology.js';

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
/** Contract floor (§12): reduced motion means a stepped ghost, no pulse. Read live so mid-session preference changes are honored. */
export function reducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

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

/** A back-face shell one size up: reads as a rim outline from any angle. */
function actorOutline(color: number, opacity: number): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.CapsuleGeometry(ACTOR_RADIUS_CM, ACTOR_BODY_CM, 6, 12),
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity,
      side: THREE.BackSide,
    }),
  );
  mesh.scale.setScalar(1.22);
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
/** A tapering tail under the capsule: reads as a spirit pawn, not a pill. */
function ghostWisp(): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.ConeGeometry(30, 80, 12, 1, true),
    new THREE.MeshBasicMaterial({ color: 0xd57064, transparent: true, opacity: 0.55, side: THREE.DoubleSide }),
  );
  mesh.rotation.x = Math.PI;
  mesh.position.y = -(ACTOR_CENTER_OFFSET_CM - 30);
  return mesh;
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
  private readonly body: THREE.Mesh;
  private readonly trail: THREE.Group;
  private index = 0;
  private distance = 0;
  private stepClock = 0;
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
    this.mesh = new THREE.Group();
    this.body = actorBody(0xe0685c, 0xc2453a, 0.95);
    this.body.scale.setScalar(1.15);
    this.mesh.add(this.body, actorOutline(0xffa89c, 0.5), underRing(0xffc0b5), ghostWisp());
    // Physical light units at cm scale: decay-1 lamp (see scene.ts goal light).
    const ghostLamp = new THREE.PointLight(0xd57064, 260, 1500, 1);
    ghostLamp.position.y = -(ACTOR_CENTER_OFFSET_CM - 55);
    this.mesh.add(ghostLamp);
    if (this.steps.length > 0) {
      const start = this.steps[0]!.points[0]!;
      this.mesh.position.set(start.x, start.y + ACTOR_CENTER_OFFSET_CM, start.z);
    }
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
    this.ctx.world.resetWorld();
    this.ctx.world.updateState(initialState(this.ctx.compiled));
    if (this.steps.length > 0) {
      const start = this.steps[0]!.points[0]!;
      this.mesh.position.set(start.x, start.y + ACTOR_CENTER_OFFSET_CM, start.z);
    }
    this.emit();
  }

  dispose(): void {
    this.unregister();
    this.ctx.follow(null);
    this.ctx.world.resetWorld();
    this.ctx.scene.remove(this.mesh);
    this.ctx.scene.remove(this.trail);
    for (const child of [...this.mesh.children, ...this.trail.children]) {
      if (child instanceof THREE.Mesh) {
        child.geometry.dispose();
        (child.material as THREE.Material).dispose();
      }
    }
  }

  private update = (dt: number, elapsed: number): void => {
    if (this.finished) {
      if (!reducedMotion()) {
        // Hold at the trapped state, pulsing gently so the eye finds it.
        const material = this.body.material as THREE.MeshStandardMaterial;
        material.opacity = 0.55 + 0.2 * Math.sin(elapsed * 0.004);
        material.emissiveIntensity = 0.8 + 0.4 * Math.sin(elapsed * 0.004);
      }
      return;
    }
    if (!this.playing || this.steps.length === 0) return;
    if (reducedMotion()) {
      // Stepped ghost: one discrete move per interval, no interpolation.
      this.stepClock += dt;
      if (this.stepClock < 0.6) return;
      this.stepClock = 0;
      this.distance += this.steps[this.index]!.length;
    } else {
      this.distance += WALK_SPEED_CM_S * dt;
    }
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
    this.ctx.world.updateState(move.after);
    if (move.events.collectedKey) {
      this.keys = [...this.keys, move.events.collectedKey];
      this.ctx.world.collectKey(move.events.collectedKey);
    }
    if (move.events.activatedSwitch) {
      this.switches = [...this.switches, move.events.activatedSwitch];
      this.ctx.world.activateSwitch(move.events.activatedSwitch);
    }
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
  readonly mesh: THREE.Group;
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
      this.animation = null;
      this.state = move.after;
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
