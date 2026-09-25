import * as THREE from 'three';

/**
 * A small, deliberately local visual language for the witness ghost. The
 * actor is positioned at the walking surface plus its center offset; this
 * visual hangs below that center so the hem stays just above the floor.
 */
export const GHOST_VISUAL_SIZE_CM = {
  width: 112,
  height: 160,
  depth: 112,
} as const;

export interface GhostMotion {
  velocity: THREE.Vector3;
  direction: THREE.Vector3;
  /** Signed amount of turn, normalized to roughly [-1, 1]. */
  turning: number;
  playing: boolean;
  finished: boolean;
}

export type GhostFinishKind = 'solution' | 'bypass' | 'dead_end' | 'replay';
export interface GhostFinishEvent {
  type: 'finish';
  kind: GhostFinishKind;
}
export type GhostVisualEvent = 'arrive' | 'key' | 'switch' | GhostFinishEvent;

export interface GhostVisualOptions {
  reducedMotion: () => boolean;
}

export interface GhostVisual {
  readonly object: THREE.Group;
  readonly cloth: THREE.Mesh;
  readonly hem: THREE.Mesh;
  readonly eyes: readonly THREE.Mesh[];
  update(dt: number, elapsed: number, motion: GhostMotion): void;
  setDirection(direction: THREE.Vector3): void;
  trigger(event: GhostVisualEvent): void;
  reset(): void;
  dispose(): void;
}

const SEGMENTS = 40;
const SCALLOPS = 6;
const CLOTH_COLOR = 0xe9e1dc;
const CLOTH_EMISSIVE = 0x1a0b0a;
const HEM_COLOR = 0xd1c5bf;
const EYE_COLOR = 0x171319;
// Leave a little room for the lean pose inside the actor's 120 cm envelope.
const FIGURE_FOOTPRINT_SCALE = 0.86;
const FIGURE_FLOOR_OFFSET = 2;
const REACTION_ATTACK_SECONDS = 0.14;
const REACTION_RELEASE_SECONDS = 0.72;

interface RingSpec {
  y: number;
  radius: number;
  scalloped?: boolean;
}

const BODY_RINGS: RingSpec[] = [
  // A continuous dome becomes nearly vertical at the shoulders. Avoid a
  // radius reversal here: it makes the crown look like a separate cap.
  { y: 76, radius: 8.9 },
  { y: 72, radius: 19.4 },
  { y: 66, radius: 27.5 },
  { y: 60, radius: 32.7 },
  { y: 53, radius: 36.7 },
  { y: 46, radius: 39 },
  { y: 39, radius: 40 },
  { y: 32, radius: 40.4 },
  { y: 23, radius: 41.2 },
  { y: 12, radius: 42.7 },
  { y: -1, radius: 44.6 },
  { y: -15, radius: 47 },
  { y: -29, radius: 48 },
  { y: -42, radius: 49 },
  { y: -53, radius: 50 },
  { y: -62, radius: 50 },
  { y: -68, radius: 50 },
  // The last skirt ring is also the hem's first ring. Keeping one shared
  // boundary avoids coplanar overlap and keeps the seam welded in motion.
  { y: -72, radius: 51, scalloped: true },
];

function ringVertex(spec: RingSpec, theta: number): [number, number, number] {
  const scallop = spec.scalloped
    ? Math.sin(theta * SCALLOPS) + 0.22 * Math.sin(theta * (SCALLOPS + 1) + 0.8)
    : 0;
  // The folds run continuously down the skirt. They are authored into the
  // rest mesh, so the ghost still reads as cloth when motion is paused.
  const depth = THREE.MathUtils.clamp((77 - spec.y) / 150, 0, 1);
  const lowerWeight = depth * depth;
  const fold = Math.cos(theta * SCALLOPS + 0.45) * 0.08 + Math.cos(theta * (SCALLOPS + 2) - 1.2) * 0.028;
  const verticalFold = 1 + fold * lowerWeight;
  const radius = (spec.radius + scallop * (spec.scalloped ? 2 : 0)) * verticalFold;
  const aspect = 1 + Math.cos(theta * 2) * 0.025;
  // Keep the deepest scallop inside the actor's floor clearance. The lower
  // edge dips from the ring's baseline, then turns back upward at the inset
  // ring instead of crossing the walking surface.
  const hemDrop = spec.scalloped ? (scallop - 1.2) * 2 : 0;
  return [Math.cos(theta) * radius * aspect, spec.y + hemDrop, Math.sin(theta) * radius];
}

