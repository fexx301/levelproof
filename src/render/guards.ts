import * as THREE from 'three';
import { CARDINALS, type Patrol } from '../../shared/schema.js';
import { centerPoint, traversalSegments } from '../core/catalog.js';
import { neighbor, type CompiledLevel } from '../core/topology.js';
import { CharacterRig, characterIfLoaded, preloadCharacter, type CharacterAsset, type CharacterClip } from './character.js';

/**
 * Guards (§6.4), rendering only: where a guard stands on each turn comes
 * from core `patrolPosition`, and the world's mechanisms decide when it
 * walks. Each guard is the same animated character in a crimson livery,
 * with a red ring on the floor where it will step next turn and a faint
 * dashed line along its beat. No lights are added (the light count is fixed).
 */

export const GUARD_COLOR = 0xb8322a;
const GUARD_RIM = 0xff8a70;
const MARKER_COLOR = 0xe0483c;

const toVector = (point: { x: number; y: number; z: number }): THREE.Vector3 => new THREE.Vector3(point.x, point.y, point.z);

/** The floor path from one route room to the next: the same geometry the player walks. */
export function guardPath(compiled: CompiledLevel, from: string, to: string): THREE.Vector3[] {
  const a = compiled.moduleById.get(from);
  const b = compiled.moduleById.get(to);
  if (a === undefined || b === undefined) return [];
  if (from === to) return [toVector(centerPoint(a)), toVector(centerPoint(a))];
  for (const dir of CARDINALS) {
    if (neighbor(compiled, from, dir)?.toId === to) return traversalSegments(a, dir, b).map(toVector);
  }
  return [toVector(centerPoint(a)), toVector(centerPoint(b))];
}

function pathLength(points: THREE.Vector3[]): number {
  let length = 0;
  for (let i = 1; i < points.length; i++) length += points[i]!.distanceTo(points[i - 1]!);
  return length;
}

function pointAlong(points: THREE.Vector3[], distance: number, target: THREE.Vector3): THREE.Vector3 {
  let remaining = Math.max(0, distance);
  for (let i = 1; i < points.length; i++) {
    const segment = points[i]!.distanceTo(points[i - 1]!);
    if (remaining <= segment || i === points.length - 1) {
      return target.copy(points[i - 1]!).lerp(points[i]!, segment === 0 ? 0 : Math.min(1, remaining / segment));
    }
    remaining -= segment;
  }
  return target.copy(points[0] ?? target);
}

/** A stand-in sentinel until the animated character has loaded. */
function sentinelFigure(): THREE.Group {
  const figure = new THREE.Group();
  const livery = new THREE.MeshStandardMaterial({ color: GUARD_COLOR, emissive: GUARD_COLOR, emissiveIntensity: 0.25, roughness: 0.55 });
  const iron = new THREE.MeshStandardMaterial({ color: 0x3a3634, metalness: 0.5, roughness: 0.45 });
  const add = (geometry: THREE.BufferGeometry, material: THREE.Material, y: number): void => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.y = y;
    mesh.castShadow = true;
    figure.add(mesh);
  };
  add(new THREE.CapsuleGeometry(26, 60, 6, 12), livery, 62);
  add(new THREE.SphereGeometry(21, 16, 12), livery, 128);
  add(new THREE.ConeGeometry(25, 30, 12), iron, 152);
  return figure;
}

/** The next-turn marker: a red ring and a faint disc on the floor. */
function nextStepMarker(): THREE.Group {
  const group = new THREE.Group();
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(46, 62, 32),
    new THREE.MeshBasicMaterial({ color: MARKER_COLOR, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false }),
  );
  const disc = new THREE.Mesh(
    new THREE.CircleGeometry(46, 32),
    new THREE.MeshBasicMaterial({ color: MARKER_COLOR, transparent: true, opacity: 0.18, side: THREE.DoubleSide, depthWrite: false }),
  );
  for (const mesh of [ring, disc]) {
    mesh.rotation.x = -Math.PI / 2;
    group.add(mesh);
  }
  group.position.y = 4;
  return group;
}

/** The guard's beat as a dashed floor line through its route rooms. */
function beatLine(compiled: CompiledLevel, patrol: Patrol): THREE.Line {
  const points: THREE.Vector3[] = [];
  for (let i = 1; i < patrol.route.length; i++) {
    const leg = guardPath(compiled, patrol.route[i - 1]!, patrol.route[i]!);
    points.push(...(points.length === 0 ? leg : leg.slice(1)));
  }
  const geometry = new THREE.BufferGeometry().setFromPoints(points.map((p) => new THREE.Vector3(p.x, p.y + 6, p.z)));
  const line = new THREE.Line(
    geometry,
    new THREE.LineDashedMaterial({ color: MARKER_COLOR, dashSize: 22, gapSize: 16, transparent: true, opacity: 0.55 }),
  );
  line.computeLineDistances();
  return line;
}

interface Walk {
  points: THREE.Vector3[];
  length: number;
  distance: number;
  speed: number;
}

