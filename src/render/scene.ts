import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { MoveRecord } from '../core/movement';
import { CARDINALS, type Cardinal, type Door, type LevelModule } from '../../shared/schema';
import { GEOMETRY, centerPoint, dirDelta, portPoint, type Vec3 } from '../core/catalog';
import { neighbor, type CompiledLevel } from '../core/topology';
import {
  GhostActor,
  PlayerActor,
  reducedMotion,
  type ActorContext,
  type GhostCallbacks,
  type PlayerCallbacks,
} from './actors';

/**
 * Imperative Three.js diorama built from the compiled level (§3, §12).
 * Rendering never decides movement legality — it consumes the same catalog
 * the core uses. Camera follows actors with a dt-normalized lerp and snaps
 * instantly under reduced motion.
 */

const COLORS = {
  background: 0x101216,
  floor: 0x8d8577,
  bridge: 0x7c8a94,
  ramp: 0x9a8f7d,
  wall: 0x5c574d,
  rail: 0x47433c,
  doorKey: 0xc9a227,
  doorSeal: 0x8a3b3b,
  doorPlain: 0x6f6a60,
  key: 0xd4af37,
  switchPad: 0xb0533a,
  spawn: 0xd7d2c4,
  goal: 0xc9a227,
} as const;

const WALL_HEIGHT_CM = 120;
const RAIL_HEIGHT_CM = 60;
const WALL_THICKNESS_CM = 24;
const DOOR_POST_HEIGHT_CM = 170;

interface Mats {
  floor: THREE.MeshStandardMaterial;
  bridge: THREE.MeshStandardMaterial;
  ramp: THREE.MeshStandardMaterial;
  wall: THREE.MeshStandardMaterial;
  rail: THREE.MeshStandardMaterial;
  doorKey: THREE.MeshStandardMaterial;
  doorSeal: THREE.MeshStandardMaterial;
  doorPlain: THREE.MeshStandardMaterial;
  key: THREE.MeshStandardMaterial;
  switchPad: THREE.MeshStandardMaterial;
  spawn: THREE.MeshStandardMaterial;
  goal: THREE.MeshStandardMaterial;
}

function standard(color: number, metalness = 0): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, metalness, roughness: 0.85 });
}

function buildMats(): Mats {
  return {
    floor: standard(COLORS.floor),
    bridge: standard(COLORS.bridge),
    ramp: standard(COLORS.ramp),
    wall: standard(COLORS.wall),
    rail: standard(COLORS.rail),
    doorKey: standard(COLORS.doorKey, 0.55),
    doorSeal: standard(COLORS.doorSeal),
    doorPlain: standard(COLORS.doorPlain),
    key: standard(COLORS.key, 0.65),
    switchPad: standard(COLORS.switchPad),
    spawn: standard(COLORS.spawn),
    goal: standard(COLORS.goal, 0.5),
  };
}

export interface SceneHandle {
  dispose(): void;
  spawnGhost(
    route: MoveRecord[],
    kind: 'solution' | 'bypass' | 'dead_end',
    missingKeys: string[],
    callbacks: GhostCallbacks,
  ): GhostActor;
  spawnPlayer(callbacks: PlayerCallbacks): PlayerActor;
  /** Arrow-key orbiting is disabled while manual play owns the arrows. */
  setKeyboardOrbit(enabled: boolean): void;
}

function layoutCenter(compiled: CompiledLevel): Vec3 {
  const modules = compiled.level.modules;
  const sum = modules.reduce(
    (acc, m) => {
      const c = centerPoint(m);
      return { x: acc.x + c.x, y: acc.y + c.y, z: acc.z + c.z };
    },
    { x: 0, y: 0, z: 0 },
  );
  const count = Math.max(modules.length, 1);
  return { x: sum.x / count, y: sum.y / count, z: sum.z / count };
}

/**
 * A wall or rail block along one edge of a module. N/S edges run along x;
 * E/W edges run along z.
 */
function addEdgeBlock(
  world: THREE.Group,
  m: LevelModule,
  dir: Cardinal,
  height: number,
  material: THREE.MeshStandardMaterial,
): void {
  const c = centerPoint(m);
  const half = GEOMETRY.cellPitchCm / 2;
  const { dx, dz } = dirDelta(dir);
  const alongX = dz !== 0;
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(
      alongX ? GEOMETRY.cellPitchCm : WALL_THICKNESS_CM,
      height,
      alongX ? WALL_THICKNESS_CM : GEOMETRY.cellPitchCm,
    ),
    material,
  );
  mesh.position.set(c.x + dx * half, c.y + height / 2, c.z + dz * half);
  world.add(mesh);
}

