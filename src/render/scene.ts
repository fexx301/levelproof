import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { MoveRecord } from '../core/movement.js';
import { CARDINALS, type Cardinal, type Door, type LevelModule } from '../../shared/schema.js';
import { GEOMETRY, centerPoint, dirDelta, portPoint, type Vec3 } from '../core/catalog.js';
import { doorPassable, type GameState } from '../core/movement.js';
import { applyOperations } from '../core/level.js';
import type { Operation } from '../../shared/schema.js';
import { neighbor, type CompiledLevel } from '../core/topology.js';
import {
  GhostActor,
  PlayerActor,
  reducedMotion,
  type ActorContext,
  type GhostCallbacks,
  type PlayerCallbacks,
} from './actors.js';

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
  wall: 0x6a655a,
  rail: 0x47433c,
  // Brass family: the key and the door it opens share the accent (§12).
  doorKey: 0xc9a227,
  key: 0xd4af37,
  // Danger family: the sealing door and its switch are one mechanism.
  doorSeal: 0x74302f,
  switchPad: 0xb0533a,
  // Ghost/player families mirror the shell's fail and text tokens.
  ghost: 0xd57064,
  player: 0xd7d2c4,
  doorPlain: 0x6f6a60,
  spawn: 0xd7d2c4,
  // The goal mirrors the shell's --color-pass: reaching it is the pass state.
  goal: 0x3fa66a,
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
  switchRim: THREE.MeshStandardMaterial;
  spawn: THREE.MeshStandardMaterial;
  goal: THREE.MeshStandardMaterial;
  goalHalo: THREE.MeshStandardMaterial;
}

/** Mutable per-entity visuals driven by engine state (§12): doors that
 * seal, plates that depress, keys that vanish into inventory. */
interface DoorVisual {
  group: THREE.Group;
  openY: number;
  closedY: number;
  targetOpen: boolean;
}

interface SwitchVisual {
  plate: THREE.Mesh;
  rim: THREE.Mesh;
}

interface WorldVisuals {
  keys: Map<string, THREE.Group>;
  switches: Map<string, SwitchVisual>;
  doors: Map<string, DoorVisual>;
}

function standard(color: number, metalness = 0): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, metalness, roughness: 0.85 });
}

function lit(color: number, emissive: number, intensity: number, metalness = 0): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    emissive,
    emissiveIntensity: intensity,
    metalness,
    roughness: 0.7,
  });
}

function buildMats(): Mats {
  return {
    floor: standard(COLORS.floor),
    bridge: standard(COLORS.bridge),
    ramp: standard(COLORS.ramp),
    wall: standard(COLORS.wall),
    rail: standard(COLORS.rail),
    doorKey: lit(COLORS.doorKey, 0x6b5312, 0.45, 0.55),
    doorSeal: lit(COLORS.doorSeal, 0x3a100e, 0.55),
    doorPlain: standard(COLORS.doorPlain),
    key: lit(COLORS.key, 0x8a6d1c, 0.75, 0.65),
    switchPad: lit(COLORS.switchPad, 0x7a2a1c, 0.9),
    switchRim: lit(COLORS.doorSeal, 0x3a100e, 0.65),
    spawn: lit(COLORS.spawn, 0x55504a, 0.25),
    goal: lit(COLORS.goal, 0x2c8a52, 1.3, 0.2),
    goalHalo: lit(COLORS.goal, 0x2c8a52, 1.0),
  };
}

export interface SceneHandle {
  dispose(): void;
  spawnGhost(
    route: MoveRecord[],
    kind: 'solution' | 'bypass' | 'dead_end' | 'replay',
    missingKeys: string[],
    callbacks: GhostCallbacks,
  ): GhostActor;
  /** Before/after markers for a repair candidate (§9): old positions in
   * fail-red, proposed positions in pass-green; null clears. */
  previewOperations(operations: Operation[] | null): void;
  spawnPlayer(callbacks: PlayerCallbacks): PlayerActor;
  /** Arrow-key orbiting is disabled while manual play owns the arrows. */
  setKeyboardOrbit(enabled: boolean): void;
  /** Overlay the engine's per-module recovery analysis on the floors. */
  setAnalysis(map: { stranded: string[]; unreachable: string[] } | null): void;
  /** Analysis overlays are the author's view — never shown while playing. */
  setAnalysisVisible(visible: boolean): void;
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
  if (conditions?.requiresKey !== undefined || conditions?.requiresKeys !== undefined) return mats.doorKey;
  if (conditions?.closesAfterSwitch !== undefined) return mats.doorSeal;
  return mats.doorPlain;
}