export class GuardView {
  /** The figure; added to the pickable world (select a guard, then describe). */
  readonly root = new THREE.Group();
  /** Floor overlays (marker and beat line); not pickable. */
  readonly overlay = new THREE.Group();
  private readonly figure = new THREE.Group();
  private readonly marker = nextStepMarker();
  private rig: CharacterRig | null = null;
  private fallback: THREE.Group | null = null;
  private walk: Walk | null = null;
  /** The room the guard stands in, or is walking to. */
  heading: string | null = null;
  private nextPoint: THREE.Vector3 | null = null;
  private yaw = 0;
  private pulse = 0;
  private disposed = false;
  private readonly scratch = new THREE.Vector3();

  constructor(
    readonly patrol: Patrol,
    compiled: CompiledLevel,
    private readonly reduced: () => boolean,
    /** Called when the animated character replaces the stand-in (re-tag for picking). */
    private readonly onFigure: (root: THREE.Object3D) => void = () => {},
  ) {
    this.root.add(this.figure);
    this.overlay.add(this.marker, beatLine(compiled, patrol));
    const asset = characterIfLoaded();
    if (asset !== null) this.attach(asset);
    else {
      this.fallback = sentinelFigure();
      this.figure.add(this.fallback);
      preloadCharacter().then((loaded) => {
        if (!this.disposed) this.attach(loaded);
      }, () => undefined);
    }
  }

  /** True while the guard is between rooms. */
  get walking(): boolean {
    return this.walk !== null;
  }

  /** Stand in a room at once (reset, restart, or a turn without animation). */
  snapTo(point: THREE.Vector3, room: string): void {
    this.heading = room;
    this.walk = null;
    this.root.position.copy(point);
    this.rig?.setLocomotion(0);
    this.showMarker();
  }

  /** Walk a path over `seconds` (0 = arrive at once). */
  walkPath(points: THREE.Vector3[], seconds: number, room: string): void {
    const length = pathLength(points);
    if (seconds <= 0 || length < 1 || this.reduced()) {
      this.snapTo(points.at(-1) ?? this.root.position.clone(), room);
      return;
    }
    this.heading = room;
    this.root.position.copy(points[0]!);
    this.walk = { points, length, distance: 0, speed: length / seconds };
    this.marker.visible = false;
  }

  /** Where the guard will step next turn (null hides the marker). */
  setNext(point: THREE.Vector3 | null): void {
    this.nextPoint = point;
    if (!this.walking) this.showMarker();
  }

  gesture(clip: CharacterClip): void {
    this.rig?.perform(clip);
  }

  update(dt: number): void {
    const seconds = Math.min(Math.max(Number.isFinite(dt) ? dt : 0, 0), 0.1);
    if (this.walk !== null) {
      const walk = this.walk;
      walk.distance += walk.speed * seconds;
      const before = this.scratch.copy(this.root.position);
      const dx0 = before.x;
      const dz0 = before.z;
      pointAlong(walk.points, walk.distance, this.root.position);
      this.face(this.root.position.x - dx0, this.root.position.z - dz0, seconds);
      this.rig?.setLocomotion(walk.speed);
      if (walk.distance >= walk.length) {
        this.walk = null;
        this.rig?.setLocomotion(0);
        this.showMarker();
      }
    } else {
      this.rig?.setLocomotion(0);
    }
    this.rig?.update(this.reduced() ? 0 : seconds);
    if (this.marker.visible && !this.reduced()) {
      this.pulse += seconds;
      this.marker.scale.setScalar(1 + 0.08 * Math.sin(this.pulse * 5));
    }
  }

  dispose(): void {
    this.disposed = true;
    this.rig?.dispose();
    this.rig = null;
    const release = (root: THREE.Object3D): void =>
      root.traverse((child) => {
        // Skinned character geometry is shared with the cached asset.
        if ((child instanceof THREE.Mesh || child instanceof THREE.Line) && !(child instanceof THREE.SkinnedMesh)) {
          child.geometry.dispose();
          (child.material as THREE.Material).dispose();
        }
      });
    release(this.fallback ?? new THREE.Group());
    release(this.overlay);
    this.root.removeFromParent();
    this.overlay.removeFromParent();
  }

  private showMarker(): void {
    this.marker.visible = this.nextPoint !== null;
    if (this.nextPoint !== null) this.marker.position.set(this.nextPoint.x, this.nextPoint.y + 4, this.nextPoint.z);
  }

  private face(dx: number, dz: number, dt: number): void {
    if (Math.abs(dx) + Math.abs(dz) < 0.01) return;
    const target = Math.atan2(dx, dz);
    let delta = target - this.yaw;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    this.yaw += delta * (this.reduced() ? 1 : 1 - Math.exp(-dt * 15));
    this.figure.rotation.y = this.yaw;
  }

  private attach(asset: CharacterAsset): void {
    if (this.fallback !== null) {
      this.figure.remove(this.fallback);
      this.fallback.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          child.geometry.dispose();
          (child.material as THREE.Material).dispose();
        }
      });
      this.fallback = null;
    }
    this.rig = new CharacterRig(asset, { tint: { color: GUARD_COLOR, rim: GUARD_RIM } });
    this.figure.add(this.rig.object);
    this.onFigure(this.root);
  }
}