function addModule(world: THREE.Group, mats: Mats, compiled: CompiledLevel, m: LevelModule): void {
  const c = centerPoint(m);
  if (m.template === 'ramp') {
    const slope = Math.hypot(GEOMETRY.cellPitchCm, GEOMETRY.floorSpacingCm);
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(GEOMETRY.cellPitchCm, GEOMETRY.floorSlabThicknessCm, slope),
      mats.ramp,
    );
    const angle = Math.atan2(GEOMETRY.floorSpacingCm, GEOMETRY.cellPitchCm);
    if (m.orientation === 'N') mesh.rotation.x = angle;
    else if (m.orientation === 'S') mesh.rotation.x = -angle;
    else if (m.orientation === 'E') mesh.rotation.z = angle;
    else mesh.rotation.z = -angle;
    mesh.position.set(c.x, c.y, c.z);
    world.add(mesh);
    return; // the slope form reads as closed sides; polished rails later
  }

  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(
      GEOMETRY.cellPitchCm,
      GEOMETRY.floorSlabThicknessCm,
      GEOMETRY.cellPitchCm,
    ),
    m.template === 'bridge' ? mats.bridge : mats.floor,
  );
  mesh.position.set(c.x, c.y - GEOMETRY.floorSlabThicknessCm / 2, c.z);
  world.add(mesh);

  // Closed sides get walls; open sides with no connection get visible edge
  // protection — unmatched openings are legal but impassable (§4.1).
  for (const dir of CARDINALS) {
    if (!m.ports.includes(dir)) {
      addEdgeBlock(world, m, dir, WALL_HEIGHT_CM, mats.wall);
    } else if (neighbor(compiled, m.id, dir) === null) {
      addEdgeBlock(world, m, dir, RAIL_HEIGHT_CM, mats.rail);
    }
  }
}

function doorMaterial(mats: Mats, door: Door): THREE.MeshStandardMaterial {
  const conditions = door.conditions;
  if (conditions?.requiresKey !== undefined) return mats.doorKey;
  if (conditions?.closesAfterSwitch !== undefined) return mats.doorSeal;
  return mats.doorPlain;
}

/** Door frame: two posts, a lintel, and a sill across the shared port. */
function addDoorFrames(world: THREE.Group, mats: Mats, compiled: CompiledLevel): void {
  for (const door of compiled.level.doors) {
    const material = doorMaterial(mats, door);
    for (const dir of CARDINALS) {
      if (neighbor(compiled, door.a, dir)?.toId !== door.b) continue;
      const a = compiled.moduleById.get(door.a);
      if (!a) continue;
      const p = portPoint(a, dir);
      const alongX = dir === 'N' || dir === 'S';
      const offset = GEOMETRY.portWidthCm / 2 + WALL_THICKNESS_CM / 2;
      for (const side of [-1, 1]) {
        const post = new THREE.Mesh(
          new THREE.BoxGeometry(WALL_THICKNESS_CM, DOOR_POST_HEIGHT_CM, WALL_THICKNESS_CM),
          material,
        );
        post.position.set(
          p.x + (alongX ? side * offset : 0),
          p.y + DOOR_POST_HEIGHT_CM / 2,
          p.z + (alongX ? 0 : side * offset),
        );
        world.add(post);
      }
      const span = GEOMETRY.portWidthCm + 2 * WALL_THICKNESS_CM;
      const lintel = new THREE.Mesh(
        new THREE.BoxGeometry(
          alongX ? span : WALL_THICKNESS_CM,
          WALL_THICKNESS_CM,
          alongX ? WALL_THICKNESS_CM : span,
        ),
        material,
      );
      lintel.position.set(p.x, p.y + DOOR_POST_HEIGHT_CM, p.z);
      world.add(lintel);
      const sill = new THREE.Mesh(
        new THREE.BoxGeometry(alongX ? GEOMETRY.portWidthCm : 12, 10, alongX ? 12 : GEOMETRY.portWidthCm),
        material,
      );
      sill.position.set(p.x, p.y + 5, p.z);
      world.add(sill);
      break; // exactly one direction joins the two endpoints
    }
  }
}