function buildRingSurface(rings: RingSpec[], capTop: boolean, capBottom: boolean): THREE.BufferGeometry {
  const positions: number[] = [];
  const indices: number[] = [];
  for (const ring of rings) {
    for (let i = 0; i < SEGMENTS; i++) {
      positions.push(...ringVertex(ring, (i / SEGMENTS) * Math.PI * 2));
    }
  }
  for (let ring = 0; ring < rings.length - 1; ring++) {
    for (let i = 0; i < SEGMENTS; i++) {
      const next = (i + 1) % SEGMENTS;
      const a = ring * SEGMENTS + i;
      const b = ring * SEGMENTS + next;
      const c = (ring + 1) * SEGMENTS + next;
      const d = (ring + 1) * SEGMENTS + i;
      indices.push(a, b, d, b, c, d);
    }
  }
  if (capTop) {
    const center = positions.length / 3;
    positions.push(0, rings[0]!.y + 1, 0);
    for (let i = 0; i < SEGMENTS; i++) {
      const next = (i + 1) % SEGMENTS;
      indices.push(center, next, i);
    }
  }
  if (capBottom) {
    const center = positions.length / 3;
    positions.push(0, rings[rings.length - 1]!.y - 1, 0);
    const last = (rings.length - 1) * SEGMENTS;
    for (let i = 0; i < SEGMENTS; i++) {
      const next = (i + 1) % SEGMENTS;
      indices.push(center, last + next, last + i);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  (geometry.getAttribute('position') as THREE.BufferAttribute).setUsage(THREE.DynamicDrawUsage);
  return geometry;
}

/** The cloth body is a rounded radial surface, not a stock primitive. */
export function buildGhostClothGeometry(): THREE.BufferGeometry {
  return buildRingSurface(BODY_RINGS, true, false);
}

/** A separate turned-under band starts on the body's final ring. */
export function buildGhostHemGeometry(): THREE.BufferGeometry {
  return buildRingSurface([
    { y: -72, radius: 51, scalloped: true },
    { y: -74, radius: 53, scalloped: true },
    { y: -73, radius: 47, scalloped: true },
  ], false, false);
}

function material(
  color: number,
  emissive: number,
  opacity: number,
  side: THREE.Side = THREE.FrontSide,
): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    emissive,
    emissiveIntensity: 0.12,
    transparent: opacity < 1,
    opacity,
    roughness: 0.82,
    metalness: 0,
    side,
    depthWrite: opacity >= 1,
  });
}

function finite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function dampAngle(current: number, target: number, amount: number): number {
  const delta = Math.atan2(Math.sin(target - current), Math.cos(target - current));
  return current + delta * (1 - Math.exp(-Math.max(0, amount)));
}

interface SpringState {
  value: number;
  velocity: number;
  limit: number;
}

/** Semi-implicit spring integration with small fixed substeps for stable,
 * bounded motion when a browser tab resumes after a long frame. */
function advanceSpring(state: SpringState, target: number, dt: number, stiffness: number, damping: number): void {
  let remaining = Math.min(Math.max(0, dt), 0.1);
  while (remaining > 0) {
    const step = Math.min(remaining, 1 / 60);
    state.velocity += ((target - state.value) * stiffness - state.velocity * damping) * step;
    state.value += state.velocity * step;
    remaining -= step;
  }
  if (state.value > state.limit) {
    state.value = state.limit;
    state.velocity = Math.min(0, state.velocity);
  } else if (state.value < -state.limit) {
    state.value = -state.limit;
    state.velocity = Math.max(0, state.velocity);
  }
}