/** Door frame: two posts, a lintel, and a sill across the shared port. */
function addDoorFrames(world: THREE.Group, mats: Mats, compiled: CompiledLevel, visuals: WorldVisuals): void {
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
      // Portcullis slab for stateful doors: keyed doors rest LOCKED (the
      // vault reads as locked); sealing doors rest OPEN and slam when their
      // switch fires. The engine decides openness — doorPassable() below.
      const conditions = door.conditions;
      if (conditions?.requiresKey !== undefined || conditions?.requiresKeys !== undefined || conditions?.closesAfterSwitch !== undefined) {
        const slab = new THREE.Group();
        const slabHeight = DOOR_POST_HEIGHT_CM - 14;
        const barCount = 4;
        for (let bar = 0; bar < barCount; bar++) {
          const t = bar / (barCount - 1);
          const barMesh = new THREE.Mesh(
            new THREE.BoxGeometry(10, slabHeight, 10),
            material,
          );
          barMesh.position.set(
            (alongX ? (t - 0.5) * GEOMETRY.portWidthCm : 0),
            slabHeight / 2,
            (alongX ? 0 : (t - 0.5) * GEOMETRY.portWidthCm),
          );
          slab.add(barMesh);
        }
        const rail = new THREE.Mesh(
          new THREE.BoxGeometry(
            alongX ? GEOMETRY.portWidthCm + 8 : 12,
            12,
            alongX ? 12 : GEOMETRY.portWidthCm + 8,
          ),
          material,
        );
        rail.position.y = slabHeight;
        slab.add(rail);
        const keyed = conditions?.requiresKey !== undefined || conditions?.requiresKeys !== undefined;
        const startsOpen = !keyed; // sealing doors start open; keyed start locked
        slab.position.set(p.x, p.y + (startsOpen ? DOOR_POST_HEIGHT_CM + 10 : 0), p.z);
        world.add(slab);
        visuals.doors.set(door.id, {
          group: slab,
          openY: p.y + DOOR_POST_HEIGHT_CM + 10,
          closedY: p.y,
          targetOpen: startsOpen,
        });
      }
      // Type telegraph: a keyhole gem on keyed doors, a warning bar on seals.
      const requiredKeys = conditions?.requiresKeys ?? (conditions?.requiresKey !== undefined ? [conditions.requiresKey] : []);
      if (requiredKeys.length > 0) {
        // One keyhole gem per required key, fanned across the lintel.
        const span = Math.min(requiredKeys.length, 3);
        for (let i = 0; i < span; i++) {
          const gem = new THREE.Mesh(
            new THREE.OctahedronGeometry(12),
            new THREE.MeshBasicMaterial({ color: 0xe8c65a, transparent: true, opacity: 0.6 }),
          );
          const offset = (i - (span - 1) / 2) * 34;
          gem.position.set(
            p.x + (alongX ? offset : 0),
            p.y + DOOR_POST_HEIGHT_CM + 24,
            p.z + (alongX ? 0 : offset),
          );
          world.add(gem);
        }
      } else if (conditions?.closesAfterSwitch !== undefined) {
        const bar = new THREE.Mesh(
          new THREE.BoxGeometry(alongX ? span * 0.72 : 14, 10, alongX ? 14 : span * 0.72),
          new THREE.MeshBasicMaterial({ color: 0x9e3d35, transparent: true, opacity: 0.85 }),
        );
        bar.position.set(p.x, p.y + DOOR_POST_HEIGHT_CM + 22, p.z);
        world.add(bar);
      }
      break; // exactly one direction joins the two endpoints
    }
  }
}