function addItems(world: THREE.Group, mats: Mats, compiled: CompiledLevel): void {
  for (const key of compiled.level.keys) {
    const m = compiled.moduleById.get(key.moduleId);
    if (!m) continue;
    const c = centerPoint(m);
    const mesh = new THREE.Mesh(new THREE.OctahedronGeometry(46), mats.key);
    mesh.position.set(c.x, c.y + 90, c.z);
    mesh.rotation.y = Math.PI / 5;
    world.add(mesh);
  }
  for (const pad of compiled.level.switches) {
    const m = compiled.moduleById.get(pad.moduleId);
    if (!m) continue;
    const c = centerPoint(m);
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(42, 52, 22, 24), mats.switchPad);
    mesh.position.set(c.x, c.y + 11, c.z);
    world.add(mesh);
  }
  const spawn = compiled.moduleById.get(compiled.spawn);
  if (spawn) {
    const c = centerPoint(spawn);
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(60, 60, 8, 32), mats.spawn);
    mesh.position.set(c.x, c.y + 4, c.z);
    world.add(mesh);
  }
  const goal = compiled.moduleById.get(compiled.goal);
  if (goal) {
    const c = centerPoint(goal);
    const chest = new THREE.Mesh(new THREE.BoxGeometry(150, 110, 110), mats.goal);
    chest.position.set(c.x, c.y + 55, c.z);
    world.add(chest);
    const lid = new THREE.Mesh(new THREE.ConeGeometry(80, 70, 4), mats.goal);
    lid.rotation.y = Math.PI / 4;
    lid.position.set(c.x, c.y + 145, c.z);
    world.add(lid);
  }
}

export function mountScene(host: HTMLElement, compiled: CompiledLevel): SceneHandle {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(host.clientWidth || 800, host.clientHeight || 600);
  host.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(COLORS.background);

  const mats = buildMats();
  const world = new THREE.Group();
  scene.add(world);
  for (const m of compiled.level.modules) {
    addModule(world, mats, compiled, m);
  }
  addDoorFrames(world, mats, compiled);
  addItems(world, mats, compiled);

  const center = layoutCenter(compiled);
  const camera = new THREE.PerspectiveCamera(45, 16 / 9, 10, 40000);
  camera.position.set(center.x + 1500, 3400, center.z + 3900);
  camera.lookAt(center.x, center.y, center.z);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(center.x, center.y, center.z);
  controls.maxPolarAngle = Math.PI / 2.05;
  // Keyboard orbit only while the canvas itself is focused, so arrows stay
  // free for manual play; damping follows reduced-motion changes live.
  renderer.domElement.tabIndex = 0;
  controls.listenToKeyEvents(renderer.domElement);
  const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  const syncDamping = () => {
    controls.enableDamping = !motionQuery.matches;
  };
  syncDamping();
  motionQuery.addEventListener('change', syncDamping);

  scene.add(new THREE.AmbientLight(0xffffff, 0.55));
  const sun = new THREE.DirectionalLight(0xfff2dd, 1.15);
  sun.position.set(center.x - 2200, 5200, center.z + 1600);
  scene.add(sun);

  const actorUpdates = new Set<(dt: number, elapsed: number) => void>();
  let followTarget: THREE.Object3D | null = null;
  let lastTime = performance.now();
  let frame = 0;
  const tick = () => {
    const now = performance.now();
    const dt = Math.min((now - lastTime) / 1000, 0.1);
    lastTime = now;
    for (const update of actorUpdates) update(dt, now);
    if (followTarget !== null) {
      const k = 1 - Math.exp(-dt * 5);
      controls.target.lerp(followTarget.position, reducedMotion() ? 1 : k);
    }
    controls.update();
    renderer.render(scene, camera);
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);

  const resize = () => {
    const w = host.clientWidth;
    const h = host.clientHeight;
    if (w === 0 || h === 0) return;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  };
  const observer = new ResizeObserver(resize);
  observer.observe(host);

  const actorContext: ActorContext = {
    scene,
    compiled,
    register: (update) => {
      actorUpdates.add(update);
      return () => actorUpdates.delete(update);
    },
    follow: (target) => {
      followTarget = target;
    },
  };

  return {
    spawnGhost(route, kind, missingKeys, callbacks) {
      return new GhostActor(actorContext, route, kind, missingKeys, callbacks);
    },
    spawnPlayer(callbacks) {
      return new PlayerActor(actorContext, callbacks);
    },
    setKeyboardOrbit(enabled) {
      if (enabled) {
        controls.listenToKeyEvents(renderer.domElement);
      } else {
        controls.stopListenToKeyEvents();
      }
    },
    dispose() {
      cancelAnimationFrame(frame);
      motionQuery.removeEventListener('change', syncDamping);
      observer.disconnect();
      controls.dispose();
      world.traverse((obj) => {
        if (obj instanceof THREE.Mesh) obj.geometry.dispose();
      });
      for (const material of Object.values(mats)) material.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