function geometryRest(geometry: THREE.BufferGeometry): Float32Array {
  const position = geometry.getAttribute('position');
  return new Float32Array(position.array as ArrayLike<number>);
}

function applyRest(geometry: THREE.BufferGeometry, rest: Float32Array): void {
  const position = geometry.getAttribute('position') as THREE.BufferAttribute;
  position.array.set(rest);
  position.needsUpdate = true;
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
}

function deform(
  geometry: THREE.BufferGeometry,
  rest: Float32Array,
  velocity: THREE.Vector3,
  lagX: number,
  lagZ: number,
  sway: number,
): void {
  const position = geometry.getAttribute('position') as THREE.BufferAttribute;
  const windX = THREE.MathUtils.clamp(finite(velocity.x) / 300, -1, 1);
  const windZ = THREE.MathUtils.clamp(finite(velocity.z) / 300, -1, 1);
  for (let i = 0; i < position.count; i++) {
    const offset = i * 3;
    const x = rest[offset] ?? 0;
    const y = rest[offset + 1] ?? 0;
    const z = rest[offset + 2] ?? 0;
    // Every frame starts from rest. The upper cloth responds immediately to
    // a new direction while the skirt uses the spring-fed trail values, so a
    // stop naturally catches up instead of waving forever in place.
    const lowerWeight = THREE.MathUtils.clamp((72 - y) / 150, 0, 1);
    const trailWeight = lowerWeight * lowerWeight;
    const headWeight = (1 - lowerWeight) * (1 - lowerWeight);
    const trailingX = lagX * (0.18 + trailWeight * 0.82) + sway * (0.12 + trailWeight * 0.88);
    const trailingZ = lagZ * (0.2 + trailWeight * 0.8);
    const responsiveX = windX * (0.35 + lowerWeight * 0.65) * 1.2 + windX * headWeight * 0.8;
    const responsiveZ = windZ * (0.35 + lowerWeight * 0.65) * 1.05 + windZ * headWeight * 0.6;
    // Opposing folds shear tangentially rather than translating as one
    // rigid skirt. Spatial harmonics are driven only by damped momentum;
    // there is no time oscillator. Identical seam vertices deform equally.
    const theta = Math.atan2(z, x);
    const foldSwing = trailWeight * (sway * 0.22 * Math.sin(theta * 3 + 0.45)
      + lagZ * 0.12 * Math.sin(theta * 2 - 0.6));
    const hemLift = -(Math.abs(lagZ) * 0.045 + Math.abs(sway) * 0.025) * lowerWeight;
    position.setXYZ(
      i,
      finite(x + trailingX + responsiveX - Math.sin(theta) * foldSwing),
      finite(y + hemLift),
      finite(z + trailingZ + responsiveZ + Math.cos(theta) * foldSwing),
    );
  }
  position.needsUpdate = true;
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
}

function eyeMesh(materialRef: THREE.MeshStandardMaterial, x: number): THREE.Mesh {
  const eye = new THREE.Mesh(new THREE.SphereGeometry(13, 16, 12), materialRef);
  eye.position.set(x, 30, 40);
  eye.scale.set(0.72, 1.28, 0.34);
  return eye;
}

type GhostEventName = 'arrive' | 'key' | 'switch' | 'finish';

function eventName(event: GhostVisualEvent | null): GhostEventName | null {
  return typeof event === 'string' ? event : event?.type ?? null;
}

function eventFinishKind(event: GhostVisualEvent | null): GhostFinishKind | null {
  return event !== null && typeof event === 'object' ? event.kind : null;
}

class ProceduralGhostVisual implements GhostVisual {
  readonly object = new THREE.Group();
  readonly cloth: THREE.Mesh;
  readonly hem: THREE.Mesh;
  readonly eyes: readonly THREE.Mesh[];