type DecorUpdate = (dt: number, elapsed: number) => void;

/**
 * Items get authored silhouettes (§12): a floating key that reads as a key, a
 * pressure-plate switch with a danger rim, and a pass-green goal beacon.
 * Idle spin/bob is disabled under reduced motion.
 */
function addItems(
  world: THREE.Group,
  mats: Mats,
  compiled: CompiledLevel,
  decorUpdates: DecorUpdate[],
  visuals: WorldVisuals,
): void {
  for (const key of compiled.level.keys) {
    const m = compiled.moduleById.get(key.moduleId);
    if (!m) continue;
    const c = centerPoint(m);
    const group = new THREE.Group();
    const bow = new THREE.Mesh(new THREE.TorusGeometry(26, 9, 10, 20), mats.key);
    bow.position.x = -36;
    const shaft = new THREE.Mesh(new THREE.BoxGeometry(72, 12, 12), mats.key);
    shaft.position.x = 8;
    for (const [x, h] of [
      [28, 24],
      [8, 18],
    ] as const) {
      const tooth = new THREE.Mesh(new THREE.BoxGeometry(12, h, 12), mats.key);
      tooth.position.set(x, -6 - h / 2, 0);
      group.add(tooth);
    }
    group.add(bow, shaft);
    group.scale.setScalar(1.6);
    const baseY = c.y + 105;
    group.position.set(c.x, baseY, c.z);
    world.add(group);
    group.userData.baseY = baseY;
    visuals.keys.set(key.id, group);
    decorUpdates.push((dt, elapsed) => {
      if (reducedMotion()) return;
      if (group.visible) {
        group.rotation.y += dt * 0.7;
        group.position.y = baseY + Math.sin(elapsed * 0.002) * 8;
      }
    });
  }
  for (const pad of compiled.level.switches) {
    const m = compiled.moduleById.get(pad.moduleId);
    if (!m) continue;
    const c = centerPoint(m);
    const base = new THREE.Mesh(new THREE.CylinderGeometry(78, 88, 12, 28), mats.wall);
    base.position.set(c.x, c.y + 6, c.z);
    const plate = new THREE.Mesh(new THREE.CylinderGeometry(46, 50, 16, 24), mats.switchPad);
    plate.position.set(c.x, c.y + 14, c.z);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(64, 6, 8, 32), mats.switchRim.clone());
    rim.rotation.x = Math.PI / 2;
    rim.position.set(c.x, c.y + 12, c.z);
    plate.userData.restY = plate.position.y;
    world.add(base, plate, rim);
    visuals.switches.set(pad.id, { plate, rim });
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
    const pedestal = new THREE.Mesh(new THREE.CylinderGeometry(50, 62, 36, 24), mats.wall);
    pedestal.position.set(c.x, c.y + 18, c.z);
    world.add(pedestal);
    const beacon = new THREE.Group();
    const gem = new THREE.Mesh(new THREE.OctahedronGeometry(40), mats.goal);
    const halo = new THREE.Mesh(new THREE.TorusGeometry(72, 5, 8, 40), mats.goalHalo);
    halo.rotation.x = Math.PI / 2;
    beacon.add(gem, halo);
    const baseY = c.y + 130;
    beacon.position.set(c.x, baseY, c.z);
    // Three.js >= r155 uses physical light units; at cm scale, decay-1 with
    // intensity ~= desired illuminance at 1 unit keeps pools readable.
    beacon.add(new THREE.PointLight(COLORS.goal, 320, 1700, 1));
    world.add(beacon);
    decorUpdates.push((dt, elapsed) => {
      if (reducedMotion()) return;
      beacon.rotation.y += dt * 0.6;
      beacon.position.y = baseY + Math.sin(elapsed * 0.0016) * 10;
    });
  }
}