  private readonly figure = new THREE.Group();
  private readonly face = new THREE.Group();
  private readonly mouth: THREE.Mesh;
  private readonly clothRest: Float32Array;
  private readonly hemRest: Float32Array;
  private readonly motionReduced: () => boolean;
  private readonly eyeMaterial: THREE.MeshStandardMaterial;
  private readonly clothMaterial: THREE.MeshStandardMaterial;
  private readonly hemMaterial: THREE.MeshStandardMaterial;
  private readonly directionScratch = new THREE.Vector3();
  private readonly localVelocity = new THREE.Vector3();
  private readonly upAxis = new THREE.Vector3(0, 1, 0);
  private readonly lagX: SpringState = { value: 0, velocity: 0, limit: 9 };
  private readonly lagZ: SpringState = { value: 0, velocity: 0, limit: 14 };
  private readonly sway: SpringState = { value: 0, velocity: 0, limit: 12 };
  private readonly lift: SpringState = { value: 0, velocity: 0, limit: 4 };
  private readonly tiltX: SpringState = { value: 0, velocity: 0, limit: 0.1 };
  private readonly tiltZ: SpringState = { value: 0, velocity: 0, limit: 0.12 };
  private readonly reactionPulse: SpringState = { value: 0, velocity: 0, limit: 1 };
  private readonly reactionWidth: SpringState = { value: 0, velocity: 0, limit: 0.15 };
  private readonly reactionHeight: SpringState = { value: 0, velocity: 0, limit: 0.15 };
  private readonly reactionEyeWiden: SpringState = { value: 0, velocity: 0, limit: 0.2 };
  private readonly reactionMouth: SpringState = { value: 0, velocity: 0, limit: 0.2 };
  private readonly reactionLiftState: SpringState = { value: 0, velocity: 0, limit: 4 };
  private blinkClock = 0;
  private blinkDuration = 0;
  private eventClock = Number.POSITIVE_INFINITY;
  private event: GhostVisualEvent | null = null;
  private finishKind: GhostFinishKind | null = null;
  private yaw = 0;
  private reducedPose = false;
  private reducedPreference: boolean;
  private disposed = false;

  constructor(options: GhostVisualOptions) {
    this.motionReduced = options.reducedMotion;
    this.reducedPreference = this.motionReduced();
    this.clothMaterial = material(CLOTH_COLOR, CLOTH_EMISSIVE, 1, THREE.DoubleSide);
    this.hemMaterial = material(HEM_COLOR, 0x180e0c, 1, THREE.DoubleSide);
    this.eyeMaterial = material(EYE_COLOR, 0x030203, 1);
    this.cloth = new THREE.Mesh(buildGhostClothGeometry(), this.clothMaterial);
    this.hem = new THREE.Mesh(buildGhostHemGeometry(), this.hemMaterial);
    this.cloth.name = 'ghost-cloth';
    this.hem.name = 'ghost-turned-under-hem';
    this.clothRest = geometryRest(this.cloth.geometry);
    this.hemRest = geometryRest(this.hem.geometry);
    this.cloth.castShadow = true;
    this.cloth.receiveShadow = true;
    this.hem.castShadow = true;
    this.hem.receiveShadow = true;

    const leftEye = eyeMesh(this.eyeMaterial, -18);
    const rightEye = eyeMesh(this.eyeMaterial, 18);
    this.eyes = [leftEye, rightEye];
    this.mouth = new THREE.Mesh(new THREE.TorusGeometry(11, 2.5, 6, 14, Math.PI), this.eyeMaterial);
    this.mouth.name = 'ghost-mouth';
    this.mouth.position.set(0, 3, 40);
    this.mouth.scale.set(0.78, 0.64, 0.4);
    this.face.name = 'ghost-face';
    this.face.add(leftEye, rightEye, this.mouth);

    this.figure.add(this.cloth, this.hem, this.face);
    this.object.name = 'procedural-cloth-ghost';
    this.figure.name = 'ghost-cloth-figure';
    this.object.add(this.figure);

    const contact = new THREE.Mesh(
      new THREE.RingGeometry(34, 44, 28),
      new THREE.MeshBasicMaterial({ color: HEM_COLOR, transparent: true, opacity: 0.28, side: THREE.DoubleSide }),
    );
    contact.name = 'ghost-contact-ring';
    contact.rotation.x = -Math.PI / 2;
    contact.position.y = -78;
    this.object.add(contact);
    const lamp = new THREE.PointLight(HEM_COLOR, 45, 500, 1);
    lamp.position.set(0, -22, 20);
    this.object.add(lamp);
    this.reset();
  }

  update(dt: number, elapsed: number, motion: GhostMotion): void {
    if (this.disposed) return;
    const delta = THREE.MathUtils.clamp(finite(dt), 0, 0.1);
    const reduced = this.motionReduced();
    if (reduced !== this.reducedPreference) {
      this.reducedPreference = reduced;
      if (reduced) {
        this.neutralize();
        this.reducedPose = true;
      } else {
        this.reducedPose = false;
      }
      // A preference toggle while paused is state synchronization only. It
      // must not restart animation until the actor reports playback.
      if (delta === 0 || reduced) return;
    }
    if (reduced) {
      if (!this.reducedPose) {
        this.neutralize();
        this.reducedPose = true;
      }
      return;
    }
    this.reducedPose = false;
    if (!motion.playing || delta === 0) return;
    void elapsed;
    const finishing = motion.finished;
    this.directionScratch.copy(motion.direction);
    this.directionScratch.y = 0;
    if (this.directionScratch.lengthSq() < 0.0001) this.directionScratch.set(0, 0, 1);
    this.directionScratch.normalize();
    const targetYaw = Math.atan2(this.directionScratch.x, this.directionScratch.z);
    this.yaw = dampAngle(this.yaw, targetYaw, delta * 9);
    this.figure.rotation.y = this.yaw;

    if (finishing) {
      // The actor has already supplied the final movement frame. Finish
      // settling only damps the cloth; route velocity must not keep pushing it.
      this.localVelocity.set(0, 0, 0);
    } else {
      this.localVelocity.set(
        finite(motion.velocity.x),
        finite(motion.velocity.y),
        finite(motion.velocity.z),
      ).applyAxisAngle(this.upAxis, -this.yaw);
    }
    const speed = THREE.MathUtils.clamp(Math.hypot(this.localVelocity.x, this.localVelocity.z) / 300, 0, 1.4);
    const turn = finishing ? 0 : THREE.MathUtils.clamp(finite(motion.turning), -1, 1);
    const forward = THREE.MathUtils.clamp(this.localVelocity.z / 300, -1, 1);
    const side = THREE.MathUtils.clamp(this.localVelocity.x / 300, -1, 1);
    const idle = speed < 0.02;
    const eventType = eventName(this.event) ?? (this.finishKind !== null ? 'finish' : null);
    const finishKind = eventFinishKind(this.event) ?? this.finishKind;
    const failedFinish = eventType === 'finish' && finishKind !== 'solution' && finishKind !== 'replay';
    advanceSpring(this.lagX, THREE.MathUtils.clamp(-side * 7, -7, 7), delta, 42, 15);
    advanceSpring(this.lagZ, THREE.MathUtils.clamp(-forward * 12, -12, 12), delta, 42, 15);
    advanceSpring(this.sway, THREE.MathUtils.clamp(turn * 8 + side * 2, -10, 10), delta, 48, 16);
    advanceSpring(this.lift, finishing ? 0 : THREE.MathUtils.clamp(speed * 2.6, 0, 3), delta, 55, 18);
    advanceSpring(
      this.tiltX,
      finishing ? (failedFinish ? 0.022 : -0.018) : THREE.MathUtils.clamp(-forward * 0.09, -0.1, 0.1),
      delta,
      58,
      17,
    );
    advanceSpring(
      this.tiltZ,
      finishing ? (failedFinish ? -0.018 : 0.01) : THREE.MathUtils.clamp(side * 0.07 + turn * 0.05, -0.12, 0.12),
      delta,
      58,
      17,
    );
    if (idle && !finishing && this.dynamicsSettled()) this.resetDynamics();
    this.figure.rotation.x = this.tiltX.value;
    this.figure.rotation.z = this.tiltZ.value;
    this.figure.scale.set(
      FIGURE_FOOTPRINT_SCALE,
      1 - speed * 0.012,
      FIGURE_FOOTPRINT_SCALE,
    );
    deform(this.cloth.geometry, this.clothRest, this.localVelocity, this.lagX.value, this.lagZ.value, this.sway.value);
    deform(this.hem.geometry, this.hemRest, this.localVelocity, this.lagX.value, this.lagZ.value, this.sway.value);
    // Follow the cloth at eye height, keeping the face attached through
    // lateral lag and turns instead of letting the fabric swallow the eyes.
    const faceDepth = (72 - 30) / 150;
    const faceTrail = faceDepth * faceDepth;
    const faceHead = (1 - faceDepth) * (1 - faceDepth);
    this.face.position.set(
      this.lagX.value * (0.18 + faceTrail * 0.82) + this.sway.value * (0.12 + faceTrail * 0.88)
        + side * ((0.35 + faceDepth * 0.65) * 1.2 + faceHead * 0.8),
      -(Math.abs(this.lagZ.value) * 0.045 + Math.abs(this.sway.value) * 0.025) * faceDepth,
      this.lagZ.value * (0.2 + faceTrail * 0.8)
        + forward * ((0.35 + faceDepth * 0.65) * 1.05 + faceHead * 0.6),
    );

    this.blinkClock += delta;
    if (this.blinkDuration > 0) this.blinkDuration = Math.max(0, this.blinkDuration - delta);
    if (this.blinkClock >= 3.8 && this.blinkDuration === 0) {
      this.blinkClock = 0;
      this.blinkDuration = 0.16;
    }
    const blink = this.blinkDuration > 0 ? Math.sin((this.blinkDuration / 0.16) * Math.PI) : 0;
    for (const eye of this.eyes) eye.scale.y = 1.28 * (1 - blink * 0.88);

    if (this.event !== null) this.eventClock += delta;
    const reactionTarget = eventType === 'finish' || (eventType !== null && this.eventClock < REACTION_ATTACK_SECONDS) ? 1 : 0;
    advanceSpring(this.reactionPulse, reactionTarget, delta, 96, 22);
    const eventPulse = this.reactionPulse.value;
    this.advanceReactionTargets(eventPulse, eventType, finishKind, delta);
    this.applyReactionOutput();
    this.figure.position.y = FIGURE_FLOOR_OFFSET + this.lift.value + this.reactionLiftState.value;
    if (
      eventType !== null &&
      eventType !== 'finish' &&
      this.eventClock >= REACTION_RELEASE_SECONDS &&
      eventPulse < 0.015 &&
      Math.abs(this.reactionPulse.velocity) < 0.05 &&
      this.reactionSettled()
    ) {
      this.event = null;
      this.eventClock = Number.POSITIVE_INFINITY;
      this.resetReaction();
      this.applyReactionOutput();
    }
  }