export function mountScene(host: HTMLElement, compiled: CompiledLevel): SceneHandle {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(host.clientWidth || 800, host.clientHeight || 600);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.12;
  host.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(COLORS.background);

  const mats = buildMats();
  const world = new THREE.Group();
  scene.add(world);
  const visuals: WorldVisuals = { keys: new Map(), switches: new Map(), doors: new Map() };
  for (const m of compiled.level.modules) {
    addModule(world, mats, compiled, m);
  }
  addDoorFrames(world, mats, compiled, visuals);
  const decorUpdates: DecorUpdate[] = [];
  addItems(world, mats, compiled, decorUpdates, visuals);
  // Everything solid casts and receives; upper floors shadow lower ones.
  world.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      obj.castShadow = true;
      obj.receiveShadow = true;
    }
  });

  // Lighting: warm key light with real shadows, cool sky fill, faint ambient.
  scene.add(new THREE.HemisphereLight(0x505662, 0x2a241c, 0.8));
  scene.add(new THREE.AmbientLight(0xffffff, 0.2));
  const center = layoutCenter(compiled);
  const sun = new THREE.DirectionalLight(0xfff2dd, 1.35);
  sun.position.set(center.x - 2200, 5200, center.z + 1600);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 500;
  sun.shadow.camera.far = 20000;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 12;
  scene.add(sun);
  scene.add(sun.target);

  // Fit-to-level framing: frame the level's bounding sphere so the diorama
  // fills the viewport instead of floating in margins. The view direction
  // keeps the original elevated southeast azimuth.
  let boundsRadius = 800;
  let boundsMin = new THREE.Vector3(-800, -300, -800);
  let boundsMax = new THREE.Vector3(800, 300, 800);
  {
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    const half = GEOMETRY.cellPitchCm / 2 + WALL_THICKNESS_CM;
    for (const m of compiled.level.modules) {
      const c = centerPoint(m);
      minX = Math.min(minX, c.x - half);
      maxX = Math.max(maxX, c.x + half);
      minY = Math.min(minY, c.y);
      maxY = Math.max(maxY, c.y + DOOR_POST_HEIGHT_CM + 60);
      minZ = Math.min(minZ, c.z - half);
      maxZ = Math.max(maxZ, c.z + half);
    }
    if (Number.isFinite(minX)) {
      const home = new THREE.Vector3(
        (minX + maxX) / 2,
        (minY + maxY) / 2,
        (minZ + maxZ) / 2,
      );
      boundsRadius = Math.max(
        half,
        home.distanceTo(new THREE.Vector3(minX, minY, minZ)),
      );
      boundsMin.set(minX, minY, minZ);
      boundsMax.set(maxX, maxY, maxZ);
      // Shadow camera covers the level with margin, centered on it.
      const s = boundsRadius + 600;
      sun.shadow.camera.left = -s;
      sun.shadow.camera.right = s;
      sun.shadow.camera.top = s;
      sun.shadow.camera.bottom = -s;
      sun.target.position.copy(home);
      sun.target.updateMatrixWorld();
    }
  }
  // A stage under the level: the diorama casts onto it, grounding the scene.
  const stage = new THREE.Mesh(
    new THREE.CircleGeometry(boundsRadius * 1.55, 48),
    new THREE.MeshStandardMaterial({ color: 0x17191f, roughness: 0.95 }),
  );
  stage.rotation.x = -Math.PI / 2;
  stage.position.set(center.x, -60, center.z);
  stage.receiveShadow = true;
  scene.add(stage);

  const viewDir = new THREE.Vector3(1500, 2600, 3900).normalize();
  const camera = new THREE.PerspectiveCamera(45, 16 / 9, 10, 60000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.maxPolarAngle = Math.PI / 2.05;
  const homeTarget = new THREE.Vector3(center.x, center.y, center.z);
  const corners: THREE.Vector3[] = [];
  const computeFit = (): number => {
    corners.length = 0;
    const half = GEOMETRY.cellPitchCm / 2 + WALL_THICKNESS_CM;
    for (const m of compiled.level.modules) {
      const c = centerPoint(m);
      for (const dx of [-half, half]) {
        for (const dz of [-half, half]) {
          corners.push(new THREE.Vector3(c.x + dx, c.y, c.z + dz));
          corners.push(new THREE.Vector3(c.x + dx, c.y + DOOR_POST_HEIGHT_CM + 60, c.z + dz));
        }
      }
    }
    if (corners.length === 0) {
      for (const x of [boundsMin.x, boundsMax.x]) {
        for (const y of [boundsMin.y, boundsMax.y]) {
          for (const z of [boundsMin.z, boundsMax.z]) corners.push(new THREE.Vector3(x, y, z));
        }
      }
    }
    // Same ray, any distance: the camera quaternion stays valid while only
    // the position slides along the view direction.
    const saved = camera.position.clone();
    const extentAt = (d: number): number => {
      camera.position.copy(homeTarget).addScaledVector(viewDir, d);
      camera.updateMatrixWorld();
      let maxExt = 0;
      for (const c of corners) {
        const p = c.clone().project(camera);
        maxExt = Math.max(maxExt, Math.abs(p.x), Math.abs(p.y));
      }
      return maxExt;
    };
    let lo = 400;
    let hi = 60000;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (extentAt(mid) > 0.92) lo = mid;
      else hi = mid;
    }
    const d = (lo + hi) / 2;
    camera.position.copy(saved);
    camera.updateMatrixWorld();
    return d;
  };
  let cachedFit = 3000;
  const fitDistance = (): number => cachedFit;
  const frameHome = (): void => {
    controls.target.copy(homeTarget);
    camera.position.copy(homeTarget).addScaledVector(viewDir, fitDistance());
    controls.update();
  };
  frameHome();
  cachedFit = computeFit();
  frameHome();
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

  const actorUpdates = new Set<(dt: number, elapsed: number) => void>();
  let followTarget: THREE.Object3D | null = null;
  let distanceControl = false;
  let lastTime = performance.now();
  let frame = 0;
  const tick = () => {
    const now = performance.now();
    const dt = Math.min((now - lastTime) / 1000, 0.1);
    lastTime = now;
    for (const update of actorUpdates) update(dt, now);
    for (const update of decorUpdates) update(dt, now);
    if (followTarget !== null) {
      // Following an actor: keep it centered and pull in close enough that
      // the actor reads — the route stays in frame, the ghost is the focus.
      distanceControl = true;
      const k = reducedMotion() ? 1 : 1 - Math.exp(-dt * 5);
      controls.target.lerp(followTarget.position, k);
      const desired = fitDistance() * 0.3;
      const offset = camera.position.clone().sub(controls.target);
      const current = offset.length() || 1;
      offset.multiplyScalar(THREE.MathUtils.lerp(current, desired, k) / current);
      camera.position.copy(controls.target).add(offset);
    } else if (distanceControl) {
      // Follow ended: glide back to the framed overview, then hand control
      // back to the user (their zoom/orbit is never fought otherwise).
      const k = reducedMotion() ? 1 : 1 - Math.exp(-dt * 4);
      controls.target.lerp(homeTarget, k);
      const desired = fitDistance();
      const offset = camera.position.clone().sub(controls.target);
      const current = offset.length() || 1;
      offset.multiplyScalar(THREE.MathUtils.lerp(current, desired, k) / current);
      camera.position.copy(controls.target).add(offset);
      if (Math.abs(current - desired) < 2 && controls.target.distanceTo(homeTarget) < 2) {
        distanceControl = false;
      }
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
    cachedFit = computeFit();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(host);

  // Recovery-analysis overlays (§7.2.3 viz): translucent floor decals.
  // Unlit materials so the tint reads identically in light and shadow.
  const analysisGroup = new THREE.Group();
  analysisGroup.visible = false;
  scene.add(analysisGroup);
  const analysisMats = {
    stranded: new THREE.MeshBasicMaterial({
      color: 0xd57064,
      transparent: true,
      opacity: 0.24,
      depthWrite: false,
    }),
    unreachable: new THREE.MeshBasicMaterial({
      color: 0x101216,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
    }),
  };
  let analysisVisible = true;
  const overlayFor = (moduleId: string, material: THREE.MeshBasicMaterial): THREE.Mesh | null => {
    const m = compiled.moduleById.get(moduleId);
    if (!m) return null;
    const c = centerPoint(m);
    const size = GEOMETRY.cellPitchCm - 16;
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(size, size), material);
    quad.rotation.x = -Math.PI / 2;
    if (m.template === 'ramp') {
      const angle = Math.atan2(GEOMETRY.floorSpacingCm, GEOMETRY.cellPitchCm);
      if (m.orientation === 'N') quad.rotation.x = -Math.PI / 2 + angle;
      else if (m.orientation === 'S') quad.rotation.x = -Math.PI / 2 - angle;
      else if (m.orientation === 'E') quad.rotation.z = -angle;
      else quad.rotation.z = angle;
    }
    quad.position.set(c.x, c.y + 3, c.z);
    return quad;
  };

  // ---- Repair preview markers (§9 before/after) ----
  const previewGroup = new THREE.Group();
  previewGroup.visible = false;
  scene.add(previewGroup);
  const previewMats = {
    old: new THREE.MeshBasicMaterial({ color: 0xd57064, transparent: true, opacity: 0.85, side: THREE.DoubleSide }),
    fresh: new THREE.MeshBasicMaterial({ color: 0x4fbe82, transparent: true, opacity: 0.9, side: THREE.DoubleSide }),
  };
  const ringAt = (x: number, y: number, z: number, material: THREE.Material, scale = 1): void => {
    const ring = new THREE.Mesh(new THREE.RingGeometry(30, 48, 28), material);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(x, y + 4, z);
    ring.scale.setScalar(scale);
    previewGroup.add(ring);
  };
  const moduleCenter = (id: string): Vec3 | null => {
    const m = compiled.moduleById.get(id);
    return m ? centerPoint(m) : null;
  };

  const clearPreview = (): void => {
    for (const child of [...previewGroup.children]) {
      previewGroup.remove(child);
      if (child instanceof THREE.Mesh) child.geometry.dispose();
    }
    previewGroup.visible = false;
  };

  const buildPreview = (operations: Operation[]): void => {
    clearPreview();
    const applied = applyOperations(compiled.level, operations);
    if (!applied.ok) return;
    const before = compiled.level;
    const after = applied.level;
    const markerForItem = (itemId: string, level: typeof before, material: THREE.Material): void => {
      const key = level.keys.find((k) => k.id === itemId);
      const pad = level.switches.find((sw) => sw.id === itemId);
      const moduleId = key?.moduleId ?? pad?.moduleId;
      if (moduleId === undefined) return;
      const c = moduleCenter(moduleId);
      if (c) ringAt(c.x, c.y, c.z, material);
    };
    for (const key of before.keys) {
      const moved = after.keys.find((k) => k.id === key.id);
      if (moved === undefined) markerForItem(key.id, before, previewMats.old);
      else if (moved.moduleId !== key.moduleId) {
        markerForItem(key.id, before, previewMats.old);
        markerForItem(key.id, after, previewMats.fresh);
      }
    }
    for (const pad of before.switches) {
      const moved = after.switches.find((sw) => sw.id === pad.id);
      if (moved === undefined) markerForItem(pad.id, before, previewMats.old);
      else if (moved.moduleId !== pad.moduleId) {
        markerForItem(pad.id, before, previewMats.old);
        markerForItem(pad.id, after, previewMats.fresh);
      }
    }
    for (const door of after.doors) {
      if (before.doors.some((d) => d.id === door.id)) continue;
      const a = moduleCenter(door.a);
      const b = moduleCenter(door.b);
      if (a && b) ringAt((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2, previewMats.fresh, 0.8);
    }
    previewGroup.visible = previewGroup.children.length > 0;
  };

  // ---- Engine-driven world state (§12 visible mechanism state) ----
  // The engine decides openness: doorPassable() against the live actor
  // state. Keyed doors rest locked; sealing doors rest open and slam shut
  // the moment their switch fires — the viewer sees the trap happen.
  let actorState: GameState | null = null;
  const restOpen = (doorId: string): boolean => {
    const door = compiled.level.doors.find((d) => d.id === doorId);
    if (!door?.conditions) return true;
    return door.conditions.requiresKey === undefined && door.conditions.requiresKeys === undefined;
  };
  const setDoorTargets = (): void => {
    for (const [id, visual] of visuals.doors) {
      visual.targetOpen = actorState === null ? restOpen(id) : doorPassable(compiled, id, actorState);
    }
  };
  decorUpdates.push((dt: number) => {
    for (const visual of visuals.doors.values()) {
      const targetY = visual.targetOpen ? visual.openY : visual.closedY;
      if (Math.abs(visual.group.position.y - targetY) < 0.5) continue;
      const speed = visual.targetOpen ? 6 : 11; // closes slam faster than opens
      const k = reducedMotion() ? 1 : 1 - Math.exp(-dt * speed);
      visual.group.position.y += (targetY - visual.group.position.y) * k;
    }
  });
  const worldEvents = {
    updateState(state: GameState): void {
      actorState = state;
      setDoorTargets();
    },
    collectKey(keyId: string): void {
      const group = visuals.keys.get(keyId);
      if (!group || !group.visible) return;
      if (reducedMotion()) {
        group.visible = false;
        return;
      }
      let progress = 0;
      decorUpdates.push((dt: number) => {
        if (!group.visible || progress >= 1) return;
        progress = Math.min(1, progress + dt / 0.45);
        const baseY = group.userData.baseY as number;
        group.position.y = baseY + progress * 40;
        group.scale.setScalar(1.6 * (1 - progress));
        if (progress >= 1) group.visible = false;
      });
    },
    activateSwitch(switchId: string): void {
      const visual = visuals.switches.get(switchId);
      if (!visual) return;
      visual.plate.position.y = (visual.plate.userData.restY as number) - 6;
      const rimMaterial = visual.rim.material as THREE.MeshStandardMaterial;
      rimMaterial.emissiveIntensity = 1.7;
    },
    resetWorld(): void {
      actorState = null;
      for (const group of visuals.keys.values()) {
        group.visible = true;
        group.scale.setScalar(1.6);
        group.position.y = group.userData.baseY as number;
      }
      for (const visual of visuals.switches.values()) {
        visual.plate.position.y = visual.plate.userData.restY as number;
        (visual.rim.material as THREE.MeshStandardMaterial).emissiveIntensity = 0.65;
      }
      setDoorTargets();
    },
  };

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
    world: worldEvents,
  };

  return {
    spawnGhost(route, kind, missingKeys, callbacks) {
      return new GhostActor(actorContext, route, kind, missingKeys, callbacks);
    },
    setAnalysis(map) {
      for (const child of [...analysisGroup.children]) {
        analysisGroup.remove(child);
        if (child instanceof THREE.Mesh) child.geometry.dispose();
      }
      if (map === null) {
        analysisGroup.visible = false;
        return;
      }
      for (const id of map.stranded) {
        const quad = overlayFor(id, analysisMats.stranded);
        if (quad) analysisGroup.add(quad);
      }
      for (const id of map.unreachable) {
        const quad = overlayFor(id, analysisMats.unreachable);
        if (quad) analysisGroup.add(quad);
      }
      analysisGroup.visible = analysisVisible && analysisGroup.children.length > 0;
    },
    setAnalysisVisible(visible) {
      analysisVisible = visible;
      analysisGroup.visible = visible && analysisGroup.children.length > 0;
    },
    previewOperations(operations) {
      if (operations === null) {
        clearPreview();
        return;
      }
      buildPreview(operations);
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
      const shared = new Set<THREE.Material>(Object.values(mats));
      const disposeAll = (root: THREE.Object3D): void => {
        root.traverse((obj) => {
          if (obj instanceof THREE.Mesh) {
            obj.geometry.dispose();
            const material = obj.material as THREE.Material | THREE.Material[];
            for (const m of Array.isArray(material) ? material : [material]) {
              if (!shared.has(m)) m.dispose();
            }
          }
        });
      };
      disposeAll(world);
      disposeAll(stage);
      for (const child of [...analysisGroup.children]) {
        analysisGroup.remove(child);
        if (child instanceof THREE.Mesh) child.geometry.dispose();
      }
      analysisMats.stranded.dispose();
      analysisMats.unreachable.dispose();
      previewMats.old.dispose();
      previewMats.fresh.dispose();
      for (const material of shared) material.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