  setDirection(direction: THREE.Vector3): void {
    if (this.disposed || direction.lengthSq() < 0.0001) return;
    const horizontal = direction.clone();
    horizontal.y = 0;
    if (horizontal.lengthSq() < 0.0001) return;
    this.yaw = Math.atan2(horizontal.x, horizontal.z);
    this.figure.rotation.y = this.yaw;
  }

  trigger(event: GhostVisualEvent): void {
    if (this.disposed) return;
    this.event = event;
    const finishKind = eventFinishKind(event);
    if (finishKind !== null) {
      this.finishKind = finishKind;
      this.blinkClock = 0;
      this.blinkDuration = 0;
      for (const eye of this.eyes) eye.scale.y = 1.28;
    }
    this.eventClock = 0;
    // Keep the current output in place. The reaction springs move toward the
    // new target on the next playing tick, so an interrupted key/switch pulse
    // cannot jump to a different expression.
    if (this.motionReduced()) {
      this.reducedPreference = true;
      this.reducedPose = true;
      this.neutralize();
    }
  }

  reset(): void {
    if (this.disposed) return;
    this.reducedPreference = this.motionReduced();
    this.blinkClock = 0;
    this.blinkDuration = 0;
    this.eventClock = Number.POSITIVE_INFINITY;
    this.event = null;
    this.finishKind = null;
    this.yaw = 0;
    this.reducedPose = false;
    this.resetDynamics();
    this.resetReaction();
    this.figure.rotation.set(0, 0, 0);
    this.figure.position.set(0, 0, 0);
    this.figure.scale.set(FIGURE_FOOTPRINT_SCALE, 1, FIGURE_FOOTPRINT_SCALE);
    this.face.scale.set(1, 1, 1);
    this.mouth.scale.set(0.78, 0.64, 0.4);
    for (const eye of this.eyes) eye.scale.set(0.72, 1.28, 0.34);
    this.neutralize();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    this.object.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        geometries.add(child.geometry);
        const childMaterials = Array.isArray(child.material) ? child.material : [child.material];
        for (const childMaterial of childMaterials) materials.add(childMaterial);
      }
    });
    for (const geometry of geometries) geometry.dispose();
    for (const childMaterial of materials) childMaterial.dispose();
  }

  private neutralize(): void {
    this.resetDynamics();
    this.resetReaction();
    this.blinkClock = 0;
    this.blinkDuration = 0;
    // Preserve yaw: changing the accessibility preference must not make the
    // witness turn its back on the route or the camera.
    this.figure.rotation.y = this.yaw;
    this.figure.rotation.x = 0;
    this.figure.rotation.z = 0;
    this.figure.position.set(0, 0, 0);
    this.figure.scale.set(FIGURE_FOOTPRINT_SCALE, 1, FIGURE_FOOTPRINT_SCALE);
    applyRest(this.cloth.geometry, this.clothRest);
    applyRest(this.hem.geometry, this.hemRest);
    this.face.position.set(0, 0, 0);
    const type = eventName(this.event) ?? (this.finishKind !== null ? 'finish' : null);
    const kind = eventFinishKind(this.event) ?? this.finishKind;
    this.setStaticReaction(type === null ? 0 : 1, type, kind);
    for (const eye of this.eyes) eye.scale.y = 1.28;
    this.figure.position.y = FIGURE_FLOOR_OFFSET + this.reactionLiftState.value;
  }

  private resetDynamics(): void {
    this.lagX.value = 0;
    this.lagX.velocity = 0;
    this.lagZ.value = 0;
    this.lagZ.velocity = 0;
    this.sway.value = 0;
    this.sway.velocity = 0;
    this.lift.value = 0;
    this.lift.velocity = 0;
    this.tiltX.value = 0;
    this.tiltX.velocity = 0;
    this.tiltZ.value = 0;
    this.tiltZ.velocity = 0;
  }

  private dynamicsSettled(): boolean {
    return Math.abs(this.lagX.value) < 0.02 && Math.abs(this.lagX.velocity) < 0.02
      && Math.abs(this.lagZ.value) < 0.02 && Math.abs(this.lagZ.velocity) < 0.02
      && Math.abs(this.sway.value) < 0.02 && Math.abs(this.sway.velocity) < 0.02
      && Math.abs(this.lift.value) < 0.02 && Math.abs(this.lift.velocity) < 0.02
      && Math.abs(this.tiltX.value) < 0.02 && Math.abs(this.tiltX.velocity) < 0.02
      && Math.abs(this.tiltZ.value) < 0.02 && Math.abs(this.tiltZ.velocity) < 0.02;
  }

  private resetReaction(): void {
    this.reactionPulse.value = 0;
    this.reactionPulse.velocity = 0;
    this.reactionWidth.value = 0;
    this.reactionWidth.velocity = 0;
    this.reactionHeight.value = 0;
    this.reactionHeight.velocity = 0;
    this.reactionEyeWiden.value = 0;
    this.reactionEyeWiden.velocity = 0;
    this.reactionMouth.value = 0;
    this.reactionMouth.velocity = 0;
    this.reactionLiftState.value = 0;
    this.reactionLiftState.velocity = 0;
  }

  private setStaticReaction(pulse: number, type: GhostEventName | null, finishKind: GhostFinishKind | null): void {
    const failedFinish = type === 'finish' && finishKind !== 'solution' && finishKind !== 'replay';
    const widthPulse = type === 'key' ? 0.09 : type === 'switch' ? 0.06 : type === 'finish' ? 0.04 : 0;
    const heightPulse = failedFinish ? -0.06 : type === 'key' ? 0.06 : type === 'switch' ? 0.04 : type === 'finish' ? 0.05 : 0;
    const eyeWiden = type === 'key' ? 0.14 : type === 'switch' ? 0.07 : type === 'finish' ? 0.03 : 0;
    const mouthPulse = type === 'finish' ? (failedFinish ? -0.12 : 0.14) : type === 'switch' ? 0.04 : -0.02;
    this.reactionPulse.value = pulse;
    this.reactionWidth.value = pulse * widthPulse;
    this.reactionHeight.value = pulse * heightPulse;
    this.reactionEyeWiden.value = pulse * eyeWiden;
    this.reactionMouth.value = pulse * mouthPulse;
    this.reactionLiftState.value = this.reactionLift(pulse, type, finishKind);
    this.applyReactionOutput();
  }

  private advanceReactionTargets(pulse: number, type: GhostEventName | null, finishKind: GhostFinishKind | null, delta: number): void {
    const failedFinish = type === 'finish' && finishKind !== 'solution' && finishKind !== 'replay';
    const widthPulse = type === 'key' ? 0.09 : type === 'switch' ? 0.06 : type === 'finish' ? 0.04 : 0;
    const heightPulse = failedFinish ? -0.06 : type === 'key' ? 0.06 : type === 'switch' ? 0.04 : type === 'finish' ? 0.05 : 0;
    const eyeWiden = type === 'key' ? 0.14 : type === 'switch' ? 0.07 : type === 'finish' ? 0.03 : 0;
    const mouthPulse = type === 'finish' ? (failedFinish ? -0.12 : 0.14) : type === 'switch' ? 0.04 : -0.02;
    advanceSpring(this.reactionWidth, pulse * widthPulse, delta, 120, 24);
    advanceSpring(this.reactionHeight, pulse * heightPulse, delta, 120, 24);
    advanceSpring(this.reactionEyeWiden, pulse * eyeWiden, delta, 120, 24);
    advanceSpring(this.reactionMouth, pulse * mouthPulse, delta, 120, 24);
    advanceSpring(this.reactionLiftState, this.reactionLift(pulse, type, finishKind), delta, 120, 24);
  }

  private applyReactionOutput(): void {
    this.face.scale.set(1 + this.reactionWidth.value, 1 + this.reactionHeight.value, 1);
    for (const eye of this.eyes) eye.scale.x = 0.72 * (1 + this.reactionEyeWiden.value);
    this.mouth.scale.y = 0.64 + this.reactionMouth.value;
  }

  private reactionSettled(): boolean {
    return Math.abs(this.reactionWidth.value) < 0.015 && Math.abs(this.reactionWidth.velocity) < 0.05
      && Math.abs(this.reactionHeight.value) < 0.015 && Math.abs(this.reactionHeight.velocity) < 0.05
      && Math.abs(this.reactionEyeWiden.value) < 0.015 && Math.abs(this.reactionEyeWiden.velocity) < 0.05
      && Math.abs(this.reactionMouth.value) < 0.015 && Math.abs(this.reactionMouth.velocity) < 0.05
      && Math.abs(this.reactionLiftState.value) < 0.015 && Math.abs(this.reactionLiftState.velocity) < 0.05;
  }

  private reactionLift(pulse: number, type: GhostEventName | null, finishKind: GhostFinishKind | null): number {
    if (type === 'finish') return pulse * (finishKind === 'solution' || finishKind === 'replay' ? 3 : 0.5);
    if (type === 'key') return pulse * 1.5;
    if (type === 'switch') return pulse * 0.6;
    return 0;
  }
}

export function createGhostVisual(options: GhostVisualOptions): GhostVisual {
  return new ProceduralGhostVisual(options);
}
